import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  DEFAULT_RUN_PROFILE,
  FALLBACK_RUN_PROFILE,
  OWN_RUN_WARNING,
  PEER_RUN_WARNING,
  RUN_PROFILES,
  describeRunProfile,
  ownProfileLine,
  resolveRunProfile,
  runProfileWarning,
} from '../src/integration/profile.js'
import { formatIntegrationStatus, readIntegrationStatus, writeIntegrationStatus, type IntegrationStatus } from '../src/integration/status.js'
import {
  AGENTCHAT_TOOL_ALLOW,
  ClaudeRunner,
  CodexRunner,
  LISTENER_KEY_ENV,
  claudeAnswerFallbackWorkdir,
  claudeCodePreset,
  claudeMcpConfigPath,
  claudeProjectsDirFor,
  claudeRunArgs,
  codexAgentchatExplicitAuth,
  codexAnswerFallbackWorkdir,
  codexDotEnvKeyNames,
  codexListenerHeadersHelperPath,
  codexPreset,
  codexRunArgs,
  type ClaudeRunnerOptions,
} from '../src/presets/index.js'
import { installFakeClaude, installFakeCodex, readFakeMcpLists, readFakeRuns, type FakeRuntime } from './helpers/fake-runtimes.js'

// ─── The `own` profile: a reply run acts as the agent itself ────────────────
//
// `own` is the default. A run started by a peer's message runs under the
// user's own Claude Code / Codex permission settings, exactly as their own
// headless runs do; AgentChat adds only what a run cannot do without (its own
// tools, pre-approved; nothing ever waiting on a prompt) and what keeps the
// key out of reach (the key-store deny rules, no key in the run's
// environment). These tests fail if `own` ever starts deciding which tools a
// run gets, or stops guarding the key.

const posix = process.platform !== 'win32'
const KEY = 'ac_live_' + 'k'.repeat(40)
const request = { kind: 'wake' as const, prompt: 'SERVED WAKE', runId: 'run-own-1', budgetMs: 20_000 }

let sandbox: string
let home: string
const originalPath = process.env['PATH']
beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-own-'))
  home = path.join(sandbox, 'home')
  fs.mkdirSync(home, { recursive: true })
})
afterEach(() => {
  process.env['PATH'] = originalPath
  fs.rmSync(sandbox, { recursive: true, force: true })
})

const withFake = (fake: FakeRuntime, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  process.env['PATH'] = `${fake.binDir}${path.delimiter}${originalPath ?? ''}`
  return { ...process.env, FAKE_RUNTIME_RECORD: fake.recordPath, CLAUDE_CONFIG_DIR: path.join(sandbox, '.claude'), CODEX_HOME: path.join(sandbox, '.codex'), ...extra }
}

function valueOf(argv: readonly string[], flag: string): string | null {
  const at = argv.indexOf(flag)
  return at < 0 ? null : (argv[at + 1] ?? null)
}

/** Nothing in an `own` argv decides what the run may do beyond AgentChat's own tools and the key store. */
function assertClaudeOwnLeavesSettingsAlone(argv: readonly string[]): void {
  for (const flag of ['--tools', '--settings', '--permission-mode', '--strict-mcp-config', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--add-dir', '--setting-sources', '--restricted', '--bare', '--safe-mode']) {
    expect(argv, `${flag} overrides the user's own settings`).not.toContain(flag)
  }
  expect(valueOf(argv, '--permission-prompts')).toBe('none')
  // Pre-approved: AgentChat's own tools, nothing else.
  expect(valueOf(argv, '--allowedTools')).toBe(AGENTCHAT_TOOL_ALLOW)
  // Denied: the key store only (Read rules), never a tool by name.
  const denied = valueOf(argv, '--disallowedTools')
  for (const rule of denied === null ? [] : denied.split(',')) expect(rule).toMatch(/^Read\(\/\/.+\)$/)
}

describe('the default is own; an unknown value is answer (fail-safe)', () => {
  it('the profiles, the default and the fallback', () => {
    expect([...RUN_PROFILES]).toEqual(['own', 'answer', 'work', 'full'])
    expect(DEFAULT_RUN_PROFILE).toBe('own')
    expect(FALLBACK_RUN_PROFILE).toBe('answer')
  })

  it('unset or blank is own; a profile in any case is that profile; anything else is answer', () => {
    expect(resolveRunProfile({})).toBe('own')
    expect(resolveRunProfile({ AGENTCHAT_RUN_PROFILE: '' })).toBe('own')
    expect(resolveRunProfile({ AGENTCHAT_RUN_PROFILE: '  ' })).toBe('own')
    expect(resolveRunProfile({ AGENTCHAT_RUN_PROFILE: 'OWN' })).toBe('own')
    expect(resolveRunProfile({ AGENTCHAT_RUN_PROFILE: ' answer ' })).toBe('answer')
    expect(resolveRunProfile({ AGENTCHAT_RUN_PROFILE: 'work' })).toBe('work')
    expect(resolveRunProfile({ AGENTCHAT_RUN_PROFILE: 'full' })).toBe('full')
    for (const typo of ['yolo', 'owns', 'answr', 'default', 'none']) expect(resolveRunProfile({ AGENTCHAT_RUN_PROFILE: typo })).toBe('answer')
  })
})

describe('what own is called wherever it is offered or described', () => {
  it('one line naming the runtime, then the honest sentence', () => {
    expect(ownProfileLine('Claude Code')).toBe('reply runs use your own Claude Code permission settings, with anything that would ask refused')
    expect(ownProfileLine('Codex')).toBe('reply runs use your own Codex permission settings, with anything that would ask refused')
    expect(OWN_RUN_WARNING).toBe("runs started by peers' messages act with those permissions")
    expect(runProfileWarning('own')).toBe(OWN_RUN_WARNING)
    expect(describeRunProfile('own', 'Claude Code')).toBe(`${ownProfileLine('Claude Code')}; ${OWN_RUN_WARNING}`)
    // work and full keep their warning; answer has none.
    expect(runProfileWarning('work')).toBe(PEER_RUN_WARNING)
    expect(runProfileWarning('full')).toBe(PEER_RUN_WARNING)
    expect(runProfileWarning('answer')).toBeNull()
    expect(describeRunProfile('work', 'Codex')).toContain(PEER_RUN_WARNING)
    expect(describeRunProfile('full', 'Codex')).toContain(PEER_RUN_WARNING)
    expect(describeRunProfile('answer', 'Codex')).not.toContain("peers' messages")
  })

  const sample = (over: Partial<IntegrationStatus> = {}): IntegrationStatus => ({
    version: 2,
    updated_at: new Date().toISOString(),
    pid: 1,
    runtime: 'claude',
    runtime_label: 'Claude Code',
    handle: 'me',
    profile: 'own',
    socket: 'ready',
    wakes: 0,
    wakes_absorbed: 0,
    invites: 0,
    runs_started: 0,
    runs_ok: 0,
    runs_failed: 0,
    runs_timed_out: 0,
    runs_not_started: 0,
    runs_skipped_empty: 0,
    last_run: null,
    retry_rung: 0,
    retry_due_at: null,
    last_error: null,
    texts: null,
    ...over,
  })

  it('status says what the active profile does, in the runtime\'s name the daemon recorded', () => {
    const lines = formatIntegrationStatus(sample()).join('\n')
    expect(lines).toContain(`profile: own (claude) — reply runs use your own Claude Code permission settings, with anything that would ask refused; ${OWN_RUN_WARNING}`)
    expect(formatIntegrationStatus(sample({ profile: 'answer' })).join('\n')).toContain('profile: answer (claude) — reply runs get the AgentChat tools and reads inside their own work folder, nothing else')
    // A status from before the label was recorded still reads.
    const { runtime_label: _, ...old } = sample()
    expect(formatIntegrationStatus(old as IntegrationStatus).join('\n')).toContain('profile: own (claude) — reply runs use your own permission settings, with anything that would ask refused')
  })

  it('the daemon records the runtime\'s name, and it reads back', () => {
    writeIntegrationStatus(home, sample({ runtime_label: 'Codex' }))
    expect(readIntegrationStatus(home)?.runtime_label).toBe('Codex')
  })

  it('a home-folder workdir: own runs, like answer runs, work in their own empty folder', () => {
    expect(formatIntegrationStatus(sample({ workdir: os.homedir() })).join('\n')).toContain("the presets' own and answer runs use their own empty folder instead")
  })
})

describe('Claude Code own: the user\'s settings decide; AgentChat adds its tools and the key-store deny', () => {
  it('the flags, pinned', () => {
    expect(claudeRunArgs('own', { workdir: '/w', denyReadPaths: ['/h', '/c/.claude.json'] })).toEqual([
      '-p', '--output-format', 'text', '--no-session-persistence',
      '--permission-prompts', 'none',
      '--allowedTools', 'mcp__agentchat__*',
      ...(posix ? ['--disallowedTools', 'Read(//h),Read(//h/**),Read(//c/.claude.json),Read(//c/.claude.json/**)'] : []),
    ])
    assertClaudeOwnLeavesSettingsAlone(claudeRunArgs('own', { workdir: '/w', denyReadPaths: ['/h'] }))
  })

  it('the identity line by --append-system-prompt-file; a listener\'s --mcp-config without --strict-mcp-config (its agentchat wins, the user\'s other servers load)', () => {
    const args = claudeRunArgs('own', { mcpConfigPath: '/h/presets/claude-code.mcp.json', appendSystemPromptFile: '/h/presets/x.identity.md', denyReadPaths: ['/h'] })
    expect(args.slice(args.indexOf('--mcp-config'), args.indexOf('--mcp-config') + 2)).toEqual(['--mcp-config', '/h/presets/claude-code.mcp.json'])
    expect(valueOf(args, '--append-system-prompt-file')).toBe('/h/presets/x.identity.md')
    assertClaudeOwnLeavesSettingsAlone(args)
    // The variadic --mcp-config is followed by an option, never by a value it could swallow.
    expect(args[args.indexOf('--mcp-config') + 2]).toMatch(/^--/)
  })

  const options = (fake: FakeRuntime, extra: Partial<ClaudeRunnerOptions> = {}): ClaudeRunnerOptions => ({
    configDir: path.join(sandbox, '.claude'),
    workdir: path.join(sandbox, 'work'),
    profile: 'own',
    denyReadPaths: [home, path.join(sandbox, '.claude', '.claude.json')],
    answerMcp: { file: claudeMcpConfigPath(home), apiBase: 'https://api.example', apiKey: () => KEY },
    env: withFake(fake, { AGENTCHAT_API_KEY: KEY }),
    ...extra,
  })

  it('a run: the user\'s MCP servers, CLAUDE.md, memory and hooks (no override); the identity line appended; the key store denied; no key anywhere', async () => {
    const fake = installFakeClaude(sandbox)
    const runner = new ClaudeRunner(options(fake))
    expect(await runner.preflight()).toEqual({ ok: true })
    const outcome = await runner.start({ ...request, identityLine: 'You are @me on AgentChat.' })
    expect(outcome.state).toBe('ok')
    const [run] = readFakeRuns(fake)
    assertClaudeOwnLeavesSettingsAlone(run!.argv)
    expect(run!.argv).not.toContain('--mcp-config')
    expect(run!.mcpConfig).toBeNull()
    expect(run!.appendedSystemPrompt).toBe('You are @me on AgentChat.\n')
    if (posix) {
      expect(valueOf(run!.argv, '--disallowedTools')).toContain(`Read(/${home}/**)`)
      // Claude Code's own record of projects is the user's own, as in their sessions.
      expect(valueOf(run!.argv, '--disallowedTools')).not.toContain(claudeProjectsDirFor(path.join(sandbox, '.claude')))
    }
    expect(run!.env['CLAUDE_CODE_DISABLE_CLAUDE_MDS']).toBeUndefined()
    expect(run!.env['CLAUDE_CODE_DISABLE_AUTO_MEMORY']).toBeUndefined()
    // A key the daemon inherited is not handed to a run that has the user's shell.
    expect(run!.env['AGENTCHAT_API_KEY']).toBeUndefined()
    expect(JSON.stringify(run!.env)).not.toContain(KEY)
    expect(JSON.stringify(run!.argv)).not.toContain(KEY)
    expect(fs.realpathSync(run!.cwd)).toBe(fs.realpathSync(path.join(sandbox, 'work')))
    // The run's own files are gone after it.
    expect(fs.existsSync(path.join(home, 'presets')) ? fs.readdirSync(path.join(home, 'presets')) : []).toEqual([])
  }, 20_000)

  it('no AgentChat-only tool config is needed, and a settings file listing additionalDirectories does not stop it (the user\'s own setting)', async () => {
    const fake = installFakeClaude(sandbox)
    fs.mkdirSync(path.join(sandbox, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(sandbox, '.claude', 'settings.json'), JSON.stringify({ permissions: { additionalDirectories: ['/tmp'] } }))
    const { answerMcp: _, ...withoutAnswerMcp } = options(fake)
    const runner = new ClaudeRunner(withoutAnswerMcp)
    expect(await runner.preflight()).toEqual({ ok: true })
    expect((await runner.start(request)).state).toBe('ok')
    // Nowhere to write an identity-line file: the run still starts (its CLAUDE.md carries the line).
    expect(readFakeRuns(fake)[0]!.appendedSystemPrompt).toBeNull()
  }, 20_000)

  it('the home folder is no own run\'s workdir either: it works in the same empty folder answer runs use', () => {
    const runner = new ClaudeRunner({ configDir: path.join(sandbox, '.claude'), workdir: os.homedir(), profile: 'own', denyReadPaths: [home] })
    expect(runner.workdir()).toBe(claudeAnswerFallbackWorkdir(path.join(sandbox, '.claude')))
    for (const profile of ['work', 'full'] as const) expect(new ClaudeRunner({ configDir: undefined, workdir: os.homedir(), profile, denyReadPaths: [home] }).workdir()).toBe(os.homedir())
  })

  it('the listener: its own --mcp-config (this agent\'s key, owner-only), not strict; the key never on argv or in the environment', async () => {
    const fake = installFakeClaude(sandbox)
    const env = withFake(fake, { AGENTCHAT_API_KEY: 'ac_live_' + 'o'.repeat(40) })
    const runner = claudeCodePreset.runner({ home, workdir: path.join(sandbox, 'work'), profile: 'own', apiKey: KEY, apiBase: 'https://api.example', env })
    expect(await runner.preflight()).toEqual({ ok: true })
    expect((await runner.start({ ...request, identityLine: 'You are @listener on AgentChat.' })).state).toBe('ok')
    const [run] = readFakeRuns(fake)
    assertClaudeOwnLeavesSettingsAlone(run!.argv)
    expect(valueOf(run!.argv, '--mcp-config')).toBe(claudeMcpConfigPath(home))
    expect(run!.mcpConfig).toEqual({ servers: ['agentchat'], mode: posix ? 0o600 : expect.any(Number) })
    expect(run!.appendedSystemPrompt).toBe('You are @listener on AgentChat.\n')
    expect(JSON.stringify(run!.argv)).not.toContain(KEY)
    expect(JSON.stringify(run!.env)).not.toContain(KEY)
    expect(run!.env['AGENTCHAT_API_KEY']).toBeUndefined()
    expect(runner.label).toBe('Claude Code')
  }, 20_000)
})

describe('Codex own: the user\'s config.toml decides; AgentChat adds only its MCP server pins', () => {
  /** Nothing in an `own` argv overrides the user's sandbox, approvals, features, tools or instructions. */
  function assertCodexOwnLeavesConfigAlone(argv: readonly string[]): void {
    for (const flag of ['--sandbox', '-s', '--dangerously-bypass-approvals-and-sandbox', '--full-auto', '--disable', '--enable', '--profile', '-p', '--add-dir']) {
      expect(argv, `${flag} overrides the user's own config`).not.toContain(flag)
    }
    const overrides = argv.flatMap((arg, i) => (argv[i - 1] === '-c' ? [arg] : []))
    for (const value of overrides) expect(value, `-c ${value} is not one of AgentChat's own MCP server keys`).toMatch(/^mcp_servers\.agentchat\.(url|http_headers_helper|http_headers|default_tools_approval_mode)=/)
  }

  it('the flags, pinned: nothing but the run\'s shape', () => {
    expect(codexRunArgs('own', { workdir: '/w' })).toEqual(['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-C', '/w', '-'])
    assertCodexOwnLeavesConfigAlone(codexRunArgs('own', { workdir: '/w' }))
  })

  it('a listener\'s server: the URL, its headers helper (never a bearer variable), approval for its own tools, the client headers', () => {
    const args = codexRunArgs('own', { workdir: '/w', mcp: { url: 'https://api.example/mcp', keyEnv: LISTENER_KEY_ENV, headersHelper: "'/n' '/h/presets/codex.mcp-headers.mjs'" } })
    assertCodexOwnLeavesConfigAlone(args)
    expect(args).toContain(`mcp_servers.agentchat.http_headers_helper=${JSON.stringify("'/n' '/h/presets/codex.mcp-headers.mjs'")}`)
    expect(args.join(' ')).not.toContain('bearer_token_env_var')
    expect(args).toContain('mcp_servers.agentchat.default_tools_approval_mode="approve"')
    expect(args[args.length - 1]).toBe('-')
  })

  it('an integration\'s run: no listing, no key in the environment, the pinned URL', async () => {
    const fake = installFakeCodex(sandbox)
    const list = path.join(sandbox, 'mcp-list.jsonl')
    const runner = new CodexRunner({
      codexHome: path.join(sandbox, '.codex'),
      workdir: path.join(sandbox, 'work'),
      profile: 'own',
      apiKey: () => null,
      keyEnv: 'AGENTCHAT_API_KEY',
      pinMcpUrl: 'https://api.example/mcp',
      // A key the daemon inherited: an own run has the user's shell, so it must not get it.
      env: withFake(fake, { FAKE_MCP_LIST_RECORD: list, AGENTCHAT_API_KEY: KEY }),
    })
    expect(await runner.preflight()).toEqual({ ok: true })
    expect((await runner.start(request)).state).toBe('ok')
    expect(readFakeMcpLists(list)).toEqual([])
    const [run] = readFakeRuns(fake)
    assertCodexOwnLeavesConfigAlone(run!.argv)
    expect(run!.argv).toContain('mcp_servers.agentchat.url="https://api.example/mcp"')
    expect(run!.stdin).toBe('SERVED WAKE')
    expect(run!.env['AGENTCHAT_API_KEY']).toBeUndefined()
    expect(JSON.stringify(run!.env)).not.toContain(KEY)
    expect(runner.label).toBe('Codex')
  }, 20_000)

  it('the home folder is no own run\'s workspace root either', () => {
    const codexHome = path.join(sandbox, '.codex')
    const base = { codexHome, apiKey: () => null, keyEnv: 'K' }
    expect(new CodexRunner({ ...base, workdir: os.homedir(), profile: 'own' }).workdir()).toBe(codexAnswerFallbackWorkdir(codexHome))
    expect(new CodexRunner({ ...base, workdir: os.homedir(), profile: 'work' }).workdir()).toBe(os.homedir())
  })

  it('the listener: a headers helper in its home reads its credentials; the run\'s environment carries no key', async () => {
    const fake = installFakeCodex(sandbox)
    fs.writeFileSync(path.join(home, 'credentials'), JSON.stringify({ api_key: KEY, handle: 'listener', api_base: 'https://api.example' }), { mode: 0o600 })
    const lists = path.join(sandbox, 'own-lists.jsonl')
    const env = withFake(fake, { AGENTCHAT_API_KEY: 'ac_live_' + 'o'.repeat(40), FAKE_MCP_LIST_RECORD: lists })
    const runner = codexPreset.runner({ home, workdir: path.join(sandbox, 'work'), profile: 'own', apiKey: KEY, apiBase: 'https://api.example', env })
    expect(await runner.preflight()).toEqual({ ok: true })
    expect((await runner.start(request)).state).toBe('ok')
    const [run] = readFakeRuns(fake)
    assertCodexOwnLeavesConfigAlone(run!.argv)
    expect(run!.env[LISTENER_KEY_ENV]).toBeUndefined()
    expect(run!.env['AGENTCHAT_API_KEY']).toBeUndefined()
    expect(JSON.stringify(run!.env)).not.toContain(KEY)
    expect(JSON.stringify(run!.argv)).not.toContain(KEY)
    const helper = codexListenerHeadersHelperPath(home)
    expect(run!.argv.join(' ')).toContain(helper)
    if (posix) expect(fs.statSync(helper).mode & 0o777).toBe(0o600)
    // The helper command exactly as the run's argv carries it, run as Codex runs it (`sh -c`, an
    // environment of its own): it yields this home's key and nothing of the environment's.
    const pin = run!.argv.find((a) => a.startsWith('mcp_servers.agentchat.http_headers_helper='))!
    const command = JSON.parse(pin.slice('mcp_servers.agentchat.http_headers_helper='.length)) as string
    if (posix) {
      const out = spawnSync('sh', ['-c', command], { encoding: 'utf-8', env: { AGENTCHAT_API_KEY: 'ac_live_' + 'e'.repeat(40) } })
      expect(out.status, out.stderr).toBe(0)
      expect(JSON.parse(out.stdout)).toEqual({ Authorization: `Bearer ${KEY}` })
    }
    // Before the run, Codex was asked how its agentchat entry authenticates (the run's own flags).
    expect(readFakeMcpLists(lists)).toHaveLength(1)
    expect(readFakeMcpLists(lists)[0]!.argv).toContain(pin)
    // answer, work and full keep the bearer variable, unchanged.
    for (const profile of ['answer', 'work', 'full'] as const) {
      const other = codexPreset.runner({ home, workdir: path.join(sandbox, 'work'), profile, apiKey: KEY, apiBase: 'https://api.example', env }) as CodexRunner
      expect(other.args().join(' ')).toContain(`bearer_token_env_var="${LISTENER_KEY_ENV}"`)
      expect(other.env()[LISTENER_KEY_ENV]).toBe(KEY)
    }
  }, 20_000)

  it('the listener: no own run while Codex would send another credential, or carry a key from $CODEX_HOME/.env (a Codex integration from 0.5.2 or earlier left both)', async () => {
    const fake = installFakeCodex(sandbox)
    fs.writeFileSync(path.join(home, 'credentials'), JSON.stringify({ api_key: KEY, handle: 'listener', api_base: 'https://api.example' }), { mode: 0o600 })
    const legacy = JSON.stringify([{ name: 'agentchat', enabled: true, transport: { type: 'streamable_http', url: 'https://api.example/mcp', bearer_token_env_var: 'AGENTCHAT_API_KEY', http_headers_helper: 'x' } }])
    const build = (extra: NodeJS.ProcessEnv) => codexPreset.runner({ home, workdir: path.join(sandbox, 'work'), profile: 'own', apiKey: KEY, apiBase: 'https://api.example', env: withFake(fake, extra) })
    const bearer = build({ FAKE_MCP_LIST: legacy })
    expect(await bearer.preflight()).toMatchObject({ ok: false, detail: expect.stringContaining('sets bearer_token_env_var: Codex sends that credential in place of this listener\'s headers helper') })
    expect(await bearer.start(request)).toMatchObject({ state: 'not_started', detail: expect.stringContaining('doctor --fix') })
    const authHeader = JSON.stringify([{ name: 'agentchat', enabled: true, transport: { env_http_headers: { authorization: 'SOME_VAR' } } }])
    expect(await build({ FAKE_MCP_LIST: authHeader }).preflight()).toMatchObject({ ok: false, detail: expect.stringContaining('env_http_headers.Authorization') })
    expect(await build({ FAKE_MCP_LIST_MODE: 'fail' }).preflight()).toMatchObject({ ok: false, detail: expect.stringContaining("could not list Codex's MCP servers") })
    // An env header that is not the Authorization one changes nothing.
    expect(await build({ FAKE_MCP_LIST: JSON.stringify([{ name: 'agentchat', enabled: true, transport: { env_http_headers: { 'X-Trace': 'T' } } }]) }).preflight()).toEqual({ ok: true })
    // A key in $CODEX_HOME/.env: Codex would load it into the run's environment.
    fs.mkdirSync(path.join(sandbox, '.codex'), { recursive: true })
    fs.writeFileSync(path.join(sandbox, '.codex', '.env'), 'OTHER=1\nexport AGENTCHAT_API_KEY=ac_live_left_behind\n')
    expect(await build({}).preflight()).toMatchObject({ ok: false, detail: expect.stringContaining('.env sets AGENTCHAT_API_KEY') })
    expect(readFakeRuns(fake)).toEqual([])
    // answer, work and full are not affected: they set their own bearer variable.
    expect(await codexPreset.runner({ home, workdir: path.join(sandbox, 'work'), profile: 'work', apiKey: KEY, apiBase: 'https://api.example', env: withFake(fake, { FAKE_MCP_LIST: legacy }) }).preflight()).toEqual({ ok: true })
    // An integration's own runs (no helper override of their own) are not refused for it either.
    expect(await new CodexRunner({ codexHome: path.join(sandbox, '.codex'), workdir: path.join(sandbox, 'work'), profile: 'own', apiKey: () => null, keyEnv: 'AGENTCHAT_API_KEY', env: withFake(fake, { FAKE_MCP_LIST: legacy }) }).preflight()).toEqual({ ok: true })
  }, 30_000)

  it('the parsers keep names only', () => {
    expect(codexAgentchatExplicitAuth('[{"name":"agentchat","transport":{"bearer_token_env_var":"K","env_http_headers":{"Authorization":"V"}}},{"name":"x","transport":{"bearer_token_env_var":"Y"}}]')).toEqual({ ok: true, keys: ['bearer_token_env_var', 'env_http_headers.Authorization'] })
    expect(codexAgentchatExplicitAuth('[{"name":"agentchat","enabled":true}]')).toEqual({ ok: true, keys: [] })
    expect(codexAgentchatExplicitAuth('[]')).toEqual({ ok: true, keys: [] })
    expect(codexAgentchatExplicitAuth('nope')).toMatchObject({ ok: false })
    expect(codexDotEnvKeyNames('A=1\r\n  export AGENTCHAT_API_KEY="x"\n# AGENTCHAT_LISTENER_API_KEY=y\nAGENTCHAT_LISTENER_API_KEY=z\nAGENTCHAT_API_KEY=\n')).toEqual(['AGENTCHAT_API_KEY', 'AGENTCHAT_LISTENER_API_KEY'])
  })

  it('describeMcp says what an own run of each preset is given', () => {
    const claude = claudeCodePreset.describeMcp({ home, apiBase: 'https://api.example', profile: 'own' }).join('\n')
    expect(claude).toContain(claudeMcpConfigPath(home))
    expect(claude).not.toContain('--strict-mcp-config')
    expect(claude).toContain('your other MCP servers load too')
    const codex = codexPreset.describeMcp({ home, apiBase: 'https://api.example', profile: 'own', env: { CODEX_HOME: path.join(sandbox, '.codex') } }).join('\n')
    expect(codex).toContain('http_headers_helper')
    expect(codex).toContain(codexListenerHeadersHelperPath(home))
    expect(codex).not.toContain('-c mcp_servers.agentchat.bearer_token_env_var=')
    expect(codex).toContain('no run while $CODEX_HOME/.env sets a key or the merged agentchat entry names bearer_token_env_var')
    // Without a profile: as before (the strict file; the bearer variable).
    expect(claudeCodePreset.describeMcp({ home, apiBase: 'https://api.example' }).join('\n')).toContain('--strict-mcp-config')
    expect(codexPreset.describeMcp({ home, apiBase: 'https://api.example', env: { CODEX_HOME: path.join(sandbox, '.codex') } }).join('\n')).toContain('bearer_token_env_var')
  })
})
