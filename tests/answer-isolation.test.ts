import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  ClaudeRunner,
  CodexRunner,
  claudeAnswerFallbackWorkdir,
  codexAnswerFallbackWorkdir,
  codexMcpDisableArgs,
  isParentSessionEnv,
  parseCodexMcpList,
  withoutParentSession,
  type ClaudeRunnerOptions,
  type CodexRunnerOptions,
} from '../src/presets/index.js'
import { workdirExposesHome } from '../src/integration/profile.js'
import { formatIntegrationStatus, type IntegrationStatus } from '../src/integration/status.js'
import { installFakeClaude, installFakeCodex, readFakeMcpLists, readFakeRuns, type FakeRuntime } from './helpers/fake-runtimes.js'

// ─── What an `answer` run is isolated from, beyond its file and web tools ───
//
//   * every MCP server but AgentChat's (Claude Code: an AgentChat-only
//     --mcp-config, strict; Codex: every other listed server switched off per
//     run, or no run),
//   * the parent session's variables (every profile, both runtimes),
//   * the user's home folder as its workdir (an empty folder of its own).

const posix = process.platform !== 'win32'
const KEY = 'ac_live_' + 'k'.repeat(40)
const request = { kind: 'wake' as const, prompt: 'WAKE', runId: 'r1', budgetMs: 20_000 }

let sandbox: string
let home: string
const originalPath = process.env['PATH']
const originalHome = process.env['HOME']
beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-isolation-'))
  home = path.join(sandbox, 'identity-home')
  fs.mkdirSync(home, { recursive: true })
})
afterEach(() => {
  process.env['PATH'] = originalPath
  if (originalHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = originalHome
  fs.rmSync(sandbox, { recursive: true, force: true })
})

/** A parent Claude Code session and a parent Codex session, as a listener started inside them inherits. */
const PARENT_SESSION = {
  CLAUDECODE: '1',
  CLAUDE_PID: '4242',
  CLAUDE_EFFORT: 'high',
  CLAUDE_CODE_SESSION_ID: 'parent-session',
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/parent.sock',
  CLAUDE_CODE_MESSAGING_TOKEN: 'parent-token',
  CLAUDE_CODE_SESSION_ATTENDED: '1',
  CLAUDE_CODE_SOME_FUTURE_SESSION_VAR: 'x',
  CODEX_SANDBOX: 'seatbelt',
  CODEX_SANDBOX_NETWORK_DISABLED: '1',
  CODEX_THREAD_ID: 'parent-thread',
  CODEX_SESSION_ID: 'parent-session',
  CODEX_ESCALATE_SOCKET: '/tmp/escalate.sock',
  CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN: 'parent-noise-token',
}
/** The user's own settings that share the prefixes and must survive. */
const USER_SETTINGS = { CLAUDE_CODE_OAUTH_TOKEN: 'user-oauth', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CODEX_API_KEY: 'user-codex-key', CODEX_CA_CERTIFICATE: '/etc/ca.pem' }

function withFake(fake: FakeRuntime, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  process.env['PATH'] = `${fake.binDir}${path.delimiter}${originalPath ?? ''}`
  return { ...process.env, PATH: process.env['PATH'], FAKE_RUNTIME_RECORD: fake.recordPath, ...extra }
}

describe('a run carries nothing of the session that started it (every profile, both runtimes)', () => {
  it('the rule: every CLAUDE_CODE_* but the documented user settings, CLAUDE_PID and the other session markers, the Codex session markers', () => {
    for (const key of Object.keys(PARENT_SESSION)) expect(isParentSessionEnv(key), key).toBe(true)
    for (const key of Object.keys(USER_SETTINGS)) expect(isParentSessionEnv(key), key).toBe(false)
    for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PATH', 'HOME', 'AGENTCHAT_RUN_PROFILE']) expect(isParentSessionEnv(key), key).toBe(false)
    expect(isParentSessionEnv('claude_code_messaging_token')).toBe(true) // Windows names are case-insensitive
    const out = withoutParentSession({ ...PARENT_SESSION, ...USER_SETTINGS, PATH: '/bin' })
    expect(Object.keys(out).sort()).toEqual([...Object.keys(USER_SETTINGS), 'PATH'].sort())
  })

  for (const profile of ['answer', 'work', 'full'] as const) {
    it(`claude-code ${profile}: the run's environment`, async () => {
      const fake = installFakeClaude(sandbox)
      const env = withFake(fake, { ...PARENT_SESSION, ...USER_SETTINGS, CLAUDE_CONFIG_DIR: path.join(sandbox, '.claude') })
      const runner = new ClaudeRunner({
        configDir: path.join(sandbox, '.claude'),
        workdir: path.join(sandbox, 'work'),
        profile,
        denyReadPaths: [home],
        answerMcp: { file: path.join(home, 'presets', 'claude-code.mcp.json'), apiBase: 'https://api.example', apiKey: () => KEY },
        env,
      })
      expect(await runner.preflight()).toEqual({ ok: true })
      expect((await runner.start(request)).state).toBe('ok')
      const [run] = readFakeRuns(fake)
      for (const key of Object.keys(PARENT_SESSION)) expect(run?.env[key], key).toBeUndefined()
      for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']) expect(run?.env[key], key).toBeDefined()
      expect(run?.env['CLAUDE_CODE_MCP_STARTUP_WAIT_MS']).toBe('15000')
    }, 20_000)

    it(`codex ${profile}: the run's environment`, async () => {
      const fake = installFakeCodex(sandbox)
      const env = withFake(fake, { ...PARENT_SESSION, ...USER_SETTINGS })
      const runner = new CodexRunner({ codexHome: path.join(sandbox, '.codex'), workdir: path.join(sandbox, 'work'), profile, apiKey: () => KEY, keyEnv: 'AGENTCHAT_LISTENER_API_KEY', env })
      expect(await runner.preflight()).toEqual({ ok: true })
      expect((await runner.start(request)).state).toBe('ok')
      const [run] = readFakeRuns(fake)
      for (const key of Object.keys(PARENT_SESSION)) expect(run?.env[key], key).toBeUndefined()
      for (const key of ['CODEX_API_KEY', 'CODEX_CA_CERTIFICATE', 'CLAUDE_CODE_OAUTH_TOKEN']) expect(run?.env[key], key).toBeDefined()
      expect(run?.env['CODEX_HOME']).toBe(path.join(sandbox, '.codex'))
      expect(run?.env['AGENTCHAT_LISTENER_API_KEY']).toBe(KEY)
    }, 20_000)
  }
})

describe('Claude Code answer: the AgentChat server only (--strict-mcp-config with an AgentChat-only file)', () => {
  const options = (fake: FakeRuntime, extra: Partial<ClaudeRunnerOptions> = {}): ClaudeRunnerOptions => ({
    configDir: path.join(sandbox, '.claude'),
    workdir: path.join(sandbox, 'work'),
    profile: 'answer',
    denyReadPaths: [home],
    env: withFake(fake, { CLAUDE_CONFIG_DIR: path.join(sandbox, '.claude') }),
    ...extra,
  })
  const file = (): string => path.join(home, 'presets', 'claude-code.mcp.json')

  it('without an AgentChat-only tool config an answer run does not start (it would load every server the user registered); work and full need none', async () => {
    const fake = installFakeClaude(sandbox)
    expect(await new ClaudeRunner(options(fake)).preflight()).toMatchObject({ ok: false, detail: expect.stringMatching(/AgentChat-only tool config/) })
    expect(await new ClaudeRunner(options(fake)).start(request)).toMatchObject({ state: 'not_started' })
    expect(readFakeRuns(fake)).toEqual([])
    for (const profile of ['work', 'full'] as const) {
      const runner = new ClaudeRunner(options(fake, { profile }))
      expect(await runner.preflight()).toEqual({ ok: true })
      expect(runner.args()).not.toContain('--strict-mcp-config')
    }
  }, 20_000)

  it('the file must sit inside a denied path: it holds the key', async () => {
    const fake = installFakeClaude(sandbox)
    const runner = new ClaudeRunner(options(fake, { answerMcp: { file: path.join(sandbox, 'elsewhere.mcp.json'), apiBase: 'https://api.example', apiKey: () => KEY } }))
    expect(await runner.preflight()).toMatchObject({ ok: false, detail: expect.stringMatching(/holds the key/) })
  }, 20_000)

  it('each run: the file written owner-only with the AgentChat server alone, strict, removed after; the key never on argv', async () => {
    const fake = installFakeClaude(sandbox)
    let key: string | null = KEY
    const runner = new ClaudeRunner(options(fake, { answerMcp: { file: file(), apiBase: 'https://api.example', apiKey: () => key, clientVersion: '9.9.9' } }))
    expect(await runner.preflight()).toEqual({ ok: true })
    const args = runner.args()
    const at = args.indexOf('--mcp-config')
    expect(args.slice(at, at + 3)).toEqual(['--mcp-config', file(), '--strict-mcp-config'])
    expect((await runner.start(request)).state).toBe('ok')
    const [run] = readFakeRuns(fake)
    expect(run?.mcpConfig).toEqual({ servers: ['agentchat'], mode: posix ? 0o600 : expect.any(Number) })
    expect(run?.argv).toContain('--strict-mcp-config')
    expect(JSON.stringify(run?.argv)).not.toContain(KEY)
    expect(fs.existsSync(file())).toBe(false)
    // No key: no run.
    key = null
    expect(await runner.start(request)).toMatchObject({ state: 'not_started', detail: expect.stringMatching(/no AgentChat key/) })
    expect(readFakeRuns(fake)).toHaveLength(1)
  }, 20_000)

  it('work and full keep the user\'s servers: answerMcp is for answer runs only', async () => {
    const fake = installFakeClaude(sandbox)
    for (const profile of ['work', 'full'] as const) {
      const runner = new ClaudeRunner(options(fake, { profile, answerMcp: { file: file(), apiBase: 'https://api.example', apiKey: () => KEY } }))
      expect(runner.args()).not.toContain('--mcp-config')
      expect(await runner.preflight()).toEqual({ ok: true })
      expect((await runner.start(request)).state).toBe('ok')
    }
    expect(readFakeRuns(fake).map((r) => r.mcpConfig)).toEqual([null, null])
  }, 20_000)
})

describe('Codex answer: every MCP server but AgentChat\'s switched off per run, or no run', () => {
  const listRecord = (): string => path.join(sandbox, 'mcp-list.jsonl')
  const options = (fake: FakeRuntime, extra: Record<string, string> = {}, more: Partial<CodexRunnerOptions> = {}): CodexRunnerOptions => ({
    codexHome: path.join(sandbox, '.codex'),
    workdir: path.join(sandbox, 'work'),
    profile: 'answer',
    apiKey: () => KEY,
    keyEnv: 'AGENTCHAT_LISTENER_API_KEY',
    mcp: { url: 'https://api.example/mcp', keyEnv: 'AGENTCHAT_LISTENER_API_KEY' },
    env: withFake(fake, { FAKE_MCP_LIST_RECORD: listRecord(), ...extra }),
    ...more,
  })

  it('parses names only, enabled ones; refuses output that is not the list', () => {
    expect(parseCodexMcpList('[{"name":"agentchat","enabled":true},{"name":"fs","enabled":true,"transport":{"env":{"TOKEN":"secret"}}},{"name":"off","enabled":false}]')).toEqual({ ok: true, names: ['agentchat', 'fs'] })
    expect(parseCodexMcpList('not json')).toMatchObject({ ok: false })
    expect(parseCodexMcpList('{"servers":[]}')).toMatchObject({ ok: false })
    expect(parseCodexMcpList('[{"enabled":true}]')).toMatchObject({ ok: false })
    expect(codexMcpDisableArgs(['agentchat', 'fs', 'gh-mcp', 'a@b:c/d'])).toEqual({ ok: true, args: ['-c', 'mcp_servers.fs.enabled=false', '-c', 'mcp_servers.gh-mcp.enabled=false', '-c', 'mcp_servers.a@b:c/d.enabled=false'] })
    // A "." is read as a table separator, an "=" as the value: such a server cannot be switched off for one run.
    for (const name of ['my.server', 'a=b', 'sp ace']) expect(codexMcpDisableArgs(['agentchat', name])).toMatchObject({ ok: false })
  })

  it('asks Codex itself, with the run\'s own flags and workdir, and switches off every other enabled server before the prompt', async () => {
    const fake = installFakeCodex(sandbox)
    const list = JSON.stringify([
      { name: 'agentchat', enabled: true },
      { name: 'filesystem', enabled: true },
      { name: 'github', enabled: true },
      { name: 'parked', enabled: false },
    ])
    const runner = new CodexRunner(options(fake, { FAKE_MCP_LIST: list, ...PARENT_SESSION }))
    expect(await runner.preflight()).toEqual({ ok: true })
    expect((await runner.start(request)).state).toBe('ok')
    const [listed] = readFakeMcpLists(listRecord())
    const runArgs = runner.args()
    // Every -c / --disable pair the run has, nothing else.
    const flags = runArgs.flatMap((a, i) => (runArgs[i - 1] === '-c' || runArgs[i - 1] === '--disable' ? [runArgs[i - 1], a] : []))
    expect(listed?.argv).toEqual(['mcp', 'list', '--json', ...flags])
    expect(listed?.argv).toContain('mcp_servers.agentchat.url="https://api.example/mcp"')
    expect(fs.realpathSync(listed?.cwd ?? '')).toBe(fs.realpathSync(path.join(sandbox, 'work')))
    expect(listed?.env['CODEX_SANDBOX']).toBeUndefined()
    const [run] = readFakeRuns(fake)
    expect(run?.argv.slice(-5)).toEqual(['-c', 'mcp_servers.filesystem.enabled=false', '-c', 'mcp_servers.github.enabled=false', '-'])
    expect(run?.argv.join(' ')).not.toContain('mcp_servers.parked')
    expect(run?.argv.join(' ')).not.toContain('mcp_servers.agentchat.enabled')
  }, 20_000)

  for (const [mode, why] of [
    ['fail', /exited 1/],
    ['garbage', /not JSON/],
    ['hang', /no answer within/],
  ] as const) {
    it(`a listing that ${mode === 'fail' ? 'fails' : mode === 'garbage' ? 'is not the list' : 'never answers'}: no run (fail closed, with the reason)`, async () => {
      const fake = installFakeCodex(sandbox)
      const runner = new CodexRunner(options(fake, { FAKE_MCP_LIST_MODE: mode }, { mcpListTimeoutMs: 1_500 }))
      // Said at preflight (status shows it as the last error), and every run is refused too.
      const pre = await runner.preflight()
      expect(pre.ok).toBe(false)
      expect(pre.detail).toMatch(why)
      const outcome = await runner.start(request)
      expect(outcome.state).toBe('not_started')
      expect(outcome.detail).toMatch(why)
      expect(outcome.detail).toMatch(/an answer run starts only with every server but agentchat switched off/)
      expect(readFakeRuns(fake)).toEqual([])
    }, 20_000)
  }

  it('a server whose name no -c key can address: no run', async () => {
    const fake = installFakeCodex(sandbox)
    const runner = new CodexRunner(options(fake, { FAKE_MCP_LIST: JSON.stringify([{ name: 'agentchat', enabled: true }, { name: 'my.server', enabled: true }]) }))
    expect(await runner.preflight()).toMatchObject({ ok: false, detail: expect.stringMatching(/"my\.server" cannot be switched off/) })
    expect(await runner.start(request)).toMatchObject({ state: 'not_started', detail: expect.stringMatching(/"my\.server" cannot be switched off/) })
    expect(readFakeRuns(fake)).toEqual([])
  }, 20_000)

  it('work and full: no listing, the user\'s servers as before', async () => {
    const fake = installFakeCodex(sandbox)
    for (const profile of ['work', 'full'] as const) {
      const runner = new CodexRunner({ ...options(fake), profile })
      expect(await runner.preflight()).toEqual({ ok: true })
      expect((await runner.start(request)).state).toBe('ok')
    }
    expect(readFakeMcpLists(listRecord())).toEqual([])
    expect(readFakeRuns(fake).every((r) => !r.argv.join(' ').includes('.enabled=false'))).toBe(true)
  }, 20_000)
})

describe('the home folder is no answer run\'s workdir', () => {
  it('workdirExposesHome: the home folder, any folder above it and the root; not a folder inside it or a look-alike beside it', () => {
    const user = path.join(sandbox, 'Users', 'alice')
    fs.mkdirSync(path.join(user, 'project'), { recursive: true })
    fs.mkdirSync(path.join(sandbox, 'Users', 'alice2'), { recursive: true })
    expect(workdirExposesHome(user, user)).toBe(true)
    expect(workdirExposesHome(path.join(sandbox, 'Users'), user)).toBe(true)
    expect(workdirExposesHome(path.parse(sandbox).root, user)).toBe(true)
    expect(workdirExposesHome(path.join(user, 'project'), user)).toBe(false)
    expect(workdirExposesHome(path.join(sandbox, 'Users', 'alice2'), user)).toBe(false)
    if (posix) {
      fs.symlinkSync(user, path.join(sandbox, 'link-to-home'))
      expect(workdirExposesHome(path.join(sandbox, 'link-to-home'), user)).toBe(true)
    }
  })

  it.skipIf(!posix)('claude-code: an answer run started with the home folder as workdir works in its own empty folder; work keeps the operator\'s choice', async () => {
    const fake = installFakeClaude(sandbox)
    const fakeHome = path.join(sandbox, 'user-home')
    fs.mkdirSync(fakeHome)
    process.env['HOME'] = fakeHome
    const configDir = path.join(sandbox, '.claude')
    const base = { configDir, workdir: fakeHome, denyReadPaths: [home], env: withFake(fake, { CLAUDE_CONFIG_DIR: configDir }), answerMcp: { file: path.join(home, 'p.mcp.json'), apiBase: 'https://api.example', apiKey: () => KEY } }
    const answer = new ClaudeRunner({ ...base, profile: 'answer' })
    expect(answer.workdir()).toBe(claudeAnswerFallbackWorkdir(configDir))
    expect(await answer.preflight()).toEqual({ ok: true })
    expect((await answer.start(request)).state).toBe('ok')
    const work = new ClaudeRunner({ ...base, profile: 'work' })
    expect(work.workdir()).toBe(fakeHome)
    expect(await work.preflight()).toEqual({ ok: true })
    expect((await work.start(request)).state).toBe('ok')
    const [answerRun, workRun] = readFakeRuns(fake)
    expect(fs.realpathSync(answerRun?.cwd ?? '')).toBe(fs.realpathSync(claudeAnswerFallbackWorkdir(configDir)))
    const allowed = answerRun?.argv[(answerRun?.argv.indexOf('--allowedTools') ?? 0) + 1] ?? ''
    expect(allowed).toContain(`Read(/${claudeAnswerFallbackWorkdir(configDir)}/**)`)
    expect(allowed).not.toContain(`Read(/${fakeHome}/**)`)
    expect(fs.readdirSync(claudeAnswerFallbackWorkdir(configDir))).toEqual([])
    expect(fs.realpathSync(workRun?.cwd ?? '')).toBe(fs.realpathSync(fakeHome))
  }, 20_000)

  it.skipIf(!posix)('codex: the same for -C', async () => {
    const fake = installFakeCodex(sandbox)
    const fakeHome = path.join(sandbox, 'user-home')
    fs.mkdirSync(fakeHome)
    process.env['HOME'] = fakeHome
    const codexHome = path.join(sandbox, '.codex')
    const base = { codexHome, workdir: path.dirname(fakeHome), apiKey: () => KEY, keyEnv: 'AGENTCHAT_LISTENER_API_KEY', env: withFake(fake) }
    const answer = new CodexRunner({ ...base, profile: 'answer' })
    expect(await answer.preflight()).toEqual({ ok: true })
    expect((await answer.start(request)).state).toBe('ok')
    const full = new CodexRunner({ ...base, profile: 'full' })
    expect(await full.preflight()).toEqual({ ok: true })
    expect((await full.start(request)).state).toBe('ok')
    const [answerRun, fullRun] = readFakeRuns(fake)
    expect(answerRun?.argv[(answerRun?.argv.indexOf('-C') ?? 0) + 1]).toBe(codexAnswerFallbackWorkdir(codexHome))
    expect(fullRun?.argv[(fullRun?.argv.indexOf('-C') ?? 0) + 1]).toBe(path.dirname(fakeHome))
  }, 20_000)

  it('status warns when the workdir is the home folder or above it', () => {
    const base: IntegrationStatus = {
      version: 2, updated_at: new Date().toISOString(), pid: 1, runtime: 'fake', handle: 'h', profile: 'answer', socket: 'ready',
      wakes: 0, wakes_absorbed: 0, invites: 0, runs_started: 0, runs_ok: 0, runs_failed: 0, runs_timed_out: 0, runs_not_started: 0, runs_skipped_empty: 0,
      last_run: null, retry_rung: 0, last_error: null, texts: null,
    } as IntegrationStatus
    const at = (workdir: string, profile = 'answer'): string => formatIntegrationStatus({ ...base, profile, workdir }).join('\n')
    expect(at(os.homedir())).toContain(`workdir: ${os.homedir()} is your home folder or contains it`)
    expect(at(os.homedir())).toContain("the presets' answer runs use their own empty folder instead")
    expect(at(path.parse(os.homedir()).root, 'work')).toContain('is your home folder or contains it — a run started by a peer')
    expect(at(path.parse(os.homedir()).root, 'work')).not.toContain('their own empty folder')
    expect(at(path.join(os.homedir(), 'projects', 'agent'))).not.toContain('workdir:')
    expect(formatIntegrationStatus(base).join('\n')).not.toContain('workdir:')
  })
})
