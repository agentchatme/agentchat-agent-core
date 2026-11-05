import { WebSocket as WsWebSocket } from 'ws'
import { log } from '../util/log.js'

// ─── The transport's health, bounded ────────────────────────────────────────
//
// The SDK's `RealtimeClient` speaks the protocol: hello, capabilities, acks,
// frames, reconnect backoff. This class parses nothing and sends nothing. It
// only knows when the PIPE is dead, which the browser-shaped WebSocket API the
// SDK consumes cannot tell it:
//
//   * The opening handshake must complete within `handshakeTimeoutMs`. `ws`
//     has no default, and a half-open upgrade (a load balancer that accepted
//     TCP and went quiet) would otherwise hang a connection forever with
//     nothing armed.
//   * The server pings every 45 s and `ws` answers on its own. If nothing at
//     all arrives for `livenessMs` — no frame, no ping — the socket is
//     terminated so the SDK sees a close and reconnects. A laptop that slept,
//     roamed Wi-Fi or lost its NAT mapping otherwise sits on a dead TCP
//     connection for as long as the OS keepalive allows, looking `ready`.
//
// Injected into the SDK through its `webSocket` option, which exists for
// exactly this: a host-supplied constructor with the browser shape.

export const HANDSHAKE_TIMEOUT_MS = 15_000
/** ~2 missed server ping cycles. */
export const LIVENESS_MS = 100_000

export interface TransportOptions {
  readonly handshakeTimeoutMs?: number
  readonly livenessMs?: number
}

export function livenessWebSocket(options: TransportOptions = {}): typeof globalThis.WebSocket {
  const handshakeTimeout = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS
  const livenessMs = options.livenessMs ?? LIVENESS_MS

  class LivenessWebSocket extends WsWebSocket {
    private liveness: ReturnType<typeof setTimeout> | null = null

    constructor(url: string | URL, protocols?: string | string[]) {
      if (protocols === undefined) super(url, { handshakeTimeout })
      else super(url, protocols, { handshakeTimeout })
      const arm = (): void => {
        if (this.liveness !== null) clearTimeout(this.liveness)
        this.liveness = setTimeout(() => {
          this.liveness = null
          log.warn(
            `socket liveness timeout (${livenessMs >= 10_000 ? `${Math.round(livenessMs / 1000)} s` : `${livenessMs} ms`} without a frame or a ping) — terminating so the SDK reconnects`,
          )
          try {
            this.terminate()
          } catch {
            /* already gone */
          }
        }, livenessMs)
        this.liveness.unref()
      }
      this.on('open', arm)
      this.on('message', arm)
      this.on('ping', arm)
      this.on('pong', arm)
      this.on('close', () => {
        if (this.liveness !== null) clearTimeout(this.liveness)
        this.liveness = null
      })
    }
  }

  return LivenessWebSocket as unknown as typeof globalThis.WebSocket
}
