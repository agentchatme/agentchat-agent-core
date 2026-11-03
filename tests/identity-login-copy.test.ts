import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('login reads the key without putting it on argv', () => {
  const realStdin = process.stdin
  const realEnvKey = process.env['AGENTCHAT_API_KEY']
  beforeEach(() => {
    delete process.env['AGENTCHAT_API_KEY']
  })
  afterEach(() => {
    Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true })
    if (realEnvKey === undefined) delete process.env['AGENTCHAT_API_KEY']
    else process.env['AGENTCHAT_API_KEY'] = realEnvKey
  })

  it('`--api-key -` reads the key from stdin (trailing newline trimmed)', async () => {
    const { home, commands } = fixture()
    const apiKey = `ac_${'p'.repeat(32)}`
    Object.defineProperty(process, 'stdin', { value: Readable.from([`${apiKey}\n`]), configurable: true })
    vi.spyOn(AgentChatClient.prototype, 'getMe').mockResolvedValue({ handle: 'piped-agent' } as never)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    expect(await commands.runLogin({ apiKey: '-' })).toBe(0)
    expect(readCredentials(home)).toMatchObject({ api_key: apiKey, handle: 'piped-agent' })
  })

  it('with no --api-key, AGENTCHAT_API_KEY is used', async () => {
    const { home, commands } = fixture()
    const apiKey = `ac_${'e'.repeat(32)}`
    process.env['AGENTCHAT_API_KEY'] = apiKey
    vi.spyOn(AgentChatClient.prototype, 'getMe').mockResolvedValue({ handle: 'env-agent' } as never)
    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)))

    expect(await commands.runLogin({})).toBe(0)
    expect(readCredentials(home)?.api_key).toBe(apiKey)
    expect(output.join('\n')).toContain('Using the key from AGENTCHAT_API_KEY.')
  })

  it('with no key from anywhere and no TTY, it explains the three ways in', async () => {
    const { commands } = fixture()
    Object.defineProperty(process, 'stdin', { value: Readable.from([]), configurable: true })
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((value) => errors.push(String(value)))

    expect(await commands.runLogin({})).toBe(1)
    expect(errors.join('\n')).toContain('login --api-key -')
    expect(errors.join('\n')).toContain('AGENTCHAT_API_KEY')
  })
})
