import { log } from '../util/log.js'
import type { DaemonConfig } from '../daemon/config.js'
import { beat, idle } from '../daemon/health.js'
import { listGroupInvites, trayHasWaiting, type WireConfig } from '../wire/index.js'
import { DoorbellInvoker } from './invoker.js'
import type { DoorbellPrompts } from './prompt.js'
import type { RunProfile } from './profile.js'
import type { RunRunner } from './runner.js'
import { DoorbellSocket, type TerminalReason } from './socket.js'
import { writeDoorbellStatus, type DoorbellStatus, type SocketState } from './status.js'

// ─── The doorbell: a socket, a coalescer, a runner ──────────────────────────
//
// Everything it knows about the agent arrives in `DaemonConfig`; everything it
// knows about the coding agent arrives as a `RunRunner`. It cannot name a
// host, so it cannot act on the wrong one.
//
// A KNOCK IS NOT A RUN. Every knock — a `message.new` frame, the connect-time
// catch-up, a ladder re-knock — goes through the invoker, which reads one
// COUNT before it starts a run (`trayHasWaiting`: `GET /v1/inbox?wait_ms=0&
// limit=1`, never a card, never a body, marks nothing delivered) and starts
// none when the tray is empty. That single guard is what makes reconnects
// cheap: sleep/wake, Wi-Fi roaming and every server deploy reconnect the whole
// fleet, and the server's connect-time drain re-offers every stored envelope
// as a plain `message.new` — including ones the agent deferred, which `defer`
// leaves stored and the tray hides. Without the count each reconnect cost a
// paid run that found nothing (live-fire leg 7, both integrations).
//
// On `hello.ok` the doorbell therefore simply knocks once (catching a backlog
// no frame announced; it coalesces with the drain frames) and reads the
// pending group invites (`GET /v1/groups/invites`): the server pushes an
// invite live only and never re-offers it, so an invite that arrived while the
// laptop was closed is surfaced here. Deduplicated by id downstream. A failed
// invite read is logged, never fatal.

const HEARTBEAT_MS = 30_000
const STATUS_MS = 30_000

export interface DoorbellOptions {
  readonly cfg: DaemonConfig
  readonly runner: RunRunner
  readonly prompts: DoorbellPrompts
  readonly profile: RunProfile
  readonly budgetMs: number
  /** Injectable for tests; defaults to a real socket. */
  readonly socket?: DoorbellSocket
  /**
   * Called when the socket gives up for good. `auth`: the credential was
   * refused — sit out until it changes. `cap`: the reconnect cap was reached —
   * open a fresh socket after a backoff. The supervisor above decides; this
   * class does not end the process.
   */
  readonly onTerminal?: (reason: TerminalReason, detail: string) => void
}

export class Doorbell {
  private readonly socket: DoorbellSocket
  private readonly invoker: DoorbellInvoker
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private statusTimer: ReturnType<typeof setInterval> | null = null
  private lastError: string | null = null
  private stopping = false

  constructor(private readonly options: DoorbellOptions) {
    const { cfg } = options
    const wire: WireConfig = { apiKey: cfg.apiKey, apiBase: cfg.apiBase }
    this.invoker = new DoorbellInvoker({
      runner: options.runner,
      prompts: options.prompts,
      budgetMs: options.budgetMs,
      onChange: () => this.writeStatus(),
      trayHasWaiting: () => trayHasWaiting(wire),
    })
    this.socket =
      options.socket ?? new DoorbellSocket({ url: cfg.wsUrl, apiKey: cfg.apiKey, selfHandle: cfg.handle })
    this.socket.on('knock', (knock) => this.invoker.knock(knock.source))
    this.socket.on('invite', (invite) => {
      this.invoker.invite(invite)
    })
    this.socket.on('ready', () => {
      void this.catchUp()
    })
    this.socket.on('state', (state) => {
      if (state === 'ready') beat(cfg.home)
      else idle(cfg.home)
      this.writeStatus()
    })
    this.socket.on('ack', () => this.writeStatus())
    this.socket.on('terminal', (reason, detail) => {
      // Do NOT end the process: this daemon is resident. A refused key is a
      // state to sit out, not to die from — the user may sign in again with a
      // good one — and an unreachable control plane deserves a fresh socket
      // later, not a dead daemon.
      this.lastError = detail
      log.error(`doorbell terminal (${reason}): ${detail}`)
      this.stop()
      options.onTerminal?.(reason, detail)
    })
  }

  async start(): Promise<void> {
    const pre = await this.options.runner.preflight()
    if (!pre.ok) {
      throw new Error(`runtime (${this.options.runner.name}) not ready: ${pre.detail ?? 'unknown'}`)
    }
    log.info(
      `doorbell up as @${this.options.cfg.handle} via ${this.options.runner.name}, profile ${this.options.profile}; holding the socket`,
    )
    this.socket.start()
    this.heartbeatTimer = setInterval(() => {
      if (this.socket.connected) beat(this.options.cfg.home)
    }, HEARTBEAT_MS)
    this.heartbeatTimer.unref()
    this.statusTimer = setInterval(() => this.writeStatus(), STATUS_MS)
    this.statusTimer.unref()
    this.writeStatus()
  }

  /**
   * Stop holding the socket and interrupt a run in flight (its process group
   * is SIGTERMed by the runner). Synchronous; `settled()` or `stopAndWait()`
   * tell when the run has actually ended.
   */
  stop(): void {
    if (this.stopping) return
    this.stopping = true
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.statusTimer) clearInterval(this.statusTimer)
    this.invoker.stop()
    this.socket.stop()
    idle(this.options.cfg.home)
    this.writeStatus()
  }

  /**
   * `stop()`, then wait up to `graceMs` for the interrupted run to end. What a
   * shutdown awaits before the process exits, so a launchd/systemd stop
   * reaches the child and the restarted daemon does not find a run still
   * going. Resolves true when nothing is running any more.
   */
  async stopAndWait(graceMs: number): Promise<boolean> {
    this.stop()
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([
        this.invoker.settled().then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), graceMs)
        }),
      ])
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  /** A run in flight finishes on its own; this resolves when it has. */
  settled(): Promise<void> {
    return this.invoker.settled()
  }

  snapshot(): DoorbellStatus {
    const c = this.invoker.counters()
    // A socket that gave up (refused key, reconnect cap) stays `terminal` even
    // though giving up also stops the doorbell: `closed` would read as a
    // clean shutdown and hide the refusal from `status` and `doctor`.
    const socket: SocketState =
      this.socket.state === 'terminal' ? 'terminal' : this.stopping ? 'closed' : this.socket.state
    return {
      version: 1,
      updated_at: new Date().toISOString(),
      pid: process.pid,
      runtime: this.options.runner.name,
      handle: this.options.cfg.handle,
      profile: this.options.profile,
      socket,
      ack_negotiated: this.socket.ackNegotiated,
      knocks: c.knocks,
      knocks_absorbed: c.absorbed,
      invites: c.invites,
      runs_started: c.runsStarted,
      runs_ok: c.runsOk,
      runs_failed: c.runsFailed,
      runs_timed_out: c.runsTimedOut,
      runs_not_started: c.runsNotStarted,
      runs_skipped_empty: c.runsSkippedEmpty,
      last_run: c.lastRun,
      retry_rung: c.retryRung,
      retry_due_at: c.retryDueAt === null ? null : new Date(c.retryDueAt).toISOString(),
      last_error: this.lastError,
    }
  }

  /**
   * The connect-time catch-up: one knock (the invoker counts the tray before
   * any run, so an empty tray costs a count, not a run) and the pending invites.
   */
  private async catchUp(): Promise<void> {
    const { cfg } = this.options
    const wire: WireConfig = { apiKey: cfg.apiKey, apiBase: cfg.apiBase }
    if (this.stopping) return
    log.info('knock — connect (a run starts only if the tray has something waiting)')
    this.invoker.knock('connect')
    try {
      const invites = await listGroupInvites(wire)
      if (this.stopping) return
      let surfaced = 0
      for (const invite of invites) if (this.invoker.invite(invite)) surfaced += 1
      if (surfaced > 0) log.info(`knock — ${surfaced} pending group invite(s) surfaced on connect`)
    } catch (err) {
      log.warn(`connect-time invite list failed (${err instanceof Error ? err.message : String(err)}) — live invite frames are unaffected`)
    }
    this.writeStatus()
  }

  private writeStatus(): void {
    writeDoorbellStatus(this.options.cfg.home, this.snapshot())
  }
}
