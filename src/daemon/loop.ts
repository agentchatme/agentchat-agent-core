import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { log } from '../util/log.js'
import { atomicWriteFile } from '../util/fsutil.js'
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
// capped) run one runtime turn per message → ack that message on success.
// Failures retry with bounded exponential backoff and remain unacknowledged
// until they genuinely succeed.
//
// Host-agnostic by construction: everything it knows about the agent arrives in
// `DaemonConfig`, and everything it knows about the coding agent arrives as a
// `RuntimeAdapter`. It cannot name a host, so it cannot act on the wrong one.

const MAX_TIMER_MS = 2_147_483_647

function positiveBoundedEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, MAX_TIMER_MS)
    : fallback
}

const MAX_CONCURRENT_TURNS = 3
const HEARTBEAT_MS = 30_000
const SEEN_TTL_MS = 24 * 60 * 60_000
const MAX_COMPLETED_SEEN = 10_000
const PAUSE_AT_PENDING = Math.max(
  1,
  Math.floor(positiveBoundedEnv('AGENTCHATD_MAX_PENDING', 2_000)),
)
const RESUME_AT_PENDING = Math.max(1, Math.floor(PAUSE_AT_PENDING / 2))
const RETRY_BASE_MS = positiveBoundedEnv('AGENTCHATD_RETRY_MS', 1_000)
const RETRY_MAX_MS = Math.max(
  RETRY_BASE_MS,
  positiveBoundedEnv('AGENTCHATD_RETRY_MAX_MS', 5 * 60_000),
)
// When the agent's live coding session is actively working, wait this long
// before claiming — a head start so the human-driven session (priority) can
// grab the message first. Only applies while a session is active; the common
// "no session, daemon only" path has zero added latency. Tunable for testing.
const YIELD_MS = Number(process.env['AGENTCHATD_YIELD_MS'] ?? 10_000)

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function retryDelay(attempt: number): number {
  // Clamp the exponent before multiplication so a long-lived outage never
  // overflows setTimeout or turns into a tight retry loop.
  return Math.min(RETRY_BASE_MS * 2 ** Math.min(20, Math.max(0, attempt - 1)), RETRY_MAX_MS)
}

type DeliveryStatus = 'queued' | 'running' | 'retry-wait' | 'handled'

interface DeliveryState {
  row: SyncRow
  status: DeliveryStatus
  attempts: number
  updatedAt: number
}

export interface DaemonFailure {
  kind: 'socket-auth' | 'runtime'
  reason: string
}

function installationId(home: string): string {
  const file = path.join(home, 'daemon.installation-id')
  try {
    const existing = fs.readFileSync(file, 'utf-8').trim()
    if (/^[0-9a-f-]{36}$/i.test(existing)) return existing
  } catch {
    /* create below */
  }
  const id = crypto.randomUUID()
  try {
    atomicWriteFile(file, `${id}\n`, 0o600)
  } catch (err) {
    // A read-only home must not make delivery disappear. The random fallback
    // is process-unique, so it still avoids cross-machine hostname collisions;
    // it simply cannot reclaim its prior claim after a restart.
    log.warn(`could not persist daemon installation id: ${String(err)}`)
  }
  return id
}

export class Daemon {
  private readonly ws: AgentWsClient
  private readonly coord: ReplyCoord
  private readonly seen = new Map<string, DeliveryState>()
  private readonly convQueues = new Map<string, SyncRow[]>()
  private readonly convWorkers = new Set<string>()
  private pending = 0
  private inFlight = 0
  private readonly waiters: Array<() => void> = []
  private stopping = false
  private heartbeatTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly cfg: DaemonConfig,
    private readonly adapter: RuntimeAdapter,
    ws?: AgentWsClient, // injectable for tests; defaults to a real socket
    /** Called when the socket gives up for good (auth refused). The supervisor
     *  above decides what happens next — this class does not end the process. */
    private readonly onTerminal?: (failure: DaemonFailure) => void,
  ) {
    // Stable holder token: the same across a restart of THIS installation, so a
    // restarted daemon re-claims its own in-flight messages instead of being
    // locked out by its own prior claim. A hostname is not unique: two laptops
    // called "macbook" can legitimately use the same AgentChat identity.
    this.coord = new ReplyCoord({
      apiKey: cfg.apiKey,
      apiBase: cfg.apiBase,
      holder: `daemon:${installationId(cfg.home)}`,
    })
    this.ws = ws ?? new AgentWsClient(cfg.wsUrl, cfg.apiKey)
    this.ws.on('inbound', (row: SyncRow) => this.onInbound(row))
    // Every fresh connection stamps the beacon immediately (don't wait up to 30s
    // for the first interval tick to prove we're live).
    this.ws.on('ready', () => beat(this.cfg.home))
    this.ws.on('terminal', (reason: string) => {
      // Auth refused. Do NOT end the process: this daemon is resident, and a
      // rejected key is a state to sit out, not to die from — the user may sign
      // in again with a good one. Setting process.exitCode here made the
      // service manager restart the whole thing on a loop instead.
      log.error(`daemon terminal: ${reason}`)
      this.stop()
      this.onTerminal?.({ kind: 'socket-auth', reason })
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
    this.pruneSeen()
    const prior = this.seen.get(row.id)
    if (prior) {
      prior.updatedAt = Date.now()
      // A replay after a lost ack must be ACKED again, not merely swallowed.
      if (prior.status === 'handled') this.ws.ack(row.id)
      return
    }
    this.seen.set(row.id, { row, status: 'queued', attempts: 0, updatedAt: Date.now() })
    this.pending += 1
    if (this.pending >= PAUSE_AT_PENDING) this.ws.pauseInbound()
    this.enqueueExisting(row)
  }

  /** Queue one already-tracked row and ensure exactly one worker for its conversation. */
  private enqueueExisting(row: SyncRow): void {
    const queue = this.convQueues.get(row.conversation_id) ?? []
    queue.push(row)
    this.convQueues.set(row.conversation_id, queue)
    if (this.convWorkers.has(row.conversation_id)) return
    this.convWorkers.add(row.conversation_id)
    void this.drainConversation(row.conversation_id)
  }

  /** Process each message independently, in arrival order within a conversation. */
  private async drainConversation(conversationId: string): Promise<void> {
    try {
      while (!this.stopping) {
        const queue = this.convQueues.get(conversationId)
        if (!queue || queue.length === 0) break
        const row = queue.shift()
        if (!row) break
        await this.handle(row)
      }
    } catch (err) {
      log.warn(`unhandled in conv ${conversationId}: ${String(err)}`)
    } finally {
      this.convWorkers.delete(conversationId)
      const queue = this.convQueues.get(conversationId)
      if (!queue || queue.length === 0) this.convQueues.delete(conversationId)
      else if (!this.stopping) {
        // A row may have landed between the final empty check and deleting the
        // worker marker. Re-arm rather than leaving it stranded.
        this.convWorkers.add(conversationId)
        void this.drainConversation(conversationId)
      }
    }
  }

  private async handle(row: SyncRow): Promise<void> {
    if (this.stopping) return
    const initial = this.seen.get(row.id)
    if (!initial || initial.status !== 'queued') return

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
      // A live session owns this one. Forget our dedup state and do NOT ack:
      // the session's sync path still needs to see and commit it.
      log.info(`msg ${row.id}: claimed by the live session — standing down`)
      this.seen.delete(row.id)
      this.markNoLongerPending()
      return
    }

    // A failed message stays at the head of its conversation. This preserves
    // ordering: a later message in the same thread cannot be acknowledged
    // before the earlier one has actually been handled.
    while (!this.stopping) {
      const state = this.seen.get(row.id)
      if (!state || state.status === 'handled') return
      state.status = 'running'
      state.attempts += 1
      state.updatedAt = Date.now()
      const attempt = state.attempts

      await this.acquireSlot()
      if (this.stopping) {
        this.releaseSlot()
        return
      }
      let result
      try {
        log.info(
          `turn for msg ${row.id} in ${row.conversation_id} from @${senderOf(row)} (attempt ${attempt})`,
        )
        const ctx = contextOf(row)
        result = await this.adapter.runTurn({
          messageId: row.id,
          conversationId: row.conversation_id,
          sender: senderOf(row),
          text:
            typeof row.content?.['text'] === 'string'
              ? (row.content['text'] as string)
              : '',
          createdAt: typeof row.created_at === 'string' ? row.created_at : undefined,
          type: typeof row.type === 'string' ? row.type : undefined,
          senderDisplayName: ctx.senderDisplayName,
          senderKind: ctx.senderKind,
          groupName: ctx.groupName,
          mentioned: ctx.mentions.includes(this.cfg.handle.toLowerCase()),
        })
      } catch (err) {
        result = { ok: false, detail: `adapter threw: ${String(err)}` }
      } finally {
        this.releaseSlot()
      }

      if (result.ok) {
        this.markHandled(row.id)
        return
      }
      if (result.fatal) {
        log.error(`fatal turn error: ${result.detail} — stopping runtime so preflight can recover`)
        this.stop()
        this.onTerminal?.({ kind: 'runtime', reason: result.detail ?? 'runtime failed' })
        return
      }

      const retryMs = retryDelay(attempt)
      state.status = 'retry-wait'
      state.updatedAt = Date.now()
      log.warn(
        `turn failed for msg ${row.id}: ${result.detail}; retrying in ${retryMs}ms without acknowledging it`,
      )
      await delay(retryMs)
    }
  }

  private markHandled(messageId: string): void {
    const state = this.seen.get(messageId)
    if (!state || state.status === 'handled') return
    state.status = 'handled'
    state.updatedAt = Date.now()
    this.markNoLongerPending()
    this.ws.ack(messageId)
  }

  private markNoLongerPending(): void {
    this.pending = Math.max(0, this.pending - 1)
    if (this.pending <= RESUME_AT_PENDING) this.ws.resumeInbound()
  }

  /** Bound reconnect-dedup memory without ever evicting unfinished work. */
  private pruneSeen(): void {
    const cutoff = Date.now() - SEEN_TTL_MS
    const completed: Array<[string, DeliveryState]> = []
    for (const entry of this.seen.entries()) {
      const [id, state] = entry
      if (state.status !== 'handled') continue
      if (state.updatedAt < cutoff) this.seen.delete(id)
      else completed.push(entry)
    }
    if (completed.length <= MAX_COMPLETED_SEEN) return
    completed.sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    for (const [id] of completed.slice(0, completed.length - MAX_COMPLETED_SEEN)) {
      this.seen.delete(id)
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
