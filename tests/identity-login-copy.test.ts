import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIdentityCommands } from '../src/identity/commands.js'
import { renderAnchorBlock } from '../src/anchor/block.js'
import { credentialsPath, readCredentials, writeCredentials, writePending } from '../src/identity/credentials.js'
import type { HostProfile } from '../src/identity/host-profile.js'
import { textsFor } from './helpers/served-texts.js'
import { fakeKey, me, recovered, signupServer, unauthorized } from './helpers/signup-server.js'

const homes: string[] = []

function fixture(): { home: string; commands: ReturnType<typeof createIdentityCommands> } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-login-copy-'))
  homes.push(home)
  const profile: HostProfile = {
    label: 'Codex',
    id: 'codex',
    client: { runtime: 'generic', version: '0.0.0-test' },
    home: () => home,
    anchorFile: () => path.join(home, 'AGENTS.md'),
    invocation: () => 'npx -y @agentchatme/codex',
    renderAnchor: renderAnchorBlock,
    isWired: () => false,
  }
  return { home, commands: createIdentityCommands(profile) }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

describe('successful identity changes report the resolved credentials path', () => {
  it('login checks the key with the server, stores it with the handle the server named, and prints its exact location', async () => {
    const { home, commands } = fixture()
    const apiKey = fakeKey('l')
    const server = signupServer().on('GET /v1/agents/me', me('login-agent'))
    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)))

    expect(await commands.runLogin({ apiKey })).toBe(0)

    expect(server.calls).toHaveLength(1)
    expect(server.calls[0]?.headers['authorization']).toBe(`Bearer ${apiKey}`)
    expect(output.join('\n')).toContain('Signed in as @login-agent for Codex.')
    expect(output.join('\n')).toContain(`API key stored at ${credentialsPath(home)}`)
    expect(readCredentials(home)).toMatchObject({ api_key: apiKey, handle: 'login-agent' })
  })

  it('recovery stores the replacement key, prints its path, and passes on the server’s word that the old key is gone', async () => {
    const { home, commands } = fixture()
    const apiKey = fakeKey('r')
    writePending(home, {
      kind: 'recover',
      flow: { version: 1, flow: 'recover', next_step: 'recover_verify', status: 'pending', pending_id: 'pending-recovery' },
      received_at: new Date().toISOString(),
      email: 'owner@example.com',
    })
    signupServer().on('POST /v1/agents/recover/verify', recovered('recovered-agent', apiKey))
    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)))

    expect(await commands.runRecover({ code: '123456' })).toBe(0)

    const rendered = output.join('\n')
    expect(rendered).toContain(`New API key for @recovered-agent stored at ${credentialsPath(home)}`)
    expect(rendered).toContain('Your old API key no longer works.')
    expect(readCredentials(home)?.api_key).toBe(apiKey)
  })
})

describe('login never saves a key the server rejected', () => {
  it('a refused key: the server’s answer, exit 1, nothing written, the old credential untouched', async () => {
    const { home, commands } = fixture()
    const previous = fakeKey('p')
    writeCredentials(home, { api_key: previous, handle: 'earlier-agent' })
    signupServer().on('GET /v1/agents/me', unauthorized())
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((value) => errors.push(String(value)))
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    expect(await commands.runLogin({ apiKey: fakeKey('x') })).toBe(1)

    expect(errors.join('\n')).toBe('Login failed. UNAUTHORIZED: Invalid API key\nThe key was not saved.')
    expect(readCredentials(home)).toMatchObject({ api_key: previous, handle: 'earlier-agent' })
  })

  it('a key of any length is the server’s to judge (no local length rule)', async () => {
    const { home, commands } = fixture()
    const server = signupServer().on('GET /v1/agents/me', unauthorized())
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(await commands.runLogin({ apiKey: 'short' })).toBe(1)

    expect(server.calls[0]?.headers['authorization']).toBe('Bearer short')
    expect(fs.existsSync(credentialsPath(home))).toBe(false)
  })

  it('no answer: nothing is known about the key, so nothing is saved', async () => {
    const { home, commands } = fixture()
    signupServer() // nothing scripted: the request fails like a network error
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((value) => errors.push(String(value)))

    expect(await commands.runLogin({ apiKey: fakeKey('n') })).toBe(1)

    expect(errors.join('\n')).toMatch(/^Login failed: /)
    expect(errors.join('\n')).toContain('The key was not saved.')
    expect(fs.existsSync(credentialsPath(home))).toBe(false)
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
    const apiKey = fakeKey('p')
    Object.defineProperty(process, 'stdin', { value: Readable.from([`${apiKey}\n`]), configurable: true })
    signupServer().on('GET /v1/agents/me', me('piped-agent'))
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    expect(await commands.runLogin({ apiKey: '-' })).toBe(0)
    expect(readCredentials(home)).toMatchObject({ api_key: apiKey, handle: 'piped-agent' })
  })

  it('with no --api-key, AGENTCHAT_API_KEY is used', async () => {
    const { home, commands } = fixture()
    const apiKey = fakeKey('e')
    process.env['AGENTCHAT_API_KEY'] = apiKey
    signupServer().on('GET /v1/agents/me', me('env-agent'))
    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)))

    expect(await commands.runLogin({})).toBe(0)
    expect(readCredentials(home)?.api_key).toBe(apiKey)
    expect(output.join('\n')).toContain('Using the key from AGENTCHAT_API_KEY.')
  })

  it('with no key from anywhere and no TTY, it names the prompt and stdin, never a key on a command line', async () => {
    const { commands } = fixture()
    Object.defineProperty(process, 'stdin', { value: Readable.from([]), configurable: true })
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((value) => errors.push(String(value)))

    expect(await commands.runLogin({})).toBe(1)
    expect(errors.join('\n')).toContain('login --api-key - < key.txt')
    expect(errors.join('\n')).not.toMatch(/--api-key ac_|AGENTCHAT_API_KEY=/)
  })
})

describe('a host without its own placement gets the identity block on sign-in', () => {
  it('login writes the kit block for the key’s handle into the instruction file, next to the user’s text', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-login-anchor-'))
    homes.push(home)
    const anchor = path.join(home, 'AGENTS.md')
    fs.writeFileSync(anchor, '# my rules\n')
    const commands = createIdentityCommands({
      label: 'Example',
      id: 'example',
      client: { runtime: 'generic', version: '0.0.0-test' },
      home: () => home,
      anchorFile: () => anchor,
      invocation: () => 'example',
      renderAnchor: renderAnchorBlock,
    })
    signupServer('login-agent').on('GET /v1/agents/me', me('login-agent'))
    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)))
    expect(await commands.runLogin({ apiKey: fakeKey('a') })).toBe(0)
    expect(output.join('\n')).not.toContain('FAILED')
    expect(fs.readFileSync(anchor, 'utf-8')).toBe(`# my rules\n\n${renderAnchorBlock(textsFor('login-agent').identity_line, 'login-agent')}\n`)
  })
})
