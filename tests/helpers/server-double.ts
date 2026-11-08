import * as http from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { textsFor } from './served-texts.js'

// ─── A server double on localhost, faithful where it matters ────────────────
//
// Models `/v1/ws` the way apps/api-server/src/ws/agent-socket.ts behaves on
// the HELLO path the SDK's RealtimeClient uses (a browser-shaped socket cannot
// set headers, so the key rides in the first frame):
//   * the upgrade completes; the client sends `{type:'hello', api_key,
//     capabilities, client, client_version}`;
//   * `hello`         — a good key: `hello.ok` echoing the accepted
//                       capabilities is the first server frame;
//   * `refuse`        — a bad key: close 1008 'Invalid token', no hello.ok.
//                       This is the production path a reconnect storm hides
//                       behind;
//   * `hello-required`— the server's handshake timer won the race: close 1008
//                       'HELLO frame required' (NOT a verdict on the key);
//   * a number        — the upgrade is answered with that HTTP status (what a
//                       load balancer does mid-deploy: 502/503).
// After `hello.ok` the double can replay `drain` frames on every connection,
// the way the server re-offers unacked envelopes right after the hello.
// Every frame a client sends after the hello is recorded (`clientFrames`) —
// the acks the SDK sends on receipt are what the tests look for there.
//
// And the reads the integration makes over HTTP, through the SDK:
//   * GET /v1/inbox?limit=N        → a tray with `waiting` cards (and a
//                                    `deferred` count the cards exclude)
//   * GET /v1/groups/invites       → the configured pending invites
//   * GET /v1/texts?runtime=R      → the served texts for R (or `textsStatus`)
// and, with `manual`, the manual the texts announce, at `<apiBase>/skill.md`
// (plain HTTP to loopback, which the manual download accepts for a local
// development server).

export type UpgradeMode = 'hello' | 'refuse' | 'hello-required' | number

export interface Tray {
  waiting: number
  truncated?: boolean
  deferred?: number
  /** The first `muted` cards are muted (they never wake; nothing is owed for them alone). */
  muted?: number
  /** Pending invites on the tray (contract v1, D4): ids. */
  invites?: string[]
}

export interface ServerDoubleOptions {
  upgrade?: UpgradeMode
  helloCapabilities?: readonly string[]
  /** Cards on the tray; `truncated` when more wait than one page shows; `deferred` hidden from the cards. */
  tray?: Tray
  /** Frames sent right after `hello.ok` on every connection (the server's connect-time re-offer). */
  drain?: readonly unknown[]
  invites?: ReadonlyArray<{ id: string; group_id?: string; group_name?: string; inviter_handle?: string }>
  /** HTTP status for GET /v1/texts; 200 serves the texts. */
  textsStatus?: number
  /** Announce this manual in the texts (url `<apiBase>/skill.md`) and serve `body` there. */
  manual?: ServedManualDouble
}

export interface ServedManualDouble {
  version: string
  body: string
}

export interface Served {
  /** The hello frame this connection authenticated with. */
  hello: Record<string, unknown> | null
  socket: WebSocket
  /** Every frame the client sent after its hello. */
  clientFrames: Array<Record<string, unknown>>
}

export interface ServerDouble {
  readonly apiBase: string
  /** `ws://127.0.0.1:<port>` — what the SDK takes as `baseUrl`. */
  readonly wsBase: string
  /** Every completed upgrade, in order. */
  readonly served: Served[]
  /** Every upgrade attempt, completed or answered with a status. */
  upgrades: number
  /** HTTP paths requested (with query), in order. */
  readonly requests: string[]
  /** Change how the NEXT upgrade is answered. */
  setUpgrade(mode: UpgradeMode): void
  setTray(tray: Tray): void
  setTextsStatus(status: number): void
  /** Announce (and serve) a different manual from the next texts fetch on. */
  setManual(manual: ServedManualDouble): void
  /** The Authorization header of every `/skill.md` request (undefined: none sent). */
  readonly manualAuth: Array<string | undefined>
  /** Push a frame to the most recent live socket. */
  send(frame: unknown): void
  /** Acks recorded across every connection. */
  acks(): string[]
  close(): Promise<void>
}

export async function startServerDouble(options: ServerDoubleOptions = {}): Promise<ServerDouble> {
  let mode: UpgradeMode = options.upgrade ?? 'hello'
  let tray: Tray = options.tray ?? { waiting: 0 }
  let textsStatus = options.textsStatus ?? 200
  const drain = options.drain ?? []
  const invites = options.invites ?? []
  const caps = options.helloCapabilities ?? ['ack']
  let manual = options.manual ?? null
  const manualAuth: Array<string | undefined> = []
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
        unread: 1,
        last_sender: '@peer',
        ...(i < (tray.muted ?? 0) ? { muted: true } : {}),
        preview: { message_id: `msg_${i}`, sender: '@peer', text: 'A PREVIEW THAT MUST NEVER BE LOGGED', at: new Date().toISOString() },
      }))
      res.end(
        JSON.stringify({
          version: 1,
          you: '@me',
          invites: (tray.invites ?? []).map((id) => ({ invite_id: id, group: { id: `grp_${id}`, name: 'A GROUP NAME', member_count: 2 }, invited_by: '@peer', at: new Date().toISOString() })),
          invites_truncated: false,
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
      res.end(
        JSON.stringify(
          invites.map((i) => ({
            group_id: null,
            group_name: null,
            group_description: null,
            group_avatar_url: null,
            group_member_count: 1,
            inviter_handle: null,
            created_at: new Date().toISOString(),
            ...i,
          })),
        ),
      )
      return
    }
    if (url.pathname === '/v1/texts') {
      if (textsStatus !== 200) {
        res.statusCode = textsStatus
        res.end(JSON.stringify({ code: 'UNAVAILABLE', message: `texts ${textsStatus}` }))
        return
      }
      const texts = textsFor('me', url.searchParams.get('runtime') ?? 'generic')
      if (manual !== null) texts.manual = { url: `${double.apiBase}/skill.md`, version: manual.version }
      res.end(JSON.stringify({ runtime: url.searchParams.get('runtime'), ...texts }))
      return
    }
    if (url.pathname === '/skill.md' && manual !== null) {
      manualAuth.push(req.headers.authorization)
      res.setHeader('content-type', 'text/markdown; charset=utf-8')
      res.end(manual.body)
      return
    }
    res.statusCode = 404
    res.end('{}')
  })

  const wss = new WebSocketServer({ noServer: true })
  const double: ServerDouble = {
    apiBase: '',
    wsBase: '',
    served,
    upgrades: 0,
    requests,
    setUpgrade: (next) => {
      mode = next
    },
    setTray: (next) => {
      tray = next
    },
    setTextsStatus: (next) => {
      textsStatus = next
    },
    setManual: (next) => {
      manual = next
    },
    manualAuth,
    send: (frame) => {
      const last = served[served.length - 1]
      if (!last) throw new Error('no live socket to send on')
      last.socket.send(JSON.stringify(frame))
    },
    acks: () =>
      served.flatMap((s) => s.clientFrames.filter((f) => f['type'] === 'ack').map((f) => String(f['message_id']))),
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
      const entry: Served = { hello: null, socket: ws, clientFrames: [] }
      served.push(entry)
      ws.on('message', (data) => {
        let frame: Record<string, unknown>
        try {
          frame = JSON.parse(data.toString()) as Record<string, unknown>
        } catch {
          return
        }
        if (entry.hello === null) {
          // agent-socket.ts HELLO path: authenticate the first frame.
          if (frame['type'] !== 'hello' || typeof frame['api_key'] !== 'string') {
            ws.close(1008, 'HELLO frame required first')
            return
          }
          entry.hello = frame
          if (decided === 'refuse') {
            ws.close(1008, 'Invalid token')
            return
          }
          if (decided === 'hello-required') {
            ws.close(1008, 'HELLO frame required')
            return
          }
          const asked = Array.isArray(frame['capabilities']) ? (frame['capabilities'] as unknown[]) : []
          const accepted = caps.filter((c) => asked.includes(c))
          ws.send(JSON.stringify({ type: 'hello.ok', capabilities: accepted }))
          for (const d of drain) ws.send(JSON.stringify(d))
          return
        }
        entry.clientFrames.push(frame)
      })
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('no address')
  Object.assign(double, { apiBase: `http://127.0.0.1:${address.port}`, wsBase: `ws://127.0.0.1:${address.port}` })
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
