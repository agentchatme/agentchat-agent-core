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
import type { RuntimeAdapter, TurnContext, TurnMentionContext } from './adapter-types.js'

// ─── The core loop ──────────────────────────────────────────────────────────
//
// WS pushes message.new → dedup → atomic foreground-aware ownership claim →
// (per-conversation serialized, globally capped) run one runtime turn per
// bounded conversation backlog → ack every
// represented delivery only after that turn succeeds. Failures retry the same
// frozen batch with bounded exponential backoff and remain unacknowledged until
// they genuinely succeed.
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

function nonNegativeBoundedEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.min(parsed, MAX_TIMER_MS)
    : fallback
}

const MAX_CONCURRENT_TURNS = 3
// Matches agentchat_get_conversation's compact default window. Larger backlogs
// become consecutive bounded turns instead of one unbounded prompt.
const MAX_BATCH_MESSAGES = 30
// Gives reconnect/socket bursts a brief chance to land before the conversation
// snapshot is frozen. Zero remains available for deterministic host tuning.
const BATCH_SETTLE_MS = nonNegativeBoundedEnv('AGENTCHATD_BATCH_SETTLE_MS', 100)
const MENTION_PREVIEW_MAX = 280
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
// A foreground lease makes the atomic claim return "deferred". Keep the
// unacked row locally and retry at this cadence so a crashed foreground turn
// becomes daemon-eligible as soon as its lease expires, without requiring a
// WebSocket reconnect to replay the delivery.
const FOREGROUND_RECHECK_MS = positiveBoundedEnv(
  'AGENTCHATD_FOREGROUND_RECHECK_MS',
  2_000,
)

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function retryDelay(attempt: number): number {
  // Clamp the exponent before multiplication so a long-lived outage never
  // overflows setTimeout or turns into a tight retry loop.
  return Math.min(RETRY_BASE_MS * 2 ** Math.min(20, Math.max(0, attempt - 1)), RETRY_MAX_MS)
}

function textOf(row: SyncRow): string {
  return typeof row.content?.['text'] === 'string'
    ? (row.content['text'] as string)
    : ''
}

function replyToOf(row: SyncRow): string | null {
  return typeof row.metadata?.['reply_to'] === 'string'
    ? (row.metadata['reply_to'] as string)
    : null
}

function previewOf(row: SyncRow): string {
  const oneLine = textOf(row).replace(/\s+/g, ' ').trim()
  if (oneLine.length === 0) return `[${row.type ?? 'message'}]`
  return oneLine.length > MENTION_PREVIEW_MAX
    ? `${oneLine.slice(0, MENTION_PREVIEW_MAX - 1)}…`
    : oneLine
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
  // Identity-wide foreground priority, learned from any deferred claim. Every
  // conversation shares this window so a large multi-conversation backlog
  // cannot turn into one polling loop per conversation.
  private foregroundClaimsBlockedUntil = 0
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

  /** Process bounded backlog snapshots, in arrival order within a conversation. */
  private async drainConversation(conversationId: string): Promise<void> {
    try {
      while (!this.stopping) {
        const queue = this.convQueues.get(conversationId)
        if (!queue || queue.length === 0) break
        await this.handleNextBatch(conversationId)
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

  private async handleNextBatch(conversationId: string): Promise<void> {
    if (this.stopping) return
    const first = this.convQueues.get(conversationId)?.[0]
    if (!first) return
    const initial = this.seen.get(first.id)
    if (!initial || initial.status !== 'queued') {
      // Defensive invariant repair: leaving an unprocessable head in place
      // would make the conversation worker spin forever.
      this.convQueues.get(conversationId)?.shift()
      return
    }

    // Wait for an actual runtime slot before freezing the backlog. Messages
    // that arrive while another conversation is using all slots can therefore
    // join this batch instead of causing avoidable follow-up turns.
    await this.acquireSlot()
    let slotHeld = true
    try {
      await this.waitForForegroundClaimWindow()
      if (this.stopping) {
        return
      }
      if (BATCH_SETTLE_MS > 0) await delay(BATCH_SETTLE_MS)
      if (this.stopping) return

      const queue = this.convQueues.get(conversationId)
      if (!queue || queue.length === 0) return
      const candidates = queue.splice(0, MAX_BATCH_MESSAGES)
      const claim = await this.coord.claimBatch(
        candidates.map((row) => row.id),
      )
      const claimedCount = claim.claimedCount
      let batch = candidates.slice(0, claimedCount)

      if (claimedCount < candidates.length) {
        if (claim.deferred) {
          this.foregroundClaimsBlockedUntil = Math.max(
            this.foregroundClaimsBlockedUntil,
            Date.now() + FOREGROUND_RECHECK_MS,
          )
          // Nobody owns this suffix yet. A foreground turn's lease atomically
          // prevented the daemon claim, so keep every row queued. If that turn
          // crashes, retrying here is the delivery's failover schedule.
          const deferred = candidates.slice(claimedCount)
          if (deferred.length > 0) {
            const current = this.convQueues.get(conversationId) ?? []
            this.convQueues.set(conversationId, [...deferred, ...current])
          }
          log.info(
            `msg ${deferred[0]?.id}: foreground turn owns priority — deferring daemon claim`,
          )
        } else {
          const conflict = candidates[claimedCount] as SyncRow
          // A live session already owns this delivery. Forget our dedup state
          // and do NOT ack: the session's sync path still needs to commit it.
          log.info(`msg ${conflict.id}: claimed by the live session — standing down`)
          this.seen.delete(conflict.id)
          this.markNoLongerPending()

          const unclaimedTail = candidates.slice(claimedCount + 1)
          if (unclaimedTail.length > 0) {
            const current = this.convQueues.get(conversationId) ?? []
            this.convQueues.set(conversationId, [...unclaimedTail, ...current])
          }
        }
      }

      if (batch.length === 0) return

      // A failed batch stays ahead of later messages in its conversation. The
      // same frozen delivery set retries; new arrivals wait for the next batch.
      while (!this.stopping) {
        // A host turn can run for almost the full coordination TTL. Renew the
        // exact frozen delivery set before every attempt so a retry never runs
        // on an expired claim. Re-claiming with this daemon's stable holder is
        // a TTL renewal, not a second owner.
        const renewed = await this.coord.claimBatch(batch.map((row) => row.id))
        if (renewed.claimedCount < batch.length) {
          const lost = batch.slice(renewed.claimedCount)
          batch = batch.slice(0, renewed.claimedCount)

          if (renewed.deferred) {
            this.foregroundClaimsBlockedUntil = Math.max(
              this.foregroundClaimsBlockedUntil,
              Date.now() + FOREGROUND_RECHECK_MS,
            )
            // A foreground turn gained priority between daemon attempts. Put
            // every unrenewed row back at the head and let the normal claim
            // path retry after handoff.
            for (const row of lost) {
              const state = this.seen.get(row.id)
              if (state) {
                state.status = 'queued'
                state.updatedAt = Date.now()
              }
            }
            const current = this.convQueues.get(conversationId) ?? []
            this.convQueues.set(conversationId, [...lost, ...current])
          } else {
            // Another live holder owns the first unrenewed row. Stand down for
            // that one and preserve the later suffix for a fresh ordered claim.
            const conflict = lost[0] as SyncRow
            log.info(`msg ${conflict.id}: renewal lost to a live session — standing down`)
            this.seen.delete(conflict.id)
            this.markNoLongerPending()

            const tail = lost.slice(1)
            for (const row of tail) {
              const state = this.seen.get(row.id)
              if (state) {
                state.status = 'queued'
                state.updatedAt = Date.now()
              }
            }
            if (tail.length > 0) {
              const current = this.convQueues.get(conversationId) ?? []
              this.convQueues.set(conversationId, [...tail, ...current])
            }
          }
        }

        if (batch.length === 0) return

        const states = batch.map((row) => this.seen.get(row.id))
        if (
          states.some(
            (state) =>
              state === undefined ||
              state.status === 'handled',
          )
        ) {
          return
        }
        const attempt = Math.max(...states.map((state) => state?.attempts ?? 0)) + 1
        const now = Date.now()
        for (const state of states) {
          if (!state) continue
          state.status = 'running'
          state.attempts = attempt
          state.updatedAt = now
        }

        const focus = batch[batch.length - 1] as SyncRow
        let result
        try {
          log.info(
            `turn for ${batch.length} message(s), newest ${focus.id}, in ${conversationId} (attempt ${attempt})`,
          )
          result = await this.adapter.runTurn(this.turnContext(batch))
        } catch (err) {
          result = { ok: false, detail: `adapter threw: ${String(err)}` }
        }

        if (result.ok) {
          for (const row of batch) this.markHandled(row.id)
          return
        }
        if (result.fatal) {
          log.error(`fatal turn error: ${result.detail} — stopping runtime so preflight can recover`)
          this.stop()
          this.onTerminal?.({ kind: 'runtime', reason: result.detail ?? 'runtime failed' })
          return
        }

        const retryMs = retryDelay(attempt)
        const retryAt = Date.now()
        for (const state of states) {
          if (!state) continue
          state.status = 'retry-wait'
          state.updatedAt = retryAt
        }
        log.warn(
          `turn failed for batch ending ${focus.id}: ${result.detail}; retrying in ${retryMs}ms without acknowledging ${batch.length} message(s)`,
        )
        this.releaseSlot()
        slotHeld = false
        await delay(retryMs)
        if (this.stopping) return
        await this.acquireSlot()
        slotHeld = true
      }
    } finally {
      if (slotHeld) this.releaseSlot()
    }
  }

  private async waitForForegroundClaimWindow(): Promise<void> {
    while (!this.stopping) {
      const remaining = this.foregroundClaimsBlockedUntil - Date.now()
      if (remaining <= 0) return
      await delay(remaining)
    }
  }

  private turnContext(batch: SyncRow[]): TurnContext {
    const focus = batch[batch.length - 1] as SyncRow
    const oldest = batch[0] as SyncRow
    const focusContext = contextOf(focus)
    const self = this.cfg.handle.replace(/^@/, '').toLowerCase()
    const isGroup = focus.conversation_id.startsWith('grp_')
    const mentionedMessages: TurnMentionContext[] = isGroup
      ? batch.flatMap((row) => {
          const ctx = contextOf(row)
          if (!ctx.mentions.includes(self)) return []
          return [
            {
              messageId: row.id,
              messageSeq: typeof row.seq === 'number' ? row.seq : undefined,
              sender: senderOf(row),
              senderDisplayName: ctx.senderDisplayName,
              senderKind: ctx.senderKind,
              createdAt:
                typeof row.created_at === 'string' ? row.created_at : undefined,
              replyToMessageId: replyToOf(row),
              textPreview: previewOf(row),
            },
          ]
        })
      : []

    return {
      messageId: focus.id,
      messageSeq: typeof focus.seq === 'number' ? focus.seq : undefined,
      conversationId: focus.conversation_id,
      sender: senderOf(focus),
      text: textOf(focus),
      createdAt:
        typeof focus.created_at === 'string' ? focus.created_at : undefined,
      type: typeof focus.type === 'string' ? focus.type : undefined,
      senderDisplayName: focusContext.senderDisplayName,
      senderKind: focusContext.senderKind,
      groupName: focusContext.groupName,
      memberCount: focusContext.memberCount,
      replyToMessageId: replyToOf(focus),
      deliveryStatus:
        typeof focus.status === 'string' ? focus.status : undefined,
      mentioned: focusContext.mentions.includes(self),
      pendingBatch: {
        count: batch.length,
        messageIds: batch.map((row) => row.id),
        oldestMessageId: oldest.id,
        oldestMessageSeq:
          typeof oldest.seq === 'number' ? oldest.seq : undefined,
        newestMessageId: focus.id,
        newestMessageSeq:
          typeof focus.seq === 'number' ? focus.seq : undefined,
        mentionedMessages,
      },
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
