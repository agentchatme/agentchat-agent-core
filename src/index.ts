// ─── @agentchatme/agent-core ────────────────────────────────────────────────
//
// The shared engine behind every AgentChat coding-agent INTEGRATION (Claude
// Code, Codex, the ones after them). A LIBRARY, not a CLI.
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
// An integration holds only runtime code (docs/architecture.md, rule 4): the
// lifecycle, how to start a turn, config, logs. Everything that talks to
// AgentChat is the SDK's — the socket that acks on receipt, the tray, the
// served texts — and every text an agent sees is the server's, fetched and
// placed, never copied (rule 3). What stays here is what must NOT drift
// between integrations: the identity flows, the credential format, the wake
// coalescer and retry ladder, the texts cache, the bundled manual's
// placement, the service plumbing. What belongs to each integration: where
// its home is, which file its anchor lives in, how to start one headless run
// of its runtime, and where its runtime keeps skills.

export { clientIdentityOf, clientHeadersOf, type IntegrationClient } from './client-identity.js'
export { VERSION } from './version.js'

// Counts on the tray (through the SDK), for `status` and the wake guard.
export { traySummary, trayHasWaiting, type TraySummary, type TrayClient } from './integration/tray.js'

// The served texts: fetched, cached in the identity home, never copied.
export {
  loadTexts,
  fetchIdentityLine,
  readCachedTexts,
  writeCachedTexts,
  textsCachePath,
  TEXTS_CACHE_FILE,
  TEXTS_REFRESH_MS,
  TEXTS_RETRY_MS,
  TextsStore,
  type CachedTexts,
  type FetchIdentityLineOptions,
  type LoadedTexts,
  type LoadTextsOptions,
  type TextsClient,
  type TextsSource,
  type TextsStoreOptions,
} from './integration/texts.js'
export { buildRunPrompts, type RunPrompts } from './integration/prompts.js'

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

// The manual (still placed from the package), the identity line's placement, the wizard's offer.
export { MANUAL, MANUAL_URL, MANUAL_SKILL_NAME, MANUAL_FILENAME, manualVersion, manualPointer } from './skill/manual.js'
export { identityLineOf, normalizeHandle } from './skill/identity-line.js'
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

// Run profile and switches.
export {
  RUN_PROFILES,
  RUN_PROFILE_ENV,
  DEFAULT_RUN_PROFILE,
  INTEGRATION_ENV,
  INTEGRATION_ENV_LEGACY,
  RUN_BUDGET_ENV,
  DEFAULT_RUN_BUDGET_MS,
  isRunProfile,
  resolveRunProfile,
  integrationDisabled,
  integrationDisabledBy,
  resolveRunBudgetMs,
  type RunProfile,
} from './integration/profile.js'

// Integration status, as the daemon writes it and `status` reads it.
export {
  INTEGRATION_STATUS_FILE,
  LEGACY_STATUS_FILE,
  SOCKET_STATES,
  integrationStatusPath,
  readIntegrationStatus,
  writeIntegrationStatus,
  clearIntegrationStatus,
  integrationStatusAge,
  formatIntegrationStatus,
  type IntegrationStatus,
  type IntegrationLastRun,
  type TextsStatus,
  type SocketState,
} from './integration/status.js'

// The hosted tool server: where it is, and whether the key opens it.
export { HOSTED_MCP_PATH, hostedMcpUrl, probeHostedMcp, type McpProbeResult } from './integration/mcp-probe.js'

// The runner seam (types only here; `spawnRun` lives in the daemon entry).
export type {
  RunRunner,
  RunRequest,
  RunOutcome,
  RunOutcomeState,
  RunKind,
  RunPreflight,
} from './integration/runner.js'

// The identity command set. An integration describes itself once (HostProfile)
// and gets register/login/recover/status/logout/doctor back.
export {
  createIdentityCommands,
  type IdentityCommands,
  type RegisterOpts,
  type RecoverOpts,
  type DoctorOpts,
} from './identity/commands.js'
export {
  anchorLabelOf,
  type HostProfile,
  type DoctorCheck,
  type DoctorContext,
  type Verdict,
} from './identity/host-profile.js'

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
