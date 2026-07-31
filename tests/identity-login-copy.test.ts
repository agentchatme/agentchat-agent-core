import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentChatClient } from 'agentchatme'
import { createIdentityCommands } from '../src/identity/commands.js'
import { credentialsPath, readCredentials, writePending } from '../src/identity/credentials.js'
import type { HostProfile } from '../src/identity/host-profile.js'

const homes: string[] = []

function fixture(): { home: string; commands: ReturnType<typeof createIdentityCommands> } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-login-copy-'))
  homes.push(home)
  const profile: HostProfile = {
    label: 'Codex',
    id: 'codex',
    home: () => home,
    anchorFile: () => path.join(home, 'AGENTS.md'),
    invocation: () => 'npx -y @agentchatme/codex',
    renderAnchor: (handle) => `@${handle}`,
    isWired: () => false,
  }
  return { home, commands: createIdentityCommands(profile) }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

describe('successful identity changes report the resolved credentials path', () => {
  it('login stores the supplied key and prints its exact location', async () => {
    const { home, commands } = fixture()
    const apiKey = `ac_${'l'.repeat(32)}`
    vi.spyOn(AgentChatClient.prototype, 'getMe').mockResolvedValue({ handle: 'login-agent' } as never)
    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)))

    expect(await commands.runLogin({ apiKey })).toBe(0)

    expect(output.join('\n')).toContain(`API key stored at ${credentialsPath(home)}`)
    expect(readCredentials(home)?.api_key).toBe(apiKey)
  })

  it('recovery stores the replacement key, prints its path, and says the old key was revoked', async () => {
    const { home, commands } = fixture()
    const apiKey = `ac_${'r'.repeat(32)}`
    writePending(home, {
      kind: 'recover',
      pending_id: 'pending-recovery',
      email: 'owner@example.com',
      created_at: new Date().toISOString(),
    })
    vi.spyOn(AgentChatClient, 'recoverVerify').mockResolvedValue({
      handle: 'recovered-agent',
      apiKey,
      client: null as never,
    })
    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)))

    expect(await commands.runRecover({ code: '123456' })).toBe(0)

    const rendered = output.join('\n')
    expect(rendered).toContain(`New API key stored at ${credentialsPath(home)}`)
    expect(rendered).toContain('old key is now revoked')
    expect(readCredentials(home)?.api_key).toBe(apiKey)
  })
})
