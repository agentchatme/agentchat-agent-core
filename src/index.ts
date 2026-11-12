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
// served texts, and the integration kit (`integration` in `agentchatme`: the
// receive loop, wake coalescing, the texts cache, the manual sync) — and every
// text an agent sees is the server's, fetched and placed, never copied (rule
// 3). What stays here is what must NOT drift between this package's
// integrations and is not the kit's: the identity flows, the credential
// format, the resident supervisor and the runner seam, the status file, the
// manual's bundled fallback, the service plumbing — and the presets the
// integrations and the `agentchat` CLI (@agentchatme/cli) share (`./presets`).
// What belongs to each integration: where its home is, which file its anchor
// lives in, and where its runtime keeps skills.

export { clientIdentityOf, clientHeadersOf, clientNameOf, type IntegrationClient } from './client-identity.js'
export { VERSION } from './version.js'

// Counts on the tray (through the SDK), for `status`.
export { traySummary, type TraySummary, type TrayClient } from './integration/tray.js'

// The served texts for a CLI command: one fetch, the identity-home copy as
// fallback (the resident integration holds the SDK kit's TextsCache).
export {
  loadTexts,
  fetchServedTexts,
  fetchIdentityLine,
  readCachedTexts,
  textsCachePath,
  TEXTS_CACHE_FILE,
  type CachedTexts,
  type FetchIdentityLineOptions,
  type FetchServedTextsOptions,
  type LoadedTexts,
  type LoadTextsOptions,
  type TextsClient,
  type TextsSource,
} from './integration/texts.js'

// Identity — credential + pending storage, always scoped to a given home.
export {
  DEFAULT_API_BASE,
  credentialsPath,
  pendingPath,
  statePath,
  readCredentials,
  resolveIdentity,
  envApiKey,
  writeCredentials,
  clearCredentials,
  readPending,
  writePending,
  clearPending,
  type Credentials,
  type ResolvedIdentity,
  type ResolveIdentityOptions,
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

// The manual: the served one placed and kept current (the bundled copy is the
// fallback for a skill file that does not exist and cannot be downloaded),
// then the identity line's placement and the wizard's offer.
export { MANUAL, MANUAL_URL, MANUAL_SKILL_NAME, MANUAL_FILENAME, manualFrontMatter, manualVersion, manualPointer } from './skill/manual.js'
export {
  syncManual,
  fromKitResult,
  checkManual,
  describeManualSync,
  readManualVersion,
  MANUAL_MAX_BYTES,
  MANUAL_FETCH_TIMEOUT_MS,
  MANUAL_MAX_REDIRECTS,
  type ServedManual,
  type ManualFetch,
  type ManualSyncState,
  type ManualSyncResult,
  type SyncManualOptions,
  type ManualCheck,
  type ManualCheckState,
  type CheckManualOptions,
} from './skill/served-manual.js'
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
  INTEGRATION_ENV_LEGACY_REMOVAL,
  RUN_BUDGET_ENV,
  DEFAULT_RUN_BUDGET_MS,
  isRunProfile,
  resolveRunProfile,
  PEER_RUN_WARNING,
  runProfileWarning,
  workdirExposesHome,
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
  type IntegrationCycle,
  FAILED_CYCLE_OUTCOMES,
  REPEATED_FAILED_CYCLES,
  failedCyclesInARow,
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
  RunnerIdentity,
  RunnerFactory,
  RunnerSource,
  RunWake,
} from './integration/runner.js'
export { isRunnerFactory } from './integration/runner.js'

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
  type StatusContext,
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
  setServiceHostOsForTests,
  type ServiceHostOs,
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
