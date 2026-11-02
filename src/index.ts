// ─── @agentchatme/agent-core ────────────────────────────────────────────────
//
// The shared engine behind every AgentChat coding-agent DOORBELL (Claude Code,
// Codex, the ones after them). A LIBRARY, not a CLI.
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
// deleted the other's credentials and stripped its wiring.
//
// An integration built on this library is a single-host binary that knows its
// own home at compile time. There is no platform flag, no host detection, and
// no code path that could reach a different agent's files.
//
// A doorbell does five things and nothing else (docs: the main-line decision
// record): hold the connection, knock, start one run, place the four texts,
// offer a wizard and a doctor. What stays here is what must NOT drift between
// doorbells: the identity flows, the credential format, the socket that never
// acknowledges, the knock coalescer and retry ladder, the run prompts with the
// server's wake text, the bundled manual and identity line, the service
// plumbing. What belongs to each integration: where its home is, which file
// its anchor lives in, how its runtime spells MCP tools, how to start one
// headless run of its runtime, and where its runtime keeps skills.

export { CODING_AGENTS_CLIENT_IDENTITY, CODING_AGENTS_CLIENT_HEADERS } from './client-identity.js'
export { VERSION } from './version.js'

// Raw reads on the main line. No sync, no ack: delivered is the agent's to settle.
export {
  wireRequest,
  getMeLite,
  traySummary,
  trayHasWaiting,
  listGroupInvites,
  WireError,
  INBOX_MAX_LIMIT,
  type WireConfig,
  type TraySummary,
  type PendingInvite,
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

export {
  readState,
  writeState,
  recordOfferDeclined,
  offerDeclined,
  clearOfferDeclined,
  type IdentityState,
} from './identity/state.js'

// The four texts, as the main line authored them, plus the wizard's offer.
export {
  MANUAL,
  MANUAL_URL,
  MANUAL_SKILL_NAME,
  MANUAL_FILENAME,
  manualVersion,
  manualCarriesIdentityLine,
  manualPointer,
} from './skill/manual.js'
export {
  IDENTITY_LINE_TEMPLATE,
  IDENTITY_LINE_SOURCE,
  renderIdentityLine,
  normalizeHandle,
} from './skill/identity-line.js'
export { renderUnregisteredBlock, renderDeclinedBlock, type HostCopy } from './anchor/offer.js'

// Instruction-file anchor — fenced-block editing against an explicit path.
export {
  ANCHOR_START,
  ANCHOR_END,
  renderAnchorBlock,
  writeAnchor,
  removeAnchorAt,
  hasAnchorAt,
  anchorIsCurrentAt,
  readAnchorHandleAt,
  readAnchorHandleFrom,
  upsertAnchorBlock,
  stripAnchorBlock,
  type AnchorAction,
} from './anchor/block.js'

// The run prompts: the server's wake text with the runtime's tool names.
export {
  wakeInstruction,
  knockPrompt,
  invitePrompt,
  buildDoorbellPrompts,
  mcpToolNamer,
  BARE_TOOL_NAMER,
  HOSTED_TOOLS,
  type ToolNamer,
  type PromptOptions,
  type DoorbellPrompts,
} from './doorbell/prompt.js'

// Run profile and switches.
export {
  RUN_PROFILES,
  RUN_PROFILE_ENV,
  DEFAULT_RUN_PROFILE,
  DOORBELL_ENV,
  RUN_BUDGET_ENV,
  DEFAULT_RUN_BUDGET_MS,
  isRunProfile,
  resolveRunProfile,
  doorbellDisabled,
  resolveRunBudgetMs,
  type RunProfile,
} from './doorbell/profile.js'

// Doorbell status, as the daemon writes it and `status` reads it.
export {
  DOORBELL_STATUS_FILE,
  SOCKET_STATES,
  doorbellStatusPath,
  readDoorbellStatus,
  writeDoorbellStatus,
  clearDoorbellStatus,
  doorbellStatusAge,
  formatDoorbellStatus,
  type DoorbellStatus,
  type DoorbellLastRun,
  type SocketState,
} from './doorbell/status.js'

// The hosted tool server: where it is, and whether the key opens it.
export { HOSTED_MCP_PATH, hostedMcpUrl, probeHostedMcp, type McpProbeResult } from './doorbell/mcp-probe.js'

// The runner seam (types only here; `spawnRun` lives in the daemon entry).
export type {
  RunRunner,
  RunRequest,
  RunOutcome,
  RunOutcomeState,
  RunKind,
  RunPreflight,
} from './doorbell/runner.js'

// The identity command set. An integration describes itself once (HostProfile)
// and gets register/login/recover/status/logout/doctor back.
export {
  createIdentityCommands,
  type IdentityCommands,
  type RegisterOpts,
  type RecoverOpts,
  type DoctorOpts,
} from './identity/commands.js'
export { anchorLabelOf, type HostProfile, type DoctorCheck, type Verdict } from './identity/host-profile.js'

// Service plumbing: always-on markers, heartbeat, leader lock, service units.
export {
  markAlwaysOnWanted,
  clearAlwaysOnWanted,
  alwaysOnWanted,
  readAlwaysOnInstalledVersion,
  markAlwaysOnInstalledVersion,
  clearAlwaysOnInstalledVersion,
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
  serviceLabelFor,
  parseServiceHome,
  setServiceCommandRunnerForTests,
  serviceStatus,
  serviceInstalled,
  serviceDefinitionCurrent,
  planForTest,
  systemdQuote,
  systemdUnit,
  xmlEscape,
  launchdPlist,
  type ServiceOpts,
  type ServiceRef,
  type ServiceCommandRunner,
  type Plan,
} from './daemon/service.js'

// The daemon's socket layer lives at `@agentchatme/agent-core/daemon`, not
// here: it depends on `ws` (CommonJS, dynamic require), which must never be
// bundled into an integration's CLI.

// Utilities integrations legitimately share.
export { log } from './util/log.js'
export { atomicWriteFile, atomicCopyFile, readJsonFile } from './util/fsutil.js'
export { spawnCommand, spawnCommandSync } from './util/spawn.js'
