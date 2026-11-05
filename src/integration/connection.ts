import { EventEmitter } from 'node:events'
import { RealtimeClient, type BlockedInfo, type RealtimeState, type WakeFrame, type WsMessage } from 'agentchatme'
import { log } from '../util/log.js'
import { clientIdentityOf, type IntegrationClient } from '../client-identity.js'
import { normalizeHandle } from '../skill/identity-line.js'
import type { SocketState } from './status.js'

// ─── The connection: the SDK's socket, read as wakes ────────────────────────
//
// The socket is the SDK's `RealtimeClient` — hello, capabilities, acks,
// reconnect backoff, the handshake and liveness watchdogs, frame validation
// all live there, once, for every AgentChat integration. With `ackOnReceipt`
// it acknowledges every `message.new` the moment the frame is parsed:
// DELIVERED means this machine received the message. Whether the agent has
// looked is read state, which only the agent's own verdict inside its run
// changes; an early ack never empties the tray (docs/architecture.md, rule 5).
//
// One client, for as long as this connection lives. The SDK's client never
// dies on its own: every close leads to a backoff and a fresh attempt (capped
// at 30 s, five minutes once an outage is 60 attempts long), a refused
// credential leads to `blocked` — a fresh hello every 10–15 minutes until one
// is accepted — and only `disconnect()` (our `stop()`) ends it. Nothing here
// classifies a close or replaces the client; the credential's fate is the
// supervisor's only through the identity file (a new key is a new
// connection).
//
// What this class adds is the integration's reading of the SDK's events:
//
//   * `message.new`  → a WAKE. Two facts are read: the sender (to skip the
//                      echo of this agent's own sends) and the ids (for the
//                      log line). The body is never read; the agent reads it
//                      through the hosted tools inside its run.
//   * `wake`         → a WAKE of the second kind: a deferred conversation's
//                      reminder came due. No message, nothing to ack. Handled
//                      exactly like a `message.new`: one coalesced wake.
//   * `group.invite.received` → an invite wake.
//   * `onConnect`    → `ready`. NOT a wake by itself: the holder wakes once on
//                      it, and the server re-offers unacked envelopes right
//                      after it. Whether any of that deserves a run is the
//                      invoker's tray count, never this class's call.
//   * `state`        → the status file's `socket` word (`socketStateOf`): the
//                      SDK's `backoff` is `reconnecting`, its `blocked` is
//                      `blocked` — one word for one state across the layers;
//                      the refusal itself travels as the `blocked` event's
//                      detail, for `last error`.
//
// `ws` stays a dependency of this package although nothing here imports it:
// the SDK prefers it on Node, and only on `ws` are the server's 45 s pings
// visible to the SDK's idle deadline (100 s) — a quiet but healthy socket
// stays up, a dead one is reopened.

export interface MessageWake {
  readonly source: 'message'
  readonly sender: string | null
  readonly conversationId: string | null
  readonly messageId: string | null
}

/** A `wake` frame: a deferred conversation's reminder came due. */
export interface ReminderWake {
  readonly source: 'reminder'
  readonly conversationId: string
  readonly anchorMessageId: string
  readonly step: number
}

export type Wake = MessageWake | ReminderWake

export interface InviteWake {
  readonly inviteId: string
  readonly groupId: string | null
  readonly groupName: string | null
  readonly inviterHandle: string | null
}

export interface IntegrationConnectionEvents {
  wake: (wake: Wake) => void
  invite: (invite: InviteWake) => void
  /** This agent's own outbound, echoed back by server fan-out. Not a wake. */
  echo: () => void
  state: (state: SocketState, previous: SocketState) => void
  /** `hello.ok` arrived: the connection is live. Once per (re)connection, after `state` → `ready`. */
  ready: () => void
  /**
   * The server refused the credential on the hello (the SDK is `blocked`,
   * and so is `state`). Once per rejected attempt — the first one in a
   * run and every 10–15 minutes after it, until a hello is accepted and
   * `state` → `ready` lifts it. `detail` is the line `status` shows as the
   * last error.
   */
  blocked: (detail: string, info: BlockedInfo) => void
}

export interface IntegrationConnectionOptions {
  readonly apiKey: string
  /** `wss://api.agentchat.me` — the SDK appends `/v1/ws`. */
  readonly wsBase: string
  /** This agent's handle, to recognise its own echo. Bare, any case. */
  readonly selfHandle: string
  readonly client: IntegrationClient
  /** Test seams for the SDK's backoff; its defaults (500 ms → 30 s) otherwise. */
  readonly reconnectIntervalMs?: number
  readonly maxReconnectIntervalMs?: number
}

/**
 * The SDK's connection state in the status file's vocabulary. Pure. `previous`
 * is the status word in effect, which decides two things the SDK's state alone
 * does not say: a `connecting` after a close is `reconnecting`, and the slow
 * retry out of `blocked` (`connecting` again) stays `blocked` — only an
 * accepted hello (`ready`) lifts it. `stopped` is `closed` from any state; a
 * refusal stays visible as the last error, not as the socket word.
 */
export function socketStateOf(next: RealtimeState, previous: SocketState): SocketState {
  switch (next) {
    case 'idle':
      return 'idle'
    case 'connecting':
      if (previous === 'blocked') return 'blocked'
      return previous === 'idle' || previous === 'connecting' ? 'connecting' : 'reconnecting'
    case 'ready':
      return 'ready'
    case 'backoff':
      return 'reconnecting'
    case 'blocked':
      return 'blocked'
    case 'stopped':
      return 'closed'
  }
}

/** The `last error` line for a refused credential: the server's close, what to do, and that the SDK keeps trying. */
export function blockedDetail(info: BlockedInfo): string {
  return `auth rejected (close ${info.code}${info.reason ? ` ${info.reason}` : ''}) — check the agent's API key; a fresh hello is tried every 10–15 min until one is accepted`
}

function stringField(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export class IntegrationConnection extends EventEmitter {
  private rt: RealtimeClient | null = null
  private _state: SocketState = 'idle'
  private stopped = false
  /** Rejected hellos since the last accepted one: the first is an error line, the rest are info. */
  private refusals = 0
  private readonly selfHandle: string

  constructor(private readonly options: IntegrationConnectionOptions) {
    super()
    this.selfHandle = normalizeHandle(options.selfHandle)
  }

  get state(): SocketState {
    return this._state
  }

  /** True only while the socket is live — `hello.ok` received, not merely open. */
  get connected(): boolean {
    return this._state === 'ready'
  }

  override on<E extends keyof IntegrationConnectionEvents>(event: E, listener: IntegrationConnectionEvents[E]): this {
    return super.on(event, listener as (...args: unknown[]) => void)
  }

  /** Open the SDK's client. Once: it lives until `stop()`, reconnecting on its own. */
  start(): void {
    if (this.rt !== null || this.stopped) return
    const rt = new RealtimeClient({
      apiKey: this.options.apiKey,
      baseUrl: this.options.wsBase,
      clientIdentity: clientIdentityOf(this.options.client),
      // Delivered = this machine received it. Acked at parse time, before
      // anything here runs; read state is the agent's verdict, separately.
      ackOnReceipt: true,
      reconnect: true,
      ...(this.options.reconnectIntervalMs !== undefined ? { reconnectInterval: this.options.reconnectIntervalMs } : {}),
      ...(this.options.maxReconnectIntervalMs !== undefined ? { maxReconnectInterval: this.options.maxReconnectIntervalMs } : {}),
    })
    this.rt = rt
    this.setState('connecting')

    rt.on('state', (next) => this.setState(socketStateOf(next, this._state)))
    rt.on('blocked', (info) => this.onBlocked(info))
    rt.onConnect(() => {
      this.refusals = 0
      log.info(`socket ready (hello.ok) — acks ${rt.ackNegotiated ? 'on receipt' : 'not negotiated by this server'}`)
      this.emit('ready')
    })
    rt.onDisconnect(({ code, reason, initiator }) => {
      if (this.stopped) return
      log.warn(`socket closed (${code}${reason ? ` ${reason}` : ''}${initiator === 'client' ? ', by this client' : ''})`)
    })
    rt.onError((err) => {
      if (this.stopped) return
      log.warn(`socket: ${err.message}`)
    })
    rt.on('message.new', (message) => {
      if (!this.stopped) this.onMessageFrame(message)
    })
    rt.on('wake', (frame) => {
      if (!this.stopped) this.onWakeFrame(frame)
    })
    rt.on('group.invite.received', (message) => {
      if (!this.stopped) this.onInviteFrame(message)
    })

    rt.connect().catch((err: unknown) => {
      // A failed attempt the SDK retries was already announced through
      // onError. The one it does not retry — no WebSocket implementation at
      // all — leaves the client idle, and is said once.
      if (this.stopped || rt.state !== 'idle') return
      log.error(`socket cannot be opened (${err instanceof Error ? err.message : String(err)}) — no WebSocket implementation; holding no socket`)
    })
  }

  /** End the SDK's client. Final: a stopped connection is not restarted. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    const rt = this.rt
    this.rt = null
    try {
      rt?.disconnect() // fires `state` → `stopped`, mapped to `closed`; a late frame flushed here is ignored
    } catch {
      /* already closed */
    }
    this.setState('closed') // also for a connection that was never started
  }

  private setState(next: SocketState): void {
    const prev = this._state
    if (prev === next) return
    this._state = next
    // `ready` is logged with the ack note on hello.ok, `blocked` with the
    // refusal on the blocked event.
    if (next === 'connecting') log.info('socket connecting')
    else if (next === 'reconnecting') log.info('socket reconnecting — the SDK backs off and retries; it never gives up')
    else if (next === 'closed') log.info('socket closed')
    this.emit('state', next, prev)
  }

  /** The SDK is `blocked`: the server refused the credential on the hello. Fires per rejected attempt. */
  private onBlocked(info: BlockedInfo): void {
    if (this.stopped) return
    const detail = blockedDetail(info)
    this.refusals += 1
    if (this.refusals === 1) {
      log.error(`socket blocked (auth): ${detail}`)
    } else {
      const next = info.retryInMs === null ? 'no retry' : `next hello in about ${Math.max(1, Math.round(info.retryInMs / 60_000))} min`
      log.info(`socket still blocked (auth): close ${info.code}${info.reason ? ` ${info.reason}` : ''} — ${next}`)
    }
    this.emit('blocked', detail, info)
  }

  /**
   * A `message.new` frame. Only the sender (echo filter) and the ids (log
   * line) are read. `content`, `metadata`, previews — never touched. The SDK
   * acked it before this ran.
   */
  private onMessageFrame(message: WsMessage): void {
    const payload = asRecord(message.payload)
    if (payload === null) {
      log.warn('socket: message.new without an object payload — dropped')
      return
    }
    const senderRaw = stringField(payload, ['sender', 'sender_handle', 'from'])
    const sender = senderRaw === null ? null : normalizeHandle(senderRaw)
    const messageId = stringField(payload, ['id'])
    const conversationId = stringField(payload, ['conversation_id'])
    if (sender !== null && sender === this.selfHandle) {
      log.debug(`socket: own echo in ${conversationId ?? '?'} — not a wake`)
      this.emit('echo')
      return
    }
    log.info(`wake — message.new conv=${conversationId ?? '?'} msg=${messageId ?? '?'} from=@${sender ?? '?'}`)
    this.emit('wake', { source: 'message', sender, conversationId, messageId } satisfies MessageWake)
  }

  /** A `wake` frame, validated by the SDK. No message, nothing to ack. */
  private onWakeFrame(frame: WakeFrame): void {
    const { conversation_id, anchor_message_id, step, reason } = frame.payload
    log.info(`wake — ${reason} conv=${conversation_id} anchor=${anchor_message_id} step=${step}`)
    this.emit('wake', {
      source: 'reminder',
      conversationId: conversation_id,
      anchorMessageId: anchor_message_id,
      step,
    } satisfies ReminderWake)
  }

  private onInviteFrame(message: WsMessage): void {
    const payload = asRecord(message.payload)
    if (payload === null) {
      log.warn('socket: group.invite.received without an object payload — dropped')
      return
    }
    const inviteId = stringField(payload, ['invite_id', 'id'])
    if (inviteId === null) {
      log.warn('socket: group invite without an invite id — dropped')
      return
    }
    const invite: InviteWake = {
      inviteId,
      groupId: stringField(payload, ['group_id', 'conversation_id']),
      groupName: stringField(payload, ['group_name', 'name']),
      inviterHandle: stringField(payload, ['inviter_handle', 'inviter', 'from']),
    }
    log.info(`wake — group invite ${invite.inviteId} to ${invite.groupId ?? '?'} from=@${invite.inviterHandle ?? '?'}`)
    this.emit('invite', invite)
  }
}
