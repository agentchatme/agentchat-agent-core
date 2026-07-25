// ─── Message "when" formatting ──────────────────────────────────────────────
//
// A coding agent has no clock of its own: a bare message body gives it no way
// to tell whether something arrived five seconds ago or five days ago, so it
// can't reason about staleness, urgency, or "I already handled this." The
// server puts `created_at` (ISO-8601 UTC) on every message; these helpers turn
// it into something a model reads at a glance — a relative age plus an
// unambiguous absolute UTC stamp.
//
// `now` is injectable so callers/tests are deterministic; it defaults to the
// wall clock in the real hook/daemon runtime.

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** Coarse, human-facing age of a duration in ms. Never negative (a slightly
 *  future timestamp from clock skew reads as "just now"). */
export function relativeAge(ms: number): string {
  if (ms < 45 * SEC) return 'just now'
  if (ms < 90 * SEC) return '1 minute ago'
  if (ms < 45 * MIN) return `${Math.round(ms / MIN)} minutes ago`
  if (ms < 90 * MIN) return '1 hour ago'
  if (ms < 22 * HOUR) return `${Math.round(ms / HOUR)} hours ago`
  if (ms < 36 * HOUR) return '1 day ago'
  return `${Math.round(ms / DAY)} days ago`
}

/** "2026-07-24 14:32 UTC" — minute precision, timezone stated explicitly so an
 *  agent never has to guess. `t` is an epoch-ms instant, so this is pure. */
export function absoluteUtc(t: number): string {
  const iso = new Date(t).toISOString() // e.g. 2026-07-24T14:32:10.000Z
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

/** Relative age only, e.g. "3 minutes ago". Empty string if `createdAt` is
 *  missing or unparseable — callers append it conditionally so a bad/absent
 *  timestamp degrades to today's timestamp-less line rather than "time unknown"
 *  noise in a scan-list digest. */
export function relativeWhen(createdAt: string | undefined, now: number = Date.now()): string {
  if (!createdAt) return ''
  const t = Date.parse(createdAt)
  if (Number.isNaN(t)) return ''
  return relativeAge(Math.max(0, now - t))
}

/** Relative age + absolute UTC, e.g. "3 minutes ago (2026-07-24 14:32 UTC)".
 *  Falls back to "at an unknown time" when the stamp is missing/unparseable so
 *  a single-message wake still reads as a sentence. */
export function formatWhen(createdAt: string | undefined, now: number = Date.now()): string {
  if (!createdAt) return 'at an unknown time'
  const t = Date.parse(createdAt)
  if (Number.isNaN(t)) return 'at an unknown time'
  return `${relativeAge(Math.max(0, now - t))} (${absoluteUtc(t)})`
}
