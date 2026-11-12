import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clientHeadersOf } from '../client-identity.js'
import { hostedMcpUrl } from '../integration/mcp-probe.js'
import type { RunProfile } from '../integration/profile.js'
import type { RunOutcome, RunPreflight, RunRequest, RunRunner } from '../integration/runner.js'
import { spawnRun } from '../integration/spawn-run.js'
import { log } from '../util/log.js'
import { spawnCommandSync } from '../util/spawn.js'
import { VERSION } from '../version.js'
import { semverAtLeast } from './semver.js'
import { withoutInheritedKey, type Preset, type PresetContext, type PresetInspection } from './types.js'

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

export function inspectCodexRuntime(codexHome: string, command = 'codex'): PresetInspection {
  const result = spawnCommandSync(command, ['--version'], {
    encoding: 'utf-8',
    timeout: 10_000,
    windowsHide: true,
    env: { ...process.env, CODEX_HOME: codexHome },
  })
  if (result.error) return { ok: false, detail: `codex CLI not found on PATH (${result.error.message})` }
  const rendered = String(result.stdout || result.stderr).trim()
  if (result.status !== 0) return { ok: false, detail: rendered || `codex --version exited ${result.status}` }
  return semverAtLeast(rendered, MIN_CODEX_VERSION)
    ? { ok: true, detail: rendered }
    : { ok: false, detail: `${rendered || 'unrecognized version'}; AgentChat requires Codex >= ${MIN_CODEX_VERSION}` }
}

/** `codex login status` exits 0 when signed in. */
export function codexIsLoggedIn(codexHome: string, command = 'codex'): PresetInspection {
  const status = spawnCommandSync(command, ['login', 'status'], {
    encoding: 'utf-8',
    timeout: 10_000,
    windowsHide: true,
    env: { ...process.env, CODEX_HOME: codexHome },
  })
  if (status.error) return { ok: false, detail: status.error.message }
  const detail = `${status.stdout ?? ''}${status.stderr ?? ''}`.trim().slice(0, 200)
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

/** Where a run's hosted tool server points, and which variable carries its bearer token. */
export interface CodexMcpOverride {
  readonly url: string
  readonly keyEnv: string
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

/** The `-c` overrides that make `[mcp_servers.agentchat]` this agent's, for one run. TOML values, no key in them. */
export function codexMcpOverrideArgs(override: CodexMcpOverride): string[] {
  const table = `mcp_servers.${CODEX_MCP_SERVER_NAME}`
  return [
    '-c',
    `${table}.url=${JSON.stringify(override.url)}`,
    '-c',
    `${table}.bearer_token_env_var=${JSON.stringify(override.keyEnv)}`,
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
  /** Test seam: the binary to run. */
  readonly command?: string
  readonly env?: NodeJS.ProcessEnv
}

export class CodexRunner implements RunRunner {
  readonly name = 'codex'
  private readonly command: string

  constructor(private readonly options: CodexRunnerOptions) {
    this.command = options.command ?? 'codex'
  }

  async preflight(): Promise<RunPreflight> {
    const runtime = inspectCodexRuntime(this.options.codexHome, this.command)
    if (!runtime.ok) return { ok: false, detail: runtime.detail }
    const auth = codexIsLoggedIn(this.options.codexHome, this.command)
    if (!auth.ok) return { ok: false, detail: `codex login status failed: ${auth.detail}` }
    fs.mkdirSync(this.options.workdir, { recursive: true })
    return { ok: true }
  }

  /** The exact argv one run uses — exported for tests to pin per profile. */
  args(): string[] {
    return codexRunArgs(this.options.profile, { workdir: this.options.workdir, ...(this.options.mcp !== undefined ? { mcp: this.options.mcp } : {}) })
  }

  /** The child environment: Codex's home and the key the hosted server needs, under the configured name. */
  env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...(this.options.env ?? process.env), CODEX_HOME: this.options.codexHome }
    const key = this.options.apiKey()
    if (key !== null) env[this.options.keyEnv] = key
    return env
  }

  async start(request: RunRequest): Promise<RunOutcome> {
    const args = this.args()
    log.debug(`codex ${args.join(' ')} (prompt on stdin, ${request.kind} run ${request.runId})`)
    return spawnRun({
      command: this.command,
      args,
      cwd: this.options.workdir,
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
  describeMcp({ apiBase, env = process.env }) {
    const file = path.join(codexHomeFrom(env), 'config.toml')
    let own: string[] | null = null
    try {
      own = agentchatTableKeys(fs.readFileSync(file, 'utf-8'))
    } catch {
      own = null
    }
    return [
      `-c mcp_servers.${CODEX_MCP_SERVER_NAME}.url="${hostedMcpUrl(apiBase)}"`,
      `-c mcp_servers.${CODEX_MCP_SERVER_NAME}.bearer_token_env_var="${LISTENER_KEY_ENV}" (the key set in the run's environment, never on argv)`,
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
  // `work` and `full` read the whole filesystem (an `answer` run reads only its
  // workdir): true, because the field is one for every profile.
  readsIdentityHome: true,
  inspect(env = process.env, command = 'codex') {
    const home = codexHomeFrom(env)
    const runtime = inspectCodexRuntime(home, command)
    if (!runtime.ok) return runtime
    const auth = codexIsLoggedIn(home, command)
    return auth.ok ? { ok: true, detail: `${runtime.detail}, signed in` } : { ok: false, detail: `${runtime.detail}, not signed in: ${auth.detail}` }
  },
  runner(ctx: PresetContext): RunRunner {
    // A key in the listener's own environment is not handed to its runs.
    const env = withoutInheritedKey(ctx.env ?? process.env)
    const apiKey = ctx.apiKey
    return new CodexRunner({
      codexHome: codexHomeFrom(env),
      workdir: ctx.workdir,
      profile: ctx.profile,
      apiKey: () => apiKey,
      keyEnv: LISTENER_KEY_ENV,
      mcp: { url: hostedMcpUrl(ctx.apiBase), keyEnv: LISTENER_KEY_ENV, clientVersion: ctx.clientVersion ?? VERSION },
      ...(ctx.command !== undefined ? { command: ctx.command } : {}),
      env,
    })
  },
}
