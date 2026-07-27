import { z } from 'zod'
import { atomicWriteFile, readJsonFile } from '../util/fsutil.js'
import { statePath } from './credentials.js'

// ─── Per-session hook state ─────────────────────────────────────────────────
//
// The stop hook must be loop-capped: without a ceiling, two plugged-in
// agents DMing each other could keep their sessions alive indefinitely.
// State is keyed by session id and pruned after 48h so the file never grows
// past a screenful. It lives in the CALLER's identity home — passed in, never
// resolved here, so one integration's hook state can never land in another
// agent's directory.
//
// Concurrency note: read-modify-write here is not atomic across processes.
// One session's own hooks are serialized by the host, so the cap holds
// where it matters; concurrent hooks from SEPARATE sessions can lose each
// other's counter updates, which at worst leaks a few extra continuations
// (each still bounded by its own session's cap). Accepted — an flock would
// buy little and cost a platform-specific dependency.

const SESSION_TTL_MS = 48 * 60 * 60 * 1000

const SessionStateSchema = z.object({
  continuations: z.number().int().min(0),
  updated_at: z.string(),
  // Ack cursor for the batch the session-start hook injected but has NOT
  // yet committed. Committed by the user-prompt hook — proof the session
  // actually ran a turn. A session that dies before its first prompt
  // (arg-error invocations, crashed startups) leaves this uncommitted and
  // the batch re-digests next session instead of being consumed by a
  // ghost. Live-fire lesson, 2026-07-12.
  pending_ack: z.string().optional(),
})

const StateSchema = z.object({
  sessions: z.record(SessionStateSchema).default({}),
  // Machine-wide timestamp of the last registration offer injected by the
  // session-start hook. Keeps the unregistered-plugin nag to once a day
  // instead of once per session.
  last_offer_at: z.string().optional(),
  // Set when the user has said "not now" to setting up a handle. Unlike the
  // cooldown above this is PERMANENT until they change their mind, because the
  // prompt that needs suppressing lives in the always-loaded instruction file
  // and would otherwise be re-read — and re-acted on — every single session.
  offer_declined_at: z.string().optional(),
})

export type HookState = z.infer<typeof StateSchema>

export function readState(home: string): HookState {
  const raw = readJsonFile<unknown>(statePath(home))
  if (raw !== null) {
    const parsed = StateSchema.safeParse(raw)
    if (parsed.success) return parsed.data
  }
  return { sessions: {} }
}

export function writeState(home: string, state: HookState): void {
  atomicWriteFile(statePath(home), JSON.stringify(state, null, 2) + '\n', 0o600)
}

function prune(state: HookState, now: Date): void {
  const cutoff = now.getTime() - SESSION_TTL_MS
  for (const [key, entry] of Object.entries(state.sessions)) {
    const t = Date.parse(entry.updated_at)
    if (Number.isNaN(t) || t < cutoff) {
      delete state.sessions[key]
    }
  }
}

export function getContinuations(home: string, sessionKey: string): number {
  return readState(home).sessions[sessionKey]?.continuations ?? 0
}

export function recordContinuation(home: string, sessionKey: string, now: Date = new Date()): number {
  const state = readState(home)
  prune(state, now)
  const current = state.sessions[sessionKey]?.continuations ?? 0
  const next = current + 1
  state.sessions[sessionKey] = { continuations: next, updated_at: now.toISOString() }
  writeState(home, state)
  return next
}

/**
 * Give a session a fresh continuation budget. Called by the session-start
 * hook: resuming a capped session is a new sitting, and its stop hook
 * should be allowed to pick messages up again.
 */
export function resetSession(home: string, sessionKey: string): void {
  const state = readState(home)
  if (state.sessions[sessionKey] === undefined) return
  delete state.sessions[sessionKey]
  writeState(home, state)
}

export function setPendingAck(home: string, sessionKey: string, cursor: string, now: Date = new Date()): void {
  const state = readState(home)
  prune(state, now)
  const existing = state.sessions[sessionKey]
  state.sessions[sessionKey] = {
    continuations: existing?.continuations ?? 0,
    updated_at: now.toISOString(),
    pending_ack: cursor,
  }
  writeState(home, state)
}

/** Read-and-clear the pending cursor for a session (user-prompt hook). */
export function takePendingAck(home: string, sessionKey: string, now: Date = new Date()): string | null {
  const state = readState(home)
  const entry = state.sessions[sessionKey]
  if (entry?.pending_ack === undefined) return null
  const cursor = entry.pending_ack
  delete entry.pending_ack
  entry.updated_at = now.toISOString()
  writeState(home, state)
  return cursor
}

const OFFER_COOLDOWN_MS = 24 * 60 * 60 * 1000

export function shouldOfferRegistration(home: string, now: Date = new Date()): boolean {
  const last = readState(home).last_offer_at
  if (last === undefined) return true
  const t = Date.parse(last)
  return Number.isNaN(t) || now.getTime() - t >= OFFER_COOLDOWN_MS
}

export function recordRegistrationOffer(home: string, now: Date = new Date()): void {
  const state = readState(home)
  state.last_offer_at = now.toISOString()
  writeState(home, state)
}

/**
 * The user said "not now".
 *
 * A hook-injected offer could rely on a 24-hour cooldown, because the hook
 * re-runs and can consult state. A prompt written into the always-loaded
 * instruction file cannot: it is static text the agent re-reads every session,
 * with no memory that it was already declined. So the decline has to be
 * recorded here, and the instruction file rewritten to stop asking.
 */
export function recordOfferDeclined(home: string, now: Date = new Date()): void {
  const state = readState(home)
  state.offer_declined_at = now.toISOString()
  writeState(home, state)
}

export function offerDeclined(home: string): boolean {
  return readState(home).offer_declined_at !== undefined
}

/** Cleared when an identity is established, so a later logout asks again. */
export function clearOfferDeclined(home: string): void {
  const state = readState(home)
  delete state.offer_declined_at
  writeState(home, state)
}
