import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  ClaudeRunner,
  CodexRunner,
  LISTENER_KEY_ENV,
  RUNTIME_CHECK_PROMPT,
  RUNTIME_CHECK_SETTINGS,
  claudeCodePreset,
  claudeRuntimeCheckArgs,
  claudeRuntimeCheckJudge,
  claudeRuntimeCheckWorkdir,
  CODEX_ANSWER_DISABLED_FEATURES,
  CODEX_RUNTIME_CHECK_DISABLED_FEATURES,
  codexPreset,
  codexRuntimeCheckArgs,
  codexRuntimeCheckWorkdir,
  runRuntimeCheck,
} from '../src/presets/index.js'
import { installFakeClaude, installFakeCodex, readFakeRuns, type FakeRuntime } from './helpers/fake-runtimes.js'

// ─── The presets' runtime check: a minimal model call, nothing more ─────────
//
// After a conversation's run failed, the kit asks the runner whether the
// runtime works; `ok` makes the failure that conversation's. So the check is
// a real headless run of the runtime — the same binary and environment as the
// runs — with a fixed prompt, no peer content, no AgentChat tools, in an empty
// folder of its own, its output discarded, and stopped (its process killed)
// when asked to. The fake binaries record what they were started with.

const posix = process.platform !== 'win32'
const KEY = 'ac_live_' + 'k'.repeat(40)

let sandbox: string
let home: string
const originalPath = process.env['PATH']
beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-check-'))
  home = path.join(sandbox, 'home')
  fs.mkdirSync(home, { recursive: true })
})
afterEach(() => {
  process.env['PATH'] = originalPath
  fs.rmSync(sandbox, { recursive: true, force: true })
})

/** The fake on PATH, and the environment the runner's runs inherit — with a key in it that must not reach the check. */
const withFake = (fake: FakeRuntime, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  process.env['PATH'] = `${fake.binDir}${path.delimiter}${originalPath ?? ''}`
  return {
    ...process.env,
    FAKE_RUNTIME_RECORD: fake.recordPath,
    CLAUDE_CONFIG_DIR: path.join(sandbox, '.claude'),
    CODEX_HOME: path.join(sandbox, '.codex'),
    AGENTCHAT_API_KEY: KEY,
    [LISTENER_KEY_ENV]: KEY,
    ...extra,
  }
}

const real = (p: string): string => fs.realpathSync(p)

/** True once `pid` is gone. */
function gone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

async function eventually(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return cond()
}

describe('Claude Code: one `claude -p` with no tool of any kind', () => {
  it('the flags, pinned: no MCP server (strict, no config), no built-in tool, no hooks, never waiting; the key-store deny rules as on every run', () => {
    expect(claudeRuntimeCheckArgs(['/h', '/c/.claude.json'])).toEqual([
      '-p', '--output-format', 'json', '--no-session-persistence',
      '--strict-mcp-config',
      '--tools', '',
      '--permission-prompts', 'none',
      '--settings', RUNTIME_CHECK_SETTINGS,
      ...(posix ? ['--disallowedTools', 'Read(//h),Read(//h/**),Read(//c/.claude.json),Read(//c/.claude.json/**)'] : []),
    ])
    // No hooks; CLAUDE.md and memory off again in the settings, as ANSWER_SETTINGS does (a settings file's env wins over the process's).
    expect(JSON.parse(RUNTIME_CHECK_SETTINGS)).toEqual({ env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }, disableAllHooks: true })
    expect(claudeRuntimeCheckArgs()).not.toContain('--mcp-config')
  })

  for (const profile of ['own', 'answer', 'work', 'full'] as const) {
    it(`${profile}: the listener's runner checks with the run's binary and environment, in its own empty folder, with the fixed prompt on stdin and no key anywhere`, async () => {
      const fake = installFakeClaude(sandbox)
      const env = withFake(fake)
      const runner = claudeCodePreset.runner({ home, workdir: path.join(sandbox, 'work'), profile, apiKey: KEY, apiBase: 'https://api.example', env })
      expect(runner.checkRuntime).toBeTypeOf('function')
      expect(await runner.checkRuntime!()).toEqual({ ok: true })
      const [check] = readFakeRuns(fake)
      expect(check?.stdin).toBe(RUNTIME_CHECK_PROMPT)
      expect(check?.argv.slice(0, 9)).toEqual(['-p', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config', '--tools', '', '--permission-prompts', 'none'])
      expect(check?.argv).not.toContain('--mcp-config')
      expect(check?.argv).not.toContain('--allowedTools')
      expect(check?.mcpConfig).toBeNull()
      expect(real(check?.cwd ?? '')).toBe(real(claudeRuntimeCheckWorkdir(path.join(sandbox, '.claude'))))
      expect(fs.readdirSync(claudeRuntimeCheckWorkdir(path.join(sandbox, '.claude')))).toEqual([])
      // No key in its environment, whatever the daemon inherited; no instruction file or memory in its context.
      expect(JSON.stringify(check?.env)).not.toContain(KEY)
      expect(check?.env['CLAUDE_CODE_DISABLE_CLAUDE_MDS']).toBe('1')
      expect(check?.env['CLAUDE_CODE_DISABLE_AUTO_MEMORY']).toBe('1')
      expect(check?.env['CLAUDE_CONFIG_DIR']).toBe(path.join(sandbox, '.claude'))
      if (posix) expect(check?.argv.at(-1)).toContain(`Read(/${home})`)
    }, 20_000)
  }

  it('a provider that refuses (exit 1 after its error) and a run that prints nothing are not ok; the diagnostic is the redacted stderr, never the output', async () => {
    const fake = installFakeClaude(sandbox)
    const runner = new ClaudeRunner({ configDir: path.join(sandbox, '.claude'), workdir: path.join(sandbox, 'w'), profile: 'own', denyReadPaths: [home], env: withFake(fake, { FAKE_RUNTIME_RUN_MODE: 'fail' }) })
    const failed = await runner.checkRuntime()
    expect(failed.ok).toBe(false)
    expect(failed.detail).toMatch(/^claude runtime check failed: exit 1: API Error: the provider refused this request$/)
    expect(failed.detail).not.toContain('must be discarded')

    const silent = new ClaudeRunner({ configDir: path.join(sandbox, '.claude'), workdir: path.join(sandbox, 'w'), profile: 'own', denyReadPaths: [home], env: withFake(fake, { FAKE_RUNTIME_RUN_MODE: 'silent' }) })
    expect(await silent.checkRuntime()).toEqual({ ok: false, detail: 'claude runtime check failed: exit 0 with nothing on stdout' })
  }, 20_000)

  it('exit 0 is not enough: an error result (a usage limit, a low balance, an expired sign-in) or plain text is not ok, and its text is never in the detail', async () => {
    const fake = installFakeClaude(sandbox)
    const runner = (mode: string): ClaudeRunner =>
      new ClaudeRunner({ configDir: path.join(sandbox, '.claude'), workdir: path.join(sandbox, 'w'), profile: 'own', denyReadPaths: [home], env: withFake(fake, { FAKE_RUNTIME_RUN_MODE: mode }) })
    const errored = await runner('error_exit0').checkRuntime()
    expect(errored).toEqual({
      ok: false,
      detail: 'claude runtime check failed: exit 0, but the result is not a success (type result, subtype success, is_error true, api_error_status 400, terminal_reason api_error)',
    })
    const text = await runner('text').checkRuntime()
    expect(text).toEqual({ ok: false, detail: 'claude runtime check failed: exit 0, but its answer is not a JSON result' })
    for (const r of [errored, text]) expect(r.detail).not.toContain('must be discarded')
  }, 20_000)

  it('the judge: success means type result, subtype success and is_error false — as Claude Code 2.1.328 prints them', () => {
    // Shapes as seen against a stand-in provider (texts shortened): an answer, and an API error, which is
    // `subtype: "success"` with `is_error: true` — so the subtype alone says nothing.
    const answer = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, api_error_status: null, terminal_reason: 'completed', num_turns: 1, result: 'OK', session_id: 's' })
    const apiError = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 401, api_error_type: 'authentication_error', terminal_reason: 'api_error', result: 'Invalid API key · Fix external API key' })
    expect(claudeRuntimeCheckJudge(`${answer}\n`)).toBeNull()
    expect(claudeRuntimeCheckJudge(apiError)).toBe('the result is not a success (type result, subtype success, is_error true, api_error_status 401, terminal_reason api_error)')
    expect(claudeRuntimeCheckJudge(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true }))).toBe('the result is not a success (type result, subtype error_during_execution, is_error true)')
    expect(claudeRuntimeCheckJudge(JSON.stringify({ type: 'result', subtype: 'success' }))).toBe('the result is not a success (type result, subtype success, is_error ?)')
    expect(claudeRuntimeCheckJudge('OK')).toBe('its answer is not a JSON result')
    expect(claudeRuntimeCheckJudge('[1]')).toBe('its answer is not a JSON result')
    // A line before the result (a warning) does not hide it.
    expect(claudeRuntimeCheckJudge(`a warning\n${answer}`)).toBeNull()
    expect(claudeRuntimeCheckJudge(apiError)).not.toContain('Invalid API key')
  })

  it('a check that hangs is stopped when its signal aborts: the process is killed and the answer is not ok', async () => {
    const fake = installFakeClaude(sandbox)
    const pids = path.join(sandbox, 'pids.json')
    const runner = new ClaudeRunner({
      configDir: path.join(sandbox, '.claude'),
      workdir: path.join(sandbox, 'w'),
      profile: 'own',
      denyReadPaths: [home],
      env: withFake(fake, { FAKE_RUNTIME_RUN_MODE: 'hang', FAKE_RUNTIME_RUN_PIDS: pids }),
    })
    const controller = new AbortController()
    const started = Date.now()
    const answer = runner.checkRuntime({ signal: controller.signal })
    expect(await eventually(() => fs.existsSync(pids) && fs.statSync(pids).size > 0, 10_000)).toBe(true)
    controller.abort()
    const result = await answer
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/^claude runtime check failed: interrupted/)
    expect(Date.now() - started).toBeLessThan(20_000)
    const [pid] = JSON.parse(fs.readFileSync(pids, 'utf-8')) as number[]
    expect(await eventually(() => gone(pid!), 10_000)).toBe(true)
  }, 30_000)

  it('already stopped: nothing is started', async () => {
    const fake = installFakeClaude(sandbox)
    const runner = new ClaudeRunner({ configDir: path.join(sandbox, '.claude'), workdir: path.join(sandbox, 'w'), profile: 'own', denyReadPaths: [home], env: withFake(fake) })
    const controller = new AbortController()
    controller.abort()
    expect(await runner.checkRuntime({ signal: controller.signal })).toEqual({ ok: false, detail: 'claude runtime check: stopped before it started' })
    expect(readFakeRuns(fake)).toHaveLength(0)
  })
})

describe('Codex: one `codex exec` in an empty folder, read-only, with the AgentChat server switched off', () => {
  it('the flags, pinned: the runs\' URL keeps the agentchat table valid, and `enabled=false` switches it off', () => {
    expect(codexRuntimeCheckArgs('/c/check', 'https://api.example/mcp')).toEqual([
      'exec', '--json', '--skip-git-repo-check', '--ephemeral', '-C', '/c/check',
      '--sandbox', 'read-only',
      '-c', 'model_reasoning_effort="low"',
      '-c', 'web_search="disabled"',
      '--disable', 'memories', '--disable', 'plugins', '--disable', 'apps',
      '-c', 'mcp_servers.agentchat.url="https://api.example/mcp"',
      '-c', 'mcp_servers.agentchat.enabled=false',
      '-',
    ])
    // Without a URL (config.toml defines the table, as such runs need), only the switch.
    expect(codexRuntimeCheckArgs('/c/check')).toEqual([
      'exec', '--json', '--skip-git-repo-check', '--ephemeral', '-C', '/c/check', '--sandbox', 'read-only',
      '-c', 'model_reasoning_effort="low"', '-c', 'web_search="disabled"',
      '--disable', 'memories', '--disable', 'plugins', '--disable', 'apps',
      '-c', 'mcp_servers.agentchat.enabled=false', '-',
    ])
    // The same features an answer run turns off, at the 0.154.0 floor.
    expect(CODEX_RUNTIME_CHECK_DISABLED_FEATURES).toEqual(['memories', 'plugins', 'apps'])
    for (const feature of CODEX_RUNTIME_CHECK_DISABLED_FEATURES) expect(CODEX_ANSWER_DISABLED_FEATURES).toContain(feature)
  })

  for (const profile of ['own', 'answer', 'work', 'full'] as const) {
    it(`${profile}: the listener's runner checks with the run's binary and CODEX_HOME, no key in its environment, the fixed prompt on stdin`, async () => {
      const fake = installFakeCodex(sandbox)
      const env = withFake(fake)
      const runner = codexPreset.runner({ home, workdir: path.join(sandbox, 'work'), profile, apiKey: KEY, apiBase: 'https://api.example', env })
      expect(await runner.checkRuntime!()).toEqual({ ok: true })
      const [check] = readFakeRuns(fake)
      const dir = codexRuntimeCheckWorkdir(path.join(sandbox, '.codex'))
      expect(check?.argv).toEqual(codexRuntimeCheckArgs(dir, 'https://api.example/mcp'))
      expect(check?.stdin).toBe(RUNTIME_CHECK_PROMPT)
      expect(real(check?.cwd ?? '')).toBe(real(dir))
      expect(check?.env['CODEX_HOME']).toBe(path.join(sandbox, '.codex'))
      expect(JSON.stringify(check?.env)).not.toContain(KEY)
      expect(check?.env[LISTENER_KEY_ENV]).toBeUndefined()
      // No `mcp list` is needed for it, whatever the profile.
      expect(readFakeRuns(fake)).toHaveLength(1)
    }, 20_000)
  }

  it('an integration\'s runner (the URL pinned) checks with that URL; a refused runner checks nothing', async () => {
    const fake = installFakeCodex(sandbox)
    const env = withFake(fake)
    const base = { codexHome: path.join(sandbox, '.codex'), workdir: path.join(sandbox, 'work'), profile: 'own' as const, apiKey: () => KEY, keyEnv: 'AGENTCHAT_API_KEY', env }
    const pinned = new CodexRunner({ ...base, pinMcpUrl: 'https://api.example/mcp' })
    expect(await pinned.checkRuntime()).toEqual({ ok: true })
    expect(readFakeRuns(fake)[0]?.argv).toContain('mcp_servers.agentchat.url="https://api.example/mcp"')
    const refused = new CodexRunner({ ...base, refuse: 'no run may start: the reason' })
    expect(await refused.checkRuntime()).toEqual({ ok: false, detail: 'no run may start: the reason' })
    expect(readFakeRuns(fake)).toHaveLength(1)
  }, 20_000)

  it('a provider error (exit 1) is not ok', async () => {
    const fake = installFakeCodex(sandbox)
    const runner = new CodexRunner({ codexHome: path.join(sandbox, '.codex'), workdir: path.join(sandbox, 'w'), profile: 'own', apiKey: () => null, keyEnv: 'AGENTCHAT_API_KEY', pinMcpUrl: 'https://api.example/mcp', env: withFake(fake, { FAKE_RUNTIME_RUN_MODE: 'fail' }) })
    const result = await runner.checkRuntime()
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/^codex runtime check failed: exit 1/)
  }, 20_000)
})

describe('runRuntimeCheck: bounded by its own budget', () => {
  it('past the budget the probe is killed and the answer is timed out', async () => {
    const fake = installFakeClaude(sandbox)
    const pids = path.join(sandbox, 'pids.json')
    const env = withFake(fake, { FAKE_RUNTIME_RUN_MODE: 'hang', FAKE_RUNTIME_RUN_PIDS: pids })
    const result = await runRuntimeCheck({ label: 'claude', command: 'claude', args: ['-p'], cwd: path.join(sandbox, 'check'), env, budgetMs: 1_500 })
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/^claude runtime check timed out: run exceeded its 2 s budget and was killed/)
    const [pid] = JSON.parse(fs.readFileSync(pids, 'utf-8')) as number[]
    expect(await eventually(() => gone(pid!), 10_000)).toBe(true)
  }, 30_000)
})
