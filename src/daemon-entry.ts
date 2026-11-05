// ─── @agentchatme/agent-core/daemon ─────────────────────────────────────────
//
// The integration daemon's runtime half, kept OUT of the main entry on purpose.
//
// `ws` is CommonJS and uses dynamic require, so anything that bundles it must
// be built as a daemon binary rather than a CLI. Splitting the entry points
// means an integration's CLI never drags the socket layer in — it stays a
// clean ESM single-file bin, and the failure mode ("Dynamic require of events
// is not supported" at startup) simply cannot occur there.
//
// The RUNNER — how to start one headless run of a given coding agent — is
// deliberately NOT here. That is the one part of the integration that
// genuinely differs per host, so each integration implements `RunRunner` itself.

export { runIntegration, type RunIntegrationOpts } from './integration/run.js'
export { Integration, type IntegrationOptions } from './integration/integration.js'
export {
  IntegrationConnection,
  socketStateOf,
  type IntegrationConnectionOptions,
  type IntegrationConnectionEvents,
  type Wake,
  type MessageWake,
  type ReminderWake,
  type InviteWake,
} from './integration/connection.js'
export {
  IntegrationInvoker,
  RETRY_LADDER_MS,
  PREFLIGHT_WATCH_MS,
  type IntegrationInvokerOptions,
  type InvokerCounters,
} from './integration/invoker.js'
export { WakeCoalescer, DEFAULT_WAKE_DEBOUNCE_MS, type WakeCoalescerOptions } from './integration/wake.js'
export { OfferedInvites, OFFERED_INVITES_FILE, offeredInvitesPath, type OfferedInviteStore } from './integration/invites.js'
export { spawnRun, redactDiagnostic, type SpawnRunSpec } from './integration/spawn-run.js'
export type {
  RunRunner,
  RunRequest,
  RunOutcome,
  RunOutcomeState,
  RunKind,
  RunPreflight,
} from './integration/runner.js'
export { resolveDaemonConfig, wsBaseFor, wsUrlFor, type DaemonConfig, type ResolveDaemonOpts } from './daemon/config.js'
