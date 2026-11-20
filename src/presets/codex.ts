import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clientHeadersOf } from '../client-identity.js'
import { hostedMcpUrl } from '../integration/mcp-probe.js'
import { workdirExposesHome, type RunProfile } from '../integration/profile.js'
import type { RunOutcome, RunPreflight, RunPreflightOptions, RunRequest, RunRunner } from '../integration/runner.js'
import { killProcessTree, redactDiagnostic, spawnRun } from '../integration/spawn-run.js'
import { atomicWriteFile } from '../util/fsutil.js'
import { log } from '../util/log.js'
import { spawnCommand } from '../util/spawn.js'
import { runProbe } from '../util/probe.js'
import { VERSION } from '../version.js'
import { semverAtLeast } from './semver.js'
import { RUNTIME_CHECK_DIR, runRuntimeCheck } from './runtime-check.js'
import { withoutInheritedKey, withoutParentSession, type Preset, type PresetContext, type PresetInspection } from './types.js'

// ─── Codex: one headless run (`codex exec`) ─────────────────────────────────
//
// `codex exec` on the box, riding the user's own Codex sign-in and config. The
// run's output is discarded by `spawnRun`. Flags, verified against `codex exec
// --help` (codex-cli 0.154.0) and the openai/codex sources:
//
//   -s, --sandbox read-only|workspace-write|danger-full-access
//                                   the sandbox policy for model-generated commands
//   --dangerously-bypass-approvals-and-sandbox
//                                   skip all confirmation prompts and run unsandboxed
//   -c approval_policy="never"      `codex exec` already defaults to `never` in
//                                   headless mode — passed explicitly so a run can
//                                   never wait on an approval, whatever a profile
//                                   or requirements file says.
//   -c mcp_servers.<name>.<key>=…   per-run config overrides (TOML values): how a
//                                   listener points the hosted server at its own
//                                   agent's key, whatever config.toml registers.
//   --json                          events as JSONL on stdout (discarded; the first
//                                   event is how "started" is told from "never got
//                                   going")
//   --skip-git-repo-check           the run's working directory is not a repository
//   --ephemeral                     no session files on disk for a wake run
//   -C <dir>                        the working root
//
// The hosted AgentChat tools reach the run through `[mcp_servers.agentchat]`
// (bearer token from an environment variable named in the config, never the
// key itself), with `default_tools_approval_mode = "approve"` so they never
// prompt (with `approval_policy = "never"`, an MCP tool call that needs
// approval is denied: codex-rs/core/src/mcp_tool_call.rs).
//
// `own` — the agent itself — passes no `--sandbox`, no `approval_policy`, no
// `--disable` and no permission profile: the user's config.toml (and its
// profiles, project layers and requirements) decides the sandbox, the web,
// the tools and the instructions, as in their own `codex exec` runs. Nothing
// waits on an approval all the same: `codex exec` sets `approval_policy =
// "never"` itself unless the user's config hands approvals to Codex's
// auto-review (a model, not a person), and it rejects every approval,
// permission or user-input request a run makes instead of waiting
// (exec/src/lib.rs at rust-v0.154.0: the headless `AskForApproval::Never`
// override, `build_exec_config`, `handle_server_request`; verified on the real
// 0.154.0 with `approval_policy = "on-request"` in the user's config: an
// escalation was rejected at once). The only `-c` keys are AgentChat's own
// server's (`mcp_servers.agentchat.*`). Codex's sandboxes restrict writes and
// the network, never reads, so an `own` run's shell can read any file the
// user can — the identity home's `credentials` included (README, known limits).
//
// `answer` — started by any peer's message — must read nothing outside its
// workdir and have no way out but the AgentChat tools. Codex can restrict a
// sandbox's READS (a permission profile: `default_permissions` +
// `[permissions.<name>.filesystem]`), but a shell needs `":minimal"` to run at
// all, and on macOS that also opens /etc, /usr, /Library/Preferences and, for
// the shell process, read-write /tmp and /var/tmp
// (codex-rs/sandboxing/src/seatbelt_read_only_platform_defaults.sbpl,
// seatbelt.rs:27-33; on Linux /etc, /usr, /bin, … in linux-sandbox/src/bwrap.rs).
// So `answer` has NO shell and no local-file tool (verified against the
// openai/codex sources at rust-v0.154.0):
//
//   --disable shell_tool            no exec_command / write_stdin
//                                   (core/src/tools/spec_plan.rs:1083-1088;
//                                   `unified_exec` cannot be turned off by user
//                                   config, but it is registered only past
//                                   this check)
//   --disable view_image, image_generation
//                                   the image tools that read local files
//   --disable plugins, apps         plugin-bundled MCP servers and skills (a
//                                   computer-use server among them) and the
//                                   ChatGPT connectors (`codex_apps`)
//   --disable memories              the local memory store in CODEX_HOME
//   --disable browser_use, browser_use_external, computer_use, in_app_browser
//                                   no tool of their own in 0.154.0; off so a
//                                   later build cannot add one to `answer`
//   -c web_search="disabled"        the hosted web search (the top-level key;
//                                   `tools.web_search=false` is parsed and
//                                   ignored, config_toml.rs:655-670)
//   -c default_permissions=… + -c permissions.<name>.filesystem={ ":workspace_roots" = "read" }
//                                   for what cannot be turned off: apply_patch
//                                   (no feature flag) reads through the sandbox,
//                                   so it reads only the workdir (`-C`), writes
//                                   nothing; no network. Replaces
//                                   `--sandbox read-only`, which reads the whole
//                                   disk ($CODEX_HOME/.env included).
//
// The runtime check (`checkRuntime`, runtime-check.ts) is one `codex exec`
// with a fixed prompt, the same binary, CODEX_HOME and environment as the runs
// (no key in it), in an empty folder of its own (`-C`), `--ephemeral`, closed
// the way an `answer` run is where the 0.154.0 floor allows
// (`codexRuntimeCheckArgs`):
//
//   --sandbox read-only             nothing written, no network for commands.
//   -c web_search="disabled", --disable memories, plugins, apps
//                                   as an `answer` run: no web search, no local
//                                   memory, no plugin-bundled servers or skills,
//                                   no ChatGPT connectors.
//   --disable hooks                 none of the user's hooks fire on a health
//                                   check (`hooks` is the feature key of
//                                   Feature::CodexHooks, stable and on by
//                                   default in 0.154.0, `codex features list`;
//                                   it sets HooksConfig.feature_enabled,
//                                   core/src/session/mod.rs:4726).
//   -c mcp_servers.agentchat.url=<the runs' URL>, -c mcp_servers.agentchat.enabled=false
//                                   the hosted AgentChat server switched off
//                                   (with the URL the table is valid whether or
//                                   not a config layer defines one).
//
// No reasoning effort is set: the check asks with the effort the runs use (the
// user's `model_reasoning_effort`, else the model's default). Codex sends a
// configured effort as is (protocol/src/openai_models/reasoning_effort.rs:
// only `ultra` and `persistent` are mapped), so `low` would make a model
// without it (one that accepts only `high`, or no reasoning effort at all)
// refuse every check; the check would then never pass for that user.
//
// The check is ok only on exit 0 AND, in its `--json` events
// (exec/src/exec_events.rs), a `turn.completed` with an `agent_message` item
// that holds text, and no `turn.failed` (`codexRuntimeCheckJudge`): exit 0
// alone is not an answer. The events are read from a bounded capture
// (`RUNTIME_CHECK_OUTPUT_BYTES`), never logged.
//
// The user's OTHER MCP servers still load: Codex 0.154.0 has no documented
// switch that turns every MCP server off, and switching each off by name
// (`-c mcp_servers.<name>.enabled=false`) needs the names first — a `codex
// mcp list --json` per check, as an `answer` run does, which would add its own
// time and failure to a 45 s probe whose prompt asks for no tool. Codex loads
// `$CODEX_HOME/.env` itself: an AgentChat key that a Codex integration before
// 0.5.3 left there is removed by the upgrade (and a listener's own runs do not
// start while one is there, `ownAuthProblem`). The user's config.toml still
// decides the model and its provider, as for the runs. Verified on 0.154.0
// against a stand-in provider: these flags parse with and without an
// `agentchat` table in config.toml; the model is offered no agentchat tool and
// no web search; a provider error exits 1 and an answer exits 0. Rechecked for
// 0.7.1 (stand-in provider): `--disable hooks` parses, the request carries no
// effort of ours, and an answer prints `item.completed` (`agent_message`,
// "OK") then `turn.completed`; a refusal prints `turn.failed` and exits 1.

export const CODEX_PRESET = 'codex'

/** `--ephemeral`, `--sandbox`, `-C`, `--json` all exist on this version; older builds were not checked. */
export const MIN_CODEX_VERSION = '0.154.0'

/** The `[mcp_servers.<name>]` table the runs use; tools are `mcp__agentchat__<tool>`, as the served texts spell them. */
export const CODEX_MCP_SERVER_NAME = 'agentchat'

/**
 * The variable a listener's runs read the bearer token from. Deliberately not
 * `AGENTCHAT_API_KEY`: Codex loads `$CODEX_HOME/.env` at startup, where an
 * installed integration keeps ITS agent's key under that name.
 */
export const LISTENER_KEY_ENV = 'AGENTCHAT_LISTENER_API_KEY'

/**
 * The final positional argument: `-` tells `codex exec` to read its
 * instructions from stdin ("If not provided as an argument (or if `-` is
 * used), instructions are read from stdin").
 */
export const CODEX_PROMPT_FROM_STDIN = '-'

/** Codex's config root. Honouring CODEX_HOME matters: users relocate it. */
export function codexHomeFrom(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['CODEX_HOME']
  if (override !== undefined && override.trim().length > 0) return path.resolve(override)
  return path.join(os.homedir(), '.codex')
}

/** How long a probe (`--version`, `login status`) may take; a hung one is killed with its whole tree (`runProbe`). */
export const CODEX_PROBE_TIMEOUT_MS = 10_000

export async function inspectCodexRuntime(codexHome: string, command = 'codex', timeoutMs = CODEX_PROBE_TIMEOUT_MS, signal?: AbortSignal): Promise<PresetInspection> {
  const result = await runProbe(command, ['--version'], { timeoutMs, env: { ...process.env, CODEX_HOME: codexHome }, ...(signal !== undefined ? { signal } : {}) })
  if (result.timedOut) return { ok: false, detail: `codex --version did not answer within ${Math.round(timeoutMs / 1000)} s (killed)` }
  if (signal?.aborted) return { ok: false, detail: 'codex --version was stopped' }
  if (result.error) return { ok: false, detail: `codex CLI not found on PATH (${result.error.message})` }
  const rendered = (result.stdout || result.stderr).trim()
  if (result.status !== 0) return { ok: false, detail: rendered || `codex --version exited ${result.status}` }
  return semverAtLeast(rendered, MIN_CODEX_VERSION)
    ? { ok: true, detail: rendered }
    : { ok: false, detail: `${rendered || 'unrecognized version'}; AgentChat requires Codex >= ${MIN_CODEX_VERSION}` }
}

/** `codex login status` exits 0 when signed in. */
export async function codexIsLoggedIn(codexHome: string, command = 'codex', timeoutMs = CODEX_PROBE_TIMEOUT_MS, signal?: AbortSignal): Promise<PresetInspection> {
  const status = await runProbe(command, ['login', 'status'], { timeoutMs, env: { ...process.env, CODEX_HOME: codexHome }, ...(signal !== undefined ? { signal } : {}) })
  if (status.error) return { ok: false, detail: status.error.message }
  const detail = `${status.stdout}${status.stderr}`.trim().slice(0, 200)
  return status.status === 0 ? { ok: true, detail: detail || 'signed in' } : { ok: false, detail: detail || 'codex is not signed in (run `codex login`)' }
}

/** The permission profile an `answer` run is given: its own name, so a user's profiles are never selected. */
export const CODEX_ANSWER_PERMISSIONS = 'agentchat_answer'

/** Its filesystem table: read the workspace root (the `-C` workdir) and nothing else; no write anywhere. */
export const CODEX_ANSWER_FILESYSTEM = '{ ":workspace_roots" = "read" }'

/**
 * Codex features an `answer` run turns off: every model-visible tool that runs
 * a command, reads a local file or reaches out beside the hosted AgentChat
 * tools (see the header). Names as `codex features list` prints them (0.154.0).
 */
export const CODEX_ANSWER_DISABLED_FEATURES = [
  'shell_tool',
  'view_image',
  'image_generation',
  'plugins',
  'apps',
  'memories',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'in_app_browser',
] as const

export function codexProfileArgs(profile: RunProfile): string[] {
  switch (profile) {
    // The agent itself: nothing but the run's shape (see the header).
    case 'own':
      return []
    case 'answer':
      return [
        '-c',
        'approval_policy="never"',
        '-c',
        `default_permissions="${CODEX_ANSWER_PERMISSIONS}"`,
        '-c',
        `permissions.${CODEX_ANSWER_PERMISSIONS}.filesystem=${CODEX_ANSWER_FILESYSTEM}`,
        '-c',
        'web_search="disabled"',
        // No project or ancestor AGENTS.md (core/src/agents_md.rs:65-67, 129: a
        // zero budget reads none). $CODEX_HOME/AGENTS.md has no such switch in
        // 0.154.0 (codex-home/src/instructions/mod.rs, wired unconditionally).
        '-c',
        'project_doc_max_bytes=0',
        ...CODEX_ANSWER_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
      ]
    // `work` and `full` are the operator's explicit opt-in: a run started by
    // any peer's message can then read and change this machine.
    case 'work':
      return ['--sandbox', 'workspace-write', '-c', 'approval_policy="never"']
    case 'full':
      return ['--dangerously-bypass-approvals-and-sandbox']
  }
}

/**
 * The features a runtime check turns off: as an `answer` run does (memories,
 * plugins, apps), and the user's hooks (names at the 0.154.0 floor, `codex
 * features list`).
 */
export const CODEX_RUNTIME_CHECK_DISABLED_FEATURES = ['memories', 'plugins', 'apps', 'hooks'] as const

/**
 * The argv of a runtime check: `codex exec` in `dir` (an empty folder), the
 * read-only sandbox, no session files, no web search, memories, plugins,
 * connectors or hooks, and the hosted AgentChat server switched off for it;
 * the prompt on stdin, as for a run. The model and its reasoning effort are
 * the runs' (see the header). `agentchatUrl` is the URL the runs pin (with
 * it, the `agentchat` table stays valid whether or not a config layer defines
 * one); without it a config layer must define the table, as the runs need.
 */
export function codexRuntimeCheckArgs(dir: string, agentchatUrl?: string): string[] {
  const table = `mcp_servers.${CODEX_MCP_SERVER_NAME}`
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ephemeral',
    '-C',
    dir,
    '--sandbox',
    'read-only',
    '-c',
    'web_search="disabled"',
    ...CODEX_RUNTIME_CHECK_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
    ...(agentchatUrl !== undefined ? ['-c', `${table}.url=${JSON.stringify(agentchatUrl)}`] : []),
    '-c',
    `${table}.enabled=false`,
    CODEX_PROMPT_FROM_STDIN,
  ]
}

/** The empty folder a runtime check runs in, under CODEX_HOME. */
export function codexRuntimeCheckWorkdir(codexHome: string): string {
  return path.join(codexHome, RUNTIME_CHECK_DIR)
}

/** A JSON object, or null for anything else. */
function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/**
 * Whether a runtime check's stdout (`codex exec --json`: one event per line,
 * exec/src/exec_events.rs) is a good answer: null when it holds a
 * `turn.completed` event and an `item.completed` whose item is an
 * `agent_message` with text, and no `turn.failed`; otherwise why not, in event
 * types only, never a message or an error's text. Exit 0 alone is not an
 * answer. A line that is not a JSON object is skipped (a cut-off last line
 * included: its events are then missing, and the check is not ok).
 */
export function codexRuntimeCheckJudge(stdout: string): string | null {
  let events = 0
  let completed = false
  let failed = false
  let answered = false
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    let event: Record<string, unknown> | null
    try {
      event = jsonObject(JSON.parse(line))
    } catch {
      continue
    }
    if (event === null) continue
    events += 1
    if (event['type'] === 'turn.completed') completed = true
    else if (event['type'] === 'turn.failed') failed = true
    else if (event['type'] === 'item.completed') {
      const item = jsonObject(event['item'])
      if (item !== null && item['type'] === 'agent_message' && typeof item['text'] === 'string' && item['text'].trim().length > 0) answered = true
    }
  }
  if (events === 0) return 'its answer holds no JSON event'
  if (failed) return 'the turn failed (turn.failed)'
  if (!completed) return 'the turn did not complete (no turn.completed)'
  if (!answered) return 'the turn completed with no agent message'
  return null
}

/** Where a run's hosted tool server points, and which variable carries its bearer token. */
export interface CodexMcpOverride {
  readonly url: string
  readonly keyEnv: string
  /**
   * A headers helper command (`http_headers_helper`) in place of the bearer
   * variable: the run's environment then carries no key. A listener's `own`
   * runs use one (`codexListenerHeadersHelperPath`): with the user's own
   * shell, an environment variable is one `env` away.
   */
  readonly headersHelper?: string
  /** The version named in `X-AgentChat-Client-Version` (the front door that placed the run). Defaults to this engine's. */
  readonly clientVersion?: string
}

/**
 * `{"X-AgentChat-Client" = "codex", "X-AgentChat-Client-Version" = "<version>"}`:
 * the client headers that name the runtime to the hosted tool server, as a
 * TOML inline table for `-c …http_headers=`. Codex parses a `-c` value as
 * TOML (inline tables included) since before 0.154.0, and sends
 * `http_headers` on every request to a streamable-HTTP server. Without them
 * a run is an unknown client and is shown the wake-webhook tools.
 */
export function codexClientHeadersToml(clientVersion: string = VERSION): string {
  const pairs = Object.entries(clientHeadersOf({ runtime: 'codex', version: clientVersion })).map(([name, value]) => `${JSON.stringify(name)} = ${JSON.stringify(value)}`)
  return `{ ${pairs.join(', ')} }`
}

/** `-c mcp_servers.agentchat.url="<url>"`: the hosted server's URL pinned for one run, whatever another config layer says. */
export function codexPinnedUrlArgs(url: string): string[] {
  return ['-c', `mcp_servers.${CODEX_MCP_SERVER_NAME}.url=${JSON.stringify(url)}`]
}

/** The `-c` overrides that make `[mcp_servers.agentchat]` this agent's, for one run. TOML values, no key in them. */
export function codexMcpOverrideArgs(override: CodexMcpOverride): string[] {
  const table = `mcp_servers.${CODEX_MCP_SERVER_NAME}`
  return [
    '-c',
    `${table}.url=${JSON.stringify(override.url)}`,
    '-c',
    override.headersHelper !== undefined ? `${table}.http_headers_helper=${JSON.stringify(override.headersHelper)}` : `${table}.bearer_token_env_var=${JSON.stringify(override.keyEnv)}`,
    '-c',
    `${table}.default_tools_approval_mode="approve"`,
    '-c',
    `${table}.http_headers=${codexClientHeadersToml(override.clientVersion ?? VERSION)}`,
  ]
}

/**
 * The full argument list for one headless run. The prompt is NOT an argument:
 * the runner writes it to stdin and closes it. An argument cannot carry it on
 * Windows — npm installs codex as a `.cmd` shim, cross-spawn runs that through
 * cmd.exe, and cmd.exe ends the command at the first line break, so every line
 * after the first was silently dropped (caught by CI on windows-latest).
 */
export function codexRunArgs(profile: RunProfile, options: { workdir: string; mcp?: CodexMcpOverride }): string[] {
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ephemeral',
    '-C',
    options.workdir,
    ...codexProfileArgs(profile),
    ...(options.mcp !== undefined ? codexMcpOverrideArgs(options.mcp) : []),
    CODEX_PROMPT_FROM_STDIN,
  ]
}

export interface CodexRunnerOptions {
  readonly codexHome: string
  /** The run's working root (`-C`); the `work` profile may write here. */
  readonly workdir: string
  readonly profile: RunProfile
  /** The agent's key, read per run (a credential change between runs is followed). Null: none is set. */
  readonly apiKey: () => string | null
  /** The variable the key is set under in the run's environment. */
  readonly keyEnv: string
  /** Point the hosted server at this agent for each run (`-c` overrides); absent, config.toml decides. */
  readonly mcp?: CodexMcpOverride
  /**
   * Without `mcp` (an integration's own runs): the hosted server's URL
   * (`<api base>/mcp`), pinned on every run with `-c mcp_servers.agentchat.url=…`
   * so no other config layer — a trusted project's `.codex/config.toml`
   * among them — can point the agentchat server, and the key its bearer
   * variable carries, anywhere else. A layer that gives it a `command`
   * instead makes the merged table invalid: the run does not start.
   */
  readonly pinMcpUrl?: string
  /** Test seam: the binary to run. */
  readonly command?: string
  readonly env?: NodeJS.ProcessEnv
  /** Test seam: how long `codex mcp list` may take (`CODEX_MCP_LIST_TIMEOUT_MS`). */
  readonly mcpListTimeoutMs?: number
  /** Why no run may start (preflight and every run say it); absent: runs start. */
  readonly refuse?: string
}

/**
 * The folder an `own` or `answer` run works in when its configured workdir is
 * the user's home folder or contains it (`workdirExposesHome`): an empty folder
 * of its own under CODEX_HOME. The run keeps working — it only cannot reach the
 * user's files through its workspace root. An `own` run needs this as much: a
 * user's `workspace-write` sandbox would let a peer-started run write anywhere
 * under the workspace root, which would be the whole home.
 */
export function codexAnswerFallbackWorkdir(codexHome: string): string {
  return path.join(codexHome, 'agentchat-answer-workdir')
}

/** How long `codex mcp list` may take before an answer run is given up (not started). */
export const CODEX_MCP_LIST_TIMEOUT_MS = 20_000
/** After a listing is killed: how long to wait for it to have exited (it holds the workdir) before it is given up on. */
export const CODEX_MCP_LIST_KILL_WAIT_MS = 10_000
/** The most `codex mcp list --json` output read; more is a failure, not a truncation. */
const CODEX_MCP_LIST_MAX_BYTES = 1024 * 1024

/**
 * A server name a `-c mcp_servers.<name>.enabled=false` override can address.
 * Codex splits a `-c` key on every `.` (codex-rs/config/src/overrides.rs) and
 * the value at the first `=`, but allows `.` in a server name
 * (codex-mcp/src/rmcp_client.rs: `^[a-zA-Z0-9_:@/.-]+$`).
 */
export function codexServerNameAddressable(name: string): boolean {
  return /^[A-Za-z0-9_:@/-]+$/.test(name)
}

/**
 * The names of the MCP servers `codex mcp list --json` reports enabled, or why
 * that output cannot be trusted. Names only: an entry's transport can carry
 * header and env values, and none of it is kept.
 */
export function parseCodexMcpList(stdout: string): { ok: true; names: string[] } | { ok: false; detail: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return { ok: false, detail: 'its output is not JSON' }
  }
  if (!Array.isArray(parsed)) return { ok: false, detail: 'its output is not a list' }
  const names: string[] = []
  for (const entry of parsed) {
    const name = (entry as { name?: unknown } | null)?.name
    const enabled = (entry as { enabled?: unknown } | null)?.enabled
    if (typeof name !== 'string' || name.length === 0) return { ok: false, detail: 'an entry has no name' }
    if (enabled !== false) names.push(name)
  }
  return { ok: true, names }
}

/**
 * What the `agentchat` entry of `codex mcp list --json` would authenticate
 * with besides a headers helper: `bearer_token_env_var`, or an `Authorization`
 * in `env_http_headers` (names only, never values). Codex sends either in
 * place of the helper's `Authorization` ("Helper Authorization is used only
 * when the request has no explicit bearer/OAuth credential",
 * rmcp-client/src/http_headers.rs). A static `http_headers` is not counted:
 * a listener's run replaces that whole table. An entry the list does not
 * have authenticates with nothing else.
 */
export function codexAgentchatExplicitAuth(stdout: string): { ok: true; keys: string[] } | { ok: false; detail: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return { ok: false, detail: 'its output is not JSON' }
  }
  if (!Array.isArray(parsed)) return { ok: false, detail: 'its output is not a list' }
  const entry = parsed.find((e) => (e as { name?: unknown } | null)?.name === CODEX_MCP_SERVER_NAME) as { transport?: unknown } | undefined
  const transport = entry?.transport !== null && typeof entry?.transport === 'object' ? (entry.transport as Record<string, unknown>) : {}
  const keys: string[] = []
  const bearer = transport['bearer_token_env_var']
  if (typeof bearer === 'string' && bearer.length > 0) keys.push('bearer_token_env_var')
  const envHeaders = transport['env_http_headers']
  if (envHeaders !== null && typeof envHeaders === 'object' && Object.keys(envHeaders).some((name) => name.toLowerCase() === 'authorization')) keys.push('env_http_headers.Authorization')
  return { ok: true, keys }
}

/** The key variables a `.env` file sets (`AGENTCHAT_API_KEY`, `LISTENER_KEY_ENV`): names only. Codex loads `$CODEX_HOME/.env` into its own environment, and a run's commands inherit it. */
export function codexDotEnvKeyNames(content: string): string[] {
  const names = new Set<string>()
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*['"]?\S/.exec(line)
    if (match?.[1] === 'AGENTCHAT_API_KEY' || match?.[1] === LISTENER_KEY_ENV) names.add(match[1])
  }
  return [...names]
}

/**
 * `-c mcp_servers.<name>.enabled=false` for every listed server but AgentChat's,
 * or why that cannot be done. Only names Codex listed: an override for a server
 * no config layer defines is a config error ("invalid transport").
 */
export function codexMcpDisableArgs(names: readonly string[]): { ok: true; args: string[] } | { ok: false; detail: string } {
  const args: string[] = []
  for (const name of names) {
    if (name === CODEX_MCP_SERVER_NAME) continue
    if (!codexServerNameAddressable(name)) {
      return { ok: false, detail: `the MCP server "${name}" cannot be switched off for one run (Codex reads a "." in a -c key as a table); rename it or remove it` }
    }
    args.push('-c', `mcp_servers.${name}.enabled=false`)
  }
  return { ok: true, args }
}

/** Why an answer run does not start when Codex's MCP servers cannot be listed (or one cannot be switched off). */
function codexAnswerListingRefusal(detail: string): string {
  return `could not list Codex's MCP servers (\`codex mcp list --json\` with the answer flags: ${detail}); an answer run starts only with every server but ${CODEX_MCP_SERVER_NAME} switched off`
}

/** How long a listing is reused while none of the files it was read from changed (layers that are not files: a cloud bundle). */
export const CODEX_MCP_LIST_MAX_AGE_MS = 60 * 60_000

/**
 * The config files `codex mcp list` (and the run) read, in the loader's order
 * (openai/codex rust-v0.154.0 config/src/loader/mod.rs:79-95, 800-841,
 * layer_io.rs:22, 78-92, loader/macos.rs:20):
 *
 *   * system: `/etc/codex/config.toml`, the legacy `/etc/codex/managed_config.toml`
 *     and `/etc/codex/requirements.toml`; on Windows `<ProgramData>\OpenAI\Codex\`
 *     `config.toml` and `requirements.toml` (the ProgramData known folder,
 *     `C:\ProgramData` when it cannot be resolved; `CODEX_HOME\managed_config.toml`
 *     is ignored there),
 *   * macOS managed preferences (`com.openai.codex`),
 *   * the user's `$CODEX_HOME/config.toml`,
 *   * `config.toml` in the workdir and `.codex/config.toml` from the workdir up
 *     to its root (a drive root on Windows).
 *
 * Paths are built for `platform` (its own separators and roots), whatever the
 * host: the list is what that platform's Codex reads.
 */
export function codexConfigLayerFiles(codexHome: string, workdir: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  const p = platform === 'win32' ? path.win32 : path.posix
  const programData = env['ProgramData'] ?? env['PROGRAMDATA'] ?? 'C:\\ProgramData'
  const system =
    platform === 'win32'
      ? [p.join(programData, 'OpenAI', 'Codex', 'config.toml'), p.join(programData, 'OpenAI', 'Codex', 'requirements.toml')]
      : ['/etc/codex/config.toml', '/etc/codex/managed_config.toml', '/etc/codex/requirements.toml']
  const user = (() => {
    try {
      return os.userInfo().username
    } catch {
      return null
    }
  })()
  const managedPrefs =
    platform === 'darwin'
      ? ['/Library/Managed Preferences/com.openai.codex.plist', ...(user !== null ? [p.join('/Library/Managed Preferences', user, 'com.openai.codex.plist')] : [])]
      : []
  const tree: string[] = []
  let current = p.resolve(workdir)
  tree.push(p.join(current, 'config.toml'))
  for (;;) {
    tree.push(p.join(current, '.codex', 'config.toml'))
    const parent = p.dirname(current)
    if (parent === current) break
    current = parent
  }
  return [...system, ...managedPrefs, p.join(codexHome, 'config.toml'), ...tree]
}

/** What the listing depends on: every layer file's size and mtime (or its absence), the flags, the workdir, the binary. */
function codexListingKey(files: readonly string[], parts: readonly string[]): string {
  const stats = files.map((file) => {
    try {
      const st = fs.statSync(file)
      return `${file}\u0000${st.size}\u0000${st.mtimeMs}`
    } catch {
      return `${file}\u0000-`
    }
  })
  return [...parts, ...stats].join('\u0001')
}

export class CodexRunner implements RunRunner {
  readonly name = 'codex'
  readonly label = 'Codex'
  private readonly command: string
  private warnedHome = false
  /** The last good listing and what it depended on: a stranger's DM does not cost a listing (and its contacts to the user's MCP hosts) on every run. */
  private listing: { key: string; at: number; result: { ok: true; args: string[] } } | null = null
  /** The last listing that showed a listener's own run authenticates with its helper alone (`ownAuthProblem`). */
  private ownListing: { key: string; at: number } | null = null

  constructor(private readonly options: CodexRunnerOptions) {
    this.command = options.command ?? 'codex'
  }

  /**
   * Where this runner's runs work (`-C`): the configured workdir, except that an
   * `own` or `answer` run never has the home folder or above it as its
   * workspace root — it gets `codexAnswerFallbackWorkdir`.
   */
  workdir(): string {
    if ((this.options.profile === 'answer' || this.options.profile === 'own') && workdirExposesHome(this.options.workdir)) return codexAnswerFallbackWorkdir(this.options.codexHome)
    return this.options.workdir
  }

  async preflight(options: RunPreflightOptions = {}): Promise<RunPreflight> {
    if (this.options.refuse !== undefined) return { ok: false, detail: this.options.refuse }
    const runtime = await inspectCodexRuntime(this.options.codexHome, this.command, CODEX_PROBE_TIMEOUT_MS, options.signal)
    if (!runtime.ok) return { ok: false, detail: runtime.detail }
    const auth = await codexIsLoggedIn(this.options.codexHome, this.command, CODEX_PROBE_TIMEOUT_MS, options.signal)
    if (!auth.ok) return { ok: false, detail: `codex login status failed: ${auth.detail}` }
    if (this.workdir() !== this.options.workdir && !this.warnedHome) {
      this.warnedHome = true
      log.warn(`the run workdir ${this.options.workdir} is your home folder or contains it: ${this.options.profile} runs work in ${this.workdir()} instead, so a peer-started run reaches none of your files there. Point the workdir at a folder of its own to choose another.`)
    }
    fs.mkdirSync(this.workdir(), { recursive: true })
    if (this.options.profile === 'answer') {
      // Said up front, not only as a run's detail: a Codex that rejects one of
      // the answer flags, or a server no `-c` key can switch off, stops every
      // answer run.
      const disables = await this.answerMcpDisables()
      if (!disables.ok) return { ok: false, detail: codexAnswerListingRefusal(disables.detail) }
    }
    // Said up front as well: a listener's own run that would carry or use another key.
    const ownProblem = await this.ownAuthProblem()
    if (ownProblem !== null) return { ok: false, detail: ownProblem }
    return { ok: true }
  }

  /** The exact argv one run uses — exported for tests to pin per profile. An `answer` run adds `answerMcpDisables()` before the prompt. */
  args(): string[] {
    const args = codexRunArgs(this.options.profile, { workdir: this.workdir(), ...(this.options.mcp !== undefined ? { mcp: this.options.mcp } : {}) })
    if (this.options.mcp !== undefined || this.options.pinMcpUrl === undefined) return args
    // The prompt stays the last positional.
    return [...args.slice(0, -1), ...codexPinnedUrlArgs(this.options.pinMcpUrl), CODEX_PROMPT_FROM_STDIN]
  }

  /**
   * The child environment: Codex's home and the key the hosted server needs,
   * under the configured name. An `own` run gets no key at all — not the
   * configured one, not an `AGENTCHAT_API_KEY` the daemon inherited: it has
   * the user's own shell, and Codex hands a run's commands its environment.
   * Its hosted server authenticates through a headers helper instead.
   */
  env(): NodeJS.ProcessEnv {
    // Nothing of a parent Claude Code or Codex session, in every profile.
    const env: NodeJS.ProcessEnv = { ...withoutParentSession(this.options.env ?? process.env), CODEX_HOME: this.options.codexHome }
    if (this.options.profile === 'own') {
      delete env['AGENTCHAT_API_KEY']
      delete env[this.options.keyEnv]
      return env
    }
    const key = this.options.apiKey()
    if (key !== null) env[this.options.keyEnv] = key
    return env
  }

  /**
   * For an `answer` run: `-c mcp_servers.<name>.enabled=false` for every MCP
   * server the run would load but AgentChat's — the user's own in config.toml,
   * a project's, a managed one. Codex has no "only this server" switch, and a
   * tool such a server marks read-only runs without approval. Asked of Codex
   * itself (`codex mcp list --json`, with the run's own `-c`/`--disable`
   * flags, from the run's workdir), so every layer is counted. Any failure —
   * an error, a timeout, output that is not the list — means no run.
   */
  async answerMcpDisables(): Promise<{ ok: true; args: string[] } | { ok: false; detail: string }> {
    const { flags, key } = this.listingFlags()
    // Reused while nothing it was read from changed (and for at most an hour);
    // a failure is never cached, so the next run asks again.
    if (this.listing !== null && this.listing.key === key && Date.now() - this.listing.at < CODEX_MCP_LIST_MAX_AGE_MS) return this.listing.result
    const listed = await this.listMcpServers(flags)
    if (!listed.ok) return listed
    const parsed = parseCodexMcpList(listed.stdout)
    if (!parsed.ok) return parsed
    const result = codexMcpDisableArgs(parsed.names)
    if (result.ok) this.listing = { key, at: Date.now(), result }
    return result
  }

  /**
   * For a listener's `own` run (its key from a headers helper, none in its
   * environment): why it must not start, or null. Two things would make it
   * carry or use a key that is not the helper's — another agent's, as a
   * Codex integration from 0.5.2 or earlier left them: `$CODEX_HOME/.env`
   * setting a key variable (Codex loads it into the run's environment), and an
   * `agentchat` entry that names `bearer_token_env_var` or an `Authorization`
   * in `env_http_headers` in any config layer (Codex sends that in place of the
   * helper's: the run would act as that other agent). The entry is asked of
   * Codex itself (`codex mcp list --json` with the run's own flags, cached as
   * an answer run's listing is); a listing that fails means no run.
   */
  async ownAuthProblem(): Promise<string | null> {
    if (this.options.profile !== 'own' || this.options.mcp?.headersHelper === undefined) return null
    const dotenv = path.join(this.options.codexHome, '.env')
    let names: string[] = []
    try {
      names = codexDotEnvKeyNames(fs.readFileSync(dotenv, 'utf-8'))
    } catch {
      names = []
    }
    if (names.length > 0) {
      return `${dotenv} sets ${names.join(' and ')}: Codex loads that file into every run's environment, so this listener's own runs would carry that key. An AgentChat Codex integration from 0.5.2 or earlier left it there (\`npx -y @agentchatme/codex doctor --fix\` takes it out); remove the line, or run this listener with --profile answer`
    }
    const { flags, key } = this.listingFlags()
    if (this.ownListing !== null && this.ownListing.key === key && Date.now() - this.ownListing.at < CODEX_MCP_LIST_MAX_AGE_MS) return null
    const listed = await this.listMcpServers(flags)
    const auth = listed.ok ? codexAgentchatExplicitAuth(listed.stdout) : listed
    if (!auth.ok) {
      return `could not list Codex's MCP servers (\`codex mcp list --json\` with the own run's flags: ${auth.detail}); a listener's own run starts only once Codex confirms its ${CODEX_MCP_SERVER_NAME} server sends this listener's key`
    }
    if (auth.keys.length > 0) {
      return `the [mcp_servers.${CODEX_MCP_SERVER_NAME}] Codex loads for these runs sets ${auth.keys.join(' and ')}: Codex sends that credential in place of this listener's headers helper, so its own runs would act as another agent. An AgentChat Codex integration from 0.5.2 or earlier wrote bearer_token_env_var (\`npx -y @agentchatme/codex doctor --fix\` replaces it); remove it, or run this listener with --profile answer`
    }
    this.ownListing = { key, at: Date.now() }
    return null
  }

  /** The run's config flags (`-c <v>` and `--disable <feature>` pairs) and what a listing of them depends on. */
  private listingFlags(): { flags: string[]; key: string } {
    const run = this.args()
    const flags = run.flatMap((arg, i) => (run[i - 1] === '-c' || run[i - 1] === '--disable' ? [run[i - 1] as string, arg] : []))
    return { flags, key: codexListingKey(codexConfigLayerFiles(this.options.codexHome, this.workdir()), [this.command, this.workdir(), ...flags]) }
  }

  /** `codex mcp list --json <flags>` from the run's workdir, with the run's environment: its output, or why there is none. Killed with its whole tree past its time. */
  private async listMcpServers(flags: string[]): Promise<{ ok: true; stdout: string } | { ok: false; detail: string }> {
    return new Promise<{ ok: true; stdout: string } | { ok: false; detail: string }>((resolve) => {
      let child: ReturnType<typeof spawnCommand>
      try {
        child = spawnCommand(this.command, ['mcp', 'list', '--json', ...flags], {
          cwd: this.workdir(),
          env: this.env(),
          stdio: ['ignore', 'pipe', 'pipe'],
          // Its own process group on POSIX, so a hung listing is killed with
          // everything it started (the npm launcher and the native binary).
          detached: process.platform !== 'win32',
          windowsHide: true,
        })
      } catch (err) {
        resolve({ ok: false, detail: err instanceof Error ? err.message : String(err) })
        return
      }
      const proc = child
      let stdout = ''
      let stderr = ''
      let stopped: string | null = null
      let settled = false
      let abandonTimer: NodeJS.Timeout | null = null
      const settle = (result: { ok: true; stdout: string } | { ok: false; detail: string }): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (abandonTimer !== null) clearTimeout(abandonTimer)
        resolve(result)
      }
      // A listing that has to be stopped: the whole tree (taskkill /T /F on
      // Windows, where the shim and the real process differ), and the answer
      // waits for it to have exited — it holds the workdir as its cwd. A tree
      // that will not die is given up on after a bound, not waited on forever.
      const stop = (why: string): void => {
        if (stopped !== null) return
        stopped = why
        killProcessTree(proc, 'SIGKILL')
        abandonTimer = setTimeout(() => settle({ ok: false, detail: `${why} (and it did not exit after being killed)` }), CODEX_MCP_LIST_KILL_WAIT_MS)
      }
      proc.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < 4096) stderr += chunk.toString('utf-8')
      })
      const timeoutMs = this.options.mcpListTimeoutMs ?? CODEX_MCP_LIST_TIMEOUT_MS
      const timer = setTimeout(() => stop(`no answer within ${Math.round(timeoutMs / 1000)} s`), timeoutMs)
      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8')
        if (stdout.length > CODEX_MCP_LIST_MAX_BYTES) stop('its output is too long')
      })
      proc.on('error', (err) => {
        if (stopped === null) settle({ ok: false, detail: err.message })
      })
      proc.on('close', (code) => {
        if (stopped !== null) {
          settle({ ok: false, detail: stopped })
          return
        }
        // Codex's own complaint, first line, bounded and redacted (e.g. "Unknown feature flag: …").
        const said = redactDiagnostic(stderr.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '', 200)
        if (code !== 0) settle({ ok: false, detail: `it exited ${code}${said ? `: ${said}` : ''}` })
        else settle({ ok: true, stdout })
      })
    })
  }

  /**
   * Does the model answer right now, through this runner's binary, sign-in,
   * CODEX_HOME and environment? One `codex exec` with a fixed prompt in its
   * own empty folder, read-only, with the hosted AgentChat server and the
   * user's hooks switched off (`codexRuntimeCheckArgs`) and no key in its
   * environment; ok only on exit 0 with a completed turn that holds an agent
   * message (`codexRuntimeCheckJudge`). Its output is read for that alone and
   * never logged. Never throws.
   */
  async checkRuntime(options: RunPreflightOptions = {}): Promise<RunPreflight> {
    if (this.options.refuse !== undefined) return { ok: false, detail: this.options.refuse }
    const dir = codexRuntimeCheckWorkdir(this.options.codexHome)
    return runRuntimeCheck({
      label: 'codex',
      command: this.command,
      args: codexRuntimeCheckArgs(dir, this.options.mcp?.url ?? this.options.pinMcpUrl),
      cwd: dir,
      // The runs' environment; runRuntimeCheck takes every key variable out, this runner's own included.
      env: this.env(),
      keyEnv: this.options.keyEnv,
      // Exit 0 is not enough: the events must show a completed turn with the model's answer.
      judge: codexRuntimeCheckJudge,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })
  }

  async start(request: RunRequest): Promise<RunOutcome> {
    const startedAt = Date.now()
    if (this.options.refuse !== undefined) return { state: 'not_started', exitCode: null, durationMs: 0, detail: this.options.refuse }
    let args = this.args()
    if (this.options.profile === 'answer') {
      // Fail closed: an answer run starts only with every MCP server but AgentChat's switched off.
      const disables = await this.answerMcpDisables()
      if (!disables.ok) return { state: 'not_started', exitCode: null, durationMs: Date.now() - startedAt, detail: codexAnswerListingRefusal(disables.detail) }
      args = [...args.slice(0, -1), ...disables.args, CODEX_PROMPT_FROM_STDIN]
    }
    // Fail closed: a listener's own run starts only when it would act as the listener's agent, with no key in its environment.
    const ownProblem = await this.ownAuthProblem()
    if (ownProblem !== null) return { state: 'not_started', exitCode: null, durationMs: Date.now() - startedAt, detail: ownProblem }
    log.debug(`codex ${args.join(' ')} (prompt on stdin, ${request.kind} run ${request.runId}${request.conversationId !== undefined ? ` for ${request.conversationId}` : ''})`)
    return spawnRun({
      command: this.command,
      args,
      cwd: this.workdir(),
      env: this.env(),
      // Written to stdin and then closed: `codex exec -` reads its
      // instructions until EOF. Never as an argument (see codexRunArgs).
      stdin: request.prompt,
      budgetMs: request.budgetMs,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.onStarted ? { onStarted: request.onStarted } : {}),
    })
  }
}

// ─── A listener's own runs: the key from a headers helper, not the environment ─
//
// An `own` run has the user's own shell, and Codex hands a run's commands its
// whole environment (`shell_environment_policy` inherits everything in
// 0.154.0). So a listener's `own` runs carry no key there: `[mcp_servers.agentchat]`
// gets `http_headers_helper` — "Local-only shell command that prints a JSON
// object of dynamic HTTP headers" (codex-rs config/src/mcp_types.rs), run with
// `sh -c` (`cmd /Q /D /C` on Windows) on each connection and again after a
// 401/403, its `Authorization` used when the server names no bearer token
// (rmcp-client/src/http_headers.rs) — and the helper reads the listener home's
// `credentials` itself. The same mechanism the Codex integration places.

/** Where a listener's `own` runs' headers helper lives: `<home>/presets/codex.mcp-headers.mjs` (owner-only; it holds no key). */
export function codexListenerHeadersHelperPath(home: string): string {
  return path.join(home, 'presets', `${CODEX_PRESET}.mcp-headers.mjs`)
}

/**
 * The helper, byte for byte. It reads the `credentials` file of the home whose
 * `presets/` it sits in and nothing else (no environment variable: the
 * identity is the home's), prints `{"Authorization":"Bearer <key>"}`, or `{}`
 * when there is no key, and never fails.
 */
export const CODEX_LISTENER_HEADERS_HELPER_SOURCE = [
  "// Written by @agentchatme/agent-core for a listener's Codex runs. Codex runs this on each",
  '// connection to the MCP server "agentchat" (its http_headers_helper) and sends what it prints',
  '// as headers: the Authorization header for the key in the credentials file of this identity',
  '// home, or nothing when there is none. It reads no environment variable. Do not edit: the',
  '// listener rewrites it.',
  "import { readFileSync } from 'node:fs'",
  'let headers = {}',
  'try {',
  "  const creds = JSON.parse(readFileSync(new URL('../credentials', import.meta.url), 'utf8'))",
  "  const key = creds !== null && typeof creds.api_key === 'string' ? creds.api_key.trim() : ''",
  '  if (key.length >= 20 && !/\\s/.test(key)) headers = { Authorization: `Bearer ${key}` }',
  '} catch {}',
  'process.stdout.write(JSON.stringify(headers))',
  '',
].join('\n')

/**
 * The helper command: this Node and the script, each quoted for the shell
 * Codex runs it in — single quotes on POSIX (`sh -c`; a `'` inside written as
 * `'\\''`), double quotes on Windows (`cmd /C`). Null when a path holds what
 * that quoting cannot carry (`"`, `%`, `$` or a backtick on Windows) or a line
 * break anywhere.
 */
export function codexHeadersHelperCommand(script: string, node: string = process.execPath, platform: NodeJS.Platform = process.platform): string | null {
  const paths = [node, script]
  if (paths.some((p) => /[\r\n]/.test(p))) return null
  if (platform === 'win32') return paths.some((p) => /["%$`]/.test(p)) ? null : paths.map((p) => `"${p}"`).join(' ')
  return paths.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(' ')
}

/**
 * The keys of `[mcp_servers.agentchat]` in a config.toml, or null when the
 * table is absent. Keys only — a value can be a secret. A line scan, not a
 * TOML parser: enough to say what a run's `-c` overrides merge over.
 */
export function agentchatTableKeys(configToml: string): string[] | null {
  const lines = configToml.split(/\r?\n/)
  const header = new RegExp(`^\\s*\\[mcp_servers\\.${CODEX_MCP_SERVER_NAME}\\]\\s*(#.*)?$`)
  const start = lines.findIndex((line) => header.test(line))
  if (start < 0) return null
  const keys: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[/.test(line)) break
    const match = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line)
    if (match?.[1] !== undefined) keys.push(match[1])
  }
  return keys
}

export const codexPreset: Preset = {
  name: CODEX_PRESET,
  describeMcp({ home, apiBase, env = process.env, profile }) {
    const file = path.join(codexHomeFrom(env), 'config.toml')
    let own: string[] | null = null
    try {
      own = agentchatTableKeys(fs.readFileSync(file, 'utf-8'))
    } catch {
      own = null
    }
    return [
      `-c mcp_servers.${CODEX_MCP_SERVER_NAME}.url="${hostedMcpUrl(apiBase)}"`,
      profile === 'own'
        ? `-c mcp_servers.${CODEX_MCP_SERVER_NAME}.http_headers_helper=<node> ${codexListenerHeadersHelperPath(home)} (own: reads this home's credentials on each connection; no key in the run's environment or on argv; no run while $CODEX_HOME/.env sets a key or the merged ${CODEX_MCP_SERVER_NAME} entry names bearer_token_env_var)`
        : `-c mcp_servers.${CODEX_MCP_SERVER_NAME}.bearer_token_env_var="${LISTENER_KEY_ENV}" (the key set in the run's environment, never on argv)`,
      `-c mcp_servers.${CODEX_MCP_SERVER_NAME}.default_tools_approval_mode="approve"`,
      `-c mcp_servers.${CODEX_MCP_SERVER_NAME}.http_headers={ "X-AgentChat-Client" = "codex", "X-AgentChat-Client-Version" = <the listener's version> } (names the runtime to the hosted tools)`,
      own === null
        ? `${file}: no [mcp_servers.${CODEX_MCP_SERVER_NAME}] of its own — the run sees only the overrides above`
        : `${file}: [mcp_servers.${CODEX_MCP_SERVER_NAME}] also sets ${own.length > 0 ? own.join(', ') : 'nothing'}; the overrides above replace their keys, the others still apply (how codex merges -c over an existing table is not verified on a real codex)`,
    ]
  },
  label: 'Codex',
  runtime: 'codex',
  serviceEnv: ['CODEX_HOME'],
  // `own`, `work` and `full` read the whole filesystem (Codex's sandboxes never
  // restrict reads; an `answer` run reads only its workdir): true, because the
  // field is one for every profile.
  readsIdentityHome: true,
  async inspect(env = process.env, command = 'codex') {
    const home = codexHomeFrom(env)
    const runtime = await inspectCodexRuntime(home, command)
    if (!runtime.ok) return runtime
    const auth = await codexIsLoggedIn(home, command)
    return auth.ok ? { ok: true, detail: `${runtime.detail}, signed in` } : { ok: false, detail: `${runtime.detail}, not signed in: ${auth.detail}` }
  },
  runner(ctx: PresetContext): RunRunner {
    // A key in the listener's own environment is not handed to its runs.
    const env = withoutInheritedKey(ctx.env ?? process.env)
    const apiKey = ctx.apiKey
    const base = {
      codexHome: codexHomeFrom(env),
      workdir: ctx.workdir,
      profile: ctx.profile,
      keyEnv: LISTENER_KEY_ENV,
      ...(ctx.command !== undefined ? { command: ctx.command } : {}),
      env,
    }
    const mcp = { url: hostedMcpUrl(ctx.apiBase), keyEnv: LISTENER_KEY_ENV, clientVersion: ctx.clientVersion ?? VERSION }
    if (ctx.profile !== 'own') return new CodexRunner({ ...base, apiKey: () => apiKey, mcp })
    // own: the user's shell is the run's, so no key in its environment — the
    // helper reads this home's credentials (rewritten for every identity the
    // listener serves; it holds no key).
    const script = codexListenerHeadersHelperPath(ctx.home)
    const helper = codexHeadersHelperCommand(script)
    if (helper === null) {
      return new CodexRunner({ ...base, apiKey: () => null, mcp, refuse: `the path of Node (${process.execPath}) or of ${script} holds a character a shell command cannot carry quoted: an own run would have its key in its environment instead` })
    }
    try {
      atomicWriteFile(script, CODEX_LISTENER_HEADERS_HELPER_SOURCE, 0o600)
    } catch (err) {
      return new CodexRunner({ ...base, apiKey: () => null, mcp, refuse: `could not write the headers helper ${script}: ${err instanceof Error ? err.message : String(err)}` })
    }
    return new CodexRunner({ ...base, apiKey: () => null, mcp: { ...mcp, headersHelper: helper } })
  },
}
