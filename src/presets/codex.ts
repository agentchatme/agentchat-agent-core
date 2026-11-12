import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clientHeadersOf } from '../client-identity.js'
import { hostedMcpUrl } from '../integration/mcp-probe.js'
import { workdirExposesHome, type RunProfile } from '../integration/profile.js'
import type { RunOutcome, RunPreflight, RunRequest, RunRunner } from '../integration/runner.js'
import { redactDiagnostic, spawnRun } from '../integration/spawn-run.js'
import { log } from '../util/log.js'
import { spawnCommand, spawnCommandSync } from '../util/spawn.js'
import { VERSION } from '../version.js'
import { semverAtLeast } from './semver.js'
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
  /** Test seam: how long `codex mcp list` may take (`CODEX_MCP_LIST_TIMEOUT_MS`). */
  readonly mcpListTimeoutMs?: number
}

/**
 * The folder an `answer` run works in when its configured workdir is the
 * user's home folder or contains it (`workdirExposesHome`): an empty folder of
 * its own under CODEX_HOME. The run keeps working — it only cannot reach the
 * user's files through its workspace root.
 */
export function codexAnswerFallbackWorkdir(codexHome: string): string {
  return path.join(codexHome, 'agentchat-answer-workdir')
}

/** How long `codex mcp list` may take before an answer run is given up (not started). */
export const CODEX_MCP_LIST_TIMEOUT_MS = 20_000
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
 * (openai/codex rust-v0.154.0 config/src/loader/mod.rs:79-95, layer_io.rs:22,
 * loader/macos.rs:20): system, managed, requirements, the user's config.toml,
 * the macOS managed preferences, and `config.toml` / `.codex/config.toml` from
 * the workdir up to the root.
 */
export function codexConfigLayerFiles(codexHome: string, workdir: string, platform: NodeJS.Platform = process.platform): string[] {
  const system =
    platform === 'win32'
      ? [path.join(process.env['ProgramData'] ?? 'C:\\ProgramData', 'OpenAI', 'Codex', 'config.toml'), path.join(process.env['ProgramData'] ?? 'C:\\ProgramData', 'OpenAI', 'Codex', 'requirements.toml')]
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
      ? ['/Library/Managed Preferences/com.openai.codex.plist', ...(user !== null ? [path.join('/Library/Managed Preferences', user, 'com.openai.codex.plist')] : [])]
      : []
  const tree: string[] = []
  let current = path.resolve(workdir)
  tree.push(path.join(current, 'config.toml'))
  for (;;) {
    tree.push(path.join(current, '.codex', 'config.toml'))
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return [...system, ...managedPrefs, path.join(codexHome, 'config.toml'), ...tree]
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
  private readonly command: string
  private warnedHome = false
  /** The last good listing and what it depended on: a stranger's DM does not cost a listing (and its contacts to the user's MCP hosts) on every run. */
  private listing: { key: string; at: number; result: { ok: true; args: string[] } } | null = null

  constructor(private readonly options: CodexRunnerOptions) {
    this.command = options.command ?? 'codex'
  }

  /**
   * Where this runner's runs work (`-C`): the configured workdir, except that an
   * `answer` run never has the home folder or above it as its workspace root —
   * it gets `codexAnswerFallbackWorkdir`.
   */
  workdir(): string {
    if (this.options.profile === 'answer' && workdirExposesHome(this.options.workdir)) return codexAnswerFallbackWorkdir(this.options.codexHome)
    return this.options.workdir
  }

  async preflight(): Promise<RunPreflight> {
    const runtime = inspectCodexRuntime(this.options.codexHome, this.command)
    if (!runtime.ok) return { ok: false, detail: runtime.detail }
    const auth = codexIsLoggedIn(this.options.codexHome, this.command)
    if (!auth.ok) return { ok: false, detail: `codex login status failed: ${auth.detail}` }
    if (this.workdir() !== this.options.workdir && !this.warnedHome) {
      this.warnedHome = true
      log.warn(`the run workdir ${this.options.workdir} is your home folder or contains it: answer runs work in ${this.workdir()} instead, so a peer-started run reaches none of your files there. Point the workdir at a folder of its own to choose another.`)
    }
    fs.mkdirSync(this.workdir(), { recursive: true })
    if (this.options.profile === 'answer') {
      // Said up front, not only as a run's detail: a Codex that rejects one of
      // the answer flags, or a server no `-c` key can switch off, stops every
      // answer run.
      const disables = await this.answerMcpDisables()
      if (!disables.ok) return { ok: false, detail: codexAnswerListingRefusal(disables.detail) }
    }
    return { ok: true }
  }

  /** The exact argv one run uses — exported for tests to pin per profile. An `answer` run adds `answerMcpDisables()` before the prompt. */
  args(): string[] {
    return codexRunArgs(this.options.profile, { workdir: this.workdir(), ...(this.options.mcp !== undefined ? { mcp: this.options.mcp } : {}) })
  }

  /** The child environment: Codex's home and the key the hosted server needs, under the configured name. */
  env(): NodeJS.ProcessEnv {
    // Nothing of a parent Claude Code or Codex session, in every profile.
    const env: NodeJS.ProcessEnv = { ...withoutParentSession(this.options.env ?? process.env), CODEX_HOME: this.options.codexHome }
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
    const run = this.args()
    // The run's config flags only: `-c <v>` and `--disable <feature>` pairs.
    const flags = run.flatMap((arg, i) => (run[i - 1] === '-c' || run[i - 1] === '--disable' ? [run[i - 1] as string, arg] : []))
    // Reused while nothing it was read from changed (and for at most an hour);
    // a failure is never cached, so the next run asks again.
    const key = codexListingKey(codexConfigLayerFiles(this.options.codexHome, this.workdir()), [this.command, this.workdir(), ...flags])
    if (this.listing !== null && this.listing.key === key && Date.now() - this.listing.at < CODEX_MCP_LIST_MAX_AGE_MS) return this.listing.result
    const listed = await new Promise<{ ok: true; stdout: string } | { ok: false; detail: string }>((resolve) => {
      let child: ReturnType<typeof spawnCommand>
      try {
        child = spawnCommand(this.command, ['mcp', 'list', '--json', ...flags], { cwd: this.workdir(), env: this.env(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      } catch (err) {
        resolve({ ok: false, detail: err instanceof Error ? err.message : String(err) })
        return
      }
      let stdout = ''
      let stderr = ''
      let tooLong = false
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < 4096) stderr += chunk.toString('utf-8')
      })
      const timeoutMs = this.options.mcpListTimeoutMs ?? CODEX_MCP_LIST_TIMEOUT_MS
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve({ ok: false, detail: `no answer within ${Math.round(timeoutMs / 1000)} s` })
      }, timeoutMs)
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8')
        if (stdout.length > CODEX_MCP_LIST_MAX_BYTES && !tooLong) {
          tooLong = true
          child.kill('SIGKILL')
        }
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        resolve({ ok: false, detail: err.message })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        // Codex's own complaint, first line, bounded and redacted (e.g. "Unknown feature flag: …").
        const said = redactDiagnostic(stderr.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '', 200)
        if (tooLong) resolve({ ok: false, detail: 'its output is too long' })
        else if (code !== 0) resolve({ ok: false, detail: `it exited ${code}${said ? `: ${said}` : ''}` })
        else resolve({ ok: true, stdout })
      })
    })
    if (!listed.ok) return listed
    const parsed = parseCodexMcpList(listed.stdout)
    if (!parsed.ok) return parsed
    const result = codexMcpDisableArgs(parsed.names)
    if (result.ok) this.listing = { key, at: Date.now(), result }
    return result
  }

  async start(request: RunRequest): Promise<RunOutcome> {
    const startedAt = Date.now()
    let args = this.args()
    if (this.options.profile === 'answer') {
      // Fail closed: an answer run starts only with every MCP server but AgentChat's switched off.
      const disables = await this.answerMcpDisables()
      if (!disables.ok) return { state: 'not_started', exitCode: null, durationMs: Date.now() - startedAt, detail: codexAnswerListingRefusal(disables.detail) }
      args = [...args.slice(0, -1), ...disables.args, CODEX_PROMPT_FROM_STDIN]
    }
    log.debug(`codex ${args.join(' ')} (prompt on stdin, ${request.kind} run ${request.runId})`)
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
