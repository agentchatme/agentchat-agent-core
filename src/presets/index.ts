// ─── @agentchatme/agent-core/presets ────────────────────────────────────────
//
// How to start one headless run of a known coding agent, shared by the
// `agentchat listen --preset <name>` listener and each runtime's own
// integration package (one copy of the flags, never two). The only module of
// this package that names a coding agent; the engine never imports it.

import { claudeCodePreset } from './claude-code.js'
import { codexPreset } from './codex.js'
import type { Preset } from './types.js'

export type { Preset, PresetContext, PresetInspection } from './types.js'
export { withoutParentSession, isParentSessionEnv, CLAUDE_CODE_ENV_KEPT, CLAUDE_SESSION_ENV, CODEX_SESSION_ENV, CODEX_MANAGED_PROXY_ENV } from './types.js'
export { semverAtLeast } from './semver.js'
export {
  CLAUDE_CODE_PRESET,
  MIN_CLAUDE_CODE_VERSION,
  PROBE_TIMEOUT_MS,
  CLAUDE_MCP_SERVER_NAME,
  AGENTCHAT_TOOL_ALLOW,
  ANSWER_TOOLS,
  WEB_TOOLS,
  WORK_TOOLS,
  ANSWER_DENIED_TOOLS,
  ANSWER_SETTINGS,
  PARENT_ENV_KEYS,
  claudeConfigDirFrom,
  claudeHomeFor,
  claudeProjectsDirFor,
  claudeUserStatePathFor,
  buildClaudeEnv,
  claudeIsLoggedIn,
  claudeSignIn,
  type ClaudeSignIn,
  inspectClaudeRuntime,
  deniedAncestorOf,
  claudeProfileArgs,
  workdirPaths,
  workdirReadRules,
  readDenyRules,
  inexpressibleDenyPaths,
  claudeRunArgs,
  claudeMcpConfig,
  claudeMcpConfigPath,
  ClaudeRunner,
  claudeCodePreset,
  claudeAnswerFallbackWorkdir,
  claudeManagedSettingsDir,
  claudeSettingsFilesGrantingDirectories,
  claudeExtraDirectoriesGrant,
  ANSWER_ENV,
  type ClaudeAnswerMcp,
  type ClaudeRunArgOptions,
  type ClaudeRunnerOptions,
} from './claude-code.js'
export {
  CODEX_PRESET,
  MIN_CODEX_VERSION,
  CODEX_PROBE_TIMEOUT_MS,
  CODEX_MCP_SERVER_NAME,
  LISTENER_KEY_ENV,
  CODEX_PROMPT_FROM_STDIN,
  CODEX_ANSWER_PERMISSIONS,
  CODEX_ANSWER_FILESYSTEM,
  CODEX_ANSWER_DISABLED_FEATURES,
  codexHomeFrom,
  inspectCodexRuntime,
  codexIsLoggedIn,
  codexProfileArgs,
  codexMcpOverrideArgs,
  codexClientHeadersToml,
  codexRunArgs,
  agentchatTableKeys,
  CodexRunner,
  codexPreset,
  codexAnswerFallbackWorkdir,
  codexServerNameAddressable,
  parseCodexMcpList,
  codexMcpDisableArgs,
  CODEX_MCP_LIST_TIMEOUT_MS,
  CODEX_MCP_LIST_MAX_AGE_MS,
  codexConfigLayerFiles,
  type CodexMcpOverride,
  type CodexRunnerOptions,
} from './codex.js'

/** Every preset, by the name a user types. */
export const PRESETS: Readonly<Record<string, Preset>> = Object.freeze({
  [claudeCodePreset.name]: claudeCodePreset,
  [codexPreset.name]: codexPreset,
})

export function presetNamed(name: string): Preset | null {
  return Object.prototype.hasOwnProperty.call(PRESETS, name) ? (PRESETS[name] ?? null) : null
}

export function presetNames(): string[] {
  return Object.keys(PRESETS)
}
