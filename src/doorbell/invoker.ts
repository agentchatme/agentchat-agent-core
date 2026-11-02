import * as crypto from 'node:crypto'
import { log } from '../util/log.js'
import { KnockCoalescer, DEFAULT_KNOCK_DEBOUNCE_MS, type TimerHandle } from './knock.js'
import type { DoorbellPrompts } from './prompt.js'
import type { RunKind, RunOutcome, RunRunner } from './runner.js'
import type { InviteKnock } from './socket.js'
import type { DoorbellLastRun } from './status.js'

// ─── Knock → one run. The only path from the socket to the agent ────────────
//
// 1. Coalesce. Knocks inside a short window become one (`KnockCoalescer`).
// 2. Run. Start ONE headless run of the resident coding agent with the fixed
//    knock prompt. The agent reads the tray with the hosted inbox tool, judges
//    every card with the tray's own question, decides or sends through the
//    hosted tools. The run's output is discarded.
//
// One run at a time per agent, ever. A knock that lands while a run is in
// flight earns exactly one more run after it (the tray is re-read, so whatever
// the knock announced is covered); ten knocks during a run still earn one.
//
// A run that fails to start (runtime missing, auth expired, non-zero exit
// before any output), fails, or exceeds its budget schedules a re-knock on a
// local ladder (60 s, 5 min, 30 min), because a connected socket gets no
// re-ring from the server. One outage climbs one rung: a retry already on its
// way is never replaced by a later one. A successful run resets the ladder.
//
// Group invites are the second knock kind: not on the tray, one run each with
// the fixed invite prompt, serialized on the same worker, deduplicated by
// invite id for the life of the process.
//
// The doorbell reads NO tray and makes NO verdicts. That is the run's job.

export const RETRY_LADDER_MS: readonly number[] = [60_000, 300_000, 1_800_000]

const MAX_SEEN_INVITES = 1_000

export interface DoorbellInvokerOptions {
  readonly runner: RunRunner
  readonly prompts: DoorbellPrompts
  /** A run is killed past this and counts as failed. */
  readonly budgetMs: number
  readonly debounceMs?: number
  readonly retryLadderMs?: readonly number[]
  /** Called after every state change (a status writer hangs off this). */
  readonly onChange?: () => void
  readonly now?: () => number
  readonly setTimeout?: (fn: () => void, ms: number) => TimerHandle
  readonly clearTimeout?: (handle: TimerHandle) => void
  readonly runId?: () => string
}

export interface InvokerCounters {
  readonly knocks: number
  readonly absorbed: number
  readonly invites: number
  readonly runsStarted: number
  readonly runsOk: number
  readonly runsFailed: number
  readonly runsTimedOut: number
  readonly runsNotStarted: number
  readonly retryRung: number
  readonly retryDueAt: number | null
  readonly lastRun: DoorbellLastRun | null
  readonly running: boolean
}

export class DoorbellInvoker {
  private readonly runner: RunRunner
  private readonly prompts: DoorbellPrompts
  private readonly budgetMs: number
  private readonly ladder: readonly number[]
  private readonly now: () => number
  private readonly onChange: () => void
  private readonly newRunId: () => string
  private readonly coalescer: KnockCoalescer

  private cycleDue = false
  private running: Promise<void> | null = null
  private stopped = false
  private readonly invites: InviteKnock[] = []
  private readonly seenInvites: string[] = []
  private retryRung = 0

  private invitesSeen = 0
  private runsStarted = 0
  private runsOk = 0
  private runsFailed = 0
  private runsTimedOut = 0
  private runsNotStarted = 0
  private lastRun: DoorbellLastRun | null = null

  constructor(options: DoorbellInvokerOptions) {
    this.runner = options.runner
    this.prompts = options.prompts
    this.budgetMs = options.budgetMs
    this.ladder = options.retryLadderMs ?? RETRY_LADDER_MS
    this.now = options.now ?? Date.now
    this.onChange = options.onChange ?? (() => undefined)
    this.newRunId = options.runId ?? (() => crypto.randomUUID())
    this.coalescer = new KnockCoalescer({
      onFire: () => this.onKnockFired(),
      debounceMs: options.debounceMs ?? DEFAULT_KNOCK_DEBOUNCE_MS,
      now: this.now,
      ...(options.setTimeout ? { setTimeout: options.setTimeout } : {}),
      ...(options.clearTimeout ? { clearTimeout: options.clearTimeout } : {}),
    })
  }

  // ─── knocks ─────────────────────────────────────────────────────────────

  /** A knock from the socket (a frame, a connect) or any other source. Coalesced, then run. */
  knock(source: string): void {
    if (this.stopped) return
    log.debug(`knock (${source})`)
    this.coalescer.knock()
    this.onChange()
  }

  /**
   * The second knock kind. Deduplicated by invite id for the life of the
   * process. Returns true when newly queued.
   */
  invite(invite: InviteKnock): boolean {
    if (this.stopped) return false
    if (this.seenInvites.includes(invite.inviteId)) return false
    this.seenInvites.push(invite.inviteId)
    if (this.seenInvites.length > MAX_SEEN_INVITES) this.seenInvites.shift()
    this.invitesSeen += 1
    this.invites.push(invite)
    this.onChange()
    this.schedule()
    return true
  }

  /** Cancel timers; a run in flight finishes on its own. */
  stop(): void {
    this.stopped = true
    this.coalescer.stop()
  }

  /** The promise of the work currently running, for tests and graceful stops. */
  settled(): Promise<void> {
    return this.running ?? Promise.resolve()
  }

  counters(): InvokerCounters {
    return {
      knocks: this.coalescer.knocks,
      absorbed: this.coalescer.absorbed,
      invites: this.invitesSeen,
      runsStarted: this.runsStarted,
      runsOk: this.runsOk,
      runsFailed: this.runsFailed,
      runsTimedOut: this.runsTimedOut,
      runsNotStarted: this.runsNotStarted,
      retryRung: this.retryRung,
      retryDueAt: this.coalescer.delayedDue,
      lastRun: this.lastRun,
      running: this.running !== null,
    }
  }

  // ─── worker ─────────────────────────────────────────────────────────────

  private onKnockFired(): void {
    this.cycleDue = true
    this.schedule()
  }

  /** Run the worker if idle. One run at a time; work that lands mid-run runs afterwards. */
  private schedule(): void {
    if (this.running) return
    this.running = this.drain().finally(() => {
      this.running = null
      this.onChange()
      if (!this.stopped && (this.cycleDue || this.invites.length > 0)) this.schedule()
    })
  }

  private async drain(): Promise<void> {
    while (!this.stopped) {
      const invite = this.invites.shift()
      if (invite) {
        await this.run('invite', this.prompts.invite)
        continue
      }
      if (this.cycleDue) {
        // Clear BEFORE the run: a knock landing during the run sets it again
        // and earns exactly one more run afterwards.
        this.cycleDue = false
        await this.run('knock', this.prompts.knock)
        continue
      }
      return
    }
  }

  private async run(kind: RunKind, prompt: string): Promise<void> {
    const runId = this.newRunId()
    const startedAt = this.now()
    this.runsStarted += 1
    this.onChange()
    log.info(`run start kind=${kind} id=${runId} budget=${Math.round(this.budgetMs / 1000)}s`)

    let outcome: RunOutcome
    try {
      outcome = await this.runner.start({ kind, prompt, runId, budgetMs: this.budgetMs })
    } catch (err) {
      // The runner contract is "never throws"; a throw is a bug in the runner,
      // not a reason to drop the knock.
      outcome = {
        state: 'not_started',
        exitCode: null,
        durationMs: this.now() - startedAt,
        detail: `runner threw: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    this.lastRun = {
      kind,
      started_at: new Date(startedAt).toISOString(),
      ended_at: new Date(this.now()).toISOString(),
      state: outcome.state,
      exit_code: outcome.exitCode,
      duration_ms: outcome.durationMs,
      detail: outcome.detail ?? null,
    }

    switch (outcome.state) {
      case 'ok':
        this.runsOk += 1
        this.retryRung = 0
        log.info(`run ok kind=${kind} id=${runId} ${Math.round(outcome.durationMs / 1000)}s (output discarded; any send was the agent's own hosted-tool call)`)
        break
      case 'failed':
        this.runsFailed += 1
        break
      case 'timed_out':
        this.runsTimedOut += 1
        break
      case 'not_started':
        this.runsNotStarted += 1
        break
    }

    if (outcome.state !== 'ok') {
      log.warn(`run ${outcome.state} kind=${kind} id=${runId}${outcome.detail ? `: ${outcome.detail}` : ''}`)
      if (kind === 'knock') {
        // The agent never saw the tray, or did not finish: the cards are still
        // stored. Look again on the ladder instead of waiting for the next peer.
        this.scheduleRetry(`run ${outcome.state}`)
      } else {
        // An invite stays pending server-side and is reachable through the
        // hosted invite tools in any later run.
        log.info(`group-invite run ${outcome.state} — the invite stays pending server-side`)
      }
    }
    this.onChange()
  }

  private scheduleRetry(reason: string): void {
    if (this.coalescer.delayedPending) {
      // A retry is already on its way (a knock landed mid-outage and failed
      // again). One outage climbs the ladder once; climbing per failed run
      // would replace the sooner retry with a later one.
      log.info(`${reason} — a re-knock is already scheduled; not climbing the ladder`)
      return
    }
    if (this.retryRung >= this.ladder.length) {
      log.warn(`${reason} — retry ladder exhausted; waiting for the next knock (the backlog stays stored)`)
      return
    }
    const delay = this.ladder[this.retryRung] ?? this.ladder[this.ladder.length - 1] ?? 60_000
    this.retryRung += 1
    log.warn(`${reason} — re-knocking in ${Math.round(delay / 1000)}s (rung ${this.retryRung}/${this.ladder.length})`)
    this.coalescer.knockAfter(delay)
  }
}
