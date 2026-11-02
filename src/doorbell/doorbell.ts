import { log } from '../util/log.js'
import type { DaemonConfig } from '../daemon/config.js'
import { beat, idle } from '../daemon/health.js'
import { DoorbellInvoker } from './invoker.js'
import type { DoorbellPrompts } from './prompt.js'
import type { RunProfile } from './profile.js'
import type { RunRunner } from './runner.js'
import { DoorbellSocket } from './socket.js'
import { writeDoorbellStatus, type DoorbellStatus, type SocketState } from './status.js'

// ─── The doorbell: a socket, a coalescer, a runner ──────────────────────────
//
// Everything it knows about the agent arrives in `DaemonConfig`; everything it
// knows about the coding agent arrives as a `RunRunner`. It cannot name a
// host, so it cannot act on the wrong one.

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
  /** Called when the socket gives up for good (auth refused). The supervisor
   *  above decides what happens next — this class does not end the process. */
  readonly onTerminal?: (reason: string) => void
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
    this.socket.on('state', (state) => {
      if (state === 'ready') beat(cfg.home)
      else idle(cfg.home)
      this.writeStatus()
    })
    this.socket.on('ack', () => this.writeStatus())
    this.socket.on('terminal', (reason) => {
      // Auth refused. Do NOT end the process: this daemon is resident, and a
      // rejected key is a state to sit out, not to die from — the user may sign
      // in again with a good one.
      this.lastError = reason
      log.error(`doorbell terminal: ${reason}`)
      this.stop()
      options.onTerminal?.(reason)
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

  private writeStatus(): void {
    writeDoorbellStatus(this.options.cfg.home, this.snapshot())
  }
}
