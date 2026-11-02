import * as http from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'

// ─── A server double on localhost, faithful where it matters ────────────────
//
// Models `/v1/ws` the way apps/api-server/src/ws/agent-socket.ts behaves:
//   * `hello`  — a good key: the upgrade completes and `hello.ok` echoing the
//                accepted capabilities is the first frame.
//   * `refuse` — a bad key: the upgrade COMPLETES, then the server closes
//                1008 'Invalid token'. No HTTP 401, no hello.ok. This is the
//                production path a reconnect storm hides behind.
//   * a number — the upgrade is answered with that HTTP status (what a load
//                balancer does mid-deploy: 502/503, or a 401 from a proxy).
// After `hello.ok` the double can replay `drain` frames on every connection,
// the way `ws/handler.ts` `drainUndelivered` re-offers every stored envelope
// (deferred ones included) as a plain `message.new`.
// And the two reads the doorbell makes over HTTP:
//   * GET /v1/inbox?wait_ms=0&limit=N  → a tray with `waiting` cards (and a
//                                        `deferred` count the cards exclude)
//   * GET /v1/groups/invites           → the configured pending invites
// Every frame a client sends after the upgrade is recorded, so a test can
// assert the list stays EMPTY.

export type UpgradeMode = 'hello' | 'refuse' | number

export interface Tray {
  waiting: number
  truncated?: boolean
  deferred?: number
}

export interface ServerDoubleOptions {
  upgrade?: UpgradeMode
  helloCapabilities?: readonly string[]
  /** Cards on the tray; `truncated` when more wait than one page shows; `deferred` hidden from the cards. */
  tray?: Tray
  /** Frames sent right after `hello.ok` on every connection (the server's connect-time drain). */
  drain?: readonly unknown[]
  invites?: ReadonlyArray<{ id: string; group_id?: string; group_name?: string; inviter_handle?: string }>
}

export interface Served {
  headers: http.IncomingHttpHeaders
  socket: WebSocket
  clientFrames: string[]
}

export interface ServerDouble {
  readonly apiBase: string
  readonly wsUrl: string
  /** Every completed upgrade, in order. */
  readonly served: Served[]
  /** Every upgrade attempt, completed or answered with a status. */
  upgrades: number
  /** HTTP paths requested (with query), in order. */
  readonly requests: string[]
  /** Change how the NEXT upgrade is answered. */
  setUpgrade(mode: UpgradeMode): void
  setTray(tray: Tray): void
  /** Push a frame to the most recent live socket. */
  send(frame: unknown): void
  close(): Promise<void>
}

export async function startServerDouble(options: ServerDoubleOptions = {}): Promise<ServerDouble> {
  let mode: UpgradeMode = options.upgrade ?? 'hello'
  let tray: Tray = options.tray ?? { waiting: 0 }
  const drain = options.drain ?? []
  const invites = options.invites ?? []
  const caps = options.helloCapabilities ?? ['ack']
  const served: Served[] = []
  const requests: string[] = []

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    requests.push(`${url.pathname}${url.search}`)
    res.setHeader('content-type', 'application/json')
    if (url.pathname === '/v1/inbox') {
      const limit = Number(url.searchParams.get('limit') ?? '20')
      const cards = Array.from({ length: Math.min(tray.waiting, limit) }, (_, i) => ({
        conversation_id: `conv_${i}`,
        preview: 'A PREVIEW THAT MUST NEVER BE LOGGED',
      }))
      res.end(
        JSON.stringify({
          you: '@me',
          question: 'q',
          categories: [],
          conversations: cards,
          deferred: tray.deferred ?? 0,
          truncated: tray.truncated ?? tray.waiting > limit,
          waited_ms: null,
        }),
      )
      return
    }
    if (url.pathname === '/v1/groups/invites') {
      res.end(JSON.stringify(invites.map((i) => ({ group_id: null, group_name: null, inviter_handle: null, ...i }))))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })

  const wss = new WebSocketServer({ noServer: true })
  const double: ServerDouble = {
    apiBase: '',
    wsUrl: '',
    served,
    upgrades: 0,
    requests,
    setUpgrade: (next) => {
      mode = next
    },
    setTray: (next) => {
      tray = next
    },
    send: (frame) => {
      const last = served[served.length - 1]
      if (!last) throw new Error('no live socket to send on')
      last.socket.send(JSON.stringify(frame))
    },
    close: async () => {
      for (const entry of served) entry.socket.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }

  server.on('upgrade', (req, socket, head) => {
    double.upgrades += 1
    if (typeof mode === 'number') {
      const text = http.STATUS_CODES[mode] ?? 'Unexpected'
      socket.write(`HTTP/1.1 ${mode} ${text}\r\nContent-Type: text/plain\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
      socket.end()
      return
    }
    const decided = mode
    wss.handleUpgrade(req, socket, head, (ws) => {
      const entry: Served = { headers: req.headers, socket: ws, clientFrames: [] }
      ws.on('message', (data) => entry.clientFrames.push(data.toString()))
      served.push(entry)
      if (decided === 'refuse') {
        // agent-socket.ts: bad bearer → onOpen closes 1008; nothing else is sent.
        ws.close(1008, 'Invalid token')
        return
      }
      ws.send(JSON.stringify({ type: 'hello.ok', capabilities: caps }))
      for (const frame of drain) ws.send(JSON.stringify(frame))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('no address')
  Object.assign(double, { apiBase: `http://127.0.0.1:${address.port}`, wsUrl: `ws://127.0.0.1:${address.port}/v1/ws` })
  return double
}

export const until = async (cond: () => boolean, ms = 3_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}

export const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
