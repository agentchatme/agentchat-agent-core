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
// CONNECT IS NOT A KNOCK. Sleep/wake, Wi-Fi roaming and every server deploy
// reconnect the whole fleet, and a paid headless run per reconnect regardless
// of the tray was the cost of treating it as one. Instead, on `hello.ok` the
// doorbell reads two COUNTS — never a card, never a body — and knocks only
// when something is waiting:
//   * the tray (`GET /v1/inbox?wait_ms=0&limit=1`): non-empty → one knock.
//     The server re-offers stored envelopes as `message.new` frames right
//     after `hello.ok`, so those frames usually knock first and this count
//     coalesces with them; it is what catches a backlog no frame announced.
//   * pending group invites (`GET /v1/groups/invites`): the server pushes an
//     invite live only and never re-offers it, so an invite that arrived while
//     the laptop was closed is surfaced here. Deduplicated by id downstream.
// Either read failing degrades to "frames only" and is logged, never fatal.

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
    this.invoker = new DoorbellInvoker({
      runner: options.runner,
      prompts: options.prompts,
      budgetMs: options.budgetMs,
      onChange: () => this.writeStatus(),
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
    const socket: SocketState = this.stopping ? 'closed' : this.socket.state
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
      last_run: c.lastRun,
      retry_rung: c.retryRung,
      retry_due_at: c.retryDueAt === null ? null : new Date(c.retryDueAt).toISOString(),
      last_error: this.lastError,
    }
  }

  /** The connect-time catch-up: two counts, a knock only when something is waiting. */
  private async catchUp(): Promise<void> {
    const { cfg } = this.options
    const wire: WireConfig = { apiKey: cfg.apiKey, apiBase: cfg.apiBase }
    try {
      const waiting = await trayHasWaiting(wire)
      if (this.stopping) return
      if (waiting) {
        log.info('knock — connect: the tray is not empty')
        this.invoker.knock('connect')
      } else {
        log.info('connect: the tray is empty — no run')
      }
    } catch (err) {
      log.warn(`connect-time tray count failed (${err instanceof Error ? err.message : String(err)}) — relying on frames`)
    }
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
