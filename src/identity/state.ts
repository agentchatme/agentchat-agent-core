import { z } from 'zod'
import { atomicWriteFile, readJsonFile } from '../util/fsutil.js'
import { statePath } from './credentials.js'

// ─── Local identity state ───────────────────────────────────────────────────
//
// One fact survives here: whether the user said "not now" to setting up a
// handle. It lives in the CALLER's identity home — passed in, never resolved
// here, so one integration's state can never land in another agent's directory.
//
// Earlier releases kept per-session hook state (continuation caps, ack
// cursors) in this same file. Those keys are ignored on read and dropped on the
// next write; a file from an older release needs no migration.

const StateSchema = z.object({
  // Set when the user has said "not now" to setting up a handle. PERMANENT
  // until they change their mind, because the prompt that needs suppressing
  // lives in the always-loaded instruction file and would otherwise be re-read
  // — and re-acted on — every single session.
  offer_declined_at: z.string().optional(),
})

export type IdentityState = z.infer<typeof StateSchema>

export function readState(home: string): IdentityState {
  const raw = readJsonFile<unknown>(statePath(home))
  if (raw !== null) {
    const parsed = StateSchema.safeParse(raw)
    if (parsed.success) return parsed.data
  }
  return {}
}

export function writeState(home: string, state: IdentityState): void {
  atomicWriteFile(statePath(home), JSON.stringify(state, null, 2) + '\n', 0o600)
}

/**
 * The user said "not now".
 *
 * A prompt written into the always-loaded instruction file is static text the
 * agent re-reads every session, with no memory that it was already declined.
 * So the decline is recorded here, and the instruction file rewritten to stop
 * asking.
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
