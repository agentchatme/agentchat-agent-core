import * as os from 'node:os'
import { log } from '../util/log.js'
import type { DaemonConfig } from './config.js'
import { AgentWsClient } from './ws-client.js'
import { ReplyCoord } from './coord.js'
import { beat } from './health.js'
import { contextOf, senderOf, type SyncRow } from './frames.js'
import type { RuntimeAdapter } from './adapter-types.js'

// ─── The core loop ──────────────────────────────────────────────────────────
//
// WS pushes message.new → dedup → coexistence check (yield to a live session,
// then claim the sole right to reply) → (per-conversation serialized, globally
// capped) run one runtime turn → ack on success. Not acking on failure means
// the server re-drains the message on the next reconnect (at-least-once); a
// per-message attempt cap drops poison after N tries so it can't loop forever.
//
// Host-agnostic by construction: everything it knows about the agent arrives in
// `DaemonConfig`, and everything it knows about the coding agent arrives as a
// `RuntimeAdapter`. It cannot name a host, so it cannot act on the wrong one.

const MAX_CONCURRENT_TURNS = 3
const MAX_ATTEMPTS = 3
const HEARTBEAT_MS = 30_000
// When the agent's live coding session is actively working, wait this long
// before claiming — a head start so the human-driven session (priority) can
// grab the message first. Only applies while a session is active; the common
// "no session, daemon only" path has zero added latency. Tunable for testing.
const YIELD_MS = Number(process.env['AGENTCHATD_YIELD_MS'] ?? 10_000)

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class Daemon {
  private readonly ws: AgentWsClient
  private readonly coord: ReplyCoord
  private readonly seen = new Map<string, number>() // message id → attempts
  private readonly convChains = new Map<string, Promise<void>>()
  private inFlight = 0
  private readonly waiters: Array<() => void> = []
  private stopping = false
  private heartbeatTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly cfg: DaemonConfig,
    private readonly adapter: RuntimeAdapter,
    ws?: AgentWsClient, // injectable for tests; defaults to a real socket
  ) {
    // Stable holder token: the same across a restart on THIS host, so a
    // restarted daemon re-claims its own in-flight messages instead of being
    // locked out by its own prior claim. (Two daemons per agent on one host
    // are already prevented by the leader lock.)
    this.coord = new ReplyCoord({
      apiKey: cfg.apiKey,
      apiBase: cfg.apiBase,
      holder: `daemon:${os.hostname()}`,
    })
    this.ws = ws ?? new AgentWsClient(cfg.wsUrl, cfg.apiKey)
    this.ws.on('inbound', (row: SyncRow) => this.onInbound(row))
    // Every fresh connection stamps the beacon immediately (don't wait up to 30s
    // for the first interval tick to prove we're live).
    this.ws.on('ready', () => beat(this.cfg.home))
    this.ws.on('terminal', (reason: string) => {
      log.error(`daemon terminal: ${reason}`)
      this.stop()
      process.exitCode = 1
    })
  }

  async start(): Promise<void> {
    const pre = await this.adapter.preflight()
    if (!pre.ok) {
      throw new Error(`runtime (${this.adapter.name}) not ready: ${pre.detail}`)
    }
    log.info(`agentchat daemon up as @${this.cfg.handle} via ${this.adapter.name}; holding the wire`)
    this.ws.start()
    // Keep the beacon fresh while connected. unref so it never by itself keeps
    // the process alive.
    this.heartbeatTimer = setInterval(() => {
      if (this.ws.connected) beat(this.cfg.home)
    }, HEARTBEAT_MS)
    this.heartbeatTimer.unref()
  }

  stop(): void {
    this.stopping = true
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.ws.stop()
  }

  private onInbound(row: SyncRow): void {
    // Ignore our own outbound echoed back by server fan-out.
    if (senderOf(row) === this.cfg.handle) return
    if (this.seen.has(row.id)) return // dedup (reconnect replay)
    this.seen.set(row.id, 0)
    this.enqueue(row)
  }

  /** Serialize turns within a conversation; the global semaphore caps total. */
  private enqueue(row: SyncRow): void {
    const prev = this.convChains.get(row.conversation_id) ?? Promise.resolve()
    const next = prev
      .then(() => this.handle(row))
      .catch((err) => {
        log.warn(`unhandled in conv ${row.conversation_id}: ${String(err)}`)
      })
    this.convChains.set(row.conversation_id, next)
    // Prune the chain entry once it settles (avoid unbounded map growth).
    void next.then(() => {
      if (this.convChains.get(row.conversation_id) === next) this.convChains.delete(row.conversation_id)
    })
  }

  private async handle(row: SyncRow): Promise<void> {
    if (this.stopping) return

    // ── Coexistence: agree on exactly one replier ──
    // If the agent's live coding session is actively working, yield briefly so
    // its hook can claim + handle this first (the human-driven session has
    // priority). Then claim the sole right to reply; whoever wins is it.
    if (await this.coord.isSessionActive()) {
      log.info(`msg ${row.id}: live session active — yielding for ${YIELD_MS}ms`)
      await delay(YIELD_MS)
      if (this.stopping) return
    }
    if (!(await this.coord.claim(row.id))) {
      // A live session owns this one. Do NOT ack — leave it 'stored' so the
      // session's sync-peek still sees it and marks it delivered on handling.
      log.info(`msg ${row.id}: claimed by the live session — standing down`)
      return
    }

    await this.acquireSlot()
    try {
      const attempts = (this.seen.get(row.id) ?? 0) + 1
      this.seen.set(row.id, attempts)
      log.info(`turn for msg ${row.id} from @${senderOf(row)} (attempt ${attempts})`)

      const ctx = contextOf(row)
      const result = await this.adapter.runTurn({
        conversationId: row.conversation_id,
        sender: senderOf(row),
        text: typeof row.content?.['text'] === 'string' ? (row.content['text'] as string) : '',
        createdAt: typeof row.created_at === 'string' ? row.created_at : undefined,
        type: typeof row.type === 'string' ? row.type : undefined,
        senderDisplayName: ctx.senderDisplayName,
        senderKind: ctx.senderKind,
        groupName: ctx.groupName,
        mentioned: ctx.mentions.includes(this.cfg.handle.toLowerCase()),
      })

      if (result.ok) {
        this.ws.ack(row.id)
      } else if (result.fatal) {
        log.error(`fatal turn error: ${result.detail} — not acking (will re-drain)`)
      } else if (attempts >= MAX_ATTEMPTS) {
        log.warn(`msg ${row.id} failed ${attempts}× (${result.detail}); acking to drop (poison guard)`)
        this.ws.ack(row.id)
      } else {
        log.warn(`turn failed for ${row.id}: ${result.detail}; leaving unacked for re-drain`)
      }
    } finally {
      this.releaseSlot()
    }
  }

  // ─── global concurrency semaphore ─────────────────────────────────────────
  // A waiter inherits the releaser's slot directly (inFlight unchanged on
  // hand-off) — no decrement-then-reincrement window that could momentarily
  // exceed the cap.
  private acquireSlot(): Promise<void> {
    if (this.inFlight < MAX_CONCURRENT_TURNS) {
      this.inFlight++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  private releaseSlot(): void {
    const next = this.waiters.shift()
    if (next) next() // pass the slot on; inFlight stays at the cap
    else this.inFlight--
  }
}
