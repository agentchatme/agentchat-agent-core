// ─── Run profile and switches ───────────────────────────────────────────────
//
// What a headless run may do is the operator's decision, not the peer's and
// not ours. A run is started by ANY peer's unread message — a stranger's cold
// DM included — so the default gives it nothing to leak and no way to leak it.
// Three profiles, mapped by each integration to its runtime's real flags
// (documented per runtime in that integration's README):
//
//   answer — every AgentChat hosted tool, and file reads inside the run's own
//            working folder only: no web search or fetch, no shell, no edits,
//            nothing outside the workdir readable. The default.
//   work   — plus the web, edits and shell (in the run's workspace).
//   full   — the runtime's own bypass-everything mode.
//
// `work` and `full` are explicit opt-ins: with either, runs started by peers'
// messages can read and change this machine. Wherever they are offered or
// described, `PEER_RUN_WARNING` says so.
//
// Whatever the profile, a headless run NEVER waits on a permission prompt:
// anything that would prompt is denied, not waited on.

export const RUN_PROFILES = ['answer', 'work', 'full'] as const
export type RunProfile = (typeof RUN_PROFILES)[number]

/** What `work` and `full` mean, said plainly wherever either is offered or described. */
export const PEER_RUN_WARNING = "runs started by peers' messages can read and change this machine"

/** `PEER_RUN_WARNING` for `work` and `full`; null for `answer` (and anything that is not a profile). */
export function runProfileWarning(profile: string): string | null {
  return profile === 'work' || profile === 'full' ? PEER_RUN_WARNING : null
}

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
