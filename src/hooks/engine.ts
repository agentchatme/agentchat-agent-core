import { log } from '../util/log.js'
import { resolveIdentity } from '../identity/credentials.js'
import type { HookInput } from './hook-input.js'
import {
  getContinuations,
  getPendingAck,
  pendingAckRequiresContinuation,
  recordContinuation,
  resetSession,
  setPendingAck,
  takePendingAck,
  shouldOfferRegistration,
  recordRegistrationOffer,
  pendingNoticeNeeded,
  recordPendingNotice,
} from '../identity/state.js'
import {
  syncPeek,
  syncAck,
  lastDeliveryId,
  markForegroundTurn,
  clearForegroundTurn,
  claimReplyBatch,
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
import { alwaysOnHealth, alwaysOnState } from '../daemon/health.js'
import {
  ackDaemonActivities,
  formatDaemonActivities,
  peekDaemonActivities,
} from '../daemon/activity.js'
import {
  formatPendingRequestsNotice,
  formatPendingRequestsSystemMessage,
  listPendingRequests,
  pendingRequestsFingerprint,
} from '../daemon/pending.js'

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
//   2. Ack only after a completed host turn proves that injected context was
//      actually processed. UserPromptSubmit and Stop return a local `stage()`
//      callback that runs only after the integration prints successfully. The
//      following Stop commits that cursor. A crash anywhere in between leaves
//      the server delivery unacked: duplicate beats loss, always.
//   3. Rows without an ackable delivery_id are never injected — they could
//      only re-inject forever. Cap-exceeded never acknowledges queued rows.
//
// Session state is keyed by session id ALONE. It used to be
// `${platform}:${sessionId}` because one state file served every host; now the
// file lives in this integration's own identity home, so the prefix has
// nothing to disambiguate. (Entries written by an older release keep their
// prefixed keys and simply age out under the 48h TTL — worst case one session
// gets a fresh continuation budget.)

const USER_PROMPT_PEEK_LIMIT = 100
const STOP_PEEK_LIMIT = 50
const DEFAULT_MAX_CONTINUATIONS = 5
// Normal handoff is explicit at Stop/SessionEnd. This lease is only the crash
// fallback, so favor preserving a long foreground deliberation over handing
// its inbox to a separate daemon context.
const FOREGROUND_TURN_TTL_SECONDS = 600

export interface HookContext {
  /** THIS integration's identity home. Never resolved here. */
  home: string
  /** How this integration names itself in user-facing copy. */
  copy: HostCopy
}

export interface SessionStartResult {
  /** Text to inject into the session, or null for "say nothing". */
  context: string | null
  /** Deterministic text for the host's user-visible hook surface. */
  notification: string | null
  /** Record the notice only after the integration printed it successfully. */
  stage: () => void
}

export interface UserPromptResult {
  /** Text to add to this prompt, or null when the inbox has nothing new. */
  context: string | null
  /** Deterministic text for the host's user-visible hook surface. */
  notification: string | null
  /**
   * Persist the surfaced cursor locally. Call only after the host has accepted
   * `context`; the following Stop is the first boundary allowed to ACK it.
   */
  stage: () => void
}

export interface StopResult {
  /** Text to continue the session with, or null to let it stop. */
  reason: string | null
  /**
   * Persist the surfaced cursor locally. Call this ONLY after the host has
   * actually been given `reason`. The following Stop commits it remotely.
   */
  stage: () => void
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
export function ackableRows<T extends { delivery_id: string | null }>(rows: T[]): T[] {
  const usable: T[] = []
  for (const row of rows) {
    // sync/ack is cursor-based: it commits everything at-or-before the last
    // delivery id. Skipping a malformed row and keeping later rows would let
    // that later cursor acknowledge content we never surfaced.
    if (typeof row.delivery_id !== 'string' || row.delivery_id.length === 0) break
    usable.push(row)
  }
  if (usable.length < rows.length) {
    log.warn(
      `${rows.length - usable.length} sync row(s) excluded after the first missing delivery_id`,
    )
  }
  return usable
}

/**
 * Coexistence with the always-on daemon: claim the sole right to reply to each
 * row before surfacing it, so the daemon stands down for what this session
 * takes. Returns the CONTIGUOUS oldest-first prefix this session won — stopping
 * at the first row the daemon already owns keeps the ack cursor (which commits
 * everything at-or-before it) from acking a message the daemon is mid-turn on.
 * Rows past a daemon-owned one stay queued and re-surface next turn —
 * duplicate beats loss, per invariant 2.
 */
async function claimContiguousPrefix(
  cfg: WireConfig,
  rows: SyncRow[],
  holder: string,
): Promise<SyncRow[]> {
  const claimed = await claimReplyBatch(
    cfg,
    rows.map((row) => row.id),
    holder,
  )
  const prefix = rows.slice(0, claimed)
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
  const none: SessionStartResult = {
    context: null,
    notification: null,
    stage: () => {},
  }
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
      // once a day, not once per session. An unregistered integration should
      // be quiet, not a nag.
      if (shouldOfferRegistration(ctx.home)) {
        recordRegistrationOffer(ctx.home)
        return {
          context: formatRegistrationOffer(ctx.copy, alwaysOnState(ctx.home)),
          notification: null,
          stage: () => {},
        }
      }
      return none
    }

    // If the user set up always-on but its daemon isn't beating, surface that —
    // independent of the inbox, since being silently unreachable is the point.
    const h = alwaysOnHealth(ctx.home)
    const alert = h.wanted && !h.healthy ? formatAlwaysOnDown(ctx.copy) : null
    const cfg: WireConfig = {
      apiKey: identity.apiKey,
      apiBase: identity.apiBase,
    }
    const handle = await resolveHandle(
      cfg,
      identity.source === 'file' ? identity.handle : null,
    )
    const requests = handle ? listPendingRequests(ctx.home, handle) : []
    const fingerprint = pendingRequestsFingerprint(requests)
    const pendingNotice = pendingNoticeNeeded(
      ctx.home,
      input.sessionId,
      fingerprint,
    )
      ? formatPendingRequestsNotice(requests, ctx.copy)
      : null
    const context = [alert, pendingNotice]
      .filter((value): value is string => value !== null)
      .join('\n\n')
    return {
      context: context || null,
      notification:
        pendingNotice === null
          ? null
          : formatPendingRequestsSystemMessage(requests),
      stage: () => {
        if (pendingNotice !== null) {
          recordPendingNotice(ctx.home, input.sessionId, fingerprint)
        }
      },
    }
  } catch (err) {
    log.warn(`session-start hook degraded to no-op: ${String(err)}`)
    return none
  }
}

/**
 * A prompt is about to run. Claim and inject the inbox at this real turn
 * boundary, then stage its cursor only after the host accepts our output.
 */
export async function userPrompt(
  ctx: HookContext,
  input: HookInput,
): Promise<UserPromptResult> {
  const none: UserPromptResult = {
    context: null,
    notification: null,
    stage: () => {},
  }
  try {
    if (hooksDisabled()) return none
    const identity = resolveIdentity(ctx.home)
    if (identity === null) return none

    const cfg: WireConfig = { apiKey: identity.apiKey, apiBase: identity.apiBase }
    // This is the exact boundary at which a foreground model turn begins.
    // Announce it even when there is no inbox digest to inject.
    await markForegroundTurn(cfg, input.sessionId, FOREGROUND_TURN_TTL_SECONDS)

    // The prior injected batch has not crossed a completed-turn boundary yet.
    // Do not overwrite its cursor or inject later rows ahead of it.
    if (getPendingAck(ctx.home, input.sessionId) !== null) return none

    const handle = await resolveHandle(
      cfg,
      identity.source === 'file' ? identity.handle : null,
    )
    const pendingRequests = handle
      ? listPendingRequests(ctx.home, handle)
      : []
    const pendingFingerprint = pendingRequestsFingerprint(pendingRequests)
    const pendingContext = pendingNoticeNeeded(
      ctx.home,
      input.sessionId,
      pendingFingerprint,
    )
      ? formatPendingRequestsNotice(pendingRequests, ctx.copy)
      : null
    const activities = peekDaemonActivities(ctx.home)
    const activityContext = formatDaemonActivities(activities)
    const localContext = [pendingContext, activityContext]
      .filter((value): value is string => value !== null)
      .join('\n\n')
    const stageLocalContext = (): void => {
      if (pendingContext !== null) {
        recordPendingNotice(
          ctx.home,
          input.sessionId,
          pendingFingerprint,
        )
      }
      ackDaemonActivities(
        ctx.home,
        activities.map((activity) => activity.id),
      )
    }
    const peeked = ackableRows(await syncPeek(cfg, { limit: USER_PROMPT_PEEK_LIMIT }))
    if (peeked.length === 0) {
      if (!localContext) return none
      return {
        context: localContext,
        notification:
          pendingContext === null
            ? null
            : formatPendingRequestsSystemMessage(pendingRequests),
        stage: stageLocalContext,
      }
    }
    const rows = await claimContiguousPrefix(
      cfg,
      peeked,
      `session:${input.sessionId}`,
    )
    if (rows.length === 0) {
      if (!localContext) return none
      return {
        context: localContext,
        notification:
          pendingContext === null
            ? null
            : formatPendingRequestsSystemMessage(pendingRequests),
        stage: stageLocalContext,
      }
    }

    const cursor = lastDeliveryId(rows)
    if (cursor === null) {
      return localContext
        ? {
            context: localContext,
            notification:
              pendingContext === null
                ? null
                : formatPendingRequestsSystemMessage(pendingRequests),
            stage: stageLocalContext,
          }
        : none
    }
    return {
      context: [pendingContext, activityContext, formatSessionStart(handle, rows)]
        .filter((value): value is string => value !== null)
        .join('\n\n'),
      notification:
        pendingContext === null
          ? null
          : formatPendingRequestsSystemMessage(pendingRequests),
      stage: () => {
        stageLocalContext()
        setPendingAck(ctx.home, input.sessionId, cursor)
      },
    }
  } catch (err) {
    log.warn(`user-prompt hook degraded to no-op: ${String(err)}`)
    return none
  }
}

export async function stop(ctx: HookContext, input: HookInput): Promise<StopResult> {
  const none: StopResult = { reason: null, stage: () => {} }
  let cfg: WireConfig | null = null
  try {
    if (hooksDisabled()) return none

    const identity = resolveIdentity(ctx.home)
    if (identity === null) return none

    cfg = { apiKey: identity.apiKey, apiBase: identity.apiBase }

    // UserPromptSubmit context is proven by its next Stop. Stop-injected
    // context needs the specific continuation the host marks with
    // stop_hook_active=true. If another Stop hook prevented that continuation,
    // discard only the local cursor and re-offer the still-unacked row below.
    const needsContinuation = pendingAckRequiresContinuation(
      ctx.home,
      input.sessionId,
    )
    if (needsContinuation && input.stopHookActive !== true) {
      takePendingAck(ctx.home, input.sessionId)
    }
    const pending =
      needsContinuation && input.stopHookActive !== true
        ? null
        : takePendingAck(ctx.home, input.sessionId)
    if (pending !== null) {
      try {
        await syncAck(cfg, pending)
      } catch (err) {
        setPendingAck(ctx.home, input.sessionId, pending)
        await clearForegroundTurn(cfg, input.sessionId)
        log.warn(`completed-turn ack failed (messages stay queued): ${String(err)}`)
        return none
      }
    }

    // Renew before the sync/claim work. If this hook continues the model with
    // an inbound digest, the lease protects that continuation until its next
    // Stop. Every path that actually becomes idle clears below.
    await markForegroundTurn(cfg, input.sessionId, FOREGROUND_TURN_TTL_SECONDS)

    const cap = maxContinuations()
    if (getContinuations(ctx.home, input.sessionId) >= cap) {
      log.info(
        `stop hook: continuation cap (${cap}) reached for ${input.sessionId}; leaving inbox queued`,
      )
      await clearForegroundTurn(cfg, input.sessionId)
      return none
    }

    const peeked = ackableRows(await syncPeek(cfg, { limit: STOP_PEEK_LIMIT }))
    if (peeked.length === 0) {
      await clearForegroundTurn(cfg, input.sessionId)
      return none
    }
    const rows = await claimContiguousPrefix(cfg, peeked, `session:${input.sessionId}`)
    if (rows.length === 0) {
      await clearForegroundTurn(cfg, input.sessionId)
      return none
    }

    recordContinuation(ctx.home, input.sessionId)

    const handle = await resolveHandle(
      cfg,
      identity.source === 'file' ? identity.handle : null,
    )
    const reason = formatStopPickup(handle, rows)
    const cursor = lastDeliveryId(rows)

    return {
      reason,
      stage: () => {
        if (cursor !== null) {
          setPendingAck(
            ctx.home,
            input.sessionId,
            cursor,
            new Date(),
            true,
          )
        }
      },
    }
  } catch (err) {
    if (cfg !== null) await clearForegroundTurn(cfg, input.sessionId)
    log.warn(`stop hook degraded to no-op: ${String(err)}`)
    return none
  }
}

/** A host session is closing. Release only its own foreground lease. */
export async function sessionEnd(ctx: HookContext, input: HookInput): Promise<void> {
  try {
    if (hooksDisabled()) return
    const identity = resolveIdentity(ctx.home)
    if (identity === null) return
    const cfg: WireConfig = { apiKey: identity.apiKey, apiBase: identity.apiBase }
    await clearForegroundTurn(cfg, input.sessionId)
  } catch (err) {
    log.warn(`session-end hook degraded to no-op: ${String(err)}`)
  }
}
