import * as crypto from 'node:crypto'
import { AgentChatClient, RealtimeClient, integration as kit, type Texts } from 'agentchatme'
import { log } from '../util/log.js'
import type { DaemonConfig } from '../daemon/config.js'
import { beat, idle } from '../daemon/health.js'
import { clientIdentityOf, type IntegrationClient } from '../client-identity.js'
import type { RunProfile } from './profile.js'
import type { RunKind, RunOutcome, RunPreflight, RunRunner, RunWake } from './runner.js'
import {
  writeIntegrationStatus,
  type IntegrationCouldNotProcess,
  type IntegrationIdentityLine,
  type IntegrationLastRun,
  type IntegrationRunsFailing,
  type IntegrationStatus,
  type SocketState,
} from './status.js'
import { PausedConversations } from './could-not-process.js'
import { blockedDetail, socketStateOf } from './socket-state.js'
import { textsCachePath } from './texts.js'
import { MANUAL, resolveManualPointer, type ManualPointer } from '../skill/manual.js'
import { describeManualSync, type ManualFetch } from '../skill/served-manual.js'
import { followIdentityAnchor, type AnchorLoadNote, type AnchorServedLine } from '../anchor/follow.js'
import { listenerReasonKindOf, type ListenerReasonKind } from '../identity/setup.js'
import { listenerReportStatusOf, tellListener, type ListenerReportSink } from './listener-report.js'
import { RecheckSchedule, RUNS_FAILING_RECHECK_MS, type RecheckTimers } from './failing-recheck.js'

// ─── The integration: the SDK kit's receive loop, and one runtime's runner ──
//
// Everything that talks to AgentChat is the SDK's integration kit (`import {
// integration } from 'agentchatme'`), written once for every runtime:
//
//   * the socket — `ackOnReceipt` (delivered = this machine received it) with
//     the `ack`, `heartbeat` and `rewake` capabilities, never reading a body;
//   * the wakes — a `message.new` that is not this agent's own echo, a `wake`
//     frame (a reminder, or the server re-waking unanswered cards), a group
//     invite, every accepted hello — coalesced into one cycle per burst, one
//     cycle at a time (`WakeCoalescer`);
//   * the cycle in single-run mode (`ReceiveLoop`): read the tray; nothing
//     owed (no cards, only muted ones, no pending invite) starts nothing.
//     With served texts that carry `conversation_run_template` (every
//     current server): CONVERSATION RUNS — one run per conversation that owes
//     a reply, prompted for that one conversation, one at a time, and one
//     run for the pending invites; a live exchange stays in its run (the
//     scoped `agentchat_wait` for that conversation). One conversation's
//     content never sits in front of the model while it answers another, and
//     one the AI cannot process never blocks the rest. From an older server
//     (no template): ONE run for the whole tray with the served wake
//     instruction, as before; a tray that cannot be read starts it anyway.
//     A run records its own verdicts; nothing is recorded on its behalf;
//   * could not process — a conversation's run that failed or timed out
//     while the runtime otherwise works (another conversation's run completed
//     since, or — for a run that failed, not one that timed out — the
//     runner's `checkRuntime`, a minimal model call, passes) is reported; the
//     server answers retry, hidden (the span is shown to this agent as a
//     note), paused (a 24 h mute) or none, and the kit follows it once;
//   * the served texts (`TextsCache`, the last good copy kept in the identity
//     home) and the manual they announce (`ManualSync`).
//
// And what this package adds to the texts: on every change of them (the copy
// read from the identity home at start, then each served copy that differs),
// the identity block in the host's always-loaded instruction file follows the
// served identity line (`anchorPath`, `followIdentityAnchor`: only this
// agent's own block, never created, never one edited by hand), and each run's
// pointer line names the manual where the texts in hand say it is.
//
// There is no retry ladder here, and no invite ledger: the server re-wakes
// unanswered cards on its own durable ladder and shows pending invites on the
// tray (contract v1, D3/D4), so a run that could not finish leaves the cards
// where they are and the next wake finds them.
//
// What stays here is this package's own: the runner seam (how a runtime's run
// is started is the integration's — `RunRunner`), the one pointer line a run
// prompt ends with, a deadline on every run (a runner that never returns must
// not hold the loop), the status file `status` and `doctor` read, and what
// the listener report says (`listenerReport`, contract v1 §3.13; the
// supervisor owns the reporter, the kit's `ListenerReporter` sends it):
// `not_ready` when the start preflight fails, `ok` once connected with the
// runtime healthy, `runs_failing` while the recheck after a failed run fails
// (its reason) or the runtime check after a failed run fails
// (`runtime_check_failed`, which changes neither `health()` nor the
// hand-over), back to `ok` when a run completes or that check passes. While
// it says `runs_failing`, it looks again on its own (`RecheckSchedule`: 30
// minutes, 1 hour, 2 hours, then every 4 hours), since without a message no
// run would: the start preflight first (no model call), then, when the
// runtime check is what failed, that check once (one minimal model call),
// never while a run is under way; passing, `ok`.

const HEARTBEAT_MS = 30_000
const STATUS_MS = 30_000
/** HTTP calls the loop makes are the tray and the texts; none deserves a long wait or a retry ramp. */
const HTTP_TIMEOUT_MS = 10_000

/**
 * How long past its budget a runner may take to return before the loop stops
 * waiting for it. `spawnRun` always returns well inside this (grace, drain and
 * abandon are seconds); the deadline is for a runner that does not keep the
 * "never hangs" promise — the loop must outlive every runner.
 */
export const RUNNER_DEADLINE_SLACK_MS = 60_000

/**
 * After a run that did not get done, the runtime is checked again (its
 * preflight) — at most once per this while runs keep failing, never on every
 * wake. A failing check is what `status` and `doctor` then say.
 */
export const RUNTIME_RECHECK_MS = 5 * 60_000

/** A runner's `preflight()` (a `--version`, an auth probe) past this counts as not ok. */
export const PREFLIGHT_DEADLINE_MS = 60_000

/**
 * A runner's `checkRuntime()` (a minimal model call) past this counts as not
 * ok, and its probe is stopped (killed with its tree). The kit's own bound is
 * the same 60 s.
 */
export const RUNTIME_CHECK_DEADLINE_MS = 60_000

export interface IntegrationOptions {
  readonly cfg: DaemonConfig
  readonly runner: RunRunner
  /** How this integration names itself to the server (texts runtime + its version). */
  readonly client: IntegrationClient
  /**
   * The one pointer line a run prompt ends with: a function of the manual's
   * address (`(url) => manualPointer(location, url)`), called with the address
   * the texts in hand announce; a plain string is used as it is.
   */
  readonly manualPointer: ManualPointer
  /**
   * The host's always-loaded instruction file, whose AgentChat identity block
   * follows the served identity line from then on (`followIdentityAnchor`).
   * Absent, the block is left to the CLI's install and `doctor --fix`.
   */
  readonly anchorPath?: string
  /**
   * For a runtime that reads another file in `anchorPath`'s place when that
   * one exists: which file it loads, and whether the identity line there is
   * the served one (judged against the texts being followed), or null when
   * it loads `anchorPath` (`HostProfile.anchorLoadNote`). Said with every
   * follow; when `ok` is false, at warn and as the status file's
   * `identity_line.not_loaded`. Nothing is written into that other file.
   */
  readonly anchorLoadNote?: (handle: string, served: AnchorServedLine) => AnchorLoadNote | null
  /** The skill file that follows the served manual (`<skills dir>/agentchat/SKILL.md`); absent, the manual is left to the CLI. */
  readonly manualPath?: string
  /** Injectable for tests; the manual download's `fetch`. */
  readonly manualFetch?: ManualFetch
  readonly profile: RunProfile
  readonly budgetMs: number
  /** Injectable for tests; past `budgetMs` plus this a runner that has not returned is abandoned. */
  readonly runnerDeadlineSlackMs?: number
  /** Injectable for tests; `RUNTIME_RECHECK_MS`. */
  readonly runtimeRecheckMs?: number
  /** What the supervisor adds to every status this integration writes (its locks' renewal errors). */
  readonly statusExtra?: () => Partial<IntegrationStatus>
  /** Injectable for tests; defaults to an SDK client for `cfg`. */
  readonly api?: AgentChatClient
  /** Injectable for tests: the socket (built with `ackOnReceipt` and the v1 capabilities otherwise). */
  readonly realtime?: RealtimeClient
  /** Injectable for tests: the coalescing window. */
  readonly quietMs?: number
  readonly maxMs?: number
  /** Injectable for tests: the kit's cycle watchdog (default 10 min, not counting runs). */
  readonly cycleTimeoutMs?: number
  /**
   * Injectable for tests: the kit's pacing window (default 60 s) — a second
   * completed run that leaves an invite pending counts toward dismissing it
   * only this long after the first.
   */
  readonly paceMs?: number
  /**
   * The kit's single-run rule dismisses an invite two completed runs left
   * pending, so an ignored invite does not cost a run on every wake. Right
   * when a run is the agent itself; wrong when "completed" only means a
   * receiver accepted a POST (the `agentchat forward` mode): there it is
   * false, and no invite is ever dismissed on the agent's behalf.
   */
  readonly dismissIgnoredInvites?: boolean
  /**
   * Conversation runs (default true): whenever the served texts carry
   * `conversation_run_template`, one run per conversation that owes a reply
   * instead of one run for the whole tray. False keeps one run for the tray:
   * right when a "run" does not start the agent on that one conversation (the
   * `agentchat forward` mode hands each run to a receiver that reads the
   * whole tray itself).
   */
  readonly conversationRuns?: boolean
  /** Injectable for tests; `RUNTIME_CHECK_DEADLINE_MS`. */
  readonly runtimeCheckDeadlineMs?: number
  /** Injectable for tests: how soon the served texts are fetched again after a fetch (the kit's 24 h). */
  readonly textsRefreshMs?: number
  /** Injectable for tests: the gaps of the re-check while the report says `runs_failing` (`RUNS_FAILING_RECHECK_MS`). */
  readonly runsFailingRecheckMs?: readonly number[]
  /** Injectable for tests: what that re-check waits with (a fake clock). */
  readonly recheckTimers?: RecheckTimers
  /**
   * The listener report for this agent (contract v1 §3.13): what this
   * integration tells AgentChat about itself. The supervisor owns it, so it
   * outlives an integration whose start failed, and gives it only to the
   * integration that holds the agent lock. Absent, nothing is reported.
   */
  readonly listenerReport?: ListenerReportSink
}

type ProcessingFailureCounts = ReturnType<kit.ReceiveLoop['status']>['processingFailures']

/** The kit's could-not-process counts when it keeps none (a kit from before could not process). */
const NO_PROCESSING_FAILURES: ProcessingFailureCounts = {
  reported: 0,
  retry: 0,
  hidden: 0,
  paused: 0,
  none: 0,
  reportErrors: 0,
  reruns: 0,
  rerunsCapped: 0,
  awaitingEvidence: 0,
  runtimeChecksOk: 0,
  runtimeChecksFailed: 0,
  lastRuntimeCheck: null,
} as ProcessingFailureCounts

/** Most of a failure line: enough to diagnose, bounded for the status file. */
const CYCLE_FAILURE_CHARS = 240

/** The webhook wake's reason for a kit wake source (contract v1); null when the source names none. */
function reasonOf(source: kit.WakeSource, frameReason: string | undefined): string | null {
  switch (source) {
    case 'message':
      return 'messages'
    case 'invite':
      return 'invite'
    case 'wake_frame':
      return frameReason ?? 'reminder'
    default:
      return null
  }
}

/** A gap for the log: `30 min`, `1 h`, `4 h` (`45 s` below a minute). */
function describeGap(ms: number | null): string {
  if (ms === null) return '?'
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`
  return `${Math.round((ms / 3_600_000) * 10) / 10} h`
}

/** `work`, or `onTimeout()` once `ms` have passed — whichever first. A late result is dropped. */
export function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try {
        resolve(onTimeout())
      } catch (err) {
        reject(err)
      }
    }, ms)
    timer.unref?.()
    work.then(
      (value) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        if (done) return
        done = true
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

export class Integration {
  private readonly api: AgentChatClient
  private readonly realtime: RealtimeClient
  private readonly texts: kit.TextsCache
  private readonly manual: kit.ManualSync | null
  private readonly loop: kit.ReceiveLoop
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private statusTimer: ReturnType<typeof setInterval> | null = null
  private socket: SocketState = 'idle'
  private lastError: string | null = null
  /** When the first run that did not get done since the last good one ended; null while runs succeed. */
  private failingSince: string | null = null
  /** Runs that did not get done since then. */
  private failingRuns = 0
  /** What the runtime's own check says while runs fail (status `runs_failing`); null when it has not failed one. */
  private runsFailing: IntegrationRunsFailing | null = null
  private lastRecheckAt = 0
  private recheckInFlight: Promise<void> | null = null
  /** Aborts a runtime check in flight when the integration stops (its probes are killed, not left running). */
  private readonly recheckAbort = new AbortController()
  private stopping = false
  private stopped: Promise<void> | null = null

  private invites = 0
  private runsStarted = 0
  private runsOk = 0
  private runsFailed = 0
  private runsTimedOut = 0
  private runsNotStarted = 0
  private runsSkippedEmpty = 0
  private lastRun: IntegrationLastRun | null = null
  /** When the last run that got done ended (`last_ok_run_at`). */
  private lastOkRunAt: string | null = null
  /** The newest wake since the last run started (for `RunRequest.wake`). */
  private pendingWake: RunWake | null = null
  /** The rung of the newest `unanswered` wake frame (the kit's wake event does not carry it). */
  private lastUnansweredStep: number | null = null
  /** The conversations the server paused for this agent, as it answered (kept in the identity home). */
  private readonly paused: PausedConversations
  /** The runner's runtime check in flight: concurrent asks share it. */
  private runtimeCheckInFlight: Promise<RunPreflight> | null = null
  /** What the identity block's last follow did (status `identity_line`); null without `anchorPath`, or before the first texts. */
  private identityLine: IntegrationIdentityLine | null = null
  /** The follows of the identity line, one after another (each texts change queues one; a stop waits for the one in flight). */
  private follows: Promise<void> = Promise.resolve()
  /** The socket's hello has been accepted since this integration started (a reconnect after it changes nothing). */
  private connected = false
  /** The recheck after a failed run failed, and the reason it gives (`runs_failing`); null when it passed or a run completed since. */
  private recheckFailing: ListenerReasonKind | null = null
  /** The runtime check after a failed run failed, and nothing has passed or completed since. */
  private runtimeCheckFailing = false
  /** Runs under way (the runner's `start` not yet returned). */
  private runsInFlight = 0
  /** While the report says `runs_failing`: the re-check on a growing gap. */
  private readonly failingRecheck: RecheckSchedule
  /** Stops the model call of a re-check under way: a run started, the kit asked its own check, or the failure ended (a stop aborts it through `recheckAbort`). */
  private failingRecheckCancel: AbortController | null = null

  constructor(private readonly options: IntegrationOptions) {
    const { cfg, client } = options
    const identity = clientIdentityOf(client)
    this.paused = new PausedConversations(cfg.home, cfg.handle)
    this.failingRecheck = new RecheckSchedule({
      recheck: (episode) => this.recheckWhileFailing(episode),
      ...(options.runsFailingRecheckMs !== undefined ? { gapsMs: options.runsFailingRecheckMs } : {}),
      ...(options.recheckTimers !== undefined ? { timers: options.recheckTimers } : {}),
    })
    this.api =
      options.api ??
      new AgentChatClient({ apiKey: cfg.apiKey, baseUrl: cfg.apiBase, clientIdentity: identity, timeoutMs: HTTP_TIMEOUT_MS, retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } })
    this.texts = new kit.TextsCache({
      client: this.api,
      runtime: client.runtime,
      filePath: textsCachePath(cfg.home),
      onError: (err) => log.warn(err.message),
      ...(options.textsRefreshMs !== undefined ? { refreshMs: options.textsRefreshMs } : {}),
    })
    this.texts.onChange((texts, source) => {
      log.info(`texts ${source === 'server' ? 'fetched' : 'read from the cache'} for ${client.runtime} (texts v${texts.version}, manual ${texts.manual.version})`)
      // In order, one at a time: a follow reads and writes the file, and the newer texts must land last.
      this.follows = this.follows.then(() => this.followIdentityLine(texts))
      this.writeStatus()
    })
    this.manual =
      options.manualPath === undefined
        ? null
        : new kit.ManualSync({
            texts: this.texts,
            targetPath: options.manualPath,
            fallback: MANUAL,
            ...(options.manualFetch !== undefined ? { fetch: options.manualFetch } : {}),
            onResult: (result) => {
              const line = `manual: ${describeManualSync({ ...result, source: result.source === 'fallback' ? 'bundled' : result.source })}`
              if (result.upToDate === false || result.state === 'failed') log.warn(line)
              else if (result.written) log.info(line)
            },
          })
    // Built here rather than by the loop, so the status file can follow the
    // socket's own words and a refused key reads `blocked` with its reason.
    // No REST drain client: the server re-offers unacked envelopes over the
    // socket right after the hello, and nothing here ever needs a body.
    this.realtime =
      options.realtime ??
      new RealtimeClient({
        apiKey: cfg.apiKey,
        baseUrl: cfg.wsBase,
        clientIdentity: identity,
        ackOnReceipt: true,
        reconnect: true,
        capabilities: { heartbeat: true, rewake: true },
      })
    this.realtime.on('state', (next) => {
      const word = socketStateOf(next, this.socket)
      if (word === this.socket) return
      this.socket = word
      if (word === 'ready') {
        beat(cfg.home)
        // An accepted hello lifts a refusal: the key works again.
        this.lastError = null
        log.info(`socket ready (hello.ok) — acks ${this.realtime.ackNegotiated ? 'on receipt' : 'not negotiated by this server'}; ${this.realtime.capabilities.has('rewake') ? 'the server re-wakes unanswered cards' : 'this server does not re-wake unanswered cards'}`)
        this.connected = true
        this.reportListener()
      } else {
        idle(cfg.home)
        if (word === 'reconnecting') log.info('socket reconnecting — the SDK backs off and retries; it never gives up')
      }
      this.writeStatus()
    })
    this.realtime.on('blocked', (info) => {
      // A refused key is a state to show, not to die from: the SDK stays
      // `blocked` and tries a fresh hello every 10–15 min.
      this.lastError = blockedDetail(info)
      log.error(`socket blocked (auth): ${this.lastError}`)
      this.writeStatus()
    })
    this.realtime.on('wake', (frame) => {
      const payload = (frame.payload ?? {}) as { reason?: unknown; step?: unknown }
      if (payload.reason === 'unanswered' && typeof payload.step === 'number') this.lastUnansweredStep = payload.step
    })
    this.loop = new kit.ReceiveLoop({
      client: this.api,
      // The kit's own switch: off, no invite is dismissed on the agent's behalf.
      ...(options.dismissIgnoredInvites === false ? { dismissIgnoredInvites: false } : {}),
      // One run per conversation whenever the served texts carry the template.
      ...(options.conversationRuns === false ? { conversationRuns: false } : {}),
      // The evidence a could-not-process report needs when no other run has
      // completed since: the runtime's own minimal model call. Without one, a
      // failure waits for another run to complete.
      ...(options.runner.checkRuntime !== undefined ? { checkRuntime: () => this.checkRuntime() } : {}),
      texts: this.texts,
      mode: 'singleRun',
      socket: this.realtime,
      handle: cfg.handle,
      startRun: (request) => this.startRun(request),
      onEvent: (event) => this.onEvent(event),
      ...(options.quietMs !== undefined ? { quietMs: options.quietMs } : {}),
      ...(options.maxMs !== undefined ? { maxMs: options.maxMs } : {}),
      ...(options.cycleTimeoutMs !== undefined ? { cycleTimeoutMs: options.cycleTimeoutMs } : {}),
      ...(options.paceMs !== undefined ? { paceMs: options.paceMs } : {}),
    })
  }

  async start(): Promise<void> {
    // Bounded: a preflight that never answers must not hold the supervisor
    // (and with it the shutdown path) forever.
    const pre = await withDeadline(this.options.runner.preflight(), PREFLIGHT_DEADLINE_MS, () => ({
      ok: false,
      detail: `preflight did not answer within ${Math.round(PREFLIGHT_DEADLINE_MS / 1000)} s`,
    }))
    if (!pre.ok) {
      // It cannot start the runtime, so it does not connect: AgentChat says
      // so (signed out, missing, too old) instead of a closed laptop. The
      // supervisor keeps the reporter across its retries: one report, not one
      // per retry.
      if (!this.stopping) tellListener(this.options.listenerReport, 'not_ready', listenerReasonKindOf(pre.detail ?? ''))
      throw new Error(`runtime (${this.options.runner.name}) not ready: ${pre.detail ?? 'unknown'}`)
    }
    // A `not_ready` an earlier start said is no longer true, connected or not
    // yet: unsaid at once, so a socket that cannot connect is not re-sent
    // every 30 minutes as a runtime that cannot start.
    if (!this.stopping && this.options.listenerReport?.status().state === 'not_ready') tellListener(this.options.listenerReport, 'ok')
    log.info(
      `integration up as @${this.options.cfg.handle} via ${this.options.runner.name} (${this.options.client.runtime} ${this.options.client.version}), profile ${this.options.profile}; fetching the served texts, then holding the socket`,
    )
    // The texts are in before the socket opens, so the first wake has the
    // freshest text; a failure is logged and the cached copy (if any) serves.
    await this.texts.start()
    // The block follows the texts in hand before the first wake can start a run.
    await this.follows
    if (this.stopping) return
    // The skill file follows the announced manual from now on; a download
    // never holds up the socket.
    void this.manual?.start()
    await this.loop.start()
    this.heartbeatTimer = setInterval(() => {
      if (this.socket === 'ready') beat(this.options.cfg.home)
    }, HEARTBEAT_MS)
    this.heartbeatTimer.unref()
    this.statusTimer = setInterval(() => this.writeStatus(), STATUS_MS)
    this.statusTimer.unref()
    this.writeStatus()
  }

  /**
   * Stop holding the socket and interrupt a run in flight (its signal aborts;
   * the runner SIGTERMs its process group). `idle()` / `stopAndWait()`
   * tell when the run has actually ended.
   */
  stop(): void {
    if (this.stopping) return
    this.stopping = true
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.statusTimer) clearInterval(this.statusTimer)
    // No re-check after a stop; one under way is stopped with the checks below (and says nothing).
    this.failingRecheck.stop()
    this.recheckAbort.abort()
    this.stopped = Promise.all([this.loop.stop(), this.recheckInFlight ?? Promise.resolve(), this.failingRecheck.done(), this.follows]).then(() => undefined)
    this.texts.stop()
    this.manual?.stop()
    this.socket = 'closed'
    idle(this.options.cfg.home)
    this.writeStatus()
  }

  /** `stop()`, then wait up to `graceMs` for the interrupted run to end. Resolves true when nothing runs any more. */
  async stopAndWait(graceMs: number): Promise<boolean> {
    this.stop()
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([
        (this.stopped ?? Promise.resolve()).then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), graceMs)
        }),
      ])
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  /** Resolves when no cycle (and so no run) is running: the kit's `ReceiveLoop.idle()`. */
  idle(): Promise<void> {
    return this.loop.idle()
  }

  /** A wake heard outside the socket (a test, a webhook the integration received). */
  wake(): void {
    this.loop.wake()
  }

  snapshot(): IntegrationStatus {
    const status = this.loop.status()
    const texts = this.texts.current()
    return {
      version: 2,
      updated_at: new Date().toISOString(),
      pid: process.pid,
      runtime: this.options.runner.name,
      runtime_label: this.options.runner.label ?? null,
      handle: this.options.cfg.handle,
      profile: this.options.profile,
      workdir: this.options.cfg.workdir,
      standby: null,
      runs_failing: this.runsFailing,
      unservable: null,
      ...(this.options.statusExtra?.() ?? {}),
      socket: this.stopping ? 'closed' : this.socket,
      wakes: status.coalescer.wakes,
      wakes_absorbed: status.coalescer.absorbed,
      invites: this.invites,
      runs_started: this.runsStarted,
      runs_ok: this.runsOk,
      runs_failed: this.runsFailed,
      runs_timed_out: this.runsTimedOut,
      runs_not_started: this.runsNotStarted,
      runs_skipped_empty: this.runsSkippedEmpty,
      last_run: this.lastRun,
      failed_runs_in_a_row: this.failingRuns,
      last_ok_run_at: this.lastOkRunAt,
      could_not_process: this.couldNotProcess(status),
      // No local retry ladder (the server re-wakes, D3); kept for older readers.
      retry_rung: 0,
      retry_due_at: null,
      last_error: this.lastError,
      texts: {
        source: this.texts.source,
        fetched_at: this.texts.fetchedAt,
        version: texts?.version ?? null,
        manual_version: texts?.manual.version ?? null,
      },
      identity_line: this.identityLine,
      listener_report: listenerReportStatusOf(this.options.listenerReport),
      capabilities: status.socket === null ? null : status.socket.capabilities,
      intake_paused: status.socket === null ? null : status.socket.intakePaused,
      recent_cycles: status.recentCycles.map((cycle) => ({
        at: cycle.at,
        outcome: cycle.outcome,
        cards: cycle.cards,
        invites: cycle.invites,
        failure: cycle.failure === null ? null : cycle.failure.slice(0, CYCLE_FAILURE_CHARS),
      })),
    }
  }

  // ─── a run ──────────────────────────────────────────────────────────────

  private async startRun(request: kit.RunRequest): Promise<kit.RunEnd> {
    // What the run is for, as the kit says: one conversation (conversation
    // runs), the pending invites, or the whole tray (texts from an older
    // server). A conversation run without its id is not one the kit makes;
    // it would run as a tray run.
    const conversationId = request.kind === 'conversation' && typeof request.conversationId === 'string' && request.conversationId.length > 0 ? request.conversationId : undefined
    const kind: RunKind = conversationId !== undefined ? 'conversation' : request.kind === 'invite' ? 'invite' : 'wake'
    // What woke it: the newest named wake since the previous run; a connect
    // (or a follow-on) names none, and the tray says what it found.
    const wake: RunWake = this.pendingWake ?? { reason: kind === 'invite' ? 'invite' : 'messages' }
    this.pendingWake = null
    const runId = crypto.randomUUID()
    const startedAt = Date.now()
    const budgetMs = this.options.budgetMs
    const slackMs = this.options.runnerDeadlineSlackMs ?? RUNNER_DEADLINE_SLACK_MS
    // Ids only, never content: the conversation a run is for, and the run's own.
    const subject = `kind=${kind}${conversationId !== undefined ? ` conv=${conversationId}` : ''} id=${runId}`
    this.runsStarted += 1
    this.writeStatus()
    log.info(
      `run start ${subject} budget=${Math.round(budgetMs / 1000)}s${
        kind === 'conversation' ? '' : ` (tray: ${request.cards ?? '?'} card(s), ${request.invites ?? '?'} invite(s))`
      }`,
    )

    // The run's own stop signal: the loop stopping, or the deadline below.
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    if (request.signal.aborted) controller.abort()
    else request.signal.addEventListener('abort', onAbort, { once: true })
    const texts = this.texts.current()
    const identityLine = texts?.identity_line
    // Where the manual is, as the texts in hand say (the constant only without any).
    // A pointer function that throws costs the line, never the run.
    let pointer = ''
    try {
      pointer = resolveManualPointer(this.options.manualPointer, texts)
    } catch (err) {
      log.warn(`run pointer: the integration's pointer function threw (${err instanceof Error ? err.message : String(err)}); the run starts without the line`)
    }
    let outcome: RunOutcome
    // A run under way says more than a re-check would: none starts its model
    // call meanwhile, and one under way stops for it.
    this.runsInFlight += 1
    this.failingRecheckCancel?.abort()
    try {
      outcome = await withDeadline(
        this.options.runner.start({
          kind,
          ...(conversationId !== undefined ? { conversationId } : {}),
          wake,
          // No pointer, no trailing blank lines.
          prompt: pointer.trim().length > 0 ? `${request.prompt}\n\n${pointer}` : request.prompt,
          runId,
          ...(identityLine !== undefined && identityLine.trim().length > 0 ? { identityLine } : {}),
          budgetMs,
          signal: controller.signal,
        }),
        budgetMs + slackMs,
        () => {
          controller.abort()
          return {
            state: 'timed_out',
            exitCode: null,
            durationMs: Date.now() - startedAt,
            detail: `the runner did not return within ${Math.round((budgetMs + slackMs) / 1000)} s (budget plus ${Math.round(slackMs / 1000)} s) — abandoned so the next wake can run`,
          }
        },
      )
    } catch (err) {
      // The runner contract is "never throws"; a throw is a bug in the runner.
      outcome = { state: 'not_started', exitCode: null, durationMs: Date.now() - startedAt, detail: `runner threw: ${err instanceof Error ? err.message : String(err)}` }
    } finally {
      this.runsInFlight -= 1
      request.signal.removeEventListener('abort', onAbort)
    }

    this.lastRun = {
      // Readers from before conversation runs know only `wake` and `invite`.
      kind: kind === 'invite' ? 'invite' : 'wake',
      run_kind: kind,
      conversation_id: conversationId ?? null,
      started_at: new Date(startedAt).toISOString(),
      ended_at: new Date().toISOString(),
      state: outcome.state,
      exit_code: outcome.exitCode,
      duration_ms: outcome.durationMs,
      detail: outcome.detail ?? null,
    }
    switch (outcome.state) {
      case 'ok':
        this.runsOk += 1
        this.lastOkRunAt = this.lastRun.ended_at
        log.info(`run ok ${subject} ${Math.round(outcome.durationMs / 1000)}s (output discarded; any send was the agent's own hosted-tool call)`)
        // A conversation that ran is not paused (any more).
        if (conversationId !== undefined) this.paused.clear(conversationId)
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
      log.warn(
        `run ${outcome.state} ${subject}${outcome.detail ? `: ${outcome.detail}` : ''} — ${
          kind !== 'conversation'
            ? 'the cards stay on the tray; the next wake (or the server\'s re-wake) finds them'
            : outcome.state === 'failed' && outcome.silent === true
              ? 'its card stays on the tray; a silent failure counts as a timeout: it is reported (could not process) only once another conversation\'s run completes, and the server decides what follows'
              : 'its card stays on the tray; if the runtime otherwise works, the failure is reported (could not process) and the server decides what follows'
        }`,
      )
    }
    this.noteRunHealth(outcome, this.lastRun.ended_at)
    this.writeStatus()
    if (outcome.state === 'ok') return { status: 'completed' }
    if (outcome.state === 'not_started') return { status: 'not_started', ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}) }
    // A run past its budget (killed, or abandoned by the deadline above) is a
    // timed-out failure: a could-not-process report then says `timed_out`.
    // So is a silent failure (`RunOutcome.silent`: it ran, then exited
    // non-zero with nothing on stdout): as ambiguous as a timeout — a crash
    // with no output says nothing about why, and the runtime check could
    // pass. The kit reports either only once another conversation's run
    // completed.
    const timedOut = outcome.state === 'timed_out' || (outcome.state === 'failed' && outcome.silent === true)
    return { status: 'failed', ...(timedOut ? { timedOut: true } : {}), ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}) }
  }

  /**
   * The runner's runtime check (a minimal model call, no peer content, no
   * AgentChat tools), bounded by `RUNTIME_CHECK_DEADLINE_MS` and stopped with
   * the integration; concurrent asks share one check. Its output is the
   * runner's to discard: only whether it answered, and a bounded diagnostic,
   * come back.
   */
  private checkRuntime(): Promise<RunPreflight> {
    // The kit's own ask comes first: a re-check's model call under way stops for it (never two at once).
    this.failingRecheckCancel?.abort()
    this.runtimeCheckInFlight ??= this.runRuntimeCheck().finally(() => {
      this.runtimeCheckInFlight = null
      // The kit counts the answer once it has it: the status file follows
      // right after (a check that fails reports nothing, so no event would).
      setTimeout(() => this.writeStatus(), 0).unref?.()
    })
    return this.runtimeCheckInFlight
  }

  /**
   * One runtime check, and what it means for the report. `cancel` (the
   * re-check while runs fail) cuts it short like a stop does: a check that
   * did not pass then says nothing.
   */
  private async runRuntimeCheck(cancel?: AbortSignal): Promise<RunPreflight> {
    const check = this.options.runner.checkRuntime
    if (check === undefined) return { ok: false, detail: 'this runtime has no runtime check' }
    if (this.stopping) return { ok: false, detail: 'the integration is stopping' }
    // A function, not a read: the signal can abort while the check is out.
    const cancelled = (): boolean => cancel?.aborted === true
    if (cancelled()) return { ok: false, detail: 'the runtime check was cut short' }
    const deadlineMs = this.options.runtimeCheckDeadlineMs ?? RUNTIME_CHECK_DEADLINE_MS
    const controller = new AbortController()
    const onStop = (): void => controller.abort()
    this.recheckAbort.signal.addEventListener('abort', onStop, { once: true })
    cancel?.addEventListener('abort', onStop, { once: true })
    const startedAt = Date.now()
    try {
      const answer = await withDeadline(check.call(this.options.runner, { signal: controller.signal }), deadlineMs, () => {
        controller.abort()
        return { ok: false, detail: `the runtime check did not answer within ${Math.round(deadlineMs / 1000)} s (stopped)` }
      }).catch((err: unknown) => ({ ok: false, detail: `the runtime check threw: ${err instanceof Error ? err.message : String(err)}` }))
      const took = `${Math.round((Date.now() - startedAt) / 1000)} s`
      // A check cut short (the stop; for a re-check, a run that started or a failure that ended) is not a failed check.
      const cut = this.stopping || (!answer.ok && cancelled())
      if (answer.ok) log.info(`runtime check ok (${this.options.runner.name}: the model answered, ${took}; output discarded)`)
      else if (!cut) {
        log.warn(
          `runtime check failed (${this.options.runner.name}, ${took}): ${answer.detail ?? 'no detail'} — ${cancel === undefined ? "a failed run is not reported as this conversation's" : 'the listener report stays runs_failing'}`,
        )
      }
      // The listener report only (a usage limit, a provider outage): runs
      // fail and the runtime's own check fails too. `health()` and the
      // hand-over to a standby do not change for it. A check cut short says
      // nothing.
      // A check that failed while another run completed is older news than
      // that run: the runtime worked after it started.
      const overtaken = !answer.ok && this.lastOkRunAt !== null && Date.parse(this.lastOkRunAt) >= startedAt
      if (!cut && !overtaken) {
        this.runtimeCheckFailing = !answer.ok
        this.reportListener()
      }
      return answer.ok ? { ok: true } : { ok: false, ...(answer.detail !== undefined ? { detail: answer.detail } : {}) }
    } finally {
      this.recheckAbort.signal.removeEventListener('abort', onStop)
      cancel?.removeEventListener('abort', onStop)
    }
  }

  /** The kit's could-not-process counts and the paused conversations, as the status file keeps them. */
  private couldNotProcess(status: ReturnType<kit.ReceiveLoop['status']>): IntegrationCouldNotProcess {
    // A kit from before could not process has no such block: zero, never a throw (the status write runs at start).
    const f = (status as { processingFailures?: ProcessingFailureCounts }).processingFailures ?? NO_PROCESSING_FAILURES
    return {
      runtime_check: this.options.runner.checkRuntime !== undefined,
      reported: f.reported,
      retry: f.retry,
      hidden: f.hidden,
      paused: f.paused,
      none: f.none,
      report_errors: f.reportErrors,
      reruns: f.reruns,
      reruns_capped: f.rerunsCapped,
      awaiting_evidence: f.awaitingEvidence,
      runtime_checks_ok: f.runtimeChecksOk,
      runtime_checks_failed: f.runtimeChecksFailed,
      last_runtime_check: f.lastRuntimeCheck === null ? null : { at: f.lastRuntimeCheck.at, ok: f.lastRuntimeCheck.ok, detail: f.lastRuntimeCheck.detail?.slice(0, CYCLE_FAILURE_CHARS) ?? null },
      paused_conversations: this.paused.list(),
    }
  }

  /**
   * A run that did not get done may be the runtime itself (signed out, the
   * binary gone, a flag an upgrade dropped): checked again, at most once per
   * `RUNTIME_RECHECK_MS`, and said in status until a run succeeds. Wakes keep
   * starting runs meanwhile — each is the quickest way back — and are counted.
   */
  private noteRunHealth(outcome: RunOutcome, endedAt: string): void {
    if (outcome.state === 'ok') {
      if (this.runsFailing !== null) log.info(`runs work again (${this.failingRuns} run(s) missed since ${this.failingSince})`)
      this.failingSince = null
      this.failingRuns = 0
      this.runsFailing = null
      // A new failure after a good run is a new problem: checked at once, not after the old window.
      this.lastRecheckAt = 0
      // A run that completed is the best evidence the runtime works.
      this.recheckFailing = null
      this.runtimeCheckFailing = false
      this.reportListener()
      return
    }
    this.failingSince ??= endedAt
    this.failingRuns += 1
    if (this.runsFailing !== null) this.runsFailing = { ...this.runsFailing, runs_missed: this.failingRuns }
    const recheckMs = this.options.runtimeRecheckMs ?? RUNTIME_RECHECK_MS
    if (this.recheckInFlight === null && !this.stopping && (this.lastRecheckAt === 0 || Date.now() - this.lastRecheckAt >= recheckMs)) {
      this.recheckInFlight = this.recheckRuntime().finally(() => {
        this.recheckInFlight = null
      })
    }
  }

  /** The runner's start preflight (a `--version`, a sign-in probe; no model call), bounded, and stopped with the integration. */
  private preflightNow(): Promise<RunPreflight> {
    return withDeadline(this.options.runner.preflight({ signal: this.recheckAbort.signal }), PREFLIGHT_DEADLINE_MS, () => ({
      ok: false,
      detail: `preflight did not answer within ${Math.round(PREFLIGHT_DEADLINE_MS / 1000)} s`,
    })).catch((err: unknown) => ({ ok: false, detail: `preflight threw: ${err instanceof Error ? err.message : String(err)}` }))
  }

  private async recheckRuntime(): Promise<void> {
    this.lastRecheckAt = Date.now()
    const pre = await this.preflightNow()
    // A run succeeded while it was being checked: nothing to say.
    if (this.failingSince === null || this.stopping) return
    const checkedAt = new Date().toISOString()
    if (!pre.ok) {
      const reason = `${this.options.runner.name}: ${pre.detail ?? 'its check failed'}`
      if (this.runsFailing?.reason !== reason) log.warn(`runs failing — ${reason} (since ${this.failingSince}, ${this.failingRuns} run(s) missed); status says so until a run succeeds`)
      this.runsFailing = { reason, since: this.failingSince, runs_missed: this.failingRuns, checked_at: checkedAt }
      // The reason from the check's own words (signed out, missing, too old), not the line above.
      this.recheckFailing = listenerReasonKindOf(pre.detail ?? '')
    } else {
      if (this.runsFailing !== null) {
        // The runtime checks out again, but no run has succeeded yet.
        this.runsFailing = {
          ...this.runsFailing,
          reason: `${this.options.runner.name} checks out now, but runs still fail${this.lastRun?.detail ? ` (last: ${this.lastRun.detail})` : ''}`,
          checked_at: checkedAt,
        }
      }
      // Its own check passes: the report says `runs_failing` only while one fails.
      this.recheckFailing = null
    }
    this.reportListener()
    this.writeStatus()
  }

  /** Why the report says `runs_failing` now, or null when it does not. */
  private failingReason(): ListenerReasonKind | null {
    return this.recheckFailing ?? (this.runtimeCheckFailing ? 'runtime_check_failed' : null)
  }

  /**
   * What the listener report says now, from what this integration knows:
   * `runs_failing` while the recheck after a failed run fails (its reason)
   * or the runtime check after one fails (`runtime_check_failed`), else
   * `ok` once connected; before the first hello nothing new is said. Nothing
   * once stopping: a stop is the supervisor's to report, or not.
   *
   * `runs_failing` starts the re-check on a growing gap (a new episode: from
   * 30 minutes; one under way keeps its place when only the reason changes),
   * unless the supervisor has stopped the reporter (this home no longer
   * holds the agent). Anything else ends it, and stops a re-check's model
   * call under way.
   */
  private reportListener(): void {
    const sink = this.options.listenerReport
    if (sink === undefined || this.stopping) return
    const failing = this.failingReason()
    if (failing !== null) tellListener(sink, 'runs_failing', failing)
    else if (this.connected) tellListener(sink, 'ok')
    if (failing === null) {
      this.failingRecheckCancel?.abort()
      this.failingRecheck.stop()
    } else if (!sink.status().stopped && this.failingRecheck.start()) {
      log.info(`listener report: runs_failing (${failing}) is checked again in ${describeGap(this.failingRecheck.nextInMs)}, then on a growing gap (to every ${describeGap(this.failingRecheckGapsMs().at(-1) ?? null)}) while it lasts`)
    }
  }

  private failingRecheckGapsMs(): readonly number[] {
    return this.options.runsFailingRecheckMs ?? RUNS_FAILING_RECHECK_MS
  }

  /**
   * A run, a check, or the kit's work around a run is under way: it says
   * sooner than a re-check would. The kit holds a run's slot past the run
   * itself (after a failed one it reads the tray, then asks its own check),
   * a turn may wait for its slot, and a wake waiting out its quiet window
   * starts a cycle within seconds.
   */
  private busyForRecheck(): boolean {
    if (this.runsInFlight > 0 || this.recheckInFlight !== null || this.runtimeCheckInFlight !== null) return true
    const loop = this.loop.status()
    return loop.coalescer.state !== 'idle' || loop.counters.turnsActive > 0 || loop.counters.turnsWaiting > 0
  }

  /**
   * One re-check while the report says `runs_failing` (the clock is
   * `RecheckSchedule`'s): a failure that ended on its own must not read as
   * failing until someone writes. First the start preflight, the one the
   * recheck after a failed run uses (no model call). Failing: `runs_failing`
   * stays, with the reason it gives now. Passing, what a preflight said is
   * over; when the runtime check is what failed, that check is asked once
   * (one minimal model call on the person's own account). Passing: `ok`, and
   * the schedule ends.
   *
   * Never while a run, another check or a wake cycle is under way: that one
   * says sooner, so this due time is skipped and the next one kept. A run
   * that starts during the re-check makes its answer stale (the run, and
   * the recheck after it, are newer): a preflight answer is then dropped,
   * and the model call is stopped, as it is by the kit's own check and by a
   * failure that ended otherwise; a check cut short says nothing. Only while
   * this integration reports: not once stopping, and not once the supervisor
   * stopped the reporter (lost lock, hand-over, standby, SIGTERM), so no
   * model call starts after any of those (one already out at SIGTERM is
   * stopped with the integration, a tick later).
   *
   * The report's, not the hand-over's: `health()` does not change for it
   * (the status line's reason follows it only while runs already fail).
   */
  private async recheckWhileFailing(episode: number): Promise<void> {
    const sink = this.options.listenerReport
    const reason = this.failingReason()
    if (this.stopping || sink === undefined || sink.status().stopped || reason === null) {
      this.failingRecheck.stop()
      return
    }
    const name = this.options.runner.name
    const next = (): string => `next in ${describeGap(this.failingRecheck.upcomingGapMs())}`
    if (this.busyForRecheck()) {
      log.info(`listener report: runs_failing (${reason}) not checked again now — a run or a check is under way and says sooner; ${next()}`)
      return
    }
    const runsBefore = this.runsStarted
    // Whether this re-check's answer still counts.
    const counts = (): boolean => !this.stopping && this.failingRecheck.current(episode) && !sink.status().stopped && this.runsStarted === runsBefore
    const pre = await this.preflightNow()
    if (!counts()) {
      if (!this.stopping && !sink.status().stopped && this.runsStarted !== runsBefore) log.info(`listener report: a run started while runs_failing was checked again; that run says instead; ${next()}`)
      return
    }
    const checkedAt = new Date().toISOString()
    if (!pre.ok) {
      const kind = listenerReasonKindOf(pre.detail ?? '')
      log.info(`listener report: runs_failing checked again — ${name}: ${pre.detail ?? 'its check failed'}; it stays (${kind}); ${next()}`)
      this.recheckFailing = kind
      if (this.runsFailing !== null) this.runsFailing = { ...this.runsFailing, reason: `${name}: ${pre.detail ?? 'its check failed'}`, checked_at: checkedAt }
      this.reportListener()
      this.writeStatus()
      return
    }
    // What a preflight said is over (the recheck after a failed run does the same).
    this.recheckFailing = null
    if (this.runsFailing !== null) {
      this.runsFailing = { ...this.runsFailing, reason: `${name} checks out now, but runs still fail${this.lastRun?.detail ? ` (last: ${this.lastRun.detail})` : ''}`, checked_at: checkedAt }
    }
    if (this.runtimeCheckFailing) {
      if (this.busyForRecheck()) {
        log.info(`listener report: runs_failing (runtime_check_failed): ${name} checks out, the runtime check is not asked now — a run or a check is under way and says sooner; ${next()}`)
      } else {
        const cancel = new AbortController()
        this.failingRecheckCancel = cancel
        try {
          // Passing clears it (`ok`, the schedule ends); failing keeps it; cut short, it says nothing.
          await this.runRuntimeCheck(cancel.signal)
        } finally {
          if (this.failingRecheckCancel === cancel) this.failingRecheckCancel = null
        }
        if (this.stopping) return
        if (cancel.signal.aborted && this.runtimeCheckFailing) log.info(`listener report: the runtime check was cut short (a run, or the kit's own check, started); runs_failing stays until that one says otherwise; ${next()}`)
        else if (this.runtimeCheckFailing) log.info(`listener report: runs_failing (runtime_check_failed) stays; ${next()}`)
      }
    } else {
      log.info(`listener report: runs_failing checked again — ${name} checks out`)
    }
    this.reportListener()
    this.writeStatus()
  }

  /**
   * Whether this integration can serve its agent: not while the server refuses
   * its key (socket `blocked`: rotated by `recover` elsewhere, revoked), nor
   * while runs fail for a runtime reason (`runs_failing`). The supervisor then
   * gives the agent up so a healthy listener for it can serve.
   */
  health(): { ok: true } | { ok: false; reason: string; runsFailing: IntegrationRunsFailing | null } {
    if (this.socket === 'blocked') return { ok: false, reason: `the server refuses this home's key${this.lastError ? ` (${this.lastError})` : ''}`, runsFailing: null }
    if (this.runsFailing !== null) return { ok: false, reason: `runs failing: ${this.runsFailing.reason}`, runsFailing: this.runsFailing }
    return { ok: true }
  }

  /** Test seam: resolves when a runtime check started by a failed run has finished. */
  async runtimeCheckDone(): Promise<void> {
    await this.recheckInFlight
  }

  /** Test seam: resolves when no re-check while runs fail is under way. */
  async runsFailingRecheckDone(): Promise<void> {
    await this.failingRecheck.done()
  }

  private onEvent(event: kit.ReceiveLoopEvent): void {
    switch (event.type) {
      case 'wake': {
        if (event.source === 'invite') this.invites += 1
        const reason = reasonOf(event.source, event.reason)
        if (reason !== null) {
          this.pendingWake = reason === 'unanswered' && this.lastUnansweredStep !== null ? { reason, step: this.lastUnansweredStep } : { reason }
        }
        log.info(`wake — ${event.source}${event.reason ? ` (${event.reason})` : ''}${event.conversationId ? ` conv=${event.conversationId}` : ''}`)
        break
      }
      case 'echo':
        log.debug(`own echo${event.conversationId ? ` in ${event.conversationId}` : ''} — not a wake`)
        break
      case 'cycle': {
        const { outcome, cards, invites, heldByTurns, paced } = event.summary
        if (outcome === 'nothing_owed' && (heldByTurns > 0 || paced > 0)) {
          // Conversation runs: everything owed is running, waiting for its
          // turn, or paced after a run that just looked. Not an empty tray.
          log.info(
            `wake: nothing new to start — ${heldByTurns} conversation(s) already running or waiting${paced > 0 ? `, ${paced} paced after a recent run` : ''} (${cards} card(s), ${invites} invite(s))`,
          )
        } else if (outcome === 'empty' || outcome === 'nothing_owed') {
          this.runsSkippedEmpty += 1
          log.info(`wake: ${outcome === 'empty' ? 'the tray is empty' : 'nothing owed (muted or notices-only cards)'} — no run (${cards} card(s), ${invites} invite(s))`)
        } else if (outcome === 'abandoned') {
          log.warn(`wake cycle abandoned by the watchdog: ${event.summary.failure ?? 'it ran past its deadline'} — the next wake starts a new one`)
        } else if (outcome === 'texts_missing') {
          this.runsNotStarted += 1
          log.warn('no served texts in hand: GET /v1/texts has not answered yet and nothing is cached in the identity home — no run this time')
        } else if (outcome === 'runs_started') {
          const { turnsStarted, turnsQueued } = event.summary
          log.info(
            `wake: ${turnsStarted + turnsQueued} run(s) for ${cards} card(s), ${invites} invite(s) — ${turnsStarted} started, ${turnsQueued} queued (one at a time)${
              heldByTurns > 0 ? `; ${heldByTurns} conversation(s) already running or waiting` : ''
            }${paced > 0 ? `; ${paced} paced` : ''}`,
          )
        }
        this.writeStatus()
        break
      }
      case 'processing_failure':
        this.onProcessingFailure(event)
        break
      case 'error':
        if (!this.stopping) log.warn(`receive loop: ${event.error.message}`)
        break
      default:
        break
    }
  }

  /**
   * One could-not-process report and the server's answer: said in the log
   * (ids and counts only), and a `paused` answer kept for `status` until the
   * pause ends; any other answer for that conversation ends what was kept.
   */
  private onProcessingFailure(event: Extract<kit.ReceiveLoopEvent, { type: 'processing_failure' }>): void {
    const what = `conv=${event.conversationId} (${event.source} ${event.outcome}, evidence ${event.evidence === 'runtime_check' ? 'runtime check passed' : 'another run completed'})`
    const result = event.result
    if (result === null) {
      log.warn(`could not process: ${what} — the report failed (${event.error ?? 'no detail'}); nothing more is done for it now: its card stays on the tray and the server re-wakes it`)
    } else {
      // `hidden_message_ids` names at most the newest 200; `hidden_count` counts
      // them all (absent from a server that predates it: the list then is all).
      const hidden = result.hidden_count ?? result.hidden_message_ids.length
      const answered =
        result.action === 'retry'
          ? 'retry (the first failure for these messages)'
          : result.action === 'hidden'
            ? `hidden (${hidden} message(s) are now a note for this agent, still unread)`
            : result.action === 'paused'
              ? `paused until ${result.paused_until ?? '?'}${hidden > 0 ? ` (${hidden} more message(s) hidden)` : ''} — no run starts there until then`
              : 'none (nothing left to act on)'
      const next =
        event.next === 'rerun'
          ? 'it runs again after the others'
          : event.next === 'running'
            ? 'its next run is under way already'
            : event.next === 'rerun_capped'
              ? 'not run again in this cycle (3 re-runs already); the server re-wakes it'
              : 'nothing more for it'
      ;(result.action === 'paused' ? log.warn : log.info)(`could not process: ${what} → server: ${answered}; ${next}`)
      if (result.action === 'paused' && result.paused_until !== null) this.paused.record(event.conversationId, result.paused_until)
      else this.paused.clear(event.conversationId)
    }
    this.writeStatus()
  }

  /**
   * The identity block follows the served identity line: on each texts
   * change, this agent's own block in the host's instruction file is brought
   * to the line served now (`followIdentityAnchor`, under its rules). Said in
   * the log and the status file (`identity_line`); never throws.
   */
  private async followIdentityLine(texts: Texts): Promise<void> {
    const filePath = this.options.anchorPath
    if (filePath === undefined || this.stopping) return
    let result: Awaited<ReturnType<typeof followIdentityAnchor>>
    try {
      result = await followIdentityAnchor({
        filePath,
        handle: this.options.cfg.handle,
        identityLine: texts.identity_line,
        template: texts.identity_line_template,
      })
    } catch (err) {
      // The kit's follow never throws; a chain that broke here would stop every later follow.
      result = { outcome: 'failed', path: filePath, claimed: null, detail: `could not follow the identity line in ${filePath}: ${err instanceof Error ? err.message : String(err)}` }
    }
    let loadNote: AnchorLoadNote | null = null
    try {
      loadNote = this.options.anchorLoadNote?.(this.options.cfg.handle, { identityLine: texts.identity_line, template: texts.identity_line_template }) ?? null
    } catch {
      loadNote = null
    }
    const notLoaded = loadNote !== null && !loadNote.ok ? loadNote.note : null
    const detail = loadNote === null ? result.detail : `${result.detail}; ${loadNote.note}`
    this.identityLine = { outcome: result.outcome, path: result.path, at: new Date().toISOString(), texts_version: texts.version, detail, not_loaded: notLoaded }
    const line = `identity line: ${result.outcome} — ${detail}`
    this.writeStatus()
    // The runtime does not read the file: whatever happened to the block, the agent does not see it.
    if (notLoaded !== null && result.outcome !== 'other_agent') {
      log.warn(line)
      return
    }
    switch (result.outcome) {
      case 'updated':
      case 'absent':
      case 'hand_edited':
        log.info(line)
        break
      case 'unchanged':
        log.debug(line)
        break
      case 'other_agent':
        // The file says this agent is someone else: peers would be handed an address that reaches another agent.
        log.error(line)
        break
      default:
        log.warn(line)
    }
  }

  private writeStatus(): void {
    writeIntegrationStatus(this.options.cfg.home, this.snapshot())
  }
}
