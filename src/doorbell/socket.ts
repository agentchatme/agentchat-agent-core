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
//   * `hello.ok`               → the connection is live (`ready`). NOT a knock
//                                by itself: the holder decides whether anything
//                                is waiting (the server re-offers stored
//                                envelopes as `message.new` frames right after
//                                it, and the doorbell reads two counts).
//
// AUTHENTICATION, as the server actually does it (`apps/api-server/src/ws/
// agent-socket.ts`): a bad bearer is NOT answered with HTTP 401 on `/v1/ws`.
// The upgrade completes and `onOpen` closes the socket with 1008 'Invalid
// token'; `hello.ok` is never sent. A good bearer gets `hello.ok` as the first
// frame (always: this socket always sends the capabilities header, and the
// server echoes when the header is present). So the only moment a credential
// is known to be accepted is `hello.ok`, and a close with an auth code before
// it is a refused credential — terminal, never retried. The server uses the
// same 1008 after authentication to evict a rotated key or a suspended
// account; that close reconnects once, and the next attempt is refused before
// `hello.ok`, so it converges on the same terminal state.
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
// unreachable. Not a credential problem: the holder opens a fresh socket after
// its own backoff (`terminal` with reason `cap`).
const RECONNECT_HARD_CAP_ATTEMPTS = 500
// The opening handshake must complete within this. `ws` has no default, and a
// half-open upgrade (a load balancer that accepted TCP and went quiet) would
// otherwise hang the socket forever with liveness not yet armed.
const HANDSHAKE_TIMEOUT_MS = 15_000
// Close codes the server uses for a refused credential: 1008 'Invalid token'
// (policy violation), and the 4401/4403 application codes. Terminal only when
// they arrive BEFORE `hello.ok` — see the header.
const AUTH_CLOSE_CODES: ReadonlySet<number> = new Set([1008, 4401, 4403])

export interface MessageKnock {
  readonly source: 'message'
  readonly sender: string | null
  readonly conversationId: string | null
  readonly messageId: string | null
}

export type Knock = MessageKnock

export interface InviteKnock {
  readonly inviteId: string
  readonly groupId: string | null
  readonly groupName: string | null
  readonly inviterHandle: string | null
}

/**
 * Why the socket gave up. `auth`: the server refused the credential — sit out
 * until it changes. `cap`: the reconnect hard cap was reached — the control
 * plane is unreachable, not the key; open a fresh socket after a backoff.
 */
export type TerminalReason = 'auth' | 'cap'

export interface DoorbellSocketEvents {
  knock: (knock: Knock) => void
  invite: (invite: InviteKnock) => void
  /** This agent's own outbound, echoed back by server fan-out. Not a knock. */
  echo: () => void
  state: (state: SocketState, previous: SocketState) => void
  /**
   * `hello.ok` arrived: the credential is accepted and the connection is live.
   * Once per connection, after `state` → `ready`. The holder's connect-time
   * catch-up hangs off this, not off the TCP `open`.
   */
  ready: () => void
  /** The server answered the capability negotiation. */
  ack: (negotiated: boolean) => void
  /** The socket gave up and stays stopped. The holder decides what happens next. */
  terminal: (reason: TerminalReason, detail: string) => void
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
  /** `hello.ok` seen on the CURRENT connection. Reset on every open. */
  private helloOk = false
  private readonly selfHandle: string

  constructor(private readonly options: DoorbellSocketOptions) {
    super()
    this.selfHandle = options.selfHandle.trim().replace(/^@/, '').toLowerCase()
  }

  get state(): SocketState {
    return this._state
  }

  /** True only while the socket is live — `hello.ok` received, not merely open. */
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
    // A socket that gave up stays `terminal`: stopping it afterwards (the
    // holder does, on `terminal`) must not dress a refused key up as a clean
    // close in `status`.
    if (this._state !== 'terminal') this.setState('closed')
    const ws = this.ws
    this.ws = null
    if (ws) {
      try {
        ws.close(1000, 'doorbell shutdown')
      } catch {
        /* already closed */
      }
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
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    })
    this.ws = ws
    this.helloOk = false
    this._ackNegotiated = null

    // Every handler checks that it still speaks for the current socket. A
    // stale instance's late `close` (after a liveness terminate, after an
    // aborted handshake) must not schedule a second reconnect or flip state.
    const current = (): boolean => this.ws === ws

    ws.on('open', () => {
      if (!current()) return
      // Open is not ready: a refused credential completes the upgrade too.
      // The attempt counter stands until `hello.ok` says the key is good, so a
      // refused key that somehow kept closing without an auth code would still
      // back off instead of storming.
      this.armLiveness()
      log.info('doorbell socket open — waiting for hello.ok')
    })

    ws.on('message', (data) => {
      if (!current()) return
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
      if (type === 'hello.ok') {
        this.onHelloOk(record)
      } else if (type === 'message.new') {
        this.onMessageFrame(asRecord(record['payload']))
      } else if (type === 'group.invite.received') {
        this.onInviteFrame(asRecord(record['payload']))
      } else {
        log.debug(`doorbell socket frame ${String(type)} — not a knock`)
      }
    })

    ws.on('ping', () => {
      if (current()) this.armLiveness() // `ws` auto-pongs; just refresh liveness
    })

    ws.on('unexpected-response', (req, res) => {
      if (!current()) return
      // With a listener on this event `ws` does NOT abort the handshake itself
      // (lib/websocket.js: `abortHandshake` runs only when nobody listens), so
      // neither `error` nor `close` would follow and the socket would hang in
      // CONNECTING forever with nothing armed. Tear the request down here and
      // decide the next step explicitly.
      const status = res.statusCode ?? 0
      try {
        res.resume()
        req.destroy()
      } catch {
        /* already gone */
      }
      this.ws = null
      if (this.stopped) return
      if (status === 401 || status === 403) {
        // Not a path the AgentChat server takes on `/v1/ws` (it closes 1008
        // after the upgrade instead), but a proxy in front of it might.
        this.enterTerminal('auth', `auth rejected (HTTP ${status}) — check the agent's API key`)
        return
      }
      // 502/503 during a deploy, 429, 500: transient. Reconnect with backoff.
      log.warn(`doorbell socket unexpected response ${status} — scheduling reconnect`)
      this.scheduleReconnect()
    })

    ws.on('error', (err) => {
      if (!current()) return
      log.warn(`doorbell socket error: ${String(err)}`)
      // 'close' fires after 'error'; reconnect is scheduled there.
    })

    ws.on('close', (code, reasonBuffer) => {
      if (!current()) return
      this.ws = null
      if (this._state === 'terminal' || this.stopped) return
      const reason = reasonBuffer.toString()
      if (!this.helloOk && AUTH_CLOSE_CODES.has(code)) {
        // The upgrade completed and the server closed before saying hello:
        // this is how `/v1/ws` refuses a credential. Never retried — a retry
        // loop here would start a paid headless run per attempt against a key
        // every hosted tool rejects.
        this.enterTerminal('auth', `auth rejected (close ${code}${reason ? ` ${reason}` : ''}) — check the agent's API key`)
        return
      }
      log.warn(`doorbell socket closed (${code}${reason ? ` ${reason}` : ''}) — scheduling reconnect`)
      this.scheduleReconnect()
    })
  }

  /** The server accepted the credential and echoed the capability set. */
  private onHelloOk(record: Record<string, unknown>): void {
    const caps = Array.isArray(record['capabilities']) ? (record['capabilities'] as unknown[]) : []
    this._ackNegotiated = caps.includes('ack')
    const first = !this.helloOk
    this.helloOk = true
    // Only now is the key known to be good: reset the backoff and go ready.
    this.attempt = 0
    this.setState('ready')
    log.info(`doorbell socket hello.ok — ack capability ${this._ackNegotiated ? 'negotiated' : 'NOT echoed (legacy server)'}`)
    this.emit('ack', this._ackNegotiated)
    if (first) this.emit('ready')
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

  /** Give up. The socket stays stopped; the holder decides what happens next. */
  private enterTerminal(reason: TerminalReason, detail: string): void {
    this.clearTimers()
    this.ws = null
    this.setState('terminal')
    log.error(`doorbell socket terminal (${reason}): ${detail}`)
    this.emit('terminal', reason, detail)
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
      this.enterTerminal('cap', `reconnect hard cap (${RECONNECT_HARD_CAP_ATTEMPTS} attempts) reached — the control plane is unreachable from here`)
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
      const ws = this.ws
      this.ws = null
      try {
        ws?.terminate()
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
