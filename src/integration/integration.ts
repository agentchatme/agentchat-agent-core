import * as crypto from 'node:crypto'
import { AgentChatClient, RealtimeClient, integration as kit } from 'agentchatme'
import { log } from '../util/log.js'
import type { DaemonConfig } from '../daemon/config.js'
import { beat, idle } from '../daemon/health.js'
import { clientIdentityOf, type IntegrationClient } from '../client-identity.js'
import type { RunProfile } from './profile.js'
import type { RunKind, RunOutcome, RunRunner, RunWake } from './runner.js'
import { writeIntegrationStatus, type IntegrationLastRun, type IntegrationRunsFailing, type IntegrationStatus, type SocketState } from './status.js'
import { blockedDetail, socketStateOf } from './socket-state.js'
import { textsCachePath } from './texts.js'
import { MANUAL } from '../skill/manual.js'
import { describeManualSync, type ManualFetch } from '../skill/served-manual.js'

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
//   * the cycle in SINGLE-RUN mode (`ReceiveLoop`): read the tray; nothing
//     owed (no cards, only muted ones, no pending invite) starts nothing; a
//     tray that cannot be read is not an empty tray, and the run starts
//     anyway; otherwise ONE run with the served wake instruction (and the
//     invite prompt when invites wait). The run reads the tray and records its
//     own verdicts; nothing is recorded on its behalf;
//   * the served texts (`TextsCache`, the last good copy kept in the identity
//     home) and the manual they announce (`ManualSync`).
//
// There is no retry ladder here, and no invite ledger: the server re-wakes
// unanswered cards on its own durable ladder and shows pending invites on the
// tray (contract v1, D3/D4), so a run that could not finish leaves the cards
// where they are and the next wake finds them.
//
// What stays here is this package's own: the runner seam (how a runtime's run
// is started is the integration's — `RunRunner`), the one pointer line a run
// prompt ends with, a deadline on every run (a runner that never returns must
// not hold the loop), and the status file `status` and `doctor` read.

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

export interface IntegrationOptions {
  readonly cfg: DaemonConfig
  readonly runner: RunRunner
  /** How this integration names itself to the server (texts runtime + its version). */
  readonly client: IntegrationClient
  /** The one pointer line a run prompt ends with (`manualPointer(...)`). */
  readonly manualPointer: string
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
}

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

/** `work`, or `onTimeout()` once `ms` have passed — whichever first. A late result is dropped. */
function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
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
  /** The newest wake since the last run started (for `RunRequest.wake`). */
  private pendingWake: RunWake | null = null
  /** The rung of the newest `unanswered` wake frame (the kit's wake event does not carry it). */
  private lastUnansweredStep: number | null = null

  constructor(private readonly options: IntegrationOptions) {
    const { cfg, client } = options
    const identity = clientIdentityOf(client)
    this.api =
      options.api ??
      new AgentChatClient({ apiKey: cfg.apiKey, baseUrl: cfg.apiBase, clientIdentity: identity, timeoutMs: HTTP_TIMEOUT_MS, retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } })
    this.texts = new kit.TextsCache({
      client: this.api,
      runtime: client.runtime,
      filePath: textsCachePath(cfg.home),
      onError: (err) => log.warn(err.message),
    })
    this.texts.onChange((texts, source) => {
      log.info(`texts ${source === 'server' ? 'fetched' : 'read from the cache'} for ${client.runtime} (texts v${texts.version}, manual ${texts.manual.version})`)
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
    if (!pre.ok) throw new Error(`runtime (${this.options.runner.name}) not ready: ${pre.detail ?? 'unknown'}`)
    log.info(
      `integration up as @${this.options.cfg.handle} via ${this.options.runner.name} (${this.options.client.runtime} ${this.options.client.version}), profile ${this.options.profile}; fetching the served texts, then holding the socket`,
    )
    // The texts are in before the socket opens, so the first wake has the
    // freshest text; a failure is logged and the cached copy (if any) serves.
    await this.texts.start()
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
    this.recheckAbort.abort()
    this.stopped = Promise.all([this.loop.stop(), this.recheckInFlight ?? Promise.resolve()]).then(() => undefined)
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
      handle: this.options.cfg.handle,
      profile: this.options.profile,
      workdir: this.options.cfg.workdir,
      standby: null,
      runs_failing: this.runsFailing,
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

  // ─── the one run ────────────────────────────────────────────────────────

  private async startRun(request: kit.RunRequest): Promise<kit.RunEnd> {
    // Invites alone: the served invite prompt. Anything else: a wake run.
    const kind: RunKind = request.cards === 0 && (request.invites ?? 0) > 0 ? 'invite' : 'wake'
    // What woke it: the newest named wake since the previous run; a connect
    // (or a follow-on) names none, and the tray says what it found.
    const wake: RunWake = this.pendingWake ?? { reason: kind === 'invite' ? 'invite' : 'messages' }
    this.pendingWake = null
    const runId = crypto.randomUUID()
    const startedAt = Date.now()
    const budgetMs = this.options.budgetMs
    const slackMs = this.options.runnerDeadlineSlackMs ?? RUNNER_DEADLINE_SLACK_MS
    this.runsStarted += 1
    this.writeStatus()
    log.info(`run start kind=${kind} id=${runId} budget=${Math.round(budgetMs / 1000)}s (tray: ${request.cards ?? '?'} card(s), ${request.invites ?? '?'} invite(s))`)

    // The run's own stop signal: the loop stopping, or the deadline below.
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    if (request.signal.aborted) controller.abort()
    else request.signal.addEventListener('abort', onAbort, { once: true })
    const identityLine = this.texts.current()?.identity_line
    let outcome: RunOutcome
    try {
      outcome = await withDeadline(
        this.options.runner.start({
          kind,
          wake,
          prompt: `${request.prompt}\n\n${this.options.manualPointer}`,
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
      request.signal.removeEventListener('abort', onAbort)
    }

    this.lastRun = {
      kind,
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
      log.warn(`run ${outcome.state} kind=${kind} id=${runId}${outcome.detail ? `: ${outcome.detail}` : ''} — the cards stay on the tray; the next wake (or the server's re-wake) finds them`)
    }
    this.noteRunHealth(outcome, this.lastRun.ended_at)
    this.writeStatus()
    return outcome.state === 'ok'
      ? { status: 'completed' }
      : { status: outcome.state === 'not_started' ? 'not_started' : 'failed', ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}) }
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

  private async recheckRuntime(): Promise<void> {
    this.lastRecheckAt = Date.now()
    const pre = await withDeadline(this.options.runner.preflight({ signal: this.recheckAbort.signal }), PREFLIGHT_DEADLINE_MS, () => ({
      ok: false,
      detail: `preflight did not answer within ${Math.round(PREFLIGHT_DEADLINE_MS / 1000)} s`,
    })).catch((err: unknown) => ({ ok: false, detail: `preflight threw: ${err instanceof Error ? err.message : String(err)}` }))
    // A run succeeded while it was being checked: nothing to say.
    if (this.failingSince === null || this.stopping) return
    const checkedAt = new Date().toISOString()
    if (!pre.ok) {
      const reason = `${this.options.runner.name}: ${pre.detail ?? 'its check failed'}`
      if (this.runsFailing?.reason !== reason) log.warn(`runs failing — ${reason} (since ${this.failingSince}, ${this.failingRuns} run(s) missed); status says so until a run succeeds`)
      this.runsFailing = { reason, since: this.failingSince, runs_missed: this.failingRuns, checked_at: checkedAt }
    } else if (this.runsFailing !== null) {
      // The runtime checks out again, but no run has succeeded yet.
      this.runsFailing = {
        ...this.runsFailing,
        reason: `${this.options.runner.name} checks out now, but runs still fail${this.lastRun?.detail ? ` (last: ${this.lastRun.detail})` : ''}`,
        checked_at: checkedAt,
      }
    }
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
  async runtimeCheckSettled(): Promise<void> {
    await this.recheckInFlight
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
        const { outcome, cards, invites } = event.summary
        if (outcome === 'empty' || outcome === 'nothing_owed') {
          this.runsSkippedEmpty += 1
          log.info(`wake: ${outcome === 'empty' ? 'the tray is empty' : 'nothing owed (muted cards only)'} — no run (${cards} card(s), ${invites} invite(s))`)
        } else if (outcome === 'abandoned') {
          log.warn(`wake cycle abandoned by the watchdog: ${event.summary.failure ?? 'it ran past its deadline'} — the next wake starts a new one`)
        } else if (outcome === 'texts_missing') {
          this.runsNotStarted += 1
          log.warn('no served texts in hand: GET /v1/texts has not answered yet and nothing is cached in the identity home — no run this time')
        }
        this.writeStatus()
        break
      }
      case 'error':
        if (!this.stopping) log.warn(`receive loop: ${event.error.message}`)
        break
      default:
        break
    }
  }

  private writeStatus(): void {
    writeIntegrationStatus(this.options.cfg.home, this.snapshot())
  }
}
