import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentChatClient, ConnectionError, UnauthorizedError } from 'agentchatme'
import { createIdentityCommands } from '../src/identity/commands.js'
import { writeCredentials } from '../src/identity/credentials.js'
import { writeIntegrationStatus, type IntegrationStatus } from '../src/integration/status.js'
import type { HostProfile } from '../src/identity/host-profile.js'
import { mockServedTexts } from './helpers/served-texts.js'

// ─── `status` with a refused key still shows the integration ────────────────
//
// Live-fire E4: a getMe failure printed "Could not reach AgentChat:
// UNAUTHORIZED: Invalid API key" and returned before the integration lines — so
// the daemon's `socket terminal` / `auth rejected (close 1008 …)`, the one
// thing that explains the failure, never appeared. A refused key (401/403) is
// now said as such, an unreachable server as such, and both print the integration.

const homes: string[] = []

function fixture(): { home: string; commands: ReturnType<typeof createIdentityCommands> } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-status-cmd-'))
  homes.push(home)
  const profile: HostProfile = {
    label: 'Claude Code',
    id: 'claude-code',
    client: { runtime: 'generic', version: '0.0.0-test' },
    home: () => home,
    anchorFile: () => path.join(home, 'CLAUDE.md'),
    invocation: () => 'npx -y @agentchatme/claude-code',
    renderAnchor: (line) => line,
  }
  writeCredentials(home, { api_key: `ac_${'s'.repeat(32)}`, handle: 'probe' })
  mockServedTexts()
  return { home, commands: createIdentityCommands(profile) }
}

function refusedIntegration(): IntegrationStatus {
  return {
    version: 2,
    updated_at: new Date().toISOString(),
    pid: 4242,
    runtime: 'claude',
    handle: 'probe',
    profile: 'answer',
    socket: 'terminal',
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
    last_error: "auth rejected (close 1008 Invalid token) — check the agent's API key",
    texts: null,
  }
}

function capture(): { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  vi.spyOn(console, 'log').mockImplementation((v) => out.push(String(v)))
  vi.spyOn(console, 'error').mockImplementation((v) => err.push(String(v)))
  return { out, err }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

describe('status when getMe fails', () => {
  it('a 401 says the key was refused (not "could not reach") and still prints the integration state', async () => {
    const { home, commands } = fixture()
    writeIntegrationStatus(home, refusedIntegration())
    vi.spyOn(AgentChatClient.prototype, 'getMe').mockRejectedValue(
      new UnauthorizedError({ code: 'UNAUTHORIZED', message: 'Invalid API key' }, 401),
    )
    const { out, err } = capture()

    expect(await commands.runStatus({})).toBe(1)

    expect(err.join('\n')).toContain("AgentChat refused this agent's key (UNAUTHORIZED: Invalid API key)")
    expect(err.join('\n')).not.toMatch(/could not reach/i)
    expect(err.join('\n')).toContain('npx -y @agentchatme/claude-code login')
    const text = out.join('\n')
    expect(text).toContain('@probe — key refused (HTTP 401)')
    expect(text).toContain('Integration: socket terminal')
    expect(text).toContain('last error: auth rejected (close 1008 Invalid token)')
  })

  it('an unreachable server says so and still prints the integration state', async () => {
    const { home, commands } = fixture()
    writeIntegrationStatus(home, { ...refusedIntegration(), socket: 'reconnecting', last_error: null })
    vi.spyOn(AgentChatClient.prototype, 'getMe').mockRejectedValue(new ConnectionError('fetch failed'))
    const { out, err } = capture()

    expect(await commands.runStatus({})).toBe(1)

    expect(err.join('\n')).toContain('Could not reach AgentChat')
    expect(err.join('\n')).not.toContain('refused')
    expect(out.join('\n')).toContain('AgentChat unreachable')
    expect(out.join('\n')).toContain('Integration: socket reconnecting')
  })

  it('--json carries the failure kind and the integration (and the old `doorbell` key, one release) instead of printing nothing parseable', async () => {
    const { home, commands } = fixture()
    writeIntegrationStatus(home, refusedIntegration())
    vi.spyOn(AgentChatClient.prototype, 'getMe').mockRejectedValue(
      new UnauthorizedError({ code: 'UNAUTHORIZED', message: 'Invalid API key' }, 401),
    )
    const { out } = capture()

    expect(await commands.runStatus({ json: true })).toBe(1)

    const parsed = JSON.parse(out.join('\n')) as { error: { kind: string; status: number }; integration: { socket: string }; doorbell: { socket: string } }
    expect(parsed.error).toMatchObject({ kind: 'key_refused', status: 401 })
    expect(parsed.integration.socket).toBe('terminal')
    expect(parsed.doorbell.socket).toBe('terminal')
  })
})
