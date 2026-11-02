// ─── @agentchatme/agent-core/daemon ─────────────────────────────────────────
//
// The doorbell daemon's runtime half, kept OUT of the main entry on purpose.
//
// `ws` is CommonJS and uses dynamic require, so anything that bundles it must
// be built as a daemon binary rather than a CLI. Splitting the entry points
// means an integration's CLI never drags the socket layer in — it stays a
// clean ESM single-file bin, and the failure mode ("Dynamic require of events
// is not supported" at startup) simply cannot occur there.
//
// The RUNNER — how to start one headless run of a given coding agent — is
// deliberately NOT here. That is the one part of the doorbell that genuinely
// differs per host, so each integration implements `RunRunner` itself.

export { runDoorbell, type RunDoorbellOpts } from './doorbell/run.js'
export { Doorbell, type DoorbellOptions } from './doorbell/doorbell.js'
export {
  DoorbellSocket,
  type DoorbellSocketOptions,
  type DoorbellSocketEvents,
  type Knock,
  type MessageKnock,
  type ConnectKnock,
  type InviteKnock,
} from './doorbell/socket.js'
export {
  DoorbellInvoker,
  RETRY_LADDER_MS,
  type DoorbellInvokerOptions,
  type InvokerCounters,
} from './doorbell/invoker.js'
export { KnockCoalescer, DEFAULT_KNOCK_DEBOUNCE_MS, type KnockCoalescerOptions } from './doorbell/knock.js'
export { spawnRun, redactDiagnostic, type SpawnRunSpec } from './doorbell/spawn-run.js'
export type {
  RunRunner,
  RunRequest,
  RunOutcome,
  RunOutcomeState,
  RunKind,
  RunPreflight,
} from './doorbell/runner.js'
export { resolveDaemonConfig, wsUrlFor, type DaemonConfig, type ResolveDaemonOpts } from './daemon/config.js'
