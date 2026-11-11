import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentChatClient, ConnectionError, HttpTransport, type Texts } from 'agentchatme'
import { createIdentityCommands } from '../src/identity/commands.js'
import { readCredentials, writeCredentials } from '../src/identity/credentials.js'
import { ANCHOR_END, ANCHOR_START, renderAnchorBlock } from '../src/anchor/block.js'
import type { HostProfile } from '../src/identity/host-profile.js'
import { textsFor } from './helpers/served-texts.js'

// ─── The identity commands never stop half-way on the instruction file ──────
//
// A file the commands cannot read or rewrite (permissions, a symlink loop,
// bytes that are not UTF-8) is reported, never thrown out of `status`,
// `doctor` or `logout`: logout must still take the key out of the host, and
// status and doctor must still print what they know. `doctor --fix` says
// "repaired" only when the file reads as repaired.

const homes: string[] = []
const NOT_UTF8 = Buffer.concat([Buffer.from('# R'), Buffer.from([0xe9, 0xff]), Buffer.from('\n')])

function serve(texts: (handle: string) => Texts): void {
  vi.spyOn(HttpTransport.prototype, 'request').mockImplementation((async (method: string, url: string) => {
    if (method === 'GET' && url.startsWith('/v1/texts')) return { data: texts('probe'), headers: new Headers(), status: 200, requestId: null }
    throw new ConnectionError(`offline in tests: ${method} ${url}`)
  }) as never)
}

function fixture(extra: Partial<HostProfile> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-anchor-robust-'))
  homes.push(home)
  const anchor = path.join(home, 'CLAUDE.md')
  const unplaced: unknown[] = []
  const profile: HostProfile = {
    label: 'Example',
    id: 'example',
    client: { runtime: 'generic', version: '0.0.0-test' },
    home: () => home,
    anchorFile: () => anchor,
    invocation: () => 'example',
    renderAnchor: renderAnchorBlock,
    unplace: (identity) => {
      unplaced.push(identity)
      return ['  key removed from the host']
    },
    ...extra,
  }
  writeCredentials(home, { api_key: `ac_${'s'.repeat(32)}`, handle: 'probe' })
  vi.spyOn(AgentChatClient.prototype, 'getMe').mockResolvedValue({ handle: 'probe', status: 'active' } as never)
  return { home, anchor, unplaced, commands: createIdentityCommands(profile) }
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

describe('an instruction file that cannot be read or rewritten', () => {
  it('logout reports it and still takes the key out of the host', async () => {
    serve((h) => textsFor(h))
    const { home, anchor, unplaced, commands } = fixture()
    fs.writeFileSync(anchor, NOT_UTF8)
    const { out } = capture()
    expect(commands.runLogout()).toBe(0)
    expect(readCredentials(home)).toBeNull()
    expect(unplaced).toHaveLength(1)
    const text = out.join('\n')
    expect(text).toContain(`could not remove the identity line from ${anchor}`)
    expect(text).toContain('key removed from the host')
    expect(fs.readFileSync(anchor).equals(NOT_UTF8)).toBe(true)
  })

  it('status says unreadable (and --json carries anchor_error) instead of printing nothing', async () => {
    serve((h) => textsFor(h))
    const { anchor, commands } = fixture()
    fs.writeFileSync(anchor, NOT_UTF8)
    const { out } = capture()
    expect(await commands.runStatus({})).toBe(0)
    expect(out.join('\n')).toMatch(/Identity line: unreadable — .*not UTF-8/)
    expect(await commands.runStatus({ json: true })).toBe(0)
    const parsed = JSON.parse(out.pop() ?? '{}') as Record<string, unknown>
    expect(parsed['anchor']).toBeNull()
    expect(parsed['anchor_current']).toBeNull()
    expect(String(parsed['anchor_error'])).toMatch(/not UTF-8/)
  })

  it('doctor reports a FAIL check and still prints every other check', async () => {
    serve((h) => textsFor(h))
    const { anchor, commands } = fixture()
    fs.writeFileSync(anchor, NOT_UTF8)
    const { out } = capture()
    expect(await commands.runDoctor({ fix: true })).toBe(1)
    const text = out.join('\n')
    expect(text).toMatch(/FAIL identity-line: cannot read .*not UTF-8/)
    expect(text).toContain('PASS credentials')
    expect(fs.readFileSync(anchor).equals(NOT_UTF8)).toBe(true)
  })

  it('a host check that throws is a FAIL check, not a crash', async () => {
    serve((h) => textsFor(h))
    const { commands } = fixture({
      extraDoctorChecks: () => {
        throw new Error('the host config is corrupt')
      },
    })
    const { out } = capture()
    expect(await commands.runDoctor({})).toBe(1)
    expect(out.join('\n')).toContain('FAIL host: the Example checks failed: the host config is corrupt')
  })
})

describe('the doctor reads the block by the served template and converges', () => {
  it('an unmarked block in words only today’s template knows is read as this agent’s (older text), not as missing', async () => {
    // The day the server rewords the line: a block placed in the new words without a handle line.
    const reworded = (h: string): Texts => ({
      ...textsFor(h),
      identity_line: `Hello, peers: this is @${h}, reachable on AgentChat.`,
      identity_line_template: 'Hello, peers: this is @<handle>, reachable on AgentChat.',
    })
    serve(reworded)
    const { anchor, commands } = fixture()
    fs.writeFileSync(anchor, `# mine\n\n${ANCHOR_START}\nHello, peers: this is @probe, reachable on AgentChat.\n${ANCHOR_END}\n`)
    const { out } = capture()
    await commands.runDoctor({})
    expect(out.join('\n')).toContain(`WARN identity-line: ${anchor} carries an older identity text for @probe`)
    expect(out.join('\n')).not.toContain('no identity line')
  })

  it('doctor --fix replaces an earlier release’s block in place, says repaired, and the next doctor passes', async () => {
    serve((h) => textsFor(h))
    const { anchor, commands } = fixture()
    const line = textsFor('probe').identity_line
    fs.writeFileSync(anchor, `# mine\n\n${ANCHOR_START}\n${line}\n${ANCHOR_END}\n\n## more of mine\n`)
    const { out } = capture()
    await commands.runDoctor({ fix: true })
    expect(out.join('\n')).toContain('PASS identity-line: repaired → @probe')
    expect(fs.readFileSync(anchor, 'utf-8')).toBe(`# mine\n\n${renderAnchorBlock(line, 'probe')}\n\n## more of mine\n`)
    out.length = 0
    await commands.runDoctor({})
    expect(out.join('\n')).toContain(`PASS identity-line: @probe in ${anchor}`)
  })

  it('doctor --fix does not claim a repair that did not take', async () => {
    serve((h) => textsFor(h))
    // A host that writes nothing (not wired, no block yet): the file stays without an identity line.
    const { anchor, commands } = fixture({ isWired: () => false })
    fs.writeFileSync(anchor, '# mine\n')
    const { out } = capture()
    await commands.runDoctor({ fix: true })
    expect(out.join('\n')).toMatch(/FAIL identity-line: repair did not take: .* still has no identity line/)
  })
})
