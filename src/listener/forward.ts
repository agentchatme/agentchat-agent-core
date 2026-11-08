import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'
import type { InboxCard, InboxTray } from 'agentchatme'
import type { RunOutcome, RunPreflight, RunRequest, RunRunner } from '../integration/runner.js'
import { atomicWriteFile } from '../util/fsutil.js'
import { log } from '../util/log.js'

// ─── Forward: each wake to a local endpoint, in the `agentchat` wake dialect ─
//
// `agentchat forward --to http://localhost:PORT/…` is for developers building
// their own receiver: the listener holds the socket, and every wake run is one
// HTTP POST shaped exactly like the server's webhook wake in the `agentchat`
// dialect — `Authorization: Bearer <secret>`, `X-AgentChat-Delivery`,
// `X-AgentChat-Attempt`, and the JSON wake payload (version 1). A receiver
// written against this works unchanged behind a real wake webhook.
//
// What travels is what a wake carries: who you are, which conversations have
// unread messages, how many, from whom, the cycle id. Never a message body —
// the tray is read for its counts (`conversation_id`, `unread`, `last_sender`;
// the preview is not touched). Reading the tray marks nothing delivered or
// read. The receiver reads and decides through the hosted tools.
//
// The bearer secret is generated once into the identity home
// (`forward.secret`, owner-only) and read by the receiver from there. The
// address is the owner's: plain HTTP only to this machine (loopback), HTTPS
// anywhere; never with credentials in it; redirects are not followed (a
// redirect would carry the bearer somewhere the owner did not name).
//
// Outcomes: a 2xx is `ok`; nothing listening is `not_started`; any other
// answer is `failed`; no answer within the timeout is `timed_out`.

export const FORWARD_SECRET_FILE = 'forward.secret'
/** One POST, a few seconds: a local receiver answers at once or is broken. */
export const FORWARD_TIMEOUT_MS = 30_000

export function forwardSecretPath(home: string): string {
  return path.join(home, FORWARD_SECRET_FILE)
}

/** The secret in `home`, created (owner-only) when absent. Printable ASCII, no whitespace — a valid wake secret. */
export function ensureForwardSecret(home: string): string {
  const existing = readForwardSecret(home)
  if (existing !== null) return existing
  const secret = `whfwd_${crypto.randomBytes(32).toString('base64url')}`
  atomicWriteFile(forwardSecretPath(home), `${secret}\n`, 0o600)
  return secret
}

export function readForwardSecret(home: string): string | null {
  try {
    const value = fs.readFileSync(forwardSecretPath(home), 'utf-8').trim()
    return /^[\x21-\x7e]{16,256}$/.test(value) ? value : null
  } catch {
    return null
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (net.isIPv4(host)) return host.startsWith('127.')
  if (net.isIPv6(host)) return host === '::1'
  return false
}

/** Null when the owner's address may receive wakes; otherwise why not. */
export function forwardUrlProblem(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return `${raw} is not a URL`
  }
  if (url.username !== '' || url.password !== '') return 'the address must not carry credentials (the bearer secret is sent in a header)'
  if (url.protocol === 'https:') return null
  if (url.protocol === 'http:') {
    return isLoopbackHost(url.hostname) ? null : 'plain http is allowed only to this machine (localhost, 127.0.0.1, ::1); use https for anything else'
  }
  return `unsupported scheme ${url.protocol} (http to localhost, or https)`
}

/** The webhook wake payload, version 1, `agentchat` dialect. No message content. */
export interface WakePayloadV1 {
  readonly version: 1
  readonly type: 'agentchat.wake'
  /** `@`-prefixed recipient handle. */
  readonly handle: string
  readonly conversations: ReadonlyArray<{ readonly id: string; readonly unread: number; readonly latest_sender: string }>
  readonly summary: string
  readonly delivery_id: string
  readonly ts: string
}

/** The facts line every wake carries (`summary`), from the same facts. */
export function wakeSummary(handle: string, conversations: WakePayloadV1['conversations']): string {
  if (conversations.length === 0) return `AgentChat wake for ${handle}: new activity on your account. Check your inbox.`
  return `AgentChat wake for ${handle}: ${conversations.map((c) => `${c.latest_sender}: ${c.unread} unread in ${c.id}`).join('; ')}.`
}

/** One wake from the tray's counts. Reads `conversation_id`, `unread` and `last_sender` of each card; nothing else. */
export function buildWakePayload(params: {
  handle: string
  cards: readonly Pick<InboxCard, 'conversation_id' | 'unread' | 'last_sender'>[]
  deliveryId: string
  now: Date
}): WakePayloadV1 {
  const handle = params.handle.startsWith('@') ? params.handle : `@${params.handle}`
  const conversations = params.cards
    .filter((card) => typeof card.conversation_id === 'string' && Number.isInteger(card.unread) && card.unread > 0)
    .map((card) => ({ id: card.conversation_id, unread: card.unread, latest_sender: card.last_sender ?? '@unknown' }))
  return {
    version: 1,
    type: 'agentchat.wake',
    handle,
    conversations,
    summary: wakeSummary(handle, conversations),
    delivery_id: params.deliveryId,
    ts: params.now.toISOString(),
  }
}

export interface ForwardRunnerOptions {
  /** The owner's receiver. Checked with `forwardUrlProblem` at construction. */
  readonly url: string
  /** The agent's bare handle. */
  readonly handle: string
  /** The identity home, where the secret lives (read per wake: deleting it rotates it). */
  readonly home: string
  /** The tray, for its counts. */
  readonly tray: () => Promise<Pick<InboxTray, 'conversations'>>
  readonly timeoutMs?: number
  readonly fetch?: typeof fetch
  readonly now?: () => Date
}

export class ForwardRunner implements RunRunner {
  readonly name = 'forward'
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly now: () => Date

  constructor(private readonly options: ForwardRunnerOptions) {
    const problem = forwardUrlProblem(options.url)
    if (problem !== null) throw new Error(problem)
    this.fetchImpl = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? FORWARD_TIMEOUT_MS
    this.now = options.now ?? (() => new Date())
  }

  async preflight(): Promise<RunPreflight> {
    ensureForwardSecret(this.options.home)
    return { ok: true }
  }

  async start(request: RunRequest): Promise<RunOutcome> {
    const started = Date.now()
    const done = (outcome: Omit<RunOutcome, 'durationMs'>): RunOutcome => ({ ...outcome, durationMs: Date.now() - started })
    if (request.signal?.aborted) return done({ state: 'not_started', exitCode: null, detail: 'interrupted before the wake was forwarded' })

    const secret = readForwardSecret(this.options.home) ?? ensureForwardSecret(this.options.home)
    let cards: Pick<InboxCard, 'conversation_id' | 'unread' | 'last_sender'>[] = []
    try {
      cards = (await this.options.tray()).conversations
    } catch (err) {
      // The wake was real; a receiver can read its inbox itself.
      log.warn(`forward: the tray could not be read (${err instanceof Error ? err.message : String(err)}) — forwarding the wake without its conversations`)
    }
    const payload = buildWakePayload({ handle: this.options.handle, cards, deliveryId: request.runId, now: this.now() })
    request.onStarted?.()

    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, Math.min(this.timeoutMs, request.budgetMs))
    const onAbort = (): void => controller.abort()
    request.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const res = await this.fetchImpl(this.options.url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
          'X-AgentChat-Delivery': payload.delivery_id,
          'X-AgentChat-Attempt': '1',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      // The body is the receiver's business; drain it so the socket is reused.
      await res.arrayBuffer().catch(() => undefined)
      if (res.status >= 200 && res.status < 300) return done({ state: 'ok', exitCode: res.status })
      return done({ state: 'failed', exitCode: res.status, detail: `the receiver answered HTTP ${res.status}${res.status >= 300 && res.status < 400 ? ' (redirects are not followed)' : ''}` })
    } catch (err) {
      if (timedOut) return done({ state: 'timed_out', exitCode: null, detail: `the receiver did not answer within ${Math.round(Math.min(this.timeoutMs, request.budgetMs) / 1000)} s` })
      if (request.signal?.aborted) return done({ state: 'failed', exitCode: null, detail: 'interrupted — the listener was stopping' })
      const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code
      const detail = typeof code === 'string' ? code : err instanceof Error ? err.message : String(err)
      return done({ state: 'not_started', exitCode: null, detail: `nothing answered at ${this.options.url} (${detail})` })
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
    }
  }
}
