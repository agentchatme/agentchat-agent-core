// ─── @agentchatme/agent-core ────────────────────────────────────────────────
//
// The shared engine behind every AgentChat coding-agent integration
// (Claude Code, Codex, Cursor, OpenCode, …). A LIBRARY, not a CLI.
//
// The one rule that shapes this whole package:
//
//   Every function takes an identity home. None resolves one.
//   Nothing here knows which coding agents exist.
//
// That rule is not stylistic. Before it, a single shared CLI served every
// host, so its commands had to *decide* which agent they were acting on — and
// a function that decides can decide wrong. In practice it did: registering
// one coding agent rewrote another's identity file, and signing out of one
// deleted the other's credentials and stripped its wiring, because one code
// path served both.
//
// An integration built on this library is a single-host binary that knows its
// own home at compile time. There is no platform flag, no host detection, and
// no code path that could reach a different agent's files — the mistake is
// unrepresentable rather than merely guarded against.
//
// What stays here: things that must NOT drift between integrations — the wire
// protocol, credential format, digest text, the ack state machine, daemon
// internals. What belongs to each integration: where its home is, which file
// its anchor lives in, what JSON shape its hooks emit, and how to spawn a
// headless turn of its runtime.

// Wire protocol — the server contract. One implementation, everywhere.
export {
  syncPeek,
  syncAck,
  lastDeliveryId,
  getMeLite,
  contextOf,
  markSessionActive,
  clearSessionActive,
  claimReply,
  WireError,
  type WireConfig,
  type SyncRow,
  type MessageContext,
} from './wire/index.js'

// Identity — credential + pending storage, always scoped to a given home.
export {
  DEFAULT_API_BASE,
  credentialsPath,
  pendingPath,
  statePath,
  readCredentials,
  resolveIdentity,
  writeCredentials,
  clearCredentials,
  readPending,
  writePending,
  clearPending,
  type Credentials,
  type ResolvedIdentity,
  type PendingRegistration,
} from './identity/credentials.js'

// Per-session hook state (continuation cap, pending ack cursor).
export {
  readState,
  writeState,
  getContinuations,
  recordContinuation,
  resetSession,
  setPendingAck,
  takePendingAck,
  shouldOfferRegistration,
  recordRegistrationOffer,
  type HookState,
} from './identity/state.js'

// Digest rendering — what the agent is actually told.
export {
  formatSessionStart,
  formatStopPickup,
  formatRegistrationOffer,
  formatAlwaysOnDown,
  type HostCopy,
} from './digest/summary.js'

// Instruction-file anchor — fenced-block editing against an explicit path.
export {
  ANCHOR_START,
  ANCHOR_END,
  renderAnchorBlock,
  writeAnchor,
  removeAnchorAt,
  hasAnchorAt,
  readAnchorHandleAt,
  readAnchorHandleFrom,
  upsertAnchorBlock,
  stripAnchorBlock,
  type AnchorAction,
} from './anchor/block.js'

// Session hooks — decisions in, host JSON out (the integration formats).
export {
  sessionStart,
  userPrompt,
  stop,
  hooksDisabled,
  type HookContext,
  type SessionStartResult,
  type StopResult,
} from './hooks/engine.js'

export { readHookInput, type HookInput } from './hooks/hook-input.js'
export { createHookRunners, type HookDialect, type HookRunners } from './hooks/runners.js'

// The identity command set. An integration describes itself once (HostProfile)
// and gets register/login/recover/status/logout/doctor back, rather than
// carrying its own copy of a server contract.
export {
  createIdentityCommands,
  type IdentityCommands,
  type RegisterOpts,
  type DoctorOpts,
} from './identity/commands.js'
export { anchorLabelOf, type HostProfile, type DoctorCheck, type Verdict } from './identity/host-profile.js'

// Always-on daemon internals.
export {
  markAlwaysOnWanted,
  clearAlwaysOnWanted,
  alwaysOnWanted,
  markAlwaysOnOptOut,
  clearAlwaysOnOptOut,
  alwaysOnOptedOut,
  alwaysOnHealth,
  alwaysOnState,
  type AlwaysOnState,
  beat,
  idle,
  HEARTBEAT_FILE,
} from './daemon/health.js'

export { acquireLeaderLock, type LockHandle } from './daemon/leader-lock.js'
export {
  installService,
  uninstallService,
  serviceStatus,
  planForTest,
  type ServiceOpts,
  type ServiceRef,
} from './daemon/service.js'

// The daemon's socket layer lives at `@agentchatme/agent-core/daemon`, not
// here: it depends on `ws` (CommonJS, dynamic require), which must never be
// bundled into an integration's CLI.

// Utilities integrations legitimately share.
export { log } from './util/log.js'
export { relativeAge, absoluteUtc, relativeWhen, formatWhen } from './util/when.js'
export { atomicWriteFile, readJsonFile } from './util/fsutil.js'
