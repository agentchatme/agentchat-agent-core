// ─── Run profile and switches ───────────────────────────────────────────────
//
// What a headless run may do is the operator's decision, not the peer's and
// not ours. Three profiles, mapped by each integration to its runtime's real
// flags (documented per runtime in that integration's README):
//
//   answer — read-only file tools + web search/fetch + every AgentChat hosted
//            tool; no edits, no shell. The default.
//   work   — plus edits and shell inside the run's workspace.
//   full   — the runtime's own bypass-everything mode.
//
// Whatever the profile, a headless run NEVER waits on a permission prompt:
// anything that would prompt is denied, not waited on.

export const RUN_PROFILES = ['answer', 'work', 'full'] as const
export type RunProfile = (typeof RUN_PROFILES)[number]

export const RUN_PROFILE_ENV = 'AGENTCHAT_RUN_PROFILE'
export const DEFAULT_RUN_PROFILE: RunProfile = 'answer'

export function isRunProfile(value: unknown): value is RunProfile {
  return typeof value === 'string' && (RUN_PROFILES as readonly string[]).includes(value)
}

/** `AGENTCHAT_RUN_PROFILE`, defaulting to `answer`; an unknown value is `answer` too. */
export function resolveRunProfile(env: NodeJS.ProcessEnv = process.env): RunProfile {
  const raw = env[RUN_PROFILE_ENV]?.trim().toLowerCase()
  return isRunProfile(raw) ? raw : DEFAULT_RUN_PROFILE
}

/** The one switch: `AGENTCHAT_DOORBELL=off` holds no socket and starts no run. Tools and manual stay. */
export const DOORBELL_ENV = 'AGENTCHAT_DOORBELL'

export function doorbellDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[DOORBELL_ENV]?.trim().toLowerCase()
  return raw === 'off' || raw === '0' || raw === 'false'
}

/** A run's time budget. Killed past it; that counts as a failed run. */
export const RUN_BUDGET_ENV = 'AGENTCHAT_RUN_BUDGET_MS'
export const DEFAULT_RUN_BUDGET_MS = 10 * 60_000
const MAX_RUN_BUDGET_MS = 2 * 60 * 60_000

export function resolveRunBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env[RUN_BUDGET_ENV])
  if (!Number.isFinite(parsed) || parsed < 1_000) return DEFAULT_RUN_BUDGET_MS
  return Math.min(parsed, MAX_RUN_BUDGET_MS)
}
