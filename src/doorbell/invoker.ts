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
// 2. Count. Ask the tray whether anything is waiting (`trayHasWaiting`: one
//    `GET /v1/inbox?wait_ms=0&limit=1` — a count, never a card; marks nothing
//    delivered). Empty → no run: nothing is owed, so the retry ladder resets
//    too. A count that cannot be read (network, 5xx) is not evidence of an
//    empty tray and the knock was real: the run starts anyway.
// 3. Run. Start ONE headless run of the resident coding agent with the fixed
//    knock prompt. The agent reads the tray with the hosted inbox tool, judges
//    every card with the tray's own question, decides or sends through the
//    hosted tools. The run's output is discarded.
//
// The count guards EVERY knock run — a frame, the connect-time catch-up, a
// ladder re-knock, the preflight re-knock, the follow-on after a busy run — so
// no source needs its own "is this worth a run?" logic. It is what keeps a
// deferred conversation from costing a run per reconnect: `defer` leaves the
// envelope stored, the server re-offers it as a plain `message.new` on every
// (re)connect, and the tray (which hides the deferred card until its time or
// a newer message) says nothing is waiting.
//
// One run at a time per agent, ever. A knock that lands while a run is in
// flight earns exactly one more cycle after it (counted first, so a burst the
// first run already answered costs a count, not a run); ten knocks during a
// run still earn one.
//
// A run that fails to start (runtime missing, auth expired, non-zero exit with
// nothing on stdout), fails, or exceeds its budget schedules a re-knock on a
// local ladder (60 s, 5 min, 30 min), because a connected socket gets no
// re-ring from the server. One outage climbs one rung: a retry already on its
// way is never replaced by a later one. A successful knock run, or a count
// that finds the tray empty, resets the ladder and cancels a pending re-knock:
// nothing is owed any more.
//
// When the ladder is exhausted the invoker does not go deaf. It asks the
// runner's `preflight()` every PREFLIGHT_WATCH_MS; if the runtime was found
// unusable (signed out, binary gone) and later answers ok, that flip earns ONE
// re-knock — a day's backlog behind a signed-out CLI is read when the user
// signs back in, not when the next new peer happens to write. If the first
// probe already says ok, the failures are not the runtime's readiness and the
// watch stops: the backlog waits for the next knock, as it always did. A knock
// from any source while watching is served as usual and, if it succeeds, ends
// the watch.
//
// `stop()` interrupts a run in flight: the run's `AbortSignal` fires, the
// runner SIGTERMs the run's process group, and `settled()` resolves when it
// has ended. A doorbell that stops without doing this leaves a model call
// running that nobody will read and that the next connect would run again.
//
// Group invites are the second knock kind: not on the tray, one run each with
// the fixed invite prompt, serialized on the same worker, deduplicated by
// invite id for the life of the process.
//
// The doorbell reads NO tray and makes NO verdicts. That is the run's job.

export const RETRY_LADDER_MS: readonly number[] = [60_000, 300_000, 1_800_000]

/** After the ladder is exhausted: how often the runtime is asked whether it is usable again. */
export const PREFLIGHT_WATCH_MS = 5 * 60_000

const MAX_SEEN_INVITES = 1_000

export interface DoorbellInvokerOptions {
  readonly runner: RunRunner
  readonly prompts: DoorbellPrompts
  /** A run is killed past this and counts as failed. */
  readonly budgetMs: number
  readonly debounceMs?: number
  readonly retryLadderMs?: readonly number[]
  readonly preflightWatchMs?: number
  /**
   * Is anything waiting on the tray? Asked before every knock run (never
   * before an invite run). Resolves the answer; rejects when the count could
   * not be read, and then the run starts anyway. Absent: every knock runs.
   */
  readonly trayHasWaiting?: () => Promise<boolean>
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
  /** Knock cycles that found the tray empty and started no run. */
  readonly runsSkippedEmpty: number
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
  private readonly preflightWatchMs: number
  private readonly now: () => number
  private readonly _setTimeout: (fn: () => void, ms: number) => TimerHandle
  private readonly _clearTimeout: (handle: TimerHandle) => void
  private readonly onChange: () => void
  private readonly newRunId: () => string
  private readonly trayHasWaiting: (() => Promise<boolean>) | null
  private readonly coalescer: KnockCoalescer

  private cycleDue = false
  private running: Promise<void> | null = null
  private inFlight: AbortController | null = null
  private stopped = false
  private readonly invites: InviteKnock[] = []
  private readonly seenInvites: string[] = []
  private retryRung = 0
  private preflightWatch: TimerHandle | null = null
  private preflightWasDown = false

  private invitesSeen = 0
  private runsStarted = 0
  private runsOk = 0
  private runsFailed = 0
  private runsTimedOut = 0
  private runsNotStarted = 0
  private runsSkippedEmpty = 0
  private lastRun: DoorbellLastRun | null = null

  constructor(options: DoorbellInvokerOptions) {
    this.runner = options.runner
    this.prompts = options.prompts
    this.budgetMs = options.budgetMs
    this.ladder = options.retryLadderMs ?? RETRY_LADDER_MS
    this.preflightWatchMs = options.preflightWatchMs ?? PREFLIGHT_WATCH_MS
    this.now = options.now ?? Date.now
    this._setTimeout = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this._clearTimeout = options.clearTimeout ?? ((handle) => clearTimeout(handle))
    this.onChange = options.onChange ?? (() => undefined)
    this.newRunId = options.runId ?? (() => crypto.randomUUID())
    this.trayHasWaiting = options.trayHasWaiting ?? null
    this.coalescer = new KnockCoalescer({
      onFire: () => this.onKnockFired(),
      debounceMs: options.debounceMs ?? DEFAULT_KNOCK_DEBOUNCE_MS,
      now: this.now,
      ...(options.setTimeout ? { setTimeout: options.setTimeout } : {}),
      ...(options.clearTimeout ? { clearTimeout: options.clearTimeout } : {}),
    })
  }

  // ─── knocks ─────────────────────────────────────────────────────────────

  /** A knock from the socket (a frame), the connect-time catch-up, or any other source. Coalesced, then run. */
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

  /**
   * Cancel timers and interrupt a run in flight (its signal aborts; the
   * runner SIGTERMs the run's process group). `settled()` resolves when the
   * interrupted run has ended.
   */
  stop(): void {
    this.stopped = true
    this.coalescer.stop()
    this.clearPreflightWatch()
    this.inFlight?.abort()
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
      runsSkippedEmpty: this.runsSkippedEmpty,
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
        // Clear BEFORE the count and the run: a knock landing during either
        // sets it again and earns exactly one more cycle afterwards.
        this.cycleDue = false
        if (!(await this.trayOwesRun())) continue
        await this.run('knock', this.prompts.knock)
        continue
      }
      return
    }
  }

  /**
   * The count before a knock run. True: start the run (something waits, or
   * the count could not be read). False: the tray is empty — no run, nothing
   * owed — or the invoker stopped while counting.
   */
  private async trayOwesRun(): Promise<boolean> {
    if (this.trayHasWaiting === null) return true
    let waiting: boolean
    try {
      waiting = await this.trayHasWaiting()
    } catch (err) {
      if (this.stopped) return false
      log.warn(
        `tray count failed (${err instanceof Error ? err.message : String(err)}) — starting the run anyway: a failed count is not an empty tray`,
      )
      return true
    }
    if (this.stopped) return false
    if (waiting) return true
    this.runsSkippedEmpty += 1
    log.info(`knock: the tray is empty — no run (nothing is owed; ${this.runsSkippedEmpty} skipped so far)`)
    this.settleLadder()
    this.onChange()
    return false
  }

  /**
   * Nothing is owed any more — a knock run read the whole tray, or a count
   * found it empty: back to the first rung, drop a pending re-knock (it would
   * only ring for a backlog that is already handled), end the preflight watch.
   */
  private settleLadder(): void {
    this.retryRung = 0
    if (this.coalescer.cancelDelayed()) log.info('pending re-knock cancelled — nothing is owed any more')
    this.clearPreflightWatch()
  }

  private async run(kind: RunKind, prompt: string): Promise<void> {
    const runId = this.newRunId()
    const startedAt = this.now()
    this.runsStarted += 1
    this.onChange()
    log.info(`run start kind=${kind} id=${runId} budget=${Math.round(this.budgetMs / 1000)}s`)

    const controller = new AbortController()
    this.inFlight = controller
    let outcome: RunOutcome
    try {
      outcome = await this.runner.start({ kind, prompt, runId, budgetMs: this.budgetMs, signal: controller.signal })
    } catch (err) {
      // The runner contract is "never throws"; a throw is a bug in the runner,
      // not a reason to drop the knock.
      outcome = {
        state: 'not_started',
        exitCode: null,
        durationMs: this.now() - startedAt,
        detail: `runner threw: ${err instanceof Error ? err.message : String(err)}`,
      }
    } finally {
      if (this.inFlight === controller) this.inFlight = null
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
        // A knock run read the whole tray. An invite run did not, so it leaves
        // a pending knock retry alone.
        if (kind === 'knock') this.settleLadder()
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
      if (this.stopped) {
        // Interrupted by stop(): nothing to schedule, the tray stays stored
        // and the next connect's catch-up finds it.
      } else if (kind === 'knock') {
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
      log.warn(
        `${reason} — retry ladder exhausted; the backlog stays stored. Watching the runtime's preflight every ${Math.round(this.preflightWatchMs / 1000)}s: if it comes back, one re-knock; any knock also re-runs`,
      )
      this.armPreflightWatch()
      return
    }
    const delay = this.ladder[this.retryRung] ?? this.ladder[this.ladder.length - 1] ?? 60_000
    this.retryRung += 1
    log.warn(`${reason} — re-knocking in ${Math.round(delay / 1000)}s (rung ${this.retryRung}/${this.ladder.length})`)
    this.coalescer.knockAfter(delay)
  }

  // ─── preflight watch, after an exhausted ladder ─────────────────────────

  private armPreflightWatch(): void {
    if (this.stopped || this.preflightWatch !== null) return
    this.preflightWatch = this._setTimeout(() => {
      this.preflightWatch = null
      void this.probePreflight()
    }, this.preflightWatchMs)
    this.onChange()
  }

  private clearPreflightWatch(): void {
    if (this.preflightWatch !== null) {
      this._clearTimeout(this.preflightWatch)
      this.preflightWatch = null
    }
    this.preflightWasDown = false
  }

  private async probePreflight(): Promise<void> {
    if (this.stopped) return
    let ok: boolean
    try {
      ok = (await this.runner.preflight()).ok
    } catch {
      ok = false
    }
    if (this.stopped) return
    if (!ok) {
      if (!this.preflightWasDown) log.info('runtime preflight is not ok — watching for it to come back')
      this.preflightWasDown = true
      this.armPreflightWatch()
      return
    }
    if (this.preflightWasDown) {
      this.preflightWasDown = false
      log.info('runtime preflight is ok again after an exhausted ladder — re-knocking once')
      this.knock('preflight')
      return
    }
    log.info('runtime preflight was already ok — the failures are not its readiness; the backlog waits for the next knock')
  }
}
