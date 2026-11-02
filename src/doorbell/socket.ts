import { WebSocket } from 'ws'
import { EventEmitter } from 'node:events'
import { log } from '../util/log.js'
import { CODING_AGENTS_CLIENT_HEADERS } from '../client-identity.js'
import type { SocketState } from './status.js'

// ─── The socket as a knock ──────────────────────────────────────────────────
//
// Connects to `/v1/ws` as the agent (Bearer header) and holds the connection.
// Every frame that matters is a KNOCK — a hint that something is waiting —
// and nothing more:
//
//   * `message.new`            → a knock. Two facts are read: the sender (to
//                                skip the echo of this agent's own sends) and
//                                the ids (for the log line). The body is never
//                                read; the agent reads it through the hosted
//                                tools inside its run.
//   * `group.invite.received`  → the second knock kind.
//   * a successful connection  → a knock. Whatever landed while the socket was
//                                down is on the tray now; the run reads it.
//
// NEVER ACKNOWLEDGES — by construction. The socket advertises the `ack`
// capability (`x-agentchat-capabilities: ack`), so the server keeps every
// envelope `stored` until an acknowledgment arrives, and none ever does from
// here: there is no method on this class that sends a frame. Delivered means
// pulled and acknowledged BY THE AGENT (or decided), through the hosted tools.
// A daemon that acknowledged on receipt would settle messages nobody judged,
// and a crash between ack and run would lose them. tests/socket.test.ts pins
// the absence of a send path against a real server double.
//
// NEVER DRAINS over REST either: `/v1/messages/sync` is not called by this
// package. The server re-offers unacked envelopes as frames on reconnect,
// which land here as knocks and coalesce into one run.

const BASE_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 60_000
// If no frame/ping arrives for this long, treat the socket as dead. The server
// pings every 45 s, so ~2 missed cycles.
const LIVENESS_MS = 100_000
// Reconnect attempts above this almost certainly mean the control plane is
// unreachable or the key was revoked without a terminal 401.
const RECONNECT_HARD_CAP_ATTEMPTS = 500

export interface MessageKnock {
  readonly source: 'message'
  readonly sender: string | null
  readonly conversationId: string | null
  readonly messageId: string | null
}

export interface ConnectKnock {
  readonly source: 'connect'
}

export type Knock = MessageKnock | ConnectKnock

export interface InviteKnock {
  readonly inviteId: string
  readonly groupId: string | null
  readonly groupName: string | null
  readonly inviterHandle: string | null
}

export interface DoorbellSocketEvents {
  knock: (knock: Knock) => void
  invite: (invite: InviteKnock) => void
  /** This agent's own outbound, echoed back by server fan-out. Not a knock. */
  echo: () => void
  state: (state: SocketState, previous: SocketState) => void
  /** The server answered the capability negotiation. */
  ack: (negotiated: boolean) => void
  /** Auth refused. The holder decides what happens next; the socket stays stopped. */
  terminal: (reason: string) => void
}

export interface DoorbellSocketOptions {
  readonly url: string
  readonly apiKey: string
  /** This agent's handle, to recognise its own echo. Bare, any case. */
  readonly selfHandle: string
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

export class DoorbellSocket extends EventEmitter {
  private ws: WebSocket | null = null
  private _state: SocketState = 'idle'
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private livenessTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private _ackNegotiated: boolean | null = null
  private readonly selfHandle: string

  constructor(private readonly options: DoorbellSocketOptions) {
    super()
    this.selfHandle = options.selfHandle.trim().replace(/^@/, '').toLowerCase()
  }

  get state(): SocketState {
    return this._state
  }

  /** True only while the socket is live. */
  get connected(): boolean {
    return this._state === 'ready'
  }

  /** null until the server answered; then whether `ack` was echoed. */
  get ackNegotiated(): boolean | null {
    return this._ackNegotiated
  }

  override on<E extends keyof DoorbellSocketEvents>(event: E, listener: DoorbellSocketEvents[E]): this {
    return super.on(event, listener as (...args: unknown[]) => void)
  }

  start(): void {
    this.stopped = false
    this.open()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    this.setState('closed')
    if (this.ws) {
      try {
        this.ws.close(1000, 'doorbell shutdown')
      } catch {
        /* already closed */
      }
      this.ws = null
    }
  }

  private setState(next: SocketState): void {
    const prev = this._state
    if (prev === next) return
    this._state = next
    this.emit('state', next, prev)
  }

  private open(): void {
    if (this.stopped) return
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting')
    log.info(`doorbell socket ${this._state} (attempt ${this.attempt + 1})`)

    const ws = new WebSocket(this.options.url, {
      headers: {
        ...CODING_AGENTS_CLIENT_HEADERS,
        authorization: `Bearer ${this.options.apiKey}`,
        // Opt into the delivery-ack protocol: the server then leaves each
        // envelope `stored` until an ack — which this socket never sends.
        'x-agentchat-capabilities': 'ack',
      },
    })
    this.ws = ws

    ws.on('open', () => {
      this.attempt = 0
      this._ackNegotiated = null
      this.setState('ready')
      this.armLiveness()
      log.info('doorbell socket ready — connect is a knock')
      this.emit('knock', { source: 'connect' } satisfies ConnectKnock)
    })

    ws.on('message', (data) => {
      this.armLiveness()
      let frame: unknown
      try {
        frame = JSON.parse(data.toString())
      } catch {
        return // non-JSON frame — ignore
      }
      const record = asRecord(frame)
      if (record === null) return
      const type = record['type']
      if (type === 'message.new') {
        this.onMessageFrame(asRecord(record['payload']))
      } else if (type === 'group.invite.received') {
        this.onInviteFrame(asRecord(record['payload']))
      } else if (type === 'hello.ok') {
        const caps = Array.isArray(record['capabilities']) ? (record['capabilities'] as unknown[]) : []
        this._ackNegotiated = caps.includes('ack')
        log.info(`doorbell socket hello.ok — ack capability ${this._ackNegotiated ? 'negotiated' : 'NOT echoed (legacy server)'}`)
        this.emit('ack', this._ackNegotiated)
      } else {
        log.debug(`doorbell socket frame ${String(type)} — not a knock`)
      }
    })

    ws.on('ping', () => this.armLiveness()) // `ws` auto-pongs; just refresh liveness

    ws.on('unexpected-response', (_req, res) => {
      if (this.stopped) return
      if (res.statusCode === 401 || res.statusCode === 403) {
        this.clearTimers()
        this.setState('terminal')
        const reason = `auth rejected (${res.statusCode}) — check the agent's API key`
        log.error(`doorbell socket ${reason}`)
        this.emit('terminal', reason)
        return
      }
      log.warn(`doorbell socket unexpected response ${res.statusCode} — will reconnect`)
    })

    ws.on('error', (err) => {
      log.warn(`doorbell socket error: ${String(err)}`)
      // 'close' fires after 'error'; reconnect is scheduled there.
    })

    ws.on('close', (code) => {
      if (this._state === 'terminal' || this.stopped) return
      log.warn(`doorbell socket closed (${code}) — scheduling reconnect`)
      this.scheduleReconnect()
    })
  }

  /**
   * A `message.new` frame. Only the sender (echo filter) and the ids (log
   * line) are read. `content`, `metadata`, previews — never touched.
   */
  private onMessageFrame(payload: Record<string, unknown> | null): void {
    if (payload === null) {
      log.warn('doorbell socket: message.new without an object payload — dropped')
      return
    }
    const senderRaw = stringField(payload, ['sender', 'sender_handle', 'from'])
    const sender = senderRaw === null ? null : senderRaw.replace(/^@/, '').toLowerCase()
    const messageId = stringField(payload, ['id'])
    const conversationId = stringField(payload, ['conversation_id'])
    if (sender !== null && sender === this.selfHandle) {
      log.debug(`doorbell socket: own echo in ${conversationId ?? '?'} — not a knock`)
      this.emit('echo')
      return
    }
    log.info(`knock — message.new conv=${conversationId ?? '?'} msg=${messageId ?? '?'} from=@${sender ?? '?'}`)
    this.emit('knock', { source: 'message', sender, conversationId, messageId } satisfies MessageKnock)
  }

  private onInviteFrame(payload: Record<string, unknown> | null): void {
    if (payload === null) {
      log.warn('doorbell socket: group.invite.received without an object payload — dropped')
      return
    }
    const inviteId = stringField(payload, ['invite_id', 'id'])
    if (inviteId === null) {
      log.warn('doorbell socket: group invite without an invite id — dropped')
      return
    }
    const invite: InviteKnock = {
      inviteId,
      groupId: stringField(payload, ['group_id', 'conversation_id']),
      groupName: stringField(payload, ['group_name', 'name']),
      inviterHandle: stringField(payload, ['inviter_handle', 'inviter', 'from']),
    }
    log.info(`knock — group invite ${invite.inviteId} to ${invite.groupId ?? '?'} from=@${invite.inviterHandle ?? '?'}`)
    this.emit('invite', invite)
  }

  private scheduleReconnect(): void {
    if (this.stopped || this._state === 'terminal') return
    // A liveness timeout terminates the socket and may race its `close` event.
    // Both paths request a reconnect; one timer is enough.
    if (this.reconnectTimer) return
    this.setState('reconnecting')
    this.clearTimers()
    const nextAttempt = this.attempt + 1
    if (nextAttempt > RECONNECT_HARD_CAP_ATTEMPTS) {
      const reason = `reconnect hard cap (${RECONNECT_HARD_CAP_ATTEMPTS}) reached`
      this.setState('terminal')
      log.error(`doorbell socket ${reason}`)
      this.emit('terminal', reason)
      return
    }
    const backoff = Math.min(BASE_BACKOFF_MS * 2 ** Math.min(this.attempt, 20), MAX_BACKOFF_MS)
    const jitter = backoff * (0.5 + Math.random() * 0.5) // 50–100% of backoff
    this.attempt = nextAttempt
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, jitter)
  }

  private armLiveness(): void {
    if (this.livenessTimer) clearTimeout(this.livenessTimer)
    this.livenessTimer = setTimeout(() => {
      log.warn('doorbell socket liveness timeout — forcing reconnect')
      try {
        this.ws?.terminate()
      } catch {
        /* ignore */
      }
      this.scheduleReconnect()
    }, LIVENESS_MS)
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.livenessTimer) {
      clearTimeout(this.livenessTimer)
      this.livenessTimer = null
    }
  }
}
