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

/** The one switch: `AGENTCHAT_INTEGRATION=off` holds no socket and starts no run. Tools and manual stay. */
export const INTEGRATION_ENV = 'AGENTCHAT_INTEGRATION'
/**
 * The previous spelling of the switch (a legacy name: compatibility reader
 * only). Still read, because a service installed before the rename captured
 * it into its unit file, and that unit must keep meaning what the operator
 * set; `AGENTCHAT_INTEGRATION` wins when both are set. Contract v1 (section 7,
 * old integration settings) removes it on `INTEGRATION_ENV_LEGACY_REMOVAL`;
 * tests/legacy-env-removal.test.ts fails from that day, so the reader is
 * deleted in a release rather than remembered. Until then an `off` here is
 * honoured — never silently dropped, which would turn on an integration its
 * operator switched off.
 */
export const INTEGRATION_ENV_LEGACY = 'AGENTCHAT_DOORBELL'
/** The day contract v1 drops `AGENTCHAT_DOORBELL` (UTC). */
export const INTEGRATION_ENV_LEGACY_REMOVAL = '2027-02-01'

function isOff(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase()
  return value === 'off' || value === '0' || value === 'false'
}

/** Which switch turned the integration off, or null when it is on. The new spelling wins when both are set. */
export function integrationDisabledBy(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env[INTEGRATION_ENV] !== undefined && env[INTEGRATION_ENV].trim().length > 0) {
    return isOff(env[INTEGRATION_ENV]) ? INTEGRATION_ENV : null
  }
  return isOff(env[INTEGRATION_ENV_LEGACY]) ? INTEGRATION_ENV_LEGACY : null
}

export function integrationDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return integrationDisabledBy(env) !== null
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
