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
  claudeRuntimeCheckWorkdir,
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
      '-p', '--output-format', 'text', '--no-session-persistence',
      '--strict-mcp-config',
      '--tools', '',
      '--permission-prompts', 'none',
      '--settings', '{"disableAllHooks":true}',
      ...(posix ? ['--disallowedTools', 'Read(//h),Read(//h/**),Read(//c/.claude.json),Read(//c/.claude.json/**)'] : []),
    ])
    expect(JSON.parse(RUNTIME_CHECK_SETTINGS)).toEqual({ disableAllHooks: true })
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
      expect(check?.argv.slice(0, 9)).toEqual(['-p', '--output-format', 'text', '--no-session-persistence', '--strict-mcp-config', '--tools', '', '--permission-prompts', 'none'])
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
      '-c', 'mcp_servers.agentchat.url="https://api.example/mcp"',
      '-c', 'mcp_servers.agentchat.enabled=false',
      '-',
    ])
    // Without a URL (config.toml defines the table, as such runs need), only the switch.
    expect(codexRuntimeCheckArgs('/c/check')).toEqual(['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-C', '/c/check', '--sandbox', 'read-only', '-c', 'mcp_servers.agentchat.enabled=false', '-'])
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
