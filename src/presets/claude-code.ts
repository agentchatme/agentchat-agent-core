import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { hostedMcpUrl } from '../integration/mcp-probe.js'
import type { RunProfile } from '../integration/profile.js'
import type { RunOutcome, RunPreflight, RunRequest, RunRunner } from '../integration/runner.js'
import { spawnRun } from '../integration/spawn-run.js'
import { atomicWriteFile } from '../util/fsutil.js'
import { log } from '../util/log.js'
import { spawnCommandSync } from '../util/spawn.js'
import { semverAtLeast } from './semver.js'
import { withoutInheritedKey, type Preset, type PresetContext, type PresetInspection } from './types.js'

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
//   --disallowedTools <rules>   denies. Deny rules win over allow rules, and a
//                               `Read(<path>)` rule covers every built-in tool
//                               that reads files (Read, Grep, Glob — docs:
//                               permissions.md "Read & Edit"). Used to keep a
//                               run's file tools off the key store. `//`
//                               prefixes an absolute path in rule syntax.
//   --permission-mode default   Manual: reads need no approval, everything else
//                               prompts (and is therefore denied here).
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

/** Built-in tools an `answer` run keeps: read-only files plus the web. */
export const ANSWER_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'] as const

/** Built-in tools a `work` run additionally pre-approves. */
export const WORK_TOOLS = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const

/** Env a parent Claude Code session leaks that would make the child think it is nested. */
export const PARENT_ENV_KEYS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_EFFORT',
  'AI_AGENT',
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
  const env = claudeProcessEnv(configDirOverride, source)
  for (const key of PARENT_ENV_KEYS) delete env[key]
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

export function claudeProfileArgs(profile: RunProfile): string[] {
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
        [AGENTCHAT_TOOL_ALLOW, ...ANSWER_TOOLS].join(','),
      ]
    case 'work':
      return [
        '--permission-mode',
        'acceptEdits',
        '--permission-prompts',
        'none',
        '--allowedTools',
        [AGENTCHAT_TOOL_ALLOW, ...ANSWER_TOOLS, ...WORK_TOOLS].join(','),
      ]
    case 'full':
      return ['--dangerously-skip-permissions', '--permission-prompts', 'none', '--allowedTools', AGENTCHAT_TOOL_ALLOW]
  }
}

export interface ClaudeRunArgOptions {
  /** `AGENTCHAT_RUN_MAX_BUDGET_USD`: stop the run once estimated spend reaches this (print mode only). */
  readonly maxBudgetUsd?: string | undefined
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
  const deny = readDenyRules(options.denyReadPaths ?? [])
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
    ...claudeProfileArgs(profile),
    // Last: the option is variadic and the prompt arrives on stdin, so there
    // is no positional for it to swallow.
    ...(deny.length > 0 ? ['--disallowedTools', deny.join(',')] : []),
  ]
}

/** The `--mcp-config` document: the hosted server, by HTTP, with the agent's key. Owner-only on disk. */
export function claudeMcpConfig(apiBase: string, apiKey: string): string {
  return `${JSON.stringify(
    { mcpServers: { [CLAUDE_MCP_SERVER_NAME]: { type: 'http', url: hostedMcpUrl(apiBase), headers: { Authorization: `Bearer ${apiKey}` } } } },
    null,
    2,
  )}\n`
}

export interface ClaudeRunnerOptions {
  readonly configDir: string | undefined
  /**
   * The run's working directory; the `work` profile edits and runs shell here.
   * Must lie outside `denyReadPaths`, or the run cannot read its own cwd —
   * preflight says so once and still runs.
   */
  readonly workdir: string
  readonly profile: RunProfile
  /** Paths every run's file tools are denied: the key store (identity home, the user-scope MCP state). */
  readonly denyReadPaths: readonly string[]
  /** See `ClaudeRunArgOptions.mcpConfigPath`. */
  readonly mcpConfigPath?: string
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

export class ClaudeRunner implements RunRunner {
  readonly name = 'claude'
  private readonly command: string
  /** The workdir warning is one line per process, not one per preflight (preflight repeats every few minutes). */
  private warnedWorkdir = false
  private warnedDeny = false

  constructor(private readonly options: ClaudeRunnerOptions) {
    this.command = options.command ?? 'claude'
  }

  /** The denied path the configured workdir sits in, or null when the run can read its own cwd. */
  workdirDeniedBy(): string | null {
    return deniedAncestorOf(this.options.workdir, this.options.denyReadPaths)
  }

  async preflight(): Promise<RunPreflight> {
    const runtime = inspectClaudeRuntime(this.options.configDir, this.command)
    if (!runtime.ok) return { ok: false, detail: runtime.detail }
    if (!claudeIsLoggedIn(this.options.configDir, this.command)) {
      return { ok: false, detail: 'claude is not signed in (run `claude` once and sign in)' }
    }
    // A cwd inside the key store is an operator choice the deny rules then
    // make unreadable to the run. Said once, with the fix; the run still
    // starts — the hosted tools do not need the cwd.
    const denied = this.workdirDeniedBy()
    if (denied !== null && !this.warnedWorkdir) {
      this.warnedWorkdir = true
      log.warn(
        `the run workdir ${this.options.workdir} is inside ${denied}, which every run's file tools are denied: runs cannot read their own working directory.${this.options.workdirAdvice ? ` ${this.options.workdirAdvice}` : ''}`,
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
    fs.mkdirSync(this.options.workdir, { recursive: true, mode: 0o700 })
    return { ok: true }
  }

  /** The exact argv one run uses — exported for tests to pin per profile. */
  args(): string[] {
    return claudeRunArgs(this.options.profile, {
      maxBudgetUsd: (this.options.env ?? process.env)['AGENTCHAT_RUN_MAX_BUDGET_USD'],
      denyReadPaths: this.options.denyReadPaths,
      mcpConfigPath: this.options.mcpConfigPath,
    })
  }

  async start(request: RunRequest): Promise<RunOutcome> {
    const args = this.args()
    log.debug(`claude ${args.join(' ')} (prompt on stdin, ${request.kind} run ${request.runId})`)
    return spawnRun({
      command: this.command,
      args,
      cwd: this.options.workdir,
      env: buildClaudeEnv(this.options.configDir, this.options.env ?? process.env),
      stdin: request.prompt,
      budgetMs: request.budgetMs,
      // Stopping SIGTERMs this run's process group instead of orphaning it.
      ...(request.signal ? { signal: request.signal } : {}),
      // The engine records a group invite as offered the moment the process
      // has spawned, so a run cut short still counts as the one offer.
      ...(request.onStarted ? { onStarted: request.onStarted } : {}),
    })
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
      `--mcp-config ${claudeMcpConfigPath(home)} (owner-only): ${CLAUDE_MCP_SERVER_NAME} → ${hostedMcpUrl(apiBase)}, Authorization: Bearer <this home's key>`,
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
    atomicWriteFile(mcpConfigPath, claudeMcpConfig(ctx.apiBase, ctx.apiKey), 0o600)
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
