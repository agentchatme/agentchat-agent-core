import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clientHeadersOf } from '../client-identity.js'
import { hostedMcpUrl } from '../integration/mcp-probe.js'
import { workdirExposesHome, type RunProfile } from '../integration/profile.js'
import type { RunOutcome, RunPreflight, RunRequest, RunRunner } from '../integration/runner.js'
import { spawnRun } from '../integration/spawn-run.js'
import { atomicWriteFile } from '../util/fsutil.js'
import { log } from '../util/log.js'
import { spawnCommandSync } from '../util/spawn.js'
import { VERSION } from '../version.js'
import { semverAtLeast } from './semver.js'
import { withoutInheritedKey, withoutParentSession, type Preset, type PresetContext, type PresetInspection } from './types.js'

// ─── Claude Code: one headless run (`claude -p`) ────────────────────────────
//
// `claude -p` on the box, riding the user's own Claude Code sign-in and user
// configuration. The run's output is discarded by `spawnRun`: the agent's only
// way to say anything on AgentChat is the hosted send tool during the run.
//
// The flags, verified against `claude --help` (2.1.316) and
// code.claude.com/docs/en/cli-reference.md, headless.md, permission-modes.md:
//
//   --permission-prompts none   anything that would prompt is denied, never
//                               waited on; the permission mode and allow rules
//                               still decide every call first (v2.1.259+).
//   --tools <list>              restricts the BUILT-IN tool set; does not affect
//                               MCP tools. Listing Glob/Grep explicitly provides
//                               the dedicated search tools.
//   --allowedTools <rules>      pre-approves. `mcp__agentchat__*` is the whole
//                               hosted server; `Bash` pre-approves every shell
//                               command (dropped as a broad rule only in auto mode).
//                               A bare `Read`, `Glob` or `Grep` pre-approves that
//                               tool on EVERY path; `Read(//<dir>/**)` only under
//                               `<dir>`. Glob and Grep have no path rules of their
//                               own: `Read(<path>)` rules are matched for them
//                               (permissions.md "Glob(path) and Grep(path) rules
//                               don't match"). An allow rule applies only when the
//                               requested path AND the file it resolves to match
//                               (permissions.md "Symlinks"), so a link out of the
//                               workdir is never allowed by it.
//   --disallowedTools <rules>   denies. Deny rules win over allow rules, and a
//                               `Read(<path>)` rule covers every built-in tool
//                               that reads files (Read, Grep, Glob — docs:
//                               permissions.md "Read & Edit"). Used to keep a
//                               run's file tools off the key store. `//`
//                               prefixes an absolute path in rule syntax. A bare
//                               tool name removes the tool.
//   --settings <json>           additional settings for this run only. `answer`
//                               sets `permissions.blockReadsOutsideWorkingDirectories`
//                               (v2.1.257+, settings-reference.md): the file tools
//                               refuse every path outside the working directories
//                               in every mode, and "no allow rule lets Claude's
//                               file tools through" — so an allow rule in the
//                               user's own settings cannot reopen the disk.
//   --permission-mode default   Manual: reads inside the working directories need
//                               no approval, everything else prompts (and is
//                               therefore denied here).
//   --permission-mode acceptEdits  file edits and common filesystem commands in
//                               the working directory need no approval.
//   --dangerously-skip-permissions  = bypassPermissions.
//   --mcp-config <file> --strict-mcp-config
//                               the hosted server from a file, and ONLY it: a
//                               listener's run acts as the listener's agent,
//                               never as whatever key the user scope registers.
//
// Whatever the profile, every AgentChat hosted tool is pre-approved: the run
// exists to read the tray and decide or send through them.

export const CLAUDE_CODE_PRESET = 'claude-code'

/**
 * Two flags set the floor:
 *   * `--permission-prompts none` — Claude Code v2.1.259.
 *   * `CLAUDE_CODE_MCP_STARTUP_WAIT_MS` — bounds how long the first
 *     non-interactive turn waits for the MCP servers `--allowedTools` names to
 *     connect. Added in v2.1.274. Without it a run could start before the
 *     hosted inbox tool is there.
 */
export const MIN_CLAUDE_CODE_VERSION = '2.1.274'

/** The MCP server name the runs see; every hosted tool is `mcp__agentchat__<tool>`, as the served texts spell them. */
export const CLAUDE_MCP_SERVER_NAME = 'agentchat'
export const AGENTCHAT_TOOL_ALLOW = `mcp__${CLAUDE_MCP_SERVER_NAME}__*`

/**
 * Built-in tools an `answer` run has: the file-reading tools, and only on the
 * run's own working folder (`workdirReadRules`, `ANSWER_SETTINGS`). An `answer`
 * run is started by any peer's message — a stranger's cold DM included — so
 * the only way out it has is the AgentChat tools: no web, no shell, no edits,
 * and nothing outside its workdir to read.
 */
export const ANSWER_TOOLS = ['Read', 'Glob', 'Grep'] as const

/** The web tools: `work` pre-approves them; `answer` never has them. */
export const WEB_TOOLS = ['WebSearch', 'WebFetch'] as const

/** Built-in tools a `work` run additionally pre-approves. */
export const WORK_TOOLS = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const

/**
 * Denied to every `answer` run by name, on top of `--tools` leaving them out:
 * the ways out (web) and the shell. A bare tool name in a deny rule removes
 * the tool, so even a widened `--tools` list could not bring them back.
 */
export const ANSWER_DENIED_TOOLS = ['WebFetch', 'WebSearch', 'Bash'] as const

/**
 * The `--settings` an `answer` run is given. A constant, never built from a
 * path: in print mode a settings value that fails validation is silently
 * ignored (`claude --help`, `-p`), so nothing variable may ride in it.
 */
export const ANSWER_SETTINGS = JSON.stringify({ permissions: { blockReadsOutsideWorkingDirectories: true } })

/**
 * Env a parent Claude Code session leaks that would make the child think it is
 * nested — a sample kept for callers that named it; the rule is
 * `withoutParentSession` (every `CLAUDE_CODE_*` but the user's documented
 * settings, `CLAUDE_PID`, and the Codex session variables).
 */
export const PARENT_ENV_KEYS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_EFFORT',
  'AI_AGENT',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_PID',
]

/**
 * How long the first turn of a `-p` run waits for a still-connecting MCP
 * server that `--allowedTools` names. Claude Code's own built-in wait is short
 * (2 s since 2.1.284), and a remote server over a cold network can take
 * longer; the run must not start without the inbox tool.
 */
const MCP_STARTUP_WAIT_MS = '15000'

/** Claude Code's supported relocation knob. Unset is NOT the same as `~/.claude`. */
export function claudeConfigDirFrom(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env['CLAUDE_CONFIG_DIR']
  return override !== undefined && override.trim().length > 0 ? path.resolve(override) : undefined
}

/** `~/.claude`, or the relocated config dir. */
export function claudeHomeFor(configDirOverride: string | undefined): string {
  return configDirOverride ?? path.join(os.homedir(), '.claude')
}

/**
 * Where Claude Code keeps user-scoped MCP servers (and so any key registered
 * there): `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`.
 */
export function claudeUserStatePathFor(configDirOverride: string | undefined): string {
  return configDirOverride !== undefined ? path.join(configDirOverride, '.claude.json') : path.join(os.homedir(), '.claude.json')
}

function claudeProcessEnv(configDirOverride: string | undefined, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source }
  if (configDirOverride === undefined) delete env['CLAUDE_CONFIG_DIR']
  else env['CLAUDE_CONFIG_DIR'] = configDirOverride
  return env
}

export function buildClaudeEnv(configDirOverride: string | undefined, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = claudeProcessEnv(configDirOverride, withoutParentSession(source))
  env['DISABLE_AUTOUPDATER'] = '1'
  const wait = Number(env['CLAUDE_CODE_MCP_STARTUP_WAIT_MS'])
  if (!Number.isFinite(wait) || wait < Number(MCP_STARTUP_WAIT_MS)) env['CLAUDE_CODE_MCP_STARTUP_WAIT_MS'] = MCP_STARTUP_WAIT_MS
  return env
}

/**
 * Is Claude Code signed in? `claude auth status` prints JSON with a boolean
 * `loggedIn` and exits 0 if logged in, 1 if not. When that JSON is there it is
 * the answer. The file/keychain probes are a fallback for builds without the
 * subcommand; the keychain probe is existence-only and never prompts — a
 * resident listener must never trigger a keychain prompt.
 */
export function claudeIsLoggedIn(configDirOverride?: string, command = 'claude'): boolean {
  const status = spawnCommandSync(command, ['auth', 'status'], {
    encoding: 'utf-8',
    timeout: 10_000,
    windowsHide: true,
    env: claudeProcessEnv(configDirOverride, process.env),
  })
  if (!status.error) {
    try {
      const parsed = JSON.parse(String(status.stdout ?? '').trim()) as { loggedIn?: unknown }
      if (typeof parsed?.loggedIn === 'boolean') return parsed.loggedIn
    } catch {
      /* no JSON: an older build; fall through to the file and keychain */
    }
    if (status.status === 0) return true
  }

  const configDir = claudeHomeFor(configDirOverride)
  if (fs.existsSync(path.join(configDir, '.credentials.json'))) return true
  if (process.platform !== 'darwin') return false
  const keychain = spawnCommandSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], {
    encoding: 'utf-8',
    timeout: 5_000,
  })
  return !keychain.error && keychain.status === 0
}

export function inspectClaudeRuntime(configDirOverride?: string, command = 'claude'): PresetInspection {
  const version = spawnCommandSync(command, ['--version'], {
    encoding: 'utf-8',
    timeout: 10_000,
    windowsHide: true,
    env: claudeProcessEnv(configDirOverride, process.env),
  })
  if (version.error) return { ok: false, detail: `claude CLI not found on PATH (${version.error.message})` }
  const rendered = String(version.stdout || version.stderr).trim()
  if (version.status !== 0) return { ok: false, detail: rendered || `claude --version exited ${version.status}` }
  return semverAtLeast(rendered, MIN_CLAUDE_CODE_VERSION)
    ? { ok: true, detail: rendered }
    : {
        ok: false,
        detail: `${rendered || 'unrecognized version'}; AgentChat requires Claude Code >= ${MIN_CLAUDE_CODE_VERSION} (for --permission-prompts none and CLAUDE_CODE_MCP_STARTUP_WAIT_MS)`,
      }
}

/**
 * The entry of `denied` that is `dir` or contains it, or null. Whole path
 * segments only: `~/.claude/agentchat` does not contain `~/.claude/agentchat-workdir`.
 */
export function deniedAncestorOf(dir: string, denied: readonly string[]): string | null {
  const target = path.resolve(dir)
  for (const raw of denied) {
    const root = path.resolve(raw)
    if (target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) return root
  }
  return null
}

/**
 * Whether a path can be carried by a `Read(//<path>)` ALLOW rule in a
 * comma/space-separated list: what `expressible` asks, and no gitignore
 * pattern character either (`*`, `?`, `[`, `]`, `\`, `!`, `#`). Rules are
 * matched as gitignore patterns and the ones written here are not escaped
 * (permissions.md "Special characters"): `/w*` would also allow `/wallet`.
 */
function expressibleAllow(raw: string): boolean {
  return expressible(raw) && !/[*?[\]\\!#]/.test(raw)
}

/**
 * The paths a workdir is reached by: as given (absolute), and where it really
 * is when that differs (`/tmp/w` is `/private/tmp/w` on macOS; a symlinked
 * workdir). An allow rule matches only when the requested path and the file
 * it resolves to both match, so both spellings are carried. A workdir that
 * does not exist yet is carried as given.
 */
export function workdirPaths(workdir: string): string[] {
  const given = path.resolve(workdir)
  let real = given
  try {
    real = fs.realpathSync(given)
  } catch {
    /* not created yet (preflight creates it): only the given spelling */
  }
  return real === given ? [given] : [given, real]
}

/**
 * `/w` → `Read(//w)` and `Read(//w/**)`, for each spelling of the workdir: the
 * only paths an `answer` run's Read, Glob and Grep are pre-approved on. A
 * spelling no allow rule can carry (whitespace, a comma, a gitignore pattern
 * character; every path on Windows) gets no rule — that fails closed: the run
 * still reads its workdir as its working directory, and nothing else.
 */
export function workdirReadRules(workdir: string | undefined): string[] {
  if (workdir === undefined || process.platform === 'win32') return []
  const rules: string[] = []
  for (const raw of workdirPaths(workdir)) {
    const clean = raw.replace(/\/+$/, '')
    // The filesystem root is no work folder: no rule (its tree is the disk).
    if (!expressibleAllow(raw) || clean.length === 0) continue
    rules.push(`Read(/${clean})`, `Read(/${clean}/**)`)
  }
  return rules
}

/**
 * The flags for one run profile. `workdir` is the run's working directory:
 * `answer` scopes its file tools to it (absent, they get no allow rule at all).
 */
export function claudeProfileArgs(profile: RunProfile, workdir?: string): string[] {
  switch (profile) {
    case 'answer':
      return [
        '--permission-mode',
        'default',
        '--permission-prompts',
        'none',
        '--tools',
        ANSWER_TOOLS.join(','),
        '--allowedTools',
        [AGENTCHAT_TOOL_ALLOW, ...workdirReadRules(workdir)].join(','),
        '--settings',
        ANSWER_SETTINGS,
      ]
    // `work` and `full` are the operator's explicit opt-in: a run started by
    // any peer's message can then read and change this machine.
    case 'work':
      return [
        '--permission-mode',
        'acceptEdits',
        '--permission-prompts',
        'none',
        '--allowedTools',
        [AGENTCHAT_TOOL_ALLOW, ...ANSWER_TOOLS, ...WEB_TOOLS, ...WORK_TOOLS].join(','),
      ]
    case 'full':
      return ['--dangerously-skip-permissions', '--permission-prompts', 'none', '--allowedTools', AGENTCHAT_TOOL_ALLOW]
  }
}

export interface ClaudeRunArgOptions {
  /** `AGENTCHAT_RUN_MAX_BUDGET_USD`: stop the run once estimated spend reaches this (print mode only). */
  readonly maxBudgetUsd?: string | undefined
  /** The run's working directory: the one folder an `answer` run's file tools are allowed (`workdirReadRules`). */
  readonly workdir?: string | undefined
  /**
   * Absolute paths the run's file tools may not read (a directory covers its
   * tree). Rendered as `Read(//<path>)` / `Read(//<dir>/**)` deny rules. A
   * prompt-injected run could otherwise read the key and send it; the wake
   * text should not be the only guard. POSIX paths only — on Windows the
   * rule syntax for drive paths is undocumented, so nothing is rendered.
   */
  readonly denyReadPaths?: readonly string[] | undefined
  /**
   * A `--mcp-config` file holding the hosted server with the agent's key;
   * with it, `--strict-mcp-config` makes it the run's only MCP server. Absent:
   * the run uses the user-scope server the integration registered.
   */
  readonly mcpConfigPath?: string | undefined
}

/** Whether a path can be carried by a `Read(//<path>)` rule in a comma/space-separated list: absolute POSIX, no comma, no whitespace. */
function expressible(raw: string): boolean {
  return raw.startsWith('/') && !/[,\s]/.test(raw)
}

/**
 * The deny paths no rule can carry: on Windows all of them (the rule syntax
 * for drive paths is undocumented), elsewhere a relative path or one with a
 * comma or whitespace. A run would be able to read these.
 */
export function inexpressibleDenyPaths(paths: readonly string[]): string[] {
  return process.platform === 'win32' ? [...paths] : paths.filter((p) => !expressible(p))
}

/** `/Users/x/.claude/agentchat` → `Read(//Users/x/.claude/agentchat/**)` and `Read(//Users/x/.claude/agentchat)`. Paths no rule can carry are left out (`inexpressibleDenyPaths`). */
export function readDenyRules(paths: readonly string[]): string[] {
  if (process.platform === 'win32') return []
  const rules: string[] = []
  for (const raw of paths) {
    if (!expressible(raw)) continue
    const clean = raw.replace(/\/+$/, '')
    rules.push(`Read(/${clean})`, `Read(/${clean}/**)`)
  }
  return rules
}

/**
 * The full argument list for one headless run. The prompt goes on STDIN, not
 * as a positional: the variadic `--allowedTools` (and `--mcp-config`) would
 * otherwise swallow a trailing positional (verified on 2.1.220; `cat file |
 * claude -p` is the documented piped form).
 */
export function claudeRunArgs(profile: RunProfile, options: ClaudeRunArgOptions = {}): string[] {
  const budget = options.maxBudgetUsd?.trim()
  const deny = [...(profile === 'answer' ? ANSWER_DENIED_TOOLS : []), ...readDenyRules(options.denyReadPaths ?? [])]
  return [
    '-p',
    '--output-format',
    'text',
    // A wake run is not a conversation to resume; keep it out of the user's
    // session list and off the disk.
    '--no-session-persistence',
    ...(budget !== undefined && /^\d+(\.\d+)?$/.test(budget) ? ['--max-budget-usd', budget] : []),
    // Variadic, so it is closed by the boolean flag right after it.
    ...(options.mcpConfigPath !== undefined ? ['--mcp-config', options.mcpConfigPath, '--strict-mcp-config'] : []),
    ...claudeProfileArgs(profile, options.workdir),
    // Last: the option is variadic and the prompt arrives on stdin, so there
    // is no positional for it to swallow.
    ...(deny.length > 0 ? ['--disallowedTools', deny.join(',')] : []),
  ]
}

/** The `--mcp-config` document: the hosted server, by HTTP, with the agent's key. Owner-only on disk. */
/**
 * The `--mcp-config` file a listener's run is given: the hosted tool server
 * with this agent's key, and the client headers that name the runtime to it
 * (`X-AgentChat-Client: claude-code`, `-Version`: the front door that placed
 * the run). The hosted tool server names a client only from these headers:
 * without them a run is an unknown client and is shown the wake-webhook
 * tools, a second way of being woken that the listener makes unnecessary.
 */
export function claudeMcpConfig(apiBase: string, apiKey: string, clientVersion: string = VERSION): string {
  const headers = { Authorization: `Bearer ${apiKey}`, ...clientHeadersOf({ runtime: 'claude-code', version: clientVersion }) }
  return `${JSON.stringify({ mcpServers: { [CLAUDE_MCP_SERVER_NAME]: { type: 'http', url: hostedMcpUrl(apiBase), headers } } }, null, 2)}\n`
}

/**
 * The AgentChat hosted server alone, for `answer` runs that have no
 * `mcpConfigPath`: written owner-only to `file` for each run (from the key
 * `apiKey()` returns then, so a credential change is followed), passed with
 * `--strict-mcp-config`, and removed when the run ends. An `answer` run then
 * loads no other MCP server — the user's own, a project's, a plugin's, a
 * claude.ai connector — whatever the user scope registers. `file` must sit
 * inside a `denyReadPaths` entry (it holds the key), or preflight refuses.
 */
export interface ClaudeAnswerMcp {
  readonly file: string
  readonly apiBase: string
  readonly apiKey: () => string | null
  /** The version named in `X-AgentChat-Client-Version` (the front door that placed the run). Defaults to this engine's. */
  readonly clientVersion?: string
}

export interface ClaudeRunnerOptions {
  readonly configDir: string | undefined
  /**
   * The run's working directory; the `work` profile edits and runs shell here.
   * Must lie outside `denyReadPaths`, or the run cannot read its own cwd —
   * preflight says so once and still runs. An `answer` run whose workdir is the
   * home folder or contains it works in `answerFallbackWorkdir` instead.
   */
  readonly workdir: string
  readonly profile: RunProfile
  /** Paths every run's file tools are denied: the key store (identity home, the user-scope MCP state). */
  readonly denyReadPaths: readonly string[]
  /** See `ClaudeRunArgOptions.mcpConfigPath`: every profile, strict. */
  readonly mcpConfigPath?: string
  /**
   * See `ClaudeAnswerMcp`. Without it (and without `mcpConfigPath`) an `answer`
   * run does not start: it would load every MCP server the user registered.
   */
  readonly answerMcp?: ClaudeAnswerMcp
  /** The one-line fix printed when the workdir sits inside a denied path. */
  readonly workdirAdvice?: string
  /**
   * A deny path no rule can carry (a comma or whitespace in it; every path on
   * Windows): `warn` (default) logs it once and runs — the run can then read
   * that path; `refuse` fails preflight with the reason, so no run starts.
   */
  readonly inexpressibleDeny?: 'warn' | 'refuse'
  /** Test seam: the binary to run. */
  readonly command?: string
  readonly env?: NodeJS.ProcessEnv
}

/**
 * The folder an `answer` run works in when its configured workdir is the
 * user's home folder or contains it (`workdirExposesHome`): an empty folder of
 * its own beside Claude Code's config, never inside a denied path. The run
 * keeps working — it only cannot read the user's files.
 */
export function claudeAnswerFallbackWorkdir(configDirOverride: string | undefined): string {
  return path.join(claudeHomeFor(configDirOverride), 'agentchat-answer-workdir')
}

export class ClaudeRunner implements RunRunner {
  readonly name = 'claude'
  private readonly command: string
  /** The workdir warning is one line per process, not one per preflight (preflight repeats every few minutes). */
  private warnedWorkdir = false
  private warnedDeny = false
  private warnedHome = false

  constructor(private readonly options: ClaudeRunnerOptions) {
    this.command = options.command ?? 'claude'
  }

  /**
   * Where this runner's runs work: the configured workdir, except that an
   * `answer` run never works in the home folder or above it — it gets
   * `claudeAnswerFallbackWorkdir` (its readable folder would be the whole home).
   */
  workdir(): string {
    if (this.options.profile === 'answer' && workdirExposesHome(this.options.workdir)) return claudeAnswerFallbackWorkdir(this.options.configDir)
    return this.options.workdir
  }

  /** The denied path the workdir sits in, or null when the run can read its own cwd. */
  workdirDeniedBy(): string | null {
    return deniedAncestorOf(this.workdir(), this.options.denyReadPaths)
  }

  async preflight(): Promise<RunPreflight> {
    const runtime = inspectClaudeRuntime(this.options.configDir, this.command)
    if (!runtime.ok) return { ok: false, detail: runtime.detail }
    if (!claudeIsLoggedIn(this.options.configDir, this.command)) {
      return { ok: false, detail: 'claude is not signed in (run `claude` once and sign in)' }
    }
    if (this.options.profile === 'answer' && this.options.mcpConfigPath === undefined) {
      const answerMcp = this.options.answerMcp
      // Fail closed: without an AgentChat-only tool config the run would load
      // every MCP server the user registered.
      if (answerMcp === undefined) {
        return { ok: false, detail: 'an answer run needs the AgentChat-only tool config (ClaudeRunnerOptions.answerMcp): without it the run would load every MCP server the user registered' }
      }
      if (deniedAncestorOf(answerMcp.file, this.options.denyReadPaths) === null) {
        return { ok: false, detail: `the answer runs' tool config ${answerMcp.file} holds the key and must sit inside a path the runs are denied (${this.options.denyReadPaths.join(', ')})` }
      }
    }
    if (this.workdir() !== this.options.workdir && !this.warnedHome) {
      this.warnedHome = true
      log.warn(`the run workdir ${this.options.workdir} is your home folder or contains it: answer runs work in ${this.workdir()} instead, so a peer-started run reads none of your files there. Point the workdir at a folder of its own to choose another.`)
    }
    // A cwd inside the key store is an operator choice the deny rules then
    // make unreadable to the run. Said once, with the fix; the run still
    // starts — the hosted tools do not need the cwd.
    const denied = this.workdirDeniedBy()
    if (denied !== null && !this.warnedWorkdir) {
      this.warnedWorkdir = true
      log.warn(
        `the run workdir ${this.workdir()} is inside ${denied}, which every run's file tools are denied: runs cannot read their own working directory.${this.options.workdirAdvice ? ` ${this.options.workdirAdvice}` : ''}`,
      )
    }
    const uncovered = inexpressibleDenyPaths(this.options.denyReadPaths)
    if (uncovered.length > 0) {
      const why =
        process.platform === 'win32'
          ? `Claude Code's rule syntax for Windows paths is undocumented, so no read-deny rule is given for ${uncovered.join(', ')}`
          : `no read-deny rule can carry ${uncovered.join(', ')} (a comma or whitespace in the path)`
      if (this.options.inexpressibleDeny === 'refuse') return { ok: false, detail: `${why}: a run could read the key there. Use an identity home whose path has no comma or whitespace (--home).` }
      if (!this.warnedDeny) {
        this.warnedDeny = true
        log.warn(`${why}: runs can read those paths.`)
      }
    }
    if (this.options.mcpConfigPath !== undefined && !fs.existsSync(this.options.mcpConfigPath)) {
      return { ok: false, detail: `the hosted tool config ${this.options.mcpConfigPath} is missing` }
    }
    // Owner-only on creation, as the identity home is. Creation only: an
    // operator's own workspace keeps its permissions.
    fs.mkdirSync(this.workdir(), { recursive: true, mode: 0o700 })
    return { ok: true }
  }

  /** The `--mcp-config` file this runner's runs are given, if any: the listener's (every profile), or the answer runs' own. */
  private mcpConfigPathForRun(): string | undefined {
    if (this.options.mcpConfigPath !== undefined) return this.options.mcpConfigPath
    return this.options.profile === 'answer' ? this.options.answerMcp?.file : undefined
  }

  /** The exact argv one run uses — exported for tests to pin per profile. */
  args(): string[] {
    const mcpConfigPath = this.mcpConfigPathForRun()
    return claudeRunArgs(this.options.profile, {
      maxBudgetUsd: (this.options.env ?? process.env)['AGENTCHAT_RUN_MAX_BUDGET_USD'],
      workdir: this.workdir(),
      denyReadPaths: this.options.denyReadPaths,
      ...(mcpConfigPath !== undefined ? { mcpConfigPath } : {}),
    })
  }

  async start(request: RunRequest): Promise<RunOutcome> {
    const startedAt = Date.now()
    const notStarted = (detail: string): RunOutcome => ({ state: 'not_started', exitCode: null, durationMs: Date.now() - startedAt, detail })
    // An answer run's own AgentChat-only tool config: written for this run, removed after it.
    const answerMcp = this.options.profile === 'answer' && this.options.mcpConfigPath === undefined ? this.options.answerMcp : undefined
    if (this.options.profile === 'answer' && this.options.mcpConfigPath === undefined && answerMcp === undefined) {
      return notStarted('an answer run needs the AgentChat-only tool config (ClaudeRunnerOptions.answerMcp)')
    }
    if (answerMcp !== undefined) {
      const key = answerMcp.apiKey()
      if (key === null) return notStarted('no AgentChat key for the answer run\'s tool config')
      try {
        atomicWriteFile(answerMcp.file, claudeMcpConfig(answerMcp.apiBase, key, answerMcp.clientVersion ?? VERSION), 0o600)
      } catch (err) {
        return notStarted(`could not write the answer run's tool config ${answerMcp.file}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    try {
      const args = this.args()
      log.debug(`claude ${args.join(' ')} (prompt on stdin, ${request.kind} run ${request.runId})`)
      return await spawnRun({
        command: this.command,
        args,
        cwd: this.workdir(),
        env: buildClaudeEnv(this.options.configDir, this.options.env ?? process.env),
        stdin: request.prompt,
        budgetMs: request.budgetMs,
        // Stopping SIGTERMs this run's process group instead of orphaning it.
        ...(request.signal ? { signal: request.signal } : {}),
        // The engine records a group invite as offered the moment the process
        // has spawned, so a run cut short still counts as the one offer.
        ...(request.onStarted ? { onStarted: request.onStarted } : {}),
      })
    } finally {
      if (answerMcp !== undefined) fs.rmSync(answerMcp.file, { force: true })
    }
  }
}

/** Where a listener keeps the `--mcp-config` file for this preset, inside its identity home. */
export function claudeMcpConfigPath(home: string): string {
  return path.join(home, 'presets', `${CLAUDE_CODE_PRESET}.mcp.json`)
}

export const claudeCodePreset: Preset = {
  name: CLAUDE_CODE_PRESET,
  describeMcp({ home, apiBase }) {
    return [
      `--mcp-config ${claudeMcpConfigPath(home)} (owner-only): ${CLAUDE_MCP_SERVER_NAME} → ${hostedMcpUrl(apiBase)}, Authorization: Bearer <this home's key>, X-AgentChat-Client: claude-code`,
      '--strict-mcp-config: no other MCP server (user, project or plugin) is loaded in these runs',
    ]
  },
  label: 'Claude Code',
  runtime: 'claude-code',
  // Every run's file tools are denied the identity home.
  serviceEnv: ['CLAUDE_CONFIG_DIR'],
  readsIdentityHome: false,
  inspect(env = process.env, command = 'claude') {
    const configDir = claudeConfigDirFrom(env)
    const runtime = inspectClaudeRuntime(configDir, command)
    if (!runtime.ok) return runtime
    return claudeIsLoggedIn(configDir, command)
      ? { ok: true, detail: `${runtime.detail}, signed in` }
      : { ok: false, detail: `${runtime.detail}, not signed in (run \`claude\` once and sign in)` }
  },
  runner(ctx: PresetContext): RunRunner {
    // A key in the listener's own environment is not handed to its runs.
    const env = withoutInheritedKey(ctx.env ?? process.env)
    const configDir = claudeConfigDirFrom(env)
    const mcpConfigPath = claudeMcpConfigPath(ctx.home)
    // Rewritten for every identity the listener serves: the runs act as THIS agent.
    atomicWriteFile(mcpConfigPath, claudeMcpConfig(ctx.apiBase, ctx.apiKey, ctx.clientVersion ?? VERSION), 0o600)
    return new ClaudeRunner({
      configDir,
      workdir: ctx.workdir,
      profile: ctx.profile,
      // The listener's home (its key and this file), the user-scope MCP state
      // and an integration's identity home beside it: no run reads a key.
      denyReadPaths: [ctx.home, claudeUserStatePathFor(configDir), path.join(claudeHomeFor(configDir), 'agentchat')],
      mcpConfigPath,
      workdirAdvice: 'Start the listener from a directory outside it, or pass --workdir.',
      // On POSIX a listener's run must not start with its key readable; on
      // Windows no rule exists at all (documented), so it warns.
      inexpressibleDeny: process.platform === 'win32' ? 'warn' : 'refuse',
      ...(ctx.command !== undefined ? { command: ctx.command } : {}),
      env,
    })
  },
}
