import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentChatClient } from 'agentchatme'
import { createIdentityCommands } from '../src/identity/commands.js'
import { resolveIdentity, writeCredentials } from '../src/identity/credentials.js'
import { resolveDaemonConfig } from '../src/daemon/config.js'
import type { HostProfile } from '../src/identity/host-profile.js'
import { writeIntegrationStatus, type IntegrationStatus } from '../src/integration/status.js'
import { ClaudeRunner, agentchatTableKeys, claudeCodePreset, codexPreset, inexpressibleDenyPaths } from '../src/presets/index.js'
import { mockServedTexts } from './helpers/served-texts.js'
import { installFakeClaude } from './helpers/fake-runtimes.js'

// ─── The engine side of the 2026-11-08 review fixes ─────────────────────────

const homes: string[] = []
const KEY = 'ac_live_' + 'h'.repeat(40)
const OTHER = 'ac_live_' + 'e'.repeat(40)
const tempHome = (): string => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-review-'))
  homes.push(home)
  return home
}
afterEach(() => {
  vi.restoreAllMocks()
  delete process.env['AGENTCHAT_API_KEY']
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

describe('home-only identity (for a resident listener)', () => {
  it('resolveIdentity and resolveDaemonConfig ignore AGENTCHAT_API_KEY when asked', async () => {
    const home = tempHome()
    writeCredentials(home, { api_key: KEY, handle: 'probe' })
    process.env['AGENTCHAT_API_KEY'] = OTHER
    expect(resolveIdentity(home)?.apiKey).toBe(OTHER)
    expect(resolveIdentity(home, { envKey: false })).toMatchObject({ apiKey: KEY, handle: 'probe', source: 'file' })
    const cfg = await resolveDaemonConfig({ home, workdir: home, client: { runtime: 'generic', version: '0' }, envKey: false })
    expect(cfg).toMatchObject({ apiKey: KEY, handle: 'probe' })
  })
})

describe('doctor: repeated failed wake cycles are a warning', () => {
  const status = (outcomes: string[]): IntegrationStatus => ({
    version: 2, updated_at: new Date().toISOString(), pid: 1, runtime: 'x', handle: 'probe', profile: 'answer', socket: 'ready',
    wakes: 1, wakes_absorbed: 0, invites: 0, runs_started: 0, runs_ok: 0, runs_failed: 0, runs_timed_out: 0, runs_not_started: 0,
    runs_skipped_empty: 0, last_run: null, retry_rung: 0, retry_due_at: null, last_error: null, texts: null,
    recent_cycles: outcomes.map((outcome) => ({ at: new Date().toISOString(), outcome, cards: 1, invites: 0, failure: outcome === 'run_completed' ? null : 'exit 1 with nothing on stdout' })),
  })

  async function doctor(outcomes: string[]): Promise<string> {
    const home = tempHome()
    writeCredentials(home, { api_key: KEY, handle: 'probe' })
    writeIntegrationStatus(home, status(outcomes))
    mockServedTexts('probe')
    vi.spyOn(AgentChatClient.prototype, 'getMe').mockResolvedValue({ handle: 'probe', status: 'active' } as never)
    const out: string[] = []
    vi.spyOn(console, 'log').mockImplementation((v) => void out.push(String(v)))
    const profile: HostProfile = { label: 'Example', id: 'example', client: { runtime: 'generic', version: '0' }, home: () => home, invocation: () => 'example', renderAnchor: (l) => l }
    await createIdentityCommands(profile).runDoctor({})
    return out.join('\n')
  }

  it('three failed in a row → WARN with the latest failure; a completed last cycle → PASS', async () => {
    expect(await doctor(['run_completed', 'run_not_started', 'run_failed', 'abandoned'])).toMatch(/WARN wake-cycles: the last 3 wake cycles did not get done \(latest: abandoned/)
    expect(await doctor(['run_failed', 'run_failed', 'run_completed'])).toMatch(/PASS wake-cycles: last cycle run_completed/)
  })
})

describe('Claude Code preset: a deny path no rule can carry is never skipped silently', () => {
  it('names the paths no rule can carry', () => {
    expect(inexpressibleDenyPaths(['/a/b', '/with space/x', '/c,d', 'relative'])).toEqual(process.platform === 'win32' ? ['/a/b', '/with space/x', '/c,d', 'relative'] : ['/with space/x', '/c,d', 'relative'])
  })

  it.skipIf(process.platform === 'win32')('refuse fails preflight with the reason; warn (the integration default) runs, argv unchanged', async () => {
    const sandbox = tempHome()
    const fake = installFakeClaude(sandbox)
    const savedPath = process.env['PATH']
    process.env['PATH'] = `${fake.binDir}${path.delimiter}${savedPath ?? ''}`
    try {
      const options = { configDir: undefined, workdir: path.join(sandbox, 'work'), profile: 'answer' as const, denyReadPaths: ['/Users/Some Body/.agentchat', '/fine/home'] }
      const refused = await new ClaudeRunner({ ...options, inexpressibleDeny: 'refuse' }).preflight()
      expect(refused.ok).toBe(false)
      expect(refused.detail).toMatch(/no read-deny rule can carry \/Users\/Some Body\/\.agentchat .*\(--home\)/)
      const warned = new ClaudeRunner(options)
      expect(await warned.preflight()).toEqual({ ok: true })
      expect(warned.args().join(' ')).toContain('Read(//fine/home)')
      expect(warned.args().join(' ')).not.toContain('Some Body')
    } finally {
      process.env['PATH'] = savedPath
    }
  })

  it('the listener preset refuses where the integration warns', () => {
    const home = path.join(tempHome(), 'with space')
    fs.mkdirSync(home, { recursive: true })
    const runner = claudeCodePreset.runner({ home, workdir: tempHome(), profile: 'answer', apiKey: KEY, apiBase: 'https://api.example.test' }) as ClaudeRunner
    expect((runner as unknown as { options: { inexpressibleDeny?: string } }).options.inexpressibleDeny).toBe(process.platform === 'win32' ? 'warn' : 'refuse')
  })
})

describe('describeMcp: what a preset run is given (no key printed)', () => {
  it('claude-code: the strict config file and its server', () => {
    const lines = claudeCodePreset.describeMcp({ home: '/h', apiBase: 'https://api.example.test' })
    expect(lines.join('\n')).toMatch(/--mcp-config .*claude-code\.mcp\.json/)
    expect(lines.join('\n')).toMatch(/--strict-mcp-config/)
    expect(lines.join('\n')).not.toMatch(/ac_live_/)
  })

  it('codex: the overrides, and the keys (never values) of the user\'s own table', () => {
    const codexHome = tempHome()
    fs.writeFileSync(path.join(codexHome, 'config.toml'), ['model = "x"', '[mcp_servers.agentchat]', 'url = "https://old"', 'bearer_token = "SHOULD-NOT-PRINT"', 'startup_timeout_sec = 30', '[other]', 'k = 1'].join('\n'))
    const lines = codexPreset.describeMcp({ home: '/h', apiBase: 'https://api.example.test', env: { CODEX_HOME: codexHome } }).join('\n')
    expect(lines).toMatch(/also sets url, bearer_token, startup_timeout_sec/)
    expect(lines).toMatch(/not verified on a real codex/)
    expect(lines).not.toContain('SHOULD-NOT-PRINT')
    expect(agentchatTableKeys('[mcp_servers.other]\nx = 1')).toBeNull()
  })
})
