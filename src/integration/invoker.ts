import * as crypto from 'node:crypto'
import { log } from '../util/log.js'
import { WakeCoalescer, DEFAULT_WAKE_DEBOUNCE_MS, type TimerHandle } from './wake.js'
import type { RunPrompts } from './prompts.js'
import type { RunKind, RunOutcome, RunRunner } from './runner.js'
import type { InviteWake } from './connection.js'
import { OfferedInvites, type OfferedInviteStore } from './invites.js'
import type { IntegrationLastRun } from './status.js'

// ─── Wake → one run. The only path from the socket to the agent ─────────────
//
// 1. Coalesce. Wakes inside a short window become one (`WakeCoalescer`).
// 2. Count. Ask the tray whether anything is waiting (`trayHasWaiting`: one
//    `GET /v1/inbox?limit=1` through the SDK — a count, never a card; marks
//    nothing read). Empty → no run: nothing is owed, so the retry ladder
//    resets too. A count that cannot be read (network, 5xx) is not evidence
//    of an empty tray and the wake was real: the run starts anyway.
// 3. Run. Start ONE headless run of the resident coding agent with the served
//    wake text. The agent reads the tray with the hosted inbox tool, judges
//    every card with the tray's own question, decides or sends through the
//    hosted tools. The run's output is discarded.
//
// The count guards EVERY wake run — a frame, a reminder, the connect-time
// catch-up, a ladder re-wake, the preflight re-wake, the follow-on after a
// busy run — so no source needs its own "is this worth a run?" logic.
// Sleep/wake, Wi-Fi roaming and every server deploy reconnect the whole
// fleet; a reconnect with nothing waiting costs a count, not a run.
//
// One run at a time per agent, ever. A wake that lands while a run is in
// flight earns exactly one more cycle after it (counted first, so a burst the
// first run already answered costs a count, not a run); ten wakes during a
// run still earn one.
//
// A run that fails to start (runtime missing, auth expired, non-zero exit with
// nothing on stdout), fails, or exceeds its budget schedules a re-wake on a
// local ladder (60 s, 5 min, 30 min), because a connected socket gets no
// re-ring from the server. One outage climbs one rung: a retry already on its
// way is never replaced by a later one. A successful wake run, or a count that
// finds the tray empty, resets the ladder and cancels a pending re-wake:
// nothing is owed any more.
//
// When the ladder is exhausted the invoker does not go deaf. It asks the
// runner's `preflight()` every PREFLIGHT_WATCH_MS; if the runtime was found
// unusable (signed out, binary gone) and later answers ok, that flip earns ONE
// re-wake — a day's backlog behind a signed-out CLI is read when the user
// signs back in, not when the next new peer happens to write. If the first
// probe already says ok, the failures are not the runtime's readiness and the
// watch stops: the backlog waits for the next wake, as it always did. A wake
// from any source while watching is served as usual and, if it succeeds, ends
// the watch.
//
// `stop()` interrupts a run in flight: the run's `AbortSignal` fires, the
// runner SIGTERMs the run's process group, and `settled()` resolves when it
// has ended. An integration that stops without doing this leaves a model call
// running that nobody will read and that the next connect would run again.
//
// Group invites are the second wake kind: not on the tray, one run each with
// the served invite prompt, serialized on the same worker. An invite is
// OFFERED once per machine — the id is written to the identity home the
// moment its run has started (the runner's `onStarted`, `OfferedInvites`), so
// a daemon restart does not start one paid run per still-pending invite, and
// neither does a run cut short by a shutdown or a crash: the model call was
// made. An invite whose run never got going (`not_started`: runtime missing,
// signed out, nothing on stdout) is taken back out and offered again on the
// next wake; the next connect's listing finds it still pending.
//
// The prompts arrive lazily: the served texts may not have been fetched yet
// when the first wake lands. A run with no texts in hand does not start — it
// counts as `not_started`, and the wake retries on the ladder.
//
// The integration reads NO tray and makes NO verdicts. That is the run's job.

export const RETRY_LADDER_MS: readonly number[] = [60_000, 300_000, 1_800_000]

/**
 * How long past its budget a runner may take to return before the worker
 * stops waiting for it. `spawnRun` always settles well inside this (grace,
 * drain and abandon are seconds); the deadline is for a runner that does not
 * keep the "never hangs" promise — the worker must outlive every runner.
 */
export const RUNNER_DEADLINE_SLACK_MS = 60_000

/** The tray count before a wake run is one HTTP request; past this it counts as failed (the run starts anyway). */
export const TRAY_COUNT_DEADLINE_MS = 30_000

/** A runner's `preflight()` (a `--version`, an auth probe) past this counts as not ok. */
export const PREFLIGHT_DEADLINE_MS = 60_000

/** After the ladder is exhausted: how often the runtime is asked whether it is usable again. */
export const PREFLIGHT_WATCH_MS = 5 * 60_000

const MAX_TAKEN = 1_000

export interface IntegrationInvokerOptions {
  readonly runner: RunRunner
  /** The run prompts, resolved per run; null when the served texts are not available yet. */
  readonly prompts: () => Promise<RunPrompts | null>
  /** A run is killed past this and counts as failed. */
  readonly budgetMs: number
  readonly debounceMs?: number
  readonly retryLadderMs?: readonly number[]
  readonly preflightWatchMs?: number
  /** Past `budgetMs` plus this, a runner that has not returned is abandoned (`timed_out`). */
  readonly runnerDeadlineSlackMs?: number
  /** Past this, a tray count that has not answered counts as failed. */
  readonly trayCountDeadlineMs?: number
  /**
   * Is anything waiting on the tray? Asked before every wake run (never
   * before an invite run). Resolves the answer; rejects when the count could
   * not be read, and then the run starts anyway. Absent: every wake runs.
   */
  readonly trayHasWaiting?: () => Promise<boolean>
  /** Invites already offered to a run from this machine. Defaults to an in-memory set. */
  readonly offeredInvites?: OfferedInviteStore
  /** Called after every state change (a status writer hangs off this). */
  readonly onChange?: () => void
  readonly now?: () => number
  readonly setTimeout?: (fn: () => void, ms: number) => TimerHandle
  readonly clearTimeout?: (handle: TimerHandle) => void
  readonly runId?: () => string
}

export interface InvokerCounters {
  readonly wakes: number
  readonly absorbed: number
  readonly invites: number
  readonly runsStarted: number
  readonly runsOk: number
  readonly runsFailed: number
  readonly runsTimedOut: number
  readonly runsNotStarted: number
  /** Wake cycles that found the tray empty and started no run. */
  readonly runsSkippedEmpty: number
  readonly retryRung: number
  readonly retryDueAt: number | null
  readonly lastRun: IntegrationLastRun | null
  readonly running: boolean
}

export class IntegrationInvoker {
  private readonly runner: RunRunner
  private readonly prompts: () => Promise<RunPrompts | null>
  private readonly budgetMs: number
  private readonly ladder: readonly number[]
  private readonly preflightWatchMs: number
  private readonly runnerSlackMs: number
  private readonly countDeadlineMs: number
  private readonly now: () => number
  private readonly _setTimeout: (fn: () => void, ms: number) => TimerHandle
  private readonly _clearTimeout: (handle: TimerHandle) => void
  private readonly onChange: () => void
  private readonly newRunId: () => string
  private readonly trayHasWaiting: (() => Promise<boolean>) | null
  private readonly offered: OfferedInviteStore
  private readonly coalescer: WakeCoalescer

  private cycleDue = false
  private running: Promise<void> | null = null
  private inFlight: AbortController | null = null
  private stopped = false
  /** Invites queued for a run, in arrival order. */
  private readonly invites: InviteWake[] = []
  /** Invites whose run did not start; offered again on the next wake. */
  private readonly invitesAwaitingRetry: InviteWake[] = []
  /**
   * Invite ids this process has taken, offered or not. The on-disk store says
   * what was OFFERED; this says what is already in hand here — queued, in
   * flight, or awaiting its retry — so the connect-time listing and a live
   * frame for the same invite cannot queue it twice.
   */
  private readonly taken = new Set<string>()
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
  private lastRun: IntegrationLastRun | null = null

  constructor(options: IntegrationInvokerOptions) {
    this.runner = options.runner
    this.prompts = options.prompts
    this.budgetMs = options.budgetMs
    this.ladder = options.retryLadderMs ?? RETRY_LADDER_MS
    this.preflightWatchMs = options.preflightWatchMs ?? PREFLIGHT_WATCH_MS
    this.runnerSlackMs = options.runnerDeadlineSlackMs ?? RUNNER_DEADLINE_SLACK_MS
    this.countDeadlineMs = options.trayCountDeadlineMs ?? TRAY_COUNT_DEADLINE_MS
    this.now = options.now ?? Date.now
    this._setTimeout = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this._clearTimeout = options.clearTimeout ?? ((handle) => clearTimeout(handle))
    this.onChange = options.onChange ?? (() => undefined)
    this.newRunId = options.runId ?? (() => crypto.randomUUID())
    this.trayHasWaiting = options.trayHasWaiting ?? null
    this.offered = options.offeredInvites ?? new OfferedInvites(null)
    this.coalescer = new WakeCoalescer({
      onFire: () => this.onWakeFired(),
      debounceMs: options.debounceMs ?? DEFAULT_WAKE_DEBOUNCE_MS,
      now: this.now,
      ...(options.setTimeout ? { setTimeout: options.setTimeout } : {}),
      ...(options.clearTimeout ? { clearTimeout: options.clearTimeout } : {}),
    })
  }

  // ─── wakes ──────────────────────────────────────────────────────────────

  /** A wake from the socket (a frame), the connect-time catch-up, or any other source. Coalesced, then run. */
  wake(source: string): void {
    if (this.stopped) return
    log.debug(`wake (${source})`)
    this.coalescer.wake()
    this.onChange()
  }

  /**
   * The second wake kind. Offered once per machine: an invite already offered
   * to a run, already queued, or awaiting its retry is not queued again.
   * Returns true when newly queued.
   */
  invite(invite: InviteWake): boolean {
    if (this.stopped) return false
    if (this.offered.has(invite.inviteId) || this.taken.has(invite.inviteId)) return false
    this.taken.add(invite.inviteId)
    if (this.taken.size > MAX_TAKEN) {
      const oldest = this.taken.values().next().value
      if (oldest !== undefined) this.taken.delete(oldest)
    }
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
      wakes: this.coalescer.wakes,
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

  private onWakeFired(): void {
    this.cycleDue = true
    // An invite whose run did not start gets its next chance on the next
    // wake, whatever woke us.
    if (this.invitesAwaitingRetry.length > 0) {
      const retry = this.invitesAwaitingRetry.splice(0)
      log.info(`${retry.length} group invite(s) whose run did not start are offered again`)
      this.invites.push(...retry)
    }
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
        await this.run('invite', invite)
        continue
      }
      if (this.cycleDue) {
        // Clear BEFORE the count and the run: a wake landing during either
        // sets it again and earns exactly one more cycle afterwards.
        this.cycleDue = false
        if (!(await this.trayOwesRun())) continue
        await this.run('wake')
        continue
      }
      return
    }
  }

  /**
   * The count before a wake run. True: start the run (something waits, or
   * the count could not be read). False: the tray is empty — no run, nothing
   * owed — or the invoker stopped while counting.
   */
  private async trayOwesRun(): Promise<boolean> {
    if (this.trayHasWaiting === null) return true
    let waiting: boolean
    try {
      waiting = await this.withDeadline(this.trayHasWaiting(), this.countDeadlineMs, () => {
        throw new Error(`no answer within ${Math.round(this.countDeadlineMs / 1000)} s`)
      })
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
    log.info(`wake: the tray is empty — no run (nothing is owed; ${this.runsSkippedEmpty} skipped so far)`)
    this.settleLadder()
    this.onChange()
    return false
  }

  /**
   * Nothing is owed any more — a wake run read the whole tray, or a count
   * found it empty: back to the first rung, drop a pending re-wake (it would
   * only ring for a backlog that is already handled), end the preflight watch.
   */
  private settleLadder(): void {
    this.retryRung = 0
    if (this.coalescer.cancelDelayed()) log.info('pending re-wake cancelled — nothing is owed any more')
    this.clearPreflightWatch()
  }

  private async run(kind: RunKind, invite?: InviteWake): Promise<void> {
    const runId = this.newRunId()
    const startedAt = this.now()
    this.runsStarted += 1
    this.onChange()
    log.info(`run start kind=${kind} id=${runId} budget=${Math.round(this.budgetMs / 1000)}s`)

    const controller = new AbortController()
    this.inFlight = controller
    // An invite is recorded as offered the moment the runtime has started —
    // the paid call is made from then on, whatever ends the run.
    let offerRecorded = false
    const onStarted = (): void => {
      if (invite === undefined || offerRecorded) return
      offerRecorded = true
      this.offered.add(invite.inviteId)
    }
    let outcome: RunOutcome
    try {
      const prompts = await this.prompts()
      if (prompts === null) {
        outcome = {
          state: 'not_started',
          exitCode: null,
          durationMs: this.now() - startedAt,
          detail: 'no served texts in hand: GET /v1/texts has not answered yet and nothing is cached in the identity home',
        }
      } else if (this.stopped) {
        outcome = { state: 'not_started', exitCode: null, durationMs: this.now() - startedAt, detail: 'interrupted before the runtime was started' }
      } else {
        const prompt = kind === 'invite' ? prompts.invite : prompts.wake
        const deadlineMs = this.budgetMs + this.runnerSlackMs
        outcome = await this.withDeadline(
          this.runner.start({
            kind,
            prompt,
            runId,
            budgetMs: this.budgetMs,
            signal: controller.signal,
            ...(invite !== undefined ? { onStarted } : {}),
          }),
          deadlineMs,
          () => {
            // Ask the runner to stop what it started, and stop waiting for it.
            controller.abort()
            return {
              state: 'timed_out',
              exitCode: null,
              durationMs: this.now() - startedAt,
              detail: `the runner did not return within ${Math.round(deadlineMs / 1000)} s (budget plus ${Math.round(this.runnerSlackMs / 1000)} s) — abandoned so the next wake can run`,
            }
          },
        )
      }
    } catch (err) {
      // The runner contract is "never throws"; a throw is a bug in the runner,
      // not a reason to drop the wake.
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
        // A wake run read the whole tray. An invite run did not, so it leaves
        // a pending wake retry alone.
        if (kind === 'wake') this.settleLadder()
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

    if (invite !== undefined) this.settleInvite(invite, outcome, offerRecorded)

    if (outcome.state !== 'ok') {
      log.warn(`run ${outcome.state} kind=${kind} id=${runId}${outcome.detail ? `: ${outcome.detail}` : ''}`)
      if (this.stopped) {
        // Interrupted by stop(): nothing to schedule, the tray stays unread
        // and the next connect's catch-up finds it.
      } else if (kind === 'wake') {
        // The agent never saw the tray, or did not finish: the cards are still
        // unread. Look again on the ladder instead of waiting for the next peer.
        this.scheduleRetry(`run ${outcome.state}`)
      }
    }
    this.onChange()
  }

  /**
   * An invite counts as offered once its run has started (recorded at
   * `onStarted`; a runner that never signals it is recorded here, when the
   * run ends): the agent had its chance, and the invite stays reachable
   * through the hosted invite tools in any later run — including a run this
   * integration interrupted. A run that never got going is no offer: the
   * record is taken back and the invite is held for the next wake.
   */
  private settleInvite(invite: InviteWake, outcome: RunOutcome, offerRecorded: boolean): void {
    if (outcome.state === 'not_started') {
      if (offerRecorded) this.offered.remove(invite.inviteId)
      if (!this.invitesAwaitingRetry.some((i) => i.inviteId === invite.inviteId)) this.invitesAwaitingRetry.push(invite)
      log.info(`group-invite run did not start — invite ${invite.inviteId} is offered again on the next wake`)
      return
    }
    if (!offerRecorded) this.offered.add(invite.inviteId)
    if (outcome.state !== 'ok') log.info(`group-invite run ${outcome.state} — the invite stays pending server-side, reachable through the hosted tools`)
  }

  private scheduleRetry(reason: string): void {
    if (this.coalescer.delayedPending) {
      // A retry is already on its way (a wake landed mid-outage and failed
      // again). One outage climbs the ladder once; climbing per failed run
      // would replace the sooner retry with a later one.
      log.info(`${reason} — a re-wake is already scheduled; not climbing the ladder`)
      return
    }
    if (this.retryRung >= this.ladder.length) {
      log.warn(
        `${reason} — retry ladder exhausted; the backlog stays unread. Watching the runtime's preflight every ${Math.round(this.preflightWatchMs / 1000)}s: if it comes back, one re-wake; any wake also re-runs`,
      )
      this.armPreflightWatch()
      return
    }
    const delay = this.ladder[this.retryRung] ?? this.ladder[this.ladder.length - 1] ?? 60_000
    this.retryRung += 1
    log.warn(`${reason} — re-waking in ${Math.round(delay / 1000)}s (rung ${this.retryRung}/${this.ladder.length})`)
    this.coalescer.wakeAfter(delay)
  }

  /**
   * `work`, or `onTimeout()` once `ms` have passed — whichever comes first. A
   * late result of `work` is dropped (and a late rejection swallowed).
   */
  private withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let done = false
      const timer = this._setTimeout(() => {
        if (done) return
        done = true
        try {
          resolve(onTimeout())
        } catch (err) {
          reject(err)
        }
      }, ms)
      work.then(
        (value) => {
          if (done) return
          done = true
          this._clearTimeout(timer)
          resolve(value)
        },
        (err: unknown) => {
          if (done) return
          done = true
          this._clearTimeout(timer)
          reject(err)
        },
      )
    })
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
      ok = (await this.withDeadline(this.runner.preflight(), PREFLIGHT_DEADLINE_MS, () => ({ ok: false }))).ok
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
      log.info('runtime preflight is ok again after an exhausted ladder — waking once')
      this.wake('preflight')
      return
    }
    log.info('runtime preflight was already ok — the failures are not its readiness; the backlog waits for the next wake')
  }
}
