import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentChatClient } from 'agentchatme'
import { createIdentityCommands } from '../src/identity/commands.js'
import { writeCredentials } from '../src/identity/credentials.js'
import type { DoctorContext, HostProfile, StatusContext } from '../src/identity/host-profile.js'
import type { ServedManual } from '../src/skill/served-manual.js'
import { MANUAL_VERSION, mockServedTexts } from './helpers/served-texts.js'

// ─── The identity commands hand the host the manual the texts announce ──────
//
// The skill file follows the served manual, so the host's `place`,
// `extraStatus` and `extraDoctorChecks` need `texts.manual` — from the same one
// fetch per command that yields the identity line, never a second one. `place`
// and `extraDoctorChecks` may be async (a download), and are awaited.

const homes: string[] = []
const ANNOUNCED: ServedManual = { url: 'https://agentchat.me/skill.md', version: MANUAL_VERSION }

function fixture(extra: Partial<HostProfile>): { home: string; commands: ReturnType<typeof createIdentityCommands>; request: ReturnType<typeof mockServedTexts> } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-served-manual-cmd-'))
  homes.push(home)
  const profile: HostProfile = {
    label: 'Example',
    id: 'example',
    client: { runtime: 'generic', version: '0.0.0-test' },
    home: () => home,
    anchorFile: () => path.join(home, 'ANCHOR.md'),
    invocation: () => 'npx -y @agentchatme/example',
    renderAnchor: (line) => line,
    ...extra,
  }
  const request = mockServedTexts('probe')
  return { home, commands: createIdentityCommands(profile), request }
}

function capture(): string[] {
  const out: string[] = []
  vi.spyOn(console, 'log').mockImplementation((v) => out.push(String(v)))
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  return out
}

const textsCalls = (request: ReturnType<typeof mockServedTexts>): number => request.mock.calls.filter(([, p]) => String(p).startsWith('/v1/texts')).length

afterEach(() => {
  vi.restoreAllMocks()
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

describe('the announced manual reaches the host', () => {
  it('login: `place` gets the identity line AND the announced manual, and an async place is awaited', async () => {
    const seen: Array<[string, string | null, ServedManual | null]> = []
    const { commands, request } = fixture({
      place: async (handle, _key, line, manual) => {
        await new Promise((r) => setTimeout(r, 10))
        seen.push([handle, line, manual])
        return ['  manual: placed (async)']
      },
    })
    vi.spyOn(AgentChatClient.prototype, 'getMe').mockResolvedValue({ handle: 'probe' } as never)
    const out = capture()
    expect(await commands.runLogin({ apiKey: `ac_${'l'.repeat(32)}` })).toBe(0)
    expect(seen).toEqual([['probe', 'I am @probe on AgentChat (api.agentchat.me). Served identity line for generic.', ANNOUNCED]])
    expect(out.join('\n')).toContain('  manual: placed (async)')
    expect(textsCalls(request)).toBe(1)
  })

  it('status: `extraStatus` gets the manual from the one texts fetch', async () => {
    const seen: StatusContext[] = []
    const { home, commands, request } = fixture({
      extraStatus: (ctx) => {
        seen.push(ctx)
        return []
      },
    })
    writeCredentials(home, { api_key: `ac_${'s'.repeat(32)}`, handle: 'probe' })
    vi.spyOn(AgentChatClient.prototype, 'getMe').mockResolvedValue({ handle: 'probe', status: 'active' } as never)
    capture()
    expect(await commands.runStatus({})).toBe(0)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.manual).toEqual(ANNOUNCED)
    expect(textsCalls(request)).toBe(1)
  })

  it('doctor: an async `extraDoctorChecks` gets the manual and its checks are printed', async () => {
    const seen: DoctorContext[] = []
    const { home, commands, request } = fixture({
      extraDoctorChecks: async (ctx) => {
        seen.push(ctx)
        return [{ name: 'manual', verdict: 'PASS', detail: `current (${ctx.manual?.version})` }]
      },
    })
    writeCredentials(home, { api_key: `ac_${'s'.repeat(32)}`, handle: 'probe' })
    vi.spyOn(AgentChatClient.prototype, 'getMe').mockResolvedValue({ handle: 'probe', status: 'active' } as never)
    const out = capture()
    await commands.runDoctor({})
    expect(seen[0]).toMatchObject({ manual: ANNOUNCED })
    expect(out.join('\n')).toContain(`PASS manual: current (${MANUAL_VERSION})`)
    expect(textsCalls(request)).toBe(1)
  })

  it('doctor with no identity: the host is told nothing is announced (null), not a guess', async () => {
    const seen: DoctorContext[] = []
    const { commands } = fixture({
      extraDoctorChecks: (ctx) => {
        seen.push(ctx)
        return []
      },
    })
    capture()
    await commands.runDoctor({})
    expect(seen[0]).toMatchObject({ manual: null, identityLine: null })
  })
})
