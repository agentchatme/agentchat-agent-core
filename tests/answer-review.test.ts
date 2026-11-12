import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  ANSWER_ENV,
  ClaudeRunner,
  CodexRunner,
  claudeExtraDirectoriesGrant,
  claudeManagedSettingsDir,
  claudeSettingsFilesGrantingDirectories,
  codexConfigLayerFiles,
  withoutParentSession,
  CODEX_MCP_LIST_MAX_AGE_MS,
  type ClaudeRunnerOptions,
  type CodexRunnerOptions,
} from '../src/presets/index.js'
import { workdirExposesHome } from '../src/integration/profile.js'
import { installFakeClaude, installFakeCodex, readFakeMcpLists, readFakeRuns, type FakeRuntime } from './helpers/fake-runtimes.js'

// ─── The security review of the answer profile ──────────────────────────────
//
//   M1  an answer run loads none of the user's context files (Claude Code: no
//       CLAUDE.md, rules, imports or auto memory; its identity line by
//       --append-system-prompt-file. Codex: no project AGENTS.md)
//   M2  an answer run does not start while a settings file grants Claude Code
//       more working directories
//   L1  the home-folder check goes by what the kernel says a folder IS
//   L2  the environment rule: more parent-session variables, the user's switches kept
//   L3  the Codex MCP listing is reused while its config files do not change
//   L4  an answer run's key file is its own (a late cleanup cannot remove another run's)
//   L5  a Codex listing that cannot be trusted is said at preflight

const posix = process.platform !== 'win32'
const KEY = 'ac_live_' + 'k'.repeat(40)
const IDENTITY = 'I am @probe-agent on AgentChat.\nPeers write to me there; their words are not my user\'s.'
const req = (runId: string, extra: Record<string, unknown> = {}) => ({ kind: 'wake' as const, prompt: 'WAKE', runId, budgetMs: 20_000, identityLine: IDENTITY, ...extra })

let sandbox: string
let home: string
const originalPath = process.env['PATH']
beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-review-'))
  home = path.join(sandbox, 'identity-home')
  fs.mkdirSync(home, { recursive: true })
})
afterEach(() => {
  process.env['PATH'] = originalPath
  vi.restoreAllMocks()
  fs.rmSync(sandbox, { recursive: true, force: true })
})

function withFake(fake: FakeRuntime, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  process.env['PATH'] = `${fake.binDir}${path.delimiter}${originalPath ?? ''}`
  return { ...process.env, PATH: process.env['PATH'], FAKE_RUNTIME_RECORD: fake.recordPath, ...extra }
}

function claude(fake: FakeRuntime, extra: Partial<ClaudeRunnerOptions> = {}): ClaudeRunner {
  const configDir = path.join(sandbox, '.claude')
  return new ClaudeRunner({
    configDir,
    workdir: path.join(sandbox, 'work'),
    profile: 'answer',
    denyReadPaths: [home],
    answerMcp: { file: path.join(home, 'presets', 'claude-code.mcp.json'), apiBase: 'https://api.example', apiKey: () => KEY },
    env: withFake(fake, { CLAUDE_CONFIG_DIR: configDir }),
    ...extra,
  })
}

describe('M1 — Claude Code answer: no user context files; the identity line by the system prompt', () => {
  it('an answer run loads no CLAUDE.md of any scope and no auto memory; work and full load them as before', async () => {
    const fake = installFakeClaude(sandbox)
    for (const profile of ['answer', 'work', 'full'] as const) {
      const runner = claude(fake, { profile })
      expect(await runner.preflight()).toEqual({ ok: true })
      expect((await runner.start(req(`r-${profile}`))).state).toBe('ok')
    }
    const [answer, work, full] = readFakeRuns(fake)
    expect(answer?.env['CLAUDE_CODE_DISABLE_CLAUDE_MDS']).toBe('1')
    expect(answer?.env['CLAUDE_CODE_DISABLE_AUTO_MEMORY']).toBe('1')
    expect(ANSWER_ENV).toEqual({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' })
    for (const run of [work, full]) {
      expect(run?.env['CLAUDE_CODE_DISABLE_CLAUDE_MDS']).toBeUndefined()
      expect(run?.env['CLAUDE_CODE_DISABLE_AUTO_MEMORY']).toBeUndefined()
      expect(run?.argv).not.toContain('--append-system-prompt-file')
    }
  }, 30_000)

  it('the served identity line reaches an answer run as an appended system prompt, from a file of the run\'s own that is removed after it', async () => {
    const fake = installFakeClaude(sandbox)
    const runner = claude(fake)
    expect(await runner.preflight()).toEqual({ ok: true })
    expect((await runner.start(req('run-1'))).state).toBe('ok')
    const [run] = readFakeRuns(fake)
    const at = run?.argv.indexOf('--append-system-prompt-file') ?? -1
    expect(at).toBeGreaterThan(-1)
    const file = run?.argv[at + 1] ?? ''
    expect(path.dirname(file)).toBe(path.join(home, 'presets'))
    expect(path.basename(file)).toBe('claude-code.mcp.run-1.identity.md')
    expect(run?.appendedSystemPrompt).toBe(`${IDENTITY}\n`)
    expect(fs.existsSync(file)).toBe(false)
    // No identity line in hand (no texts yet): no file, no flag.
    expect((await runner.start(req('run-2', { identityLine: undefined }))).state).toBe('ok')
    expect(readFakeRuns(fake)[1]?.argv).not.toContain('--append-system-prompt-file')
  }, 30_000)

  it('the listener path (its own --mcp-config): the identity file sits beside that config', async () => {
    const fake = installFakeClaude(sandbox)
    const listenerConfig = path.join(home, 'presets', 'claude-code.mcp.json')
    fs.mkdirSync(path.dirname(listenerConfig), { recursive: true })
    fs.writeFileSync(listenerConfig, '{"mcpServers":{"agentchat":{"type":"http","url":"https://api.example/mcp"}}}', { mode: 0o600 })
    const runner = claude(fake, { mcpConfigPath: listenerConfig, answerMcp: undefined })
    expect(await runner.preflight()).toEqual({ ok: true })
    expect((await runner.start(req('lsn'))).state).toBe('ok')
    const [run] = readFakeRuns(fake)
    expect(run?.argv[(run?.argv.indexOf('--mcp-config') ?? 0) + 1]).toBe(listenerConfig)
    expect(run?.argv[(run?.argv.indexOf('--append-system-prompt-file') ?? 0) + 1]).toBe(path.join(home, 'presets', 'claude-code.mcp.lsn.identity.md'))
    expect(fs.existsSync(listenerConfig)).toBe(true) // the listener's own file is not the run's to remove
  }, 30_000)
})

describe('M1 — Claude Code answer: Claude Code\'s record of every project is denied', () => {
  it.skipIf(!posix)('an answer run is denied <config dir>/projects (transcripts, auto memory); work and full are not', () => {
    const fake = installFakeClaude(sandbox)
    const projects = path.join(sandbox, '.claude', 'projects')
    const deny = (runner: ClaudeRunner): string => {
      const argv = runner.args()
      return argv[argv.indexOf('--disallowedTools') + 1] ?? ''
    }
    expect(deny(claude(fake))).toContain(`Read(/${projects}),Read(/${projects}/**)`)
    for (const profile of ['work', 'full'] as const) expect(deny(claude(fake, { profile }))).not.toContain('projects')
  })
})

describe('L4 — an answer run\'s key file is its own', () => {
  it('named after the run; a late cleanup of an abandoned run cannot remove the next run\'s file', async () => {
    const fake = installFakeClaude(sandbox)
    const runner = claude(fake)
    expect(await runner.preflight()).toEqual({ ok: true })
    expect(runner.args('a/b c')).toContain(path.join(home, 'presets', 'claude-code.mcp.abc.json'))
    expect((await runner.start(req('run-a'))).state).toBe('ok')
    expect((await runner.start(req('run-b'))).state).toBe('ok')
    const [a, b] = readFakeRuns(fake)
    const fileOf = (argv: string[] | undefined): string => argv?.[(argv?.indexOf('--mcp-config') ?? 0) + 1] ?? ''
    expect(path.basename(fileOf(a?.argv))).toBe('claude-code.mcp.run-a.json')
    expect(path.basename(fileOf(b?.argv))).toBe('claude-code.mcp.run-b.json')
    expect(a?.mcpConfig).toMatchObject({ servers: ['agentchat'] })
    // Nothing of either run is left; the configured name itself is never written.
    expect(fs.readdirSync(path.join(home, 'presets'))).toEqual([])
  }, 30_000)
})

describe('M2 — no answer run while a settings file grants Claude Code more working directories', () => {
  const write = (file: string, body: unknown): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body))
  }

  it('which files: the user\'s settings, the managed file and its drop-ins, settings.local.json at the workdir\'s repository root', () => {
    const repo = path.join(sandbox, 'repo')
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
    const wd = path.join(repo, 'a', 'wd')
    fs.mkdirSync(wd, { recursive: true })
    const files = claudeSettingsFilesGrantingDirectories(path.join(sandbox, '.claude'), wd)
    expect(files).toContain(path.join(sandbox, '.claude', 'settings.json'))
    expect(files).toContain(path.join(claudeManagedSettingsDir(), 'managed-settings.json'))
    expect(files).toContain(path.join(repo, '.claude', 'settings.local.json'))
    expect(claudeManagedSettingsDir('darwin')).toBe('/Library/Application Support/ClaudeCode')
    expect(claudeManagedSettingsDir('linux')).toBe('/etc/claude-code')
    expect(claudeManagedSettingsDir('win32')).toBe('C:\\Program Files\\ClaudeCode')
  })

  it('the user\'s settings list additionalDirectories: preflight refuses naming the file, every run is refused, work and full run', async () => {
    const fake = installFakeClaude(sandbox)
    const userSettings = path.join(sandbox, '.claude', 'settings.json')
    write(userSettings, { model: 'claude-x', permissions: { additionalDirectories: [path.join(sandbox, 'docs')] } })
    const pre = await claude(fake).preflight()
    expect(pre.ok).toBe(false)
    expect(pre.detail).toContain(userSettings)
    expect(pre.detail).toMatch(/lists permissions\.additionalDirectories \(1 folder\)/)
    expect(await claude(fake).start(req('x'))).toMatchObject({ state: 'not_started', detail: expect.stringContaining(userSettings) })
    for (const profile of ['work', 'full'] as const) {
      const runner = claude(fake, { profile })
      expect(await runner.preflight()).toEqual({ ok: true })
      expect((await runner.start(req(profile))).state).toBe('ok')
    }
    expect(readFakeRuns(fake)).toHaveLength(2)
  }, 30_000)

  it('an untracked settings.local.json at the repository root counts; an empty list, other keys and a broken file without the key do not', () => {
    const repo = path.join(sandbox, 'repo')
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
    const wd = path.join(repo, 'wd')
    fs.mkdirSync(wd, { recursive: true })
    const cfg = path.join(sandbox, '.claude')
    write(path.join(cfg, 'settings.json'), { permissions: { additionalDirectories: [], allow: ['Read'] } })
    expect(claudeExtraDirectoriesGrant(cfg, wd)).toBeNull()
    write(path.join(cfg, 'settings.json'), '{ broken')
    expect(claudeExtraDirectoriesGrant(cfg, wd)).toBeNull()
    write(path.join(cfg, 'settings.json'), '{ "permissions": { "additionalDirectories": ["/x"], } }')
    expect(claudeExtraDirectoriesGrant(cfg, wd)).toMatchObject({ detail: expect.stringMatching(/not valid JSON/) })
    write(path.join(cfg, 'settings.json'), {})
    write(path.join(repo, '.claude', 'settings.local.json'), { permissions: { additionalDirectories: ['../../secrets', '../notes'] } })
    expect(claudeExtraDirectoriesGrant(cfg, wd)).toEqual({ file: path.join(repo, '.claude', 'settings.local.json'), detail: 'lists permissions.additionalDirectories (2 folders)' })
  })
})

describe('L1 — the home-folder check goes by the kernel\'s identity of the folder', () => {
  it('a symlink to the home folder or to a folder above it, by any name', () => {
    if (!posix) return
    const user = path.join(sandbox, 'Users', 'alice')
    fs.mkdirSync(path.join(user, 'proj'), { recursive: true })
    fs.symlinkSync(user, path.join(sandbox, 'alias-of-home'))
    fs.symlinkSync(path.join(sandbox, 'Users'), path.join(sandbox, 'alias-of-users'))
    expect(workdirExposesHome(path.join(sandbox, 'alias-of-home'), user)).toBe(true)
    expect(workdirExposesHome(path.join(sandbox, 'alias-of-users'), user)).toBe(true)
    expect(workdirExposesHome(path.join(sandbox, 'alias-of-home', 'proj'), user)).toBe(false)
  })

  it('a folder that holds the home folder under its own names (a bind mount, macOS\'s data-volume firmlink) is seen through', () => {
    if (!posix) return
    // /mnt/homes holding alice as alice: modelled by a second path to the same folder.
    const real = path.join(sandbox, 'volume', 'Users', 'alice')
    fs.mkdirSync(real, { recursive: true })
    fs.mkdirSync(path.join(sandbox, 'mnt'), { recursive: true })
    fs.symlinkSync(path.join(sandbox, 'volume', 'Users'), path.join(sandbox, 'mnt', 'homes'))
    expect(workdirExposesHome(path.join(sandbox, 'mnt', 'homes'), real)).toBe(true)
    expect(workdirExposesHome(path.join(sandbox, 'volume'), real)).toBe(true)
  })

  it.skipIf(process.platform !== 'darwin')('macOS: /users/<name>, /USERS/<NAME>, /System/Volumes/Data/Users/<name> and /System/Volumes/Data are the home folder or above it', () => {
    const userHome = fs.realpathSync.native(os.homedir())
    if (!userHome.startsWith('/Users/')) return
    const name = path.basename(userHome)
    const variants = [`/users/${name}`, `/USERS/${name.toUpperCase()}`, `/System/Volumes/Data/Users/${name}`, '/System/Volumes/Data', '/users']
    for (const v of variants) if (fs.existsSync(v)) expect(workdirExposesHome(v), v).toBe(true)
    expect(workdirExposesHome(path.join(userHome, 'definitely-not-home-' + process.pid))).toBe(false)
    expect(workdirExposesHome('/Applications')).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')('Windows: the drive root and the profile folder in any case', () => {
    const h = os.homedir()
    expect(workdirExposesHome(path.parse(h).root)).toBe(true)
    expect(workdirExposesHome(h.toUpperCase())).toBe(true)
    expect(workdirExposesHome(path.dirname(h).toLowerCase())).toBe(true)
  })
})

describe('L2 — the environment rule', () => {
  it('drops the rest of Claude Code\'s session variables; keeps the user\'s request and memory switches', () => {
    const out = withoutParentSession({
      CLAUDE_JOB_DIR: '/j', CLAUDE_ENV_FILE: '/e', CLAUDE_PROJECT_DIR: '/p', TRACEPARENT: '00-abc-def-01', TRACESTATE: 'x=y',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1', CLAUDE_CODE_EXTRA_BODY: '{}', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096',
    })
    expect(Object.keys(out).sort()).toEqual(['CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', 'CLAUDE_CODE_EXTRA_BODY', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS'])
  })

  it('a parent Codex proxy: its URLs (only while its marker says it was active), its CA bundle, its SSH command, its brokered dummies; the user\'s own stay', () => {
    const managedBundle = '/Users/x/.codex/proxy/ca-bundle-0123abcd.pem'
    const parent = {
      CODEX_NETWORK_PROXY_ACTIVE: '1',
      CODEX_NETWORK_PROXY_ATTRIBUTION: 'tok',
      CODEX_NETWORK_PROXY_CREDENTIAL_BROKER_ACTIVE: '1',
      CODEX_NETWORK_PROXY_BROKERED_CREDENTIALS: JSON.stringify([['OPENAI_API_KEY', 'dummy-123'], ['GITHUB_TOKEN', 'dummy-gh']]),
      HTTP_PROXY: 'http://127.0.0.1:3128', https_proxy: 'http://127.0.0.1:3128', ALL_PROXY: 'socks5h://127.0.0.1:1080', NO_PROXY: 'localhost', NODE_USE_ENV_PROXY: '1',
      SSL_CERT_FILE: managedBundle, NODE_EXTRA_CA_CERTS: managedBundle,
      GIT_SSH_COMMAND: "CODEX_PROXY_GIT_SSH_COMMAND=1 ssh -o ProxyCommand='nc -X 5 -x 127.0.0.1:1080 %h %p'",
      OPENAI_API_KEY: 'dummy-123', GITHUB_TOKEN: 'real-user-token',
      PATH: '/bin',
    }
    expect(withoutParentSession(parent)).toEqual({ GITHUB_TOKEN: 'real-user-token', PATH: '/bin' })
    // Without the parent proxy's marker the proxy and CA settings are the user's.
    const user = { HTTP_PROXY: 'http://proxy.corp:8080', NO_PROXY: '.corp', SSL_CERT_FILE: '/etc/ssl/corp.pem', GIT_SSH_COMMAND: 'ssh -i ~/.ssh/deploy', PATH: '/bin' }
    expect(withoutParentSession(user)).toEqual(user)
  })

  it('every run of both runtimes gets the rule (the preset runners apply it themselves)', async () => {
    const fake = installFakeClaude(sandbox)
    const runner = claude(fake, { profile: 'work', env: withFake(fake, { CLAUDE_JOB_DIR: '/j', TRACEPARENT: '00-a-b-01', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '9', CLAUDE_CONFIG_DIR: path.join(sandbox, '.claude') }) })
    expect(await runner.preflight()).toEqual({ ok: true })
    expect((await runner.start(req('w'))).state).toBe('ok')
    const [run] = readFakeRuns(fake)
    expect(run?.env['CLAUDE_JOB_DIR']).toBeUndefined()
    expect(run?.env['CLAUDE_CODE_MAX_OUTPUT_TOKENS']).toBe('9')
  }, 20_000)
})

describe('L3 and L5 — the Codex listing: reused while its config files do not change; untrusted output said at preflight', () => {
  const listRecord = (): string => path.join(sandbox, 'mcp-list.jsonl')
  const codex = (fake: FakeRuntime, extra: Record<string, string> = {}, more: Partial<CodexRunnerOptions> = {}): CodexRunner =>
    new CodexRunner({
      codexHome: path.join(sandbox, '.codex'),
      workdir: path.join(sandbox, 'work'),
      profile: 'answer',
      apiKey: () => KEY,
      keyEnv: 'AGENTCHAT_LISTENER_API_KEY',
      mcp: { url: 'https://api.example/mcp', keyEnv: 'AGENTCHAT_LISTENER_API_KEY' },
      env: withFake(fake, { FAKE_MCP_LIST_RECORD: listRecord(), ...extra }),
      ...more,
    })

  it('the files the key is made of: system, managed, requirements, the user\'s config.toml, every config.toml / .codex/config.toml from the workdir up', () => {
    const files = codexConfigLayerFiles('/h/.codex', '/a/b', 'linux')
    expect(files).toEqual(['/etc/codex/config.toml', '/etc/codex/managed_config.toml', '/etc/codex/requirements.toml', '/h/.codex/config.toml', '/a/b/config.toml', '/a/b/.codex/config.toml', '/a/.codex/config.toml', '/.codex/config.toml'])
    expect(codexConfigLayerFiles('/h/.codex', '/a', 'darwin')).toContain('/Library/Managed Preferences/com.openai.codex.plist')
  })

  it('one listing for many runs; a changed config file, or the age limit, lists again', async () => {
    const fake = installFakeCodex(sandbox)
    const runner = codex(fake, { FAKE_MCP_LIST: JSON.stringify([{ name: 'agentchat', enabled: true }, { name: 'fs', enabled: true }]) })
    expect(await runner.preflight()).toEqual({ ok: true })
    for (const id of ['1', '2', '3']) expect((await runner.start(req(id))).state).toBe('ok')
    expect(readFakeMcpLists(listRecord())).toHaveLength(1)
    expect(readFakeRuns(fake).every((r) => r.argv.includes('mcp_servers.fs.enabled=false'))).toBe(true)
    // The user's config.toml appears (or changes): listed again.
    fs.mkdirSync(path.join(sandbox, '.codex'), { recursive: true })
    fs.writeFileSync(path.join(sandbox, '.codex', 'config.toml'), '[mcp_servers.fs]\nurl = "https://fs.example/mcp"\n')
    expect((await runner.start(req('4'))).state).toBe('ok')
    expect(readFakeMcpLists(listRecord())).toHaveLength(2)
    expect((await runner.start(req('5'))).state).toBe('ok')
    expect(readFakeMcpLists(listRecord())).toHaveLength(2)
    // Past the age limit (layers that are not files): listed again.
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + CODEX_MCP_LIST_MAX_AGE_MS + 1_000)
    expect((await runner.start(req('6'))).state).toBe('ok')
    expect(readFakeMcpLists(listRecord())).toHaveLength(3)
  }, 30_000)

  it('a failure is never reused: the next run asks again, and still does not start while it fails', async () => {
    const fake = installFakeCodex(sandbox)
    const runner = codex(fake, { FAKE_MCP_LIST_MODE: 'fail' })
    expect(await runner.preflight()).toMatchObject({ ok: false })
    expect(await runner.start(req('a'))).toMatchObject({ state: 'not_started' })
    expect(await runner.start(req('b'))).toMatchObject({ state: 'not_started' })
    expect(readFakeMcpLists(listRecord())).toHaveLength(3)
    expect(readFakeRuns(fake)).toEqual([])
  }, 30_000)

  it('Codex\'s own complaint rides along, first line, redacted (e.g. a feature name it does not know)', async () => {
    const fake = installFakeCodex(sandbox)
    const pre = await codex(fake, { FAKE_MCP_LIST_MODE: 'fail' }).preflight()
    expect(pre.detail).toMatch(/exited 1: config error/)
    expect(pre.detail).toMatch(/with the answer flags/)
  }, 20_000)

  it('work and full do not list at preflight', async () => {
    const fake = installFakeCodex(sandbox)
    for (const profile of ['work', 'full'] as const) expect(await codex(fake, { FAKE_MCP_LIST_MODE: 'fail' }, { profile }).preflight()).toEqual({ ok: true })
    expect(readFakeMcpLists(listRecord())).toEqual([])
  }, 20_000)
})
