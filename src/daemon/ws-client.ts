import { WebSocket } from 'ws'
import { EventEmitter } from 'node:events'
import { log } from '../util/log.js'
import { parseInbound, type SyncRow } from './frames.js'

// ─── Agent WebSocket client ─────────────────────────────────────────────────
//
// Connects to /v1/ws as the agent (Bearer auth). The server drains undelivered
// as `message.new` frames on connect AND pushes them in real time. The `ws`
// library auto-pongs the server's heartbeat pings, which keeps presence alive.
// We add reconnect with exponential backoff + jitter, a liveness watchdog, and
// a terminal state for auth failure so a bad key doesn't reconnect forever.

type State = 'connecting' | 'ready' | 'reconnecting' | 'terminal' | 'closed'

const BASE_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 60_000
// If no frame/ping arrives for this long, treat the socket as dead. The server
// pings every 45s, so ~2 missed cycles.
const LIVENESS_MS = 100_000

export interface WsClientEvents {
  inbound: (row: SyncRow) => void
  ready: () => void
  terminal: (reason: string) => void
}

export class AgentWsClient extends EventEmitter {
  private ws: WebSocket | null = null
  private state: State = 'closed'
  private attempt = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private livenessTimer: NodeJS.Timeout | null = null
  private stopped = false
  private ackMode = false

  constructor(
    private readonly url: string,
    private readonly apiKey: string,
  ) {
    super()
  }

  /** True only while the socket is live and ready. The heartbeat writer keys
   *  off this, so a reconnecting/terminal daemon lets its heartbeat go stale
   *  and the next session detects that always-on is actually down. */
  get connected(): boolean {
    return this.state === 'ready'
  }

  start(): void {
    this.stopped = false
    this.open()
  }

  stop(): void {
    this.stopped = true
    this.state = 'closed'
    this.clearTimers()
    if (this.ws) {
      try {
        this.ws.close(1000, 'daemon shutdown')
      } catch {
        /* already closed */
      }
      this.ws = null
    }
  }

  getState(): State {
    return this.state
  }

  /**
   * Confirm a message as handled: `{"type":"ack","message_id":"msg_..."}`.
   * Fire-and-forget by design — a dropped ack is loss-free (the delivery
   * stays 'stored' and re-drains on the next reconnect, where dedup absorbs
   * the replay). Acking by message id (not delivery id) is what lets a
   * real-time push — which carries no delivery_id — be acked at all.
   */
  ack(messageId: string): void {
    if (this.state !== 'ready' || !this.ws) return
    try {
      this.ws.send(JSON.stringify({ type: 'ack', message_id: messageId }))
    } catch (err) {
      log.debug(`ack send failed for ${messageId} (will re-drain): ${String(err)}`)
    }
  }

  private open(): void {
    if (this.stopped) return
    this.state = this.attempt === 0 ? 'connecting' : 'reconnecting'
    log.info(`ws ${this.state} (attempt ${this.attempt + 1}) → ${this.url}`)

    const ws = new WebSocket(this.url, {
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        // Opt into the delivery-ack protocol: the server then leaves each
        // delivery 'stored' until we ack it (by message id) instead of
        // marking it delivered the instant it hits the socket. A crash
        // mid-turn therefore re-drains on reconnect — at-least-once.
        'x-agentchat-capabilities': 'ack',
      },
    })
    this.ws = ws

    ws.on('open', () => {
      this.attempt = 0
      this.state = 'ready'
      this.armLiveness()
      log.info('ws ready — draining + listening')
      this.emit('ready')
    })

    ws.on('message', (data) => {
      this.armLiveness()
      let frame: unknown
      try {
        frame = JSON.parse(data.toString())
      } catch {
        return // non-JSON frame — ignore
      }
      const f = frame as { type?: string; payload?: unknown; capabilities?: unknown }
      if (f?.type === 'message.new') {
        const row = parseInbound(f.payload)
        if (row) this.emit('inbound', row)
        else log.warn(`message.new payload failed to parse: ${JSON.stringify(f.payload).slice(0, 300)}`)
      } else if (f?.type === 'hello.ok') {
        const caps = Array.isArray(f.capabilities) ? (f.capabilities as string[]) : []
        this.ackMode = caps.includes('ack')
        log.info(`ws hello.ok — ack-mode ${this.ackMode ? 'ON' : 'OFF (legacy)'}`)
      } else {
        log.debug(`ws frame: ${f?.type}`)
      }
      // presence.update, typing.* etc. — not acted on here.
    })

    ws.on('ping', () => this.armLiveness()) // ws auto-pongs; just refresh liveness

    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401 || res.statusCode === 403) {
        this.state = 'terminal'
        this.clearTimers()
        const reason = `auth rejected (${res.statusCode}) — check the agent's API key`
        log.error(`ws ${reason}`)
        this.emit('terminal', reason)
        return
      }
      log.warn(`ws unexpected response ${res.statusCode} — will reconnect`)
    })

    ws.on('error', (err) => {
      log.warn(`ws error: ${String(err)}`)
      // 'close' fires after 'error'; reconnect is scheduled there.
    })

    ws.on('close', (code) => {
      if (this.state === 'terminal' || this.stopped) return
      log.warn(`ws closed (${code}) — scheduling reconnect`)
      this.scheduleReconnect()
    })
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.state === 'terminal') return
    this.state = 'reconnecting'
    this.clearTimers()
    const backoff = Math.min(BASE_BACKOFF_MS * 2 ** this.attempt, MAX_BACKOFF_MS)
    const jitter = backoff * (0.5 + Math.random() * 0.5) // 50–100% of backoff
    this.attempt++
    this.reconnectTimer = setTimeout(() => this.open(), jitter)
  }

  private armLiveness(): void {
    if (this.livenessTimer) clearTimeout(this.livenessTimer)
    this.livenessTimer = setTimeout(() => {
      log.warn('ws liveness timeout — forcing reconnect')
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
