import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AgentChatClient, ConnectionError, HttpTransport } from 'agentchatme'
import { placeAnchorAt, renderAnchorBlock } from '../src/anchor/block.js'
import { renderUnregisteredBlock } from '../src/anchor/offer.js'
import { createIdentityCommands } from '../src/identity/commands.js'
import { writeCredentials } from '../src/identity/credentials.js'
import type { HostProfile } from '../src/identity/host-profile.js'
import { HANDLE, SERVED_TEMPLATE, USER_AFTER, USER_BEFORE, servedLine } from './fixtures/old-anchor-blocks.js'
import { textsFor } from './helpers/served-texts.js'

// ─── Placing the identity line: one policy for every integration ────────────
//
// A person's words are only replaced once they delete the block themselves.
// Setup (install, register, login, recover) updates this agent's block or
// places one, replaces another agent's (and says so), and leaves a block
// edited by hand (or several) with the remedy. `doctor --fix` does the same,
// but refuses another agent's block: the key or the file is wrong.

const COPY = { invoke: 'npx -y @agentchatme/example', label: 'Example' }
const NEW_LINE = servedLine().replace('Full guide', 'The full guide')
const FIX = 'npx -y @agentchatme/example doctor --fix'

let dir: string
let file: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-core-place-'))
  file = path.join(dir, 'INSTRUCTIONS.md')
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

const around = (block: string): string => `${USER_BEFORE}\n\n${block}\n\n${USER_AFTER}\n`
const snapshot = (): { bytes: string; ino: number } => ({ bytes: fs.readFileSync(file, 'utf-8'), ino: fs.statSync(file).ino })
const place = (mode: 'setup' | 'repair', extra: Partial<Parameters<typeof placeAnchorAt>[1]> = {}) =>
  placeAnchorAt(file, { handle: HANDLE, identityLine: NEW_LINE, template: SERVED_TEMPLATE, mode, fix: FIX, ...extra })
const handEdited = ['<!-- agentchat:start -->', `My rules for AgentChat (written by me): I am @${HANDLE} there.`, '<!-- agentchat:end -->'].join('\n')

for (const mode of ['setup', 'repair'] as const) {
  describe(`placeAnchorAt (${mode}) — what both setup and doctor --fix do`, () => {
    it('no file, no block, or the setup offer: the identity block is placed', () => {
      expect(place(mode)).toMatchObject({ outcome: 'placed', written: true })
      expect(fs.readFileSync(file, 'utf-8')).toBe(`${renderAnchorBlock(NEW_LINE, HANDLE)}\n`)
      for (const text of [`${USER_BEFORE}\n`, around(renderUnregisteredBlock(COPY))]) {
        fs.writeFileSync(file, text)
        expect(place(mode)).toMatchObject({ outcome: 'placed', written: true })
        expect(fs.readFileSync(file, 'utf-8')).toContain(renderAnchorBlock(NEW_LINE, HANDLE))
        expect(fs.readFileSync(file, 'utf-8')).not.toContain('no account yet')
      }
    })

    it('this agent\'s stale block is updated in place (marked, or an exact older served text); a current one is not rewritten', () => {
      for (const block of [renderAnchorBlock(servedLine(), HANDLE), ['<!-- agentchat:start -->', servedLine(), '<!-- agentchat:end -->'].join('\n')]) {
        fs.writeFileSync(file, around(block))
        expect(place(mode)).toMatchObject({ outcome: 'updated', written: true })
        expect(fs.readFileSync(file, 'utf-8')).toBe(around(renderAnchorBlock(NEW_LINE, HANDLE)))
      }
      const before = snapshot()
      expect(place(mode)).toMatchObject({ outcome: 'unchanged', written: false })
      expect(snapshot()).toEqual(before)
    })

    it('a block edited by hand is left, with the remedy: delete that block, then run doctor --fix', () => {
      fs.writeFileSync(file, around(handEdited))
      const before = snapshot()
      const result = place(mode)
      expect(result).toMatchObject({ outcome: 'hand_edited', written: false })
      expect(result.detail).toBe(`the AgentChat block in ${file} was edited by hand, so it is left; to have the served line, delete that block, then run \`${FIX}\``)
      expect(snapshot()).toEqual(before)
    })

    it('more than one AgentChat block is left, with the remedy', () => {
      fs.writeFileSync(file, around(`${renderAnchorBlock(servedLine(), HANDLE)}\n\n${handEdited}`))
      const before = snapshot()
      const result = place(mode)
      expect(result).toMatchObject({ outcome: 'several_blocks', written: false })
      expect(result.detail).toContain('to have the served line, delete them, then run')
      expect(snapshot()).toEqual(before)
    })

    it('a served line that does not name this agent is never written', () => {
      fs.writeFileSync(file, around(renderAnchorBlock(servedLine(), HANDLE)))
      const before = snapshot()
      expect(place(mode, { identityLine: servedLine('someone-else') })).toMatchObject({ outcome: 'failed', written: false })
      expect(snapshot()).toEqual(before)
    })
  })
}

describe('another agent\'s block: setup replaces it and says so; doctor --fix refuses', () => {
  it('setup (the key just set is the agent this file is for)', () => {
    fs.writeFileSync(file, around(renderAnchorBlock(servedLine('someone-else'), 'someone-else')))
    const result = place('setup')
    expect(result).toMatchObject({ outcome: 'replaced_other', written: true, claimed: 'someone-else' })
    expect(result.detail).toBe(`replaced @someone-else's identity line in ${file} with @${HANDLE}'s`)
    expect(fs.readFileSync(file, 'utf-8')).toBe(around(renderAnchorBlock(NEW_LINE, HANDLE)))
  })

  it('repair (the key or the file is wrong: which, the person says)', () => {
    fs.writeFileSync(file, around(renderAnchorBlock(servedLine('someone-else'), 'someone-else')))
    const before = snapshot()
    const result = place('repair')
    expect(result).toMatchObject({ outcome: 'other_agent', written: false, claimed: 'someone-else' })
    expect(result.detail).toBe(`${file} says @someone-else but this agent is @${HANDLE}; it is left — fix the key, or remove that block`)
    expect(snapshot()).toEqual(before)
  })
})

describe('doctor --fix writes only where it takes nothing of anyone\'s', () => {
  function fixture(): { anchor: string; commands: ReturnType<typeof createIdentityCommands> } {
    const home = fs.mkdtempSync(path.join(dir, 'home-'))
    const anchor = path.join(dir, 'CLAUDE.md')
    const profile: HostProfile = {
      label: 'Example',
      id: 'example',
      client: { runtime: 'generic', version: '0.0.0-test' },
      home: () => home,
      anchorFile: () => anchor,
      invocation: () => 'example',
      renderAnchor: renderAnchorBlock,
    }
    writeCredentials(home, { api_key: `ac_${'d'.repeat(32)}`, handle: 'probe' })
    vi.spyOn(HttpTransport.prototype, 'request').mockImplementation((async (method: string, url: string) => {
      if (method === 'GET' && url.startsWith('/v1/texts')) return { data: textsFor('probe'), headers: new Headers(), status: 200, requestId: null }
      throw new ConnectionError(`offline in tests: ${method} ${url}`)
    }) as never)
    vi.spyOn(AgentChatClient.prototype, 'getMe').mockResolvedValue({ handle: 'probe', status: 'active' } as never)
    return { anchor, commands: createIdentityCommands(profile) }
  }
  const capture = (): string[] => {
    const out: string[] = []
    vi.spyOn(console, 'log').mockImplementation((v) => out.push(...String(v).split('\n')))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    return out
  }
  const served = textsFor('probe').identity_line

  it('a block edited by hand stays through doctor --fix, said with the remedy; deleted by the person, the next --fix places the served block', async () => {
    const { anchor, commands } = fixture()
    const theirs = `# mine\n\n<!-- agentchat:start -->\nMy own rules: I am @probe here.\n<!-- agentchat:end -->\n`
    fs.writeFileSync(anchor, theirs)
    const out = capture()
    await commands.runDoctor({ fix: true })
    expect(fs.readFileSync(anchor, 'utf-8')).toBe(theirs)
    expect(out.find((l) => l.includes('identity-line'))).toBe(
      `WARN identity-line: the AgentChat block in ${anchor} was edited by hand (no handle line, and not a text AgentChat served), so it is left; to have the served line, delete that block, then run \`example doctor --fix\``,
    )
    fs.writeFileSync(anchor, '# mine\n')
    out.length = 0
    await commands.runDoctor({ fix: true })
    expect(fs.readFileSync(anchor, 'utf-8')).toBe(`# mine\n\n${renderAnchorBlock(served, 'probe')}\n`)
    expect(out).toContain('PASS identity-line: repaired → @probe')
  })

  it('another agent\'s block is refused by doctor --fix; this agent\'s stale block is updated', async () => {
    const { anchor, commands } = fixture()
    const other = `# mine\n\n${renderAnchorBlock(textsFor('someone-else').identity_line, 'someone-else')}\n`
    fs.writeFileSync(anchor, other)
    const out = capture()
    await commands.runDoctor({ fix: true })
    expect(fs.readFileSync(anchor, 'utf-8')).toBe(other)
    expect(out.find((l) => l.includes('identity-line'))).toBe(`WARN identity-line: ${anchor} says @someone-else but this agent is @probe — fix the key, or remove that block`)

    fs.writeFileSync(anchor, `# mine\n\n${renderAnchorBlock('I am @probe on AgentChat. An older line.', 'probe')}\n`)
    out.length = 0
    await commands.runDoctor({ fix: true })
    expect(fs.readFileSync(anchor, 'utf-8')).toBe(`# mine\n\n${renderAnchorBlock(served, 'probe')}\n`)
    expect(out).toContain('PASS identity-line: repaired → @probe')
  })
})
