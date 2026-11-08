import { RealtimeClient, type ServerEvent, type WsMessage } from 'agentchatme'
import { clientIdentityOf, normalizeHandle, resolveIdentity, type SocketState } from '../index.js'
import { WakeCoalescer, DEFAULT_WAKE_DEBOUNCE_MS, socketStateOf, wsBaseFor } from '../daemon-entry.js'
import { cliClient, invocation } from './home.js'
import { terminalSafe } from './terminal.js'

// ─── `agentchat watch`: the socket, as a listener sees it ───────────────────
//
// For debugging a listener: holds its own socket for this home's agent and
// prints every frame's TYPE and ids — the sender, the conversation, the
// message id, a wake's reason and step, an invite's group — and, below them,
// the wake cycles a listener would start (the same coalescing). Never a
// message body, a preview or a name: the same facts a wake carries.
//
// It is a receiver like any other: it acknowledges what it receives, so a
// message it sees counts as delivered to this machine (never as read — only
// a verdict reads). It starts no run.

const EVENTS: readonly ServerEvent[] = [
  'message.new',
  'message.read',
  'presence.update',
  'typing.start',
  'typing.stop',
  'rate_limit.warning',
  'group.invite.received',
  'group.deleted',
  'wake',
]

export interface WatchIo {
  readonly out: (line: string) => void
  readonly err: (line: string) => void
  readonly env?: NodeJS.ProcessEnv
  /** Ends the watch (Ctrl-C in production; tests). */
  readonly signal?: AbortSignal
  readonly now?: () => Date
}

function field(payload: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.length > 0) return terminalSafe(value)
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

/** One frame as a line of facts. Exported for tests: what is printed, and what never is. */
export function describeFrame(type: string, payload: Record<string, unknown>, self: string): { text: string; facts: Record<string, string>; wake: boolean } {
  const facts: Record<string, string> = {}
  const put = (name: string, keys: readonly string[]): void => {
    const value = field(payload, keys)
    if (value !== null) facts[name] = value
  }
  let wake = false
  switch (type) {
    case 'message.new': {
      put('conv', ['conversation_id'])
      put('msg', ['id'])
      put('from', ['sender', 'sender_handle', 'from'])
      const from = facts['from']
      const own = from !== undefined && normalizeHandle(from) === self
      if (own) facts['own'] = 'true'
      wake = !own
      break
    }
    case 'wake':
      put('reason', ['reason'])
      put('conv', ['conversation_id'])
      put('step', ['step'])
      wake = true
      break
    case 'group.invite.received':
      put('invite', ['invite_id', 'id'])
      put('group', ['group_id', 'conversation_id'])
      put('from', ['inviter_handle', 'inviter', 'from'])
      wake = true
      break
    case 'message.read':
      put('conv', ['conversation_id'])
      put('through', ['message_id', 'through_message_id'])
      put('by', ['reader', 'handle'])
      break
    case 'group.deleted':
      put('group', ['group_id', 'conversation_id'])
      break
    default:
      put('conv', ['conversation_id'])
      put('handle', ['handle'])
  }
  const text = [terminalSafe(type), ...Object.entries(facts).map(([k, v]) => (k === 'from' || k === 'by' || k === 'handle' ? `${k}=@${v.replace(/^@/, '')}` : `${k}=${v}`))].join(' ')
  return { text, facts, wake }
}

export async function runWatch(home: string, opts: { json?: boolean; seconds?: string }, io: WatchIo): Promise<number> {
  const identity = resolveIdentity(home)
  if (identity === null) {
    io.err(`No AgentChat identity in ${home}. Set one up first: ${invocation(io.env)} register`)
    return 1
  }
  const self = normalizeHandle(identity.handle ?? '')
  const now = io.now ?? (() => new Date())
  const emit = (kind: string, text: string, extra: Record<string, unknown> = {}): void => {
    if (opts.json === true) io.out(JSON.stringify({ at: now().toISOString(), kind, ...extra }))
    else io.out(`${now().toISOString().slice(11, 23)}  ${text}`)
  }

  let frames = 0
  const coalescer = new WakeCoalescer({
    debounceMs: DEFAULT_WAKE_DEBOUNCE_MS,
    onFire: () => {
      emit('cycle', `→ wake cycle: a listener would count the tray now and start one run if it holds anything (${frames} signal(s) coalesced)`, { signals: frames })
      frames = 0
    },
  })
  const wakeSignal = (): void => {
    frames += 1
    coalescer.wake()
  }

  let state: SocketState = 'idle'
  const rt = new RealtimeClient({
    apiKey: identity.apiKey,
    baseUrl: wsBaseFor(identity.apiBase),
    clientIdentity: clientIdentityOf(cliClient()),
    ackOnReceipt: true,
    reconnect: true,
  })
  rt.on('state', (next) => {
    const word = socketStateOf(next, state)
    if (word !== state) emit('state', `socket ${word}`, { socket: word })
    state = word
  })
  rt.onConnect(() => {
    emit('ready', `hello.ok as @${self} — acks ${rt.ackNegotiated ? 'on receipt' : 'not negotiated'}`, { ack: rt.ackNegotiated })
    // A connect is a wake for a listener: it catches a backlog no frame announced.
    wakeSignal()
  })
  rt.onDisconnect(({ code, reason }) => emit('closed', `socket closed (${code}${reason ? ` ${terminalSafe(reason)}` : ''})`, { code }))
  rt.onError((err) => emit('error', `socket: ${terminalSafe(err.message)}`))
  rt.on('blocked', (info) => emit('blocked', `auth rejected (close ${info.code}) — the key is refused; the client retries every 10–15 min`, { code: info.code }))
  for (const type of EVENTS) {
    rt.on(type, (message: WsMessage) => {
      const payload = message.payload !== null && typeof message.payload === 'object' ? (message.payload as Record<string, unknown>) : {}
      const described = describeFrame(type, payload, self)
      emit('frame', described.text, { type, ...described.facts })
      if (described.wake) wakeSignal()
    })
  }

  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const stop = (): void => {
      if (timer !== null) clearTimeout(timer)
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      io.signal?.removeEventListener('abort', stop)
      resolve()
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    io.signal?.addEventListener('abort', stop, { once: true })
    if (opts.seconds !== undefined) {
      const seconds = Number(opts.seconds)
      if (Number.isFinite(seconds) && seconds > 0) timer = setTimeout(stop, seconds * 1000)
    }
    emit('start', `watching @${self} on ${wsBaseFor(identity.apiBase)}/v1/ws — frame types and ids only, never content. Ctrl-C stops.`)
    rt.connect().catch((err: unknown) => {
      emit('error', `socket cannot be opened: ${terminalSafe(err instanceof Error ? err.message : String(err))}`)
      stop()
    })
  })
  coalescer.stop()
  rt.disconnect()
  return 0
}
