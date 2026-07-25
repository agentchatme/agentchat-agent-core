import { log } from '../util/log.js'
import { resolveIdentity } from '../identity/credentials.js'
import type { HookInput } from './hook-input.js'
import {
  getContinuations,
  recordContinuation,
  resetSession,
  setPendingAck,
  takePendingAck,
  shouldOfferRegistration,
  recordRegistrationOffer,
} from '../identity/state.js'
import {
  syncPeek,
  syncAck,
  lastDeliveryId,
  markSessionActive,
  claimReply,
  getMeLite,
  type WireConfig,
  type SyncRow,
} from '../wire/index.js'
import {
  formatSessionStart,
  formatStopPickup,
  formatRegistrationOffer,
  formatAlwaysOnDown,
  type HostCopy,
} from '../digest/summary.js'
import { alwaysOnHealth } from '../daemon/health.js'

// ─── Session hook engine (host-agnostic) ────────────────────────────────────
//
// Decides WHAT the agent should be told; the integration decides HOW to say it
// to its host. This module never writes to stdout and never formats a host's
// hook JSON — Claude Code, Codex and Cursor each expect a different envelope,
// and a shared function choosing between them is another place to pick wrong.
//
// Invariants that hold no matter what goes wrong:
//   1. These functions never throw. A failing hook must degrade to "no
//      AgentChat context this turn", never to a broken session.
//   2. Ack only when a session PROVES it is real. Session-start injects the
//      digest and records the cursor as pending; the user-prompt hook commits
//      it — a prompt actually running is the proof. A session that dies before
//      its first prompt (arg-error invocation, crashed startup — live-fired
//      2026-07-12) leaves the batch unacked and it re-digests next session:
//      duplicate beats loss, always. Cap-exceeded never acks. Rows without an
//      ackable delivery_id are never injected — they could only re-inject
//      forever.
//   3. The stop path acks AFTER the host has been handed the text. That
//      ordering is expressed in the return type: `stop()` gives back a
//      `commit()` the integration calls once it has printed. An engine that
//      acked eagerly would lose a message whenever printing failed.
//
// Session state is keyed by session id ALONE. It used to be
// `${platform}:${sessionId}` because one state file served every host; now the
// file lives in this integration's own identity home, so the prefix has
// nothing to disambiguate. (Entries written by an older release keep their
// prefixed keys and simply age out under the 48h TTL — worst case one session
// gets a fresh continuation budget.)

const SESSION_START_PEEK_LIMIT = 100
const STOP_PEEK_LIMIT = 50
const DEFAULT_MAX_CONTINUATIONS = 5

export interface HookContext {
  /** THIS integration's identity home. Never resolved here. */
  home: string
  /** How this integration names itself in user-facing copy. */
  copy: HostCopy
}

export interface SessionStartResult {
  /** Text to inject into the session, or null for "say nothing". */
  context: string | null
}

export interface StopResult {
  /** Text to continue the session with, or null to let it stop. */
  reason: string | null
  /**
   * Commit the surfaced batch as delivered. Call this ONLY after the host has
   * actually been given `reason` (invariant 3). Safe to call when `reason` is
   * null — it is a no-op.
   */
  commit: () => Promise<void>
}

export function hooksDisabled(): boolean {
  return process.env['AGENTCHAT_HOOKS_ENABLED'] === '0'
}

function maxContinuations(): number {
  const raw = process.env['AGENTCHAT_HOOK_MAX_CONTINUATIONS']
  if (raw === undefined) return DEFAULT_MAX_CONTINUATIONS
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_CONTINUATIONS
}

async function resolveHandle(cfg: WireConfig, cachedHandle: string | null): Promise<string | null> {
  if (cachedHandle) return cachedHandle
  const me = await getMeLite(cfg)
  return me?.handle ?? null // never inject a made-up handle into the agent's identity
}

/** Only rows with a real delivery cursor can be surfaced — an unackable row
 *  would re-inject on every hook run forever. (The production sync path always
 *  has one; this guards the typed-nullable case.) */
function ackableRows<T extends { delivery_id: string | null }>(rows: T[]): T[] {
  const usable = rows.filter((r) => typeof r.delivery_id === 'string' && r.delivery_id.length > 0)
  if (usable.length < rows.length) {
    log.warn(`${rows.length - usable.length} sync row(s) without delivery_id excluded from digest`)
  }
  return usable
}

/**
 * Coexistence with the always-on daemon: claim the sole right to reply to each
 * row before surfacing it, so the daemon stands down for what this session
 * takes. Returns the CONTIGUOUS oldest-first prefix this session won — stopping
 * at the first row the daemon already owns keeps the ack cursor (which commits
 * everything at-or-before it) from acking a message the daemon is mid-turn on.
 * Claims run in parallel; each is fail-open (a coord outage yields the row to
 * this session, i.e. the no-daemon behavior). Rows past a daemon-owned one stay
 * queued and re-surface next turn — duplicate beats loss, per invariant 2.
 */
async function claimContiguousPrefix(
  cfg: WireConfig,
  rows: SyncRow[],
  holder: string,
): Promise<SyncRow[]> {
  const won = await Promise.all(rows.map((r) => claimReply(cfg, r.id, holder)))
  const prefix: SyncRow[] = []
  for (let i = 0; i < rows.length; i++) {
    if (!won[i]) break // daemon owns this one — stop so the ack cursor stays clean
    prefix.push(rows[i] as SyncRow)
  }
  if (prefix.length < rows.length) {
    log.info(
      `coexistence: daemon owns ${rows.length - prefix.length} row(s); surfacing ${prefix.length}`,
    )
  }
  return prefix
}

export async function sessionStart(
  ctx: HookContext,
  input: HookInput,
): Promise<SessionStartResult> {
  const none: SessionStartResult = { context: null }
  try {
    if (hooksDisabled()) return none

    // Compaction is NOT a new sitting: the host matcher usually excludes it,
    // and this guard covers hosts/installs without matcher support. Resetting
    // the stop budget on compact would let two chatting agents refill their
    // loop cap every time their own ping-pong forces a compaction —
    // unbounded, the exact loop the cap exists to stop.
    if (input.source === 'compact') return none

    // A session start is a new sitting — give this session a fresh stop-hook
    // continuation budget (matters when resuming a session that hit the cap).
    resetSession(ctx.home, input.sessionId)

    const identity = resolveIdentity(ctx.home)
    if (identity === null) {
      // First-run experience: let the agent offer registration — but at most
      // once a day, not once per session. An unregistered plugin should be
      // quiet, not a nag.
      if (shouldOfferRegistration(ctx.home)) {
        recordRegistrationOffer(ctx.home)
        return { context: formatRegistrationOffer(ctx.copy) }
      }
      return none
    }

    const cfg: WireConfig = { apiKey: identity.apiKey, apiBase: identity.apiBase }
    // Announce this session so the always-on daemon (if the user runs one)
    // yields incoming messages to it. Fail-open: a no-op without /v1/reply.
    await markSessionActive(cfg)

    // If the user set up always-on but its daemon isn't beating, surface that —
    // independent of the inbox, since being silently unreachable is the point.
    const h = alwaysOnHealth(ctx.home)
    const alert = h.wanted && !h.healthy ? formatAlwaysOnDown(ctx.copy) : null

    const peeked = ackableRows(await syncPeek(cfg, { limit: SESSION_START_PEEK_LIMIT }))
    const rows =
      peeked.length > 0
        ? await claimContiguousPrefix(cfg, peeked, `session:${input.sessionId}`)
        : []

    if (rows.length === 0) return { context: alert }

    const handle = await resolveHandle(cfg, identity.handle)
    const digest = formatSessionStart(handle, rows)
    const context = alert !== null ? `${alert}\n\n${digest}` : digest

    // Record the cursor as pending — committed by the user-prompt hook once a
    // turn actually runs (invariant 2).
    const cursor = lastDeliveryId(rows)
    if (cursor !== null) setPendingAck(ctx.home, input.sessionId, cursor)

    return { context }
  } catch (err) {
    log.warn(`session-start hook degraded to no-op: ${String(err)}`)
    return none
  }
}

/**
 * A prompt is running, so the session is real — commit the digest batch that
 * session-start injected. Silent in every outcome.
 */
export async function userPrompt(ctx: HookContext, input: HookInput): Promise<void> {
  try {
    if (hooksDisabled()) return
    const identity = resolveIdentity(ctx.home)
    if (identity === null) return

    const cursor = takePendingAck(ctx.home, input.sessionId)
    if (cursor === null) return

    const cfg: WireConfig = { apiKey: identity.apiKey, apiBase: identity.apiBase }
    try {
      await syncAck(cfg, cursor)
    } catch (err) {
      // Put it back — the next prompt retries. Rows stay stored server-side
      // either way, so the worst case is a duplicate digest next session.
      setPendingAck(ctx.home, input.sessionId, cursor)
      log.warn(`user-prompt ack failed (will retry next prompt): ${String(err)}`)
    }
  } catch (err) {
    log.warn(`user-prompt hook degraded to no-op: ${String(err)}`)
  }
}

export async function stop(ctx: HookContext, input: HookInput): Promise<StopResult> {
  const none: StopResult = { reason: null, commit: async () => {} }
  try {
    if (hooksDisabled()) return none

    const identity = resolveIdentity(ctx.home)
    if (identity === null) return none

    const cfg: WireConfig = { apiKey: identity.apiKey, apiBase: identity.apiBase }
    // Keep announcing this session so the daemon keeps yielding — even when
    // we're capped this sitting: a capped session still OWNS its inbox, and
    // the daemon taking over would defeat the continuation loop-guard.
    await markSessionActive(cfg)

    const cap = maxContinuations()
    if (getContinuations(ctx.home, input.sessionId) >= cap) {
      log.info(
        `stop hook: continuation cap (${cap}) reached for ${input.sessionId}; leaving inbox queued`,
      )
      return none
    }

    const peeked = ackableRows(await syncPeek(cfg, { limit: STOP_PEEK_LIMIT }))
    if (peeked.length === 0) return none
    const rows = await claimContiguousPrefix(cfg, peeked, `session:${input.sessionId}`)
    if (rows.length === 0) return none

    recordContinuation(ctx.home, input.sessionId)

    const handle = await resolveHandle(cfg, identity.handle)
    const reason = formatStopPickup(handle, rows)
    const cursor = lastDeliveryId(rows)

    return {
      reason,
      commit: async () => {
        if (cursor === null) return
        try {
          await syncAck(cfg, cursor)
        } catch (err) {
          log.warn(`stop ack failed (messages stay queued): ${String(err)}`)
        }
      },
    }
  } catch (err) {
    log.warn(`stop hook degraded to no-op: ${String(err)}`)
    return none
  }
}
