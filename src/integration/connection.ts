import { EventEmitter } from 'node:events'
import { RealtimeClient, type WakeFrame, type WsMessage } from 'agentchatme'
import { log } from '../util/log.js'
import { clientIdentityOf, type IntegrationClient } from '../client-identity.js'
import { normalizeHandle } from '../skill/identity-line.js'
import { livenessWebSocket } from './transport.js'
import type { SocketState } from './status.js'

// ─── The connection: the SDK's socket, read as wakes ────────────────────────
//
// The socket is the SDK's `RealtimeClient` — hello, capabilities, acks,
// reconnect backoff, frame validation all live there, once, for every
// AgentChat integration. With `ackOnReceipt` it acknowledges every
// `message.new` the moment the frame is parsed: DELIVERED means this machine
// received the message. Whether the agent has looked is read state, which only
// the agent's own verdict inside its run changes; an early ack never empties
// the tray (docs/architecture.md, rule 5).
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
//
// A refused credential, the way the server refuses one: the upgrade
// completes, the hello is answered with close 1008 'Invalid token', no
// `hello.ok`. The SDK stops reconnecting on 1008/4401/4403 — the right call
// for a bad key, but it also stops on a 1008 that is not one (the server's own
// 'HELLO frame required' racing a slow handshake). So a close with one of
// those codes is read here by the server's reason: a refused or revoked
// credential is `terminal` (the supervisor sits the key out until it
// changes); anything else gets a fresh client after a backoff. Everything
// below those codes the SDK reconnects on its own.
//
// Liveness is the transport's job (`transport.ts`): a dead pipe is terminated
// there, and the SDK reconnects as on any close.

/** Close codes the SDK treats as terminal (it stops reconnecting). */
const SDK_TERMINAL_CLOSE_CODES: ReadonlySet<number> = new Set([1008, 4401, 4403])
/** The reason the SDK puts on its own transient 1008 (hello.ok did not arrive in time). */
const SDK_HELLO_TIMEOUT_REASON = 'HELLO ack timeout'
/**
 * The server's reasons for closing 1008 on a credential that will not work
 * again: refused before hello.ok, or evicted after it. Anything else on 1008
 * is a handshake-timing close, not a verdict on the key.
 */
const CREDENTIAL_CLOSE_REASONS: ReadonlySet<string> = new Set([
  'Invalid token',
  'API key rotated',
  'Account suspended',
  'Account deleted',
])
const REOPEN_BASE_MS = 5_000
const REOPEN_MAX_MS = 60_000
const SDK_RECONNECT_INTERVAL_MS = 1_000
const SDK_MAX_RECONNECT_INTERVAL_MS = 60_000

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

/** Why the connection gave up: the server refused or revoked the credential — sit out until it changes. */
export type TerminalReason = 'auth'

export interface IntegrationConnectionEvents {
  wake: (wake: Wake) => void
  invite: (invite: InviteWake) => void
  /** This agent's own outbound, echoed back by server fan-out. Not a wake. */
  echo: () => void
  state: (state: SocketState, previous: SocketState) => void
  /** `hello.ok` arrived: the connection is live. Once per (re)connection, after `state` → `ready`. */
  ready: () => void
  /** The connection gave up and stays stopped. The holder decides what happens next. */
  terminal: (reason: TerminalReason, detail: string) => void
}

export interface IntegrationConnectionOptions {
  readonly apiKey: string
  /** `wss://api.agentchat.me` — the SDK appends `/v1/ws`. */
  readonly wsBase: string
  /** This agent's handle, to recognise its own echo. Bare, any case. */
  readonly selfHandle: string
  readonly client: IntegrationClient
  /** Test seam: the WebSocket constructor. Defaults to the liveness-bounded `ws` transport. */
  readonly webSocket?: typeof globalThis.WebSocket
  readonly reconnectIntervalMs?: number
  readonly maxReconnectIntervalMs?: number
  readonly reopenBaseMs?: number
  readonly reopenMaxMs?: number
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
  private readyOnThisConnection = false
  private reopenTimer: ReturnType<typeof setTimeout> | null = null
  private reopens = 0
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

  start(): void {
    this.stopped = false
    this.open()
  }

  stop(): void {
    this.stopped = true
    this.clearReopen()
    // A connection that gave up stays `terminal`: stopping it afterwards (the
    // holder does, on `terminal`) must not dress a refused key up as a clean
    // close in `status`.
    if (this._state !== 'terminal') this.setState('closed')
    this.disposeClient()
  }

  private setState(next: SocketState): void {
    const prev = this._state
    if (prev === next) return
    this._state = next
    this.emit('state', next, prev)
  }

  private open(): void {
    if (this.stopped) return
    this.setState(this.reopens === 0 ? 'connecting' : 'reconnecting')
    log.info(`socket ${this._state}${this.reopens > 0 ? ` (fresh client ${this.reopens + 1})` : ''}`)

    const rt = new RealtimeClient({
      apiKey: this.options.apiKey,
      baseUrl: this.options.wsBase,
      clientIdentity: clientIdentityOf(this.options.client),
      // Delivered = this machine received it. Acked at parse time, before
      // anything here runs; read state is the agent's verdict, separately.
      ackOnReceipt: true,
      reconnect: true,
      reconnectInterval: this.options.reconnectIntervalMs ?? SDK_RECONNECT_INTERVAL_MS,
      maxReconnectInterval: this.options.maxReconnectIntervalMs ?? SDK_MAX_RECONNECT_INTERVAL_MS,
      webSocket: this.options.webSocket ?? livenessWebSocket(),
    })
    this.rt = rt
    this.readyOnThisConnection = false

    // Every handler checks that it still speaks for the current client. A
    // disposed client's late `close` must not flip state or schedule a reopen.
    const current = (): boolean => this.rt === rt

    rt.onConnect(() => {
      if (!current()) return
      this.readyOnThisConnection = true
      this.reopens = 0
      this.setState('ready')
      log.info('socket ready (hello.ok) — acks on receipt')
      this.emit('ready')
    })
    rt.onDisconnect(({ code, reason }) => {
      if (!current()) return
      const wasReady = this.readyOnThisConnection
      this.readyOnThisConnection = false
      if (this.stopped) return
      this.onClose(code, reason, wasReady)
    })
    rt.onError((err) => {
      if (!current() || this.stopped) return
      log.warn(`socket: ${err.message}`)
    })
    rt.on('message.new', (message) => {
      if (current()) this.onMessageFrame(message)
    })
    rt.on('wake', (frame) => {
      if (current()) this.onWakeFrame(frame)
    })
    rt.on('group.invite.received', (message) => {
      if (current()) this.onInviteFrame(message)
    })

    rt.connect().catch((err: unknown) => {
      // The SDK rejects only when no WebSocket could be constructed; it does
      // not retry that itself when the constructor is injected.
      if (!current() || this.stopped) return
      log.warn(`socket could not be opened (${err instanceof Error ? err.message : String(err)}) — fresh client after a backoff`)
      this.reopenAfterBackoff()
    })
  }

  private onClose(code: number, reason: string, wasReady: boolean): void {
    if (SDK_TERMINAL_CLOSE_CODES.has(code) && reason !== SDK_HELLO_TIMEOUT_REASON) {
      // The SDK has stopped reconnecting. Whether that is right is the
      // server's reason to say.
      if (code !== 1008 || CREDENTIAL_CLOSE_REASONS.has(reason)) {
        this.enterTerminal(
          'auth',
          `auth rejected (close ${code}${reason ? ` ${reason}` : ''}${wasReady ? ', after hello.ok' : ''}) — check the agent's API key`,
        )
        return
      }
      log.warn(
        `socket closed ${code}${reason ? ` ${reason}` : ''} ${wasReady ? 'after' : 'before'} hello.ok — not a refused key; fresh client after a backoff`,
      )
      this.reopenAfterBackoff()
      return
    }
    log.warn(`socket closed (${code}${reason ? ` ${reason}` : ''}) — the SDK reconnects with backoff`)
    this.setState('reconnecting')
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

  /** Give up. The connection stays stopped; the holder decides what happens next. */
  private enterTerminal(reason: TerminalReason, detail: string): void {
    this.clearReopen()
    this.disposeClient()
    this.setState('terminal')
    log.error(`socket terminal (${reason}): ${detail}`)
    this.emit('terminal', reason, detail)
  }

  /** Replace the SDK client after a backoff: it stopped on a close that was not a verdict on the key. */
  private reopenAfterBackoff(): void {
    if (this.stopped || this.reopenTimer !== null) return
    this.setState('reconnecting')
    this.disposeClient()
    const base = this.options.reopenBaseMs ?? REOPEN_BASE_MS
    const max = this.options.reopenMaxMs ?? REOPEN_MAX_MS
    const backoff = Math.min(base * 2 ** Math.min(this.reopens, 6), max)
    const jitter = backoff * (0.5 + Math.random() * 0.5)
    this.reopens += 1
    this.reopenTimer = setTimeout(() => {
      this.reopenTimer = null
      this.open()
    }, jitter)
  }

  private clearReopen(): void {
    if (this.reopenTimer !== null) {
      clearTimeout(this.reopenTimer)
      this.reopenTimer = null
    }
  }

  private disposeClient(): void {
    const rt = this.rt
    this.rt = null
    if (rt === null) return
    try {
      rt.disconnect()
    } catch {
      /* already closed */
    }
  }
}
