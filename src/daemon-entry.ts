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
export { Integration, RUNNER_DEADLINE_SLACK_MS, PREFLIGHT_DEADLINE_MS, type IntegrationOptions } from './integration/integration.js'
export { socketStateOf, blockedDetail } from './integration/socket-state.js'
export { spawnRun, redactDiagnostic, type SpawnRunSpec } from './integration/spawn-run.js'
export type {
  RunRunner,
  RunRequest,
  RunOutcome,
  RunOutcomeState,
  RunKind,
  RunPreflight,
  RunnerIdentity,
  RunnerFactory,
  RunnerSource,
} from './integration/runner.js'

// The listener's runners: the owner's command, and the forwarder.
export { CommandRunner, commandRunEnv, RUN_ENV, type CommandRunnerOptions } from './listener/command-runner.js'
export { ForwardRunner, type ForwardRunnerOptions } from './listener/forward.js'
export type { ListenerConfig } from './listener/config.js'
export { resolveDaemonConfig, wsBaseFor, wsUrlFor, type DaemonConfig, type ResolveDaemonOpts } from './daemon/config.js'
