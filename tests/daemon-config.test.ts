import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveDaemonConfig, wsUrlFor } from '../src/daemon/config.js'
import { planForTest } from '../src/daemon/service.js'

// The daemon half of the "one command, one agent" rule: resolution is driven
// ONLY by the home it is handed, and the service it installs runs ONLY the
// entry it is handed. Both used to be inferred, and both inferred wrong.

let root: string
let homeA: string
let homeB: string

const creds = (handle: string, apiBase?: string): string =>
  JSON.stringify({ api_key: 'ac_' + 'x'.repeat(32), handle, ...(apiBase ? { api_base: apiBase } : {}) })

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-daemon-'))
  homeA = path.join(root, 'a')
  homeB = path.join(root, 'b')
  fs.mkdirSync(homeA, { recursive: true })
  fs.mkdirSync(homeB, { recursive: true })
  delete process.env['AGENTCHAT_API_KEY']
  delete process.env['AGENTCHAT_API_BASE']
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('wsUrlFor', () => {
  it('derives the socket URL from the API base', () => {
    expect(wsUrlFor('https://api.agentchat.me')).toBe('wss://api.agentchat.me/v1/ws')
    expect(wsUrlFor('http://localhost:3000')).toBe('ws://localhost:3000/v1/ws')
  })

  it('tolerates a trailing slash rather than producing a double slash', () => {
    expect(wsUrlFor('https://api.agentchat.me/')).toBe('wss://api.agentchat.me/v1/ws')
  })
})

describe('resolveDaemonConfig reads the home it is GIVEN', () => {
  it('resolves from that home and nowhere else', async () => {
    fs.writeFileSync(path.join(homeA, 'credentials'), creds('agent-a'))
    fs.writeFileSync(path.join(homeB, 'credentials'), creds('agent-b'))

    const a = await resolveDaemonConfig({ home: homeA })
    const b = await resolveDaemonConfig({ home: homeB })

    expect(a.handle).toBe('agent-a')
    expect(b.handle).toBe('agent-b')
    expect(a.home).toBe(path.resolve(homeA))
  })

  it('defaults the workdir inside its own home, so two daemons never share scratch', async () => {
    fs.writeFileSync(path.join(homeA, 'credentials'), creds('agent-a'))
    fs.writeFileSync(path.join(homeB, 'credentials'), creds('agent-b'))

    const a = await resolveDaemonConfig({ home: homeA })
    const b = await resolveDaemonConfig({ home: homeB })

    expect(a.workdir).toBe(path.join(path.resolve(homeA), 'daemon-workdir'))
    expect(a.workdir).not.toBe(b.workdir)
  })

  it('honours a per-agent api_base when deriving the socket URL', async () => {
    fs.writeFileSync(path.join(homeA, 'credentials'), creds('agent-a', 'http://localhost:3000'))
    const a = await resolveDaemonConfig({ home: homeA })
    expect(a.wsUrl).toBe('ws://localhost:3000/v1/ws')
  })

  it('refuses to start against a home with no identity', async () => {
    await expect(resolveDaemonConfig({ home: homeB })).rejects.toThrow(/no AgentChat identity/)
  })
})

describe('the installed service runs the entry it was given', () => {
  it('uses the supplied daemon entry verbatim', () => {
    const p = planForTest({ label: 'agentchatd-x', home: homeA, entry: '/stable/path/daemon.js' })
    expect(p.bin).toBe('/stable/path/daemon.js')
  })

  it('does NOT fall back to the running CLI', () => {
    // The regression this replaces: `bin` defaulted to process.argv[1], so the
    // unit ran the CLI — which has no daemon in it, exited 1, and restart-looped
    // forever while `daemon status` reported always-on was on.
    const p = planForTest({ label: 'agentchatd-x', home: homeA, entry: '/stable/path/daemon.js' })
    expect(p.bin).not.toBe(process.argv[1])
  })

  it('resolves a relative entry to an absolute path — a unit has no cwd', () => {
    const p = planForTest({ label: 'agentchatd-x', home: homeA, entry: 'rel/daemon.js' })
    expect(path.isAbsolute(p.bin)).toBe(true)
  })
})
