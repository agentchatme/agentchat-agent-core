import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIdentityCommands } from '../src/identity/commands.js'
import { renderAnchorBlock } from '../src/anchor/block.js'
import { renderUnregisteredBlock } from '../src/anchor/offer.js'
import { credentialsPath, envKeyConflict, readCredentials, resolveIdentity, writeCredentials } from '../src/identity/credentials.js'
import type { DoctorContext, HostProfile } from '../src/identity/host-profile.js'
import { fakeKey, me, signupServer } from './helpers/signup-server.js'

// ─── An exported AGENTCHAT_API_KEY never speaks for another agent ───────────
//
// Found in testing: with another agent's key exported in the
// shell, `status` showed the other agent as this one, and `doctor --fix`
// wrote the other agent's key into the runtime's config, so the runs then
// acted as that agent. The home's `credentials` name the agent; an exported
// key that differs is refused in words, never adopted.

const homes: string[] = []
const HOME_KEY = fakeKey('h')
const OTHER_KEY = fakeKey('o')

interface Fixture {
  home: string
  commands: ReturnType<typeof createIdentityCommands>
  placed: Array<{ handle: string; apiKey: string }>
  doctorContexts: DoctorContext[]
}

function fixture(): Fixture {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-env-key-'))
  homes.push(home)
  const placed: Array<{ handle: string; apiKey: string }> = []
  const doctorContexts: DoctorContext[] = []
  const profile: HostProfile = {
    label: 'Codex',
    id: 'codex',
    client: { runtime: 'generic', version: '0.0.0-test' },
    home: () => home,
    anchorFile: () => path.join(home, 'AGENTS.md'),
    invocation: () => 'npx -y @agentchatme/codex',
    renderAnchor: renderAnchorBlock,
    place: async (handle, apiKey) => {
      placed.push({ handle, apiKey })
      return []
    },
    extraDoctorChecks: async (ctx) => {
      doctorContexts.push(ctx)
      return []
    },
  }
  return { home, commands: createIdentityCommands(profile), placed, doctorContexts }
}

const realEnvKey = process.env['AGENTCHAT_API_KEY']
beforeEach(() => {
  delete process.env['AGENTCHAT_API_KEY']
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (realEnvKey === undefined) delete process.env['AGENTCHAT_API_KEY']
  else process.env['AGENTCHAT_API_KEY'] = realEnvKey
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

function capture(): { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  vi.spyOn(console, 'log').mockImplementation((value) => out.push(String(value)))
  vi.spyOn(console, 'error').mockImplementation((value) => err.push(String(value)))
  return { out, err }
}

describe('resolveIdentity: the home names the agent', () => {
  it('an exported key that is not the home’s never becomes the identity', () => {
    const { home } = fixture()
    writeCredentials(home, { api_key: HOME_KEY, handle: 'home-agent' })
    process.env['AGENTCHAT_API_KEY'] = OTHER_KEY
    expect(resolveIdentity(home)).toMatchObject({ apiKey: HOME_KEY, handle: 'home-agent', source: 'file' })
  })

  it('the same key exported is the same agent', () => {
    const { home } = fixture()
    writeCredentials(home, { api_key: HOME_KEY, handle: 'home-agent' })
    process.env['AGENTCHAT_API_KEY'] = HOME_KEY
    expect(resolveIdentity(home)).toMatchObject({ apiKey: HOME_KEY, handle: 'home-agent', source: 'file' })
  })

  it('a home with no key still takes an exported one (CI, an externally managed secret)', () => {
    const { home } = fixture()
    process.env['AGENTCHAT_API_KEY'] = OTHER_KEY
    expect(resolveIdentity(home)).toMatchObject({ apiKey: OTHER_KEY, handle: null, source: 'env' })
  })
})

describe('envKeyConflict', () => {
  it('names the conflict only when both keys exist and differ', () => {
    const { home } = fixture()
    expect(envKeyConflict(home, { AGENTCHAT_API_KEY: OTHER_KEY })).toBeNull()
    writeCredentials(home, { api_key: HOME_KEY, handle: 'home-agent' })
    expect(envKeyConflict(home, {})).toBeNull()
    expect(envKeyConflict(home, { AGENTCHAT_API_KEY: HOME_KEY })).toBeNull()
    const said = envKeyConflict(home, { AGENTCHAT_API_KEY: OTHER_KEY })
    expect(said).toContain('AGENTCHAT_API_KEY is exported')
    expect(said).toContain(credentialsPath(home))
    expect(said).not.toContain(OTHER_KEY)
    expect(said).not.toContain(HOME_KEY)
  })
})

describe('the identity commands refuse a foreign exported key', () => {
  it('status refuses in words, names no other agent and asks the server nothing', async () => {
    const { home, commands } = fixture()
    writeCredentials(home, { api_key: HOME_KEY, handle: 'home-agent' })
    process.env['AGENTCHAT_API_KEY'] = OTHER_KEY
    const server = signupServer()
    const { out, err } = capture()

    expect(await commands.runStatus({})).toBe(1)

    expect(server.calls).toHaveLength(0)
    expect(err.join('\n')).toContain('AGENTCHAT_API_KEY is exported')
    expect(err.join('\n')).toMatch(/unset AGENTCHAT_API_KEY/i)
    expect([...out, ...err].join('\n')).not.toContain(OTHER_KEY)
  })

  it('status --json says so as an error object', async () => {
    const { home, commands } = fixture()
    writeCredentials(home, { api_key: HOME_KEY, handle: 'home-agent' })
    process.env['AGENTCHAT_API_KEY'] = OTHER_KEY
    signupServer()
    const { out } = capture()

    expect(await commands.runStatus({ json: true })).toBe(1)

    const parsed = JSON.parse(out.join('\n')) as { error?: { kind?: string } }
    expect(parsed.error?.kind).toBe('env_key_conflict')
  })

  it('doctor fails the env-key check, checks the home’s key, and --fix places the home’s key only', async () => {
    const { home, commands, placed, doctorContexts } = fixture()
    writeCredentials(home, { api_key: HOME_KEY, handle: 'home-agent' })
    fs.writeFileSync(path.join(home, 'AGENTS.md'), '# rules\n')
    process.env['AGENTCHAT_API_KEY'] = OTHER_KEY
    const server = signupServer('home-agent').on('GET /v1/agents/me', me('home-agent'))
    const { out } = capture()

    expect(await commands.runDoctor({ fix: true })).toBe(1)

    const report = out.join('\n')
    expect(report).toMatch(/FAIL env-key: AGENTCHAT_API_KEY is exported/)
    expect(report).toContain('PASS api-auth: @home-agent')
    expect(server.calls.map((c) => c.headers['authorization'])).toEqual([`Bearer ${HOME_KEY}`])
    expect(placed.length).toBeGreaterThan(0)
    for (const p of placed) expect(p.apiKey).toBe(HOME_KEY)
    expect(doctorContexts).toHaveLength(1)
    expect(report).not.toContain(OTHER_KEY)
  })

  it('login with no --api-key does not adopt an exported key that is not the home’s', async () => {
    const { home, commands } = fixture()
    writeCredentials(home, { api_key: HOME_KEY, handle: 'home-agent' })
    process.env['AGENTCHAT_API_KEY'] = OTHER_KEY
    const server = signupServer()
    const { err } = capture()

    expect(await commands.runLogin({})).toBe(1)

    expect(server.calls).toHaveLength(0)
    expect(readCredentials(home)?.api_key).toBe(HOME_KEY)
    expect(err.join('\n')).toContain('AGENTCHAT_API_KEY is exported')
    expect(err.join('\n')).toContain('login --api-key -')
  })
})

describe('no printed step puts a key on a command line', () => {
  it('login with no key and no terminal points at a prompt or stdin, never at a key argument or the environment', async () => {
    const { commands } = fixture()
    const { Readable } = await import('node:stream')
    const realStdin = process.stdin
    Object.defineProperty(process, 'stdin', { value: Readable.from([]), configurable: true })
    try {
      const { err } = capture()
      expect(await commands.runLogin({})).toBe(1)
      const said = err.join('\n')
      expect(said).toContain('login --api-key - <')
      expect(said).not.toMatch(/--api-key ac_|--api-key <ac|AGENTCHAT_API_KEY=|printf %s "\$KEY"/)
    } finally {
      Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true })
    }
  })

  it('a key given as an argument still works, and the output says where it was seen', async () => {
    const { commands } = fixture()
    signupServer().on('GET /v1/agents/me', me('argv-agent'))
    const { out } = capture()

    expect(await commands.runLogin({ apiKey: HOME_KEY })).toBe(0)

    expect(out.join('\n')).toMatch(/command line/)
    expect(out.join('\n')).toContain('--api-key -')
    expect(out.join('\n')).not.toContain(HOME_KEY)
  })

  it('the setup offer sends an existing key through a file on stdin, never the conversation or a command line', () => {
    const block = renderUnregisteredBlock({ invoke: 'npx -y @agentchatme/codex', label: 'Codex' })
    expect(block).not.toMatch(/--api-key <ac|--api-key ac_/)
    expect(block).toContain('npx -y @agentchatme/codex login --api-key - < <that file>')
    expect(block).toContain('the key never goes in this chat or on a command line')
    expect(block).not.toMatch(/own terminal/)
  })
})
