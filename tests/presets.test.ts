import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  PRESETS,
  claudeCodePreset,
  claudeMcpConfigPath,
  claudeRunArgs,
  codexPreset,
  codexRunArgs,
  deniedAncestorOf,
  presetNamed,
  readDenyRules,
  LISTENER_KEY_ENV,
} from '../src/presets/index.js'
import { installFakeClaude, installFakeCodex, readFakeRuns, type FakeRuntime } from './helpers/fake-runtimes.js'

// ─── Presets: the exact flags per profile, and runs that act as the given agent ─

const KEY = 'ac_live_' + 'k'.repeat(40)
let sandbox: string
let home: string
let workdir: string
const originalPath = process.env['PATH']

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-presets-'))
  home = path.join(sandbox, 'home')
  workdir = path.join(sandbox, 'work')
  fs.mkdirSync(home, { recursive: true })
})
afterEach(() => {
  process.env['PATH'] = originalPath
  fs.rmSync(sandbox, { recursive: true, force: true })
})

const withFake = (fake: FakeRuntime): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: `${fake.binDir}${path.delimiter}${originalPath ?? ''}`,
  FAKE_RUNTIME_RECORD: fake.recordPath,
  CLAUDE_CONFIG_DIR: path.join(sandbox, '.claude'),
  CODEX_HOME: path.join(sandbox, '.codex'),
})

describe('the registry', () => {
  it('names each preset once; an unknown name is null (never a prototype key)', () => {
    expect(Object.keys(PRESETS).sort()).toEqual(['claude-code', 'codex'])
    expect(presetNamed('claude-code')).toBe(claudeCodePreset)
    expect(presetNamed('constructor')).toBeNull()
    expect(presetNamed('nope')).toBeNull()
  })
})

describe('Claude Code flags (pinned: the integration and the listener share them)', () => {
  it('answer: read-only built-ins + web + every hosted tool, prompts denied, Manual mode', () => {
    expect(claudeRunArgs('answer')).toEqual([
      '-p', '--output-format', 'text', '--no-session-persistence',
      '--permission-mode', 'default', '--permission-prompts', 'none',
      '--tools', 'Read,Glob,Grep,WebSearch,WebFetch',
      '--allowedTools', 'mcp__agentchat__*,Read,Glob,Grep,WebSearch,WebFetch',
    ])
  })

  it('work and full', () => {
    expect(claudeRunArgs('work')).toContain('acceptEdits')
    expect(claudeRunArgs('work').join(' ')).toContain('mcp__agentchat__*,Read,Glob,Grep,WebSearch,WebFetch,Bash,Edit,Write,MultiEdit,NotebookEdit')
    expect(claudeRunArgs('full')).toEqual(['-p', '--output-format', 'text', '--no-session-persistence', '--dangerously-skip-permissions', '--permission-prompts', 'none', '--allowedTools', 'mcp__agentchat__*'])
  })

  it('an --mcp-config file is closed by --strict-mcp-config, before the profile; deny rules come last', () => {
    const args = claudeRunArgs('answer', { mcpConfigPath: '/h/presets/claude-code.mcp.json', denyReadPaths: ['/h'] })
    const at = args.indexOf('--mcp-config')
    expect(args.slice(at, at + 3)).toEqual(['--mcp-config', '/h/presets/claude-code.mcp.json', '--strict-mcp-config'])
    expect(at).toBeLessThan(args.indexOf('--permission-mode'))
    if (process.platform !== 'win32') expect(args.slice(-2)).toEqual(['--disallowedTools', 'Read(//h),Read(//h/**)'])
  })

  it('deny rules: POSIX absolute paths only; a path a comma list cannot carry is skipped', () => {
    if (process.platform === 'win32') {
      expect(readDenyRules(['/a'])).toEqual([])
      return
    }
    expect(readDenyRules(['/a/b/', 'relative', '/with space', '/c,d'])).toEqual(['Read(//a/b)', 'Read(//a/b/**)'])
    expect(deniedAncestorOf('/a/b-workdir', ['/a/b'])).toBeNull()
    expect(deniedAncestorOf('/a/b/c', ['/a/b'])).toBe(path.resolve('/a/b'))
  })
})

describe('Codex flags', () => {
  it('answer, work, full', () => {
    expect(codexRunArgs('answer', { workdir: '/w' })).toEqual(['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-C', '/w', '--sandbox', 'read-only', '-c', 'approval_policy="never"', '-'])
    expect(codexRunArgs('work', { workdir: '/w' })).toContain('workspace-write')
    expect(codexRunArgs('full', { workdir: '/w' })).toContain('--dangerously-bypass-approvals-and-sandbox')
  })

  it('the hosted-server overrides name the key variable, never the key; the prompt stays the last positional', () => {
    const args = codexRunArgs('answer', { workdir: '/w', mcp: { url: 'https://api.example/mcp', keyEnv: LISTENER_KEY_ENV } })
    expect(args).toContain('mcp_servers.agentchat.url="https://api.example/mcp"')
    expect(args).toContain(`mcp_servers.agentchat.bearer_token_env_var="${LISTENER_KEY_ENV}"`)
    expect(args).toContain('mcp_servers.agentchat.default_tools_approval_mode="approve"')
    expect(args[args.length - 1]).toBe('-')
  })
})

describe('a listener preset acts as the listener\'s agent', () => {
  it('claude-code: the hosted server from an owner-only file with this key, strict; the home is denied; the key is never on argv', async () => {
    const fake = installFakeClaude(sandbox)
    const env = withFake(fake)
    process.env['PATH'] = env['PATH']
    const runner = claudeCodePreset.runner({ home, workdir, profile: 'answer', apiKey: KEY, apiBase: 'https://api.example', env })
    const file = claudeMcpConfigPath(home)
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8')) as { mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }> }
    expect(doc.mcpServers['agentchat']).toEqual({ type: 'http', url: 'https://api.example/mcp', headers: { Authorization: `Bearer ${KEY}` } })
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600)

    expect(await runner.preflight()).toEqual({ ok: true })
    const outcome = await runner.start({ kind: 'wake', prompt: 'SERVED WAKE', runId: 'r1', budgetMs: 20_000 })
    expect(outcome.state).toBe('ok')
    const [run] = readFakeRuns(fake)
    expect(run?.stdin).toBe('SERVED WAKE')
    expect(run?.argv).toContain('--strict-mcp-config')
    expect(run?.argv[run.argv.indexOf('--mcp-config') + 1]).toBe(file)
    expect(JSON.stringify(run?.argv)).not.toContain(KEY)
    expect(JSON.stringify(run?.env)).not.toContain(KEY)
    if (process.platform !== 'win32') expect(run?.argv.join(' ')).toContain(`Read(/${home})`)
    expect(fs.realpathSync(run?.cwd ?? '')).toBe(fs.realpathSync(workdir))
  }, 20_000)

  it('codex: the key under its own variable (never the integration\'s AGENTCHAT_API_KEY), the server overridden per run', async () => {
    const fake = installFakeCodex(sandbox)
    const env = { ...withFake(fake), AGENTCHAT_API_KEY: 'ac_live_' + 'o'.repeat(40) }
    process.env['PATH'] = env['PATH']
    const runner = codexPreset.runner({ home, workdir, profile: 'work', apiKey: KEY, apiBase: 'https://api.example', env })
    expect(await runner.preflight()).toEqual({ ok: true })
    const outcome = await runner.start({ kind: 'invite', prompt: 'SERVED INVITE', runId: 'r2', budgetMs: 20_000 })
    expect(outcome.state).toBe('ok')
    const [run] = readFakeRuns(fake)
    expect(run?.stdin).toBe('SERVED INVITE')
    expect(run?.env[LISTENER_KEY_ENV]).toBe(KEY)
    expect(run?.argv).toContain(`mcp_servers.agentchat.bearer_token_env_var="${LISTENER_KEY_ENV}"`)
    expect(JSON.stringify(run?.argv)).not.toContain(KEY)
    // The listener's inherited key variable is not handed on.
    expect(run?.env['AGENTCHAT_API_KEY']).toBeUndefined()
  }, 20_000)

  it('inspect says installed and signed in, or why not', () => {
    const fake = installFakeClaude(sandbox)
    const env = withFake(fake)
    process.env['PATH'] = env['PATH']
    expect(claudeCodePreset.inspect(env)).toMatchObject({ ok: true })
    process.env['FAKE_RUNTIME_LOGGED_OUT'] = '1'
    try {
      expect(claudeCodePreset.inspect(env)).toMatchObject({ ok: false })
    } finally {
      delete process.env['FAKE_RUNTIME_LOGGED_OUT']
    }
  }, 20_000)
})
