import { z } from 'zod'
import { CODING_AGENTS_CLIENT_HEADERS } from '../client-identity.js'

// ─── Raw HTTP to the main line ──────────────────────────────────────────────
//
// Two small reads the CLI commands need and the SDK pinned here does not type:
// who the key authenticates as, and how many conversations are waiting on the
// tray. Neither moves a message out of `stored`; `GET /v1/inbox` marks nothing
// delivered (it is the tray the agent itself reads with `agentchat_inbox`),
// and `/v1/messages/sync` — the one path that can be acknowledged — is
// deliberately not here: delivered means pulled and acknowledged BY THE AGENT,
// through the hosted tools, never by an integration.

export interface WireConfig {
  apiKey: string
  apiBase: string
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 6_000

export class WireError extends Error {
  readonly status: number
  constructor(status: number, detail: string) {
    super(`AgentChat API ${status}: ${detail}`)
    this.name = 'WireError'
    this.status = status
  }
}

export async function wireRequest(
  cfg: WireConfig,
  method: 'GET' | 'POST',
  pathname: string,
  body?: unknown,
): Promise<unknown> {
  // Join by concatenation, exactly like the SDK's HttpTransport — `new URL`
  // with an absolute pathname would clobber a path component in the base
  // (e.g. a reverse-proxy prefix).
  const url = cfg.apiBase.replace(/\/+$/, '') + pathname
  const res = await fetch(url, {
    method,
    headers: {
      ...CODING_AGENTS_CLIENT_HEADERS,
      authorization: `Bearer ${cfg.apiKey}`,
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new WireError(res.status, text.slice(0, 300))
  }
  return res.json()
}

/**
 * Minimal self-lookup for an env-var key with no credentials file (so no
 * cached handle). Only the handle is read.
 */
export async function getMeLite(cfg: WireConfig): Promise<{ handle: string } | null> {
  try {
    const data = await wireRequest(cfg, 'GET', '/v1/agents/me')
    const parsed = z.object({ handle: z.string() }).passthrough().safeParse(data)
    return parsed.success ? { handle: parsed.data.handle } : null
  } catch {
    return null
  }
}

/** Server caps on the tray: `INBOX_TRAY_MAX_LIMIT`. */
export const INBOX_MAX_LIMIT = 50

export interface TraySummary {
  /** Conversations with something waiting (cards on the tray). */
  waiting: number
  /** Conversations the agent deferred and that are hidden until their time. */
  deferred: number
  /** More conversations are waiting than one tray shows. */
  truncated: boolean
}

/**
 * How many conversations are waiting, for `status`. Reads `GET /v1/inbox`
 * with `wait_ms=0` and counts the cards — card contents (the previews) are
 * never read, never logged.
 */
export async function traySummary(cfg: WireConfig): Promise<TraySummary> {
  const data = await wireRequest(cfg, 'GET', `/v1/inbox?wait_ms=0&limit=${INBOX_MAX_LIMIT}`)
  const parsed = z
    .object({
      conversations: z.array(z.unknown()).optional(),
      deferred: z.number().optional(),
      truncated: z.boolean().optional(),
    })
    .passthrough()
    .safeParse(data)
  if (!parsed.success) throw new WireError(200, 'GET /v1/inbox: unexpected shape')
  return {
    waiting: parsed.data.conversations?.length ?? 0,
    deferred: parsed.data.deferred ?? 0,
    truncated: parsed.data.truncated === true,
  }
}
