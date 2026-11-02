import { z } from 'zod'
import { CODING_AGENTS_CLIENT_HEADERS } from '../client-identity.js'

// ─── Raw HTTP to the main line ──────────────────────────────────────────────
//
// A few small reads the CLI commands and the doorbell need and the SDK pinned
// here does not type: who the key authenticates as, whether (and how many)
// conversations are waiting on the tray, which group invites are pending. None
// moves a message out of `stored`; `GET /v1/inbox` marks nothing delivered (it
// is the tray the agent itself reads with `agentchat_inbox`), and
// `/v1/messages/sync` — the one path that can be acknowledged — is
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

/**
 * Is anything waiting on the tray? `GET /v1/inbox?wait_ms=0&limit=1` — a
 * count, never a card: the one card the server may return is not read, not
 * kept, not logged. Marks nothing delivered. This is the connect-time question
 * "does this (re)connect deserve a run at all?" — the server re-offers stored
 * envelopes as `message.new` frames right after `hello.ok`, so this is a
 * second opinion that coalesces with them, and the reason a reconnect with an
 * empty tray starts no run.
 */
export async function trayHasWaiting(cfg: WireConfig): Promise<boolean> {
  const data = await wireRequest(cfg, 'GET', '/v1/inbox?wait_ms=0&limit=1')
  const parsed = z
    .object({ conversations: z.array(z.unknown()).optional(), truncated: z.boolean().optional() })
    .passthrough()
    .safeParse(data)
  if (!parsed.success) throw new WireError(200, 'GET /v1/inbox: unexpected shape')
  return (parsed.data.conversations?.length ?? 0) > 0 || parsed.data.truncated === true
}

/** A pending group invite, as the doorbell knocks for it: the same four fields the live frame carries. */
export interface PendingInvite {
  readonly inviteId: string
  readonly groupId: string | null
  readonly groupName: string | null
  readonly inviterHandle: string | null
}

/**
 * Pending group invites: `GET /v1/groups/invites`. The server pushes an invite
 * live only (`group.service.ts`) and never re-offers it on reconnect, so an
 * invite that arrived while the socket was down is surfaced by this read on
 * connect — the invoker deduplicates by id, so one seen live is not run twice.
 * Four fields read; descriptions, avatars and member counts are ignored.
 */
export async function listGroupInvites(cfg: WireConfig): Promise<PendingInvite[]> {
  const data = await wireRequest(cfg, 'GET', '/v1/groups/invites')
  const parsed = z
    .array(
      z
        .object({
          id: z.string(),
          group_id: z.string().nullable().optional(),
          group_name: z.string().nullable().optional(),
          inviter_handle: z.string().nullable().optional(),
        })
        .passthrough(),
    )
    .safeParse(data)
  if (!parsed.success) throw new WireError(200, 'GET /v1/groups/invites: unexpected shape')
  return parsed.data.map((row) => ({
    inviteId: row.id,
    groupId: row.group_id ?? null,
    groupName: row.group_name ?? null,
    inviterHandle: row.inviter_handle ?? null,
  }))
}
