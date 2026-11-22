import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { removeAnchorAt, renderAnchorBlock, writeOfferAt } from '../src/anchor/block.js'
import { renderDeclinedBlock, renderUnregisteredBlock } from '../src/anchor/offer.js'
import { createIdentityCommands } from '../src/identity/commands.js'
import { writeCredentials } from '../src/identity/credentials.js'
import type { HostProfile } from '../src/identity/host-profile.js'
import { HANDLE, SERVED_TEMPLATE, USER_AFTER, USER_BEFORE, servedLine } from './fixtures/old-anchor-blocks.js'
import { mockServedTexts, textsFor, writeTextsCacheFile } from './helpers/served-texts.js'

// ─── Removing AgentChat removes only what AgentChat placed for this agent ───
//
// Logout and uninstall take out this agent's identity block (the kit's strict
// owner: its handle line, or a whole text that is exactly a served one) and
// the setup offer. A block a person wrote inside the markers, another agent's
// block, or a file with several blocks is left exactly as it is, and said.

const COPY = { invoke: 'npx -y @agentchatme/example', label: 'Example' }
const NEW_LINE = servedLine().replace('Full guide', 'The full guide')

let dir: string
let file: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-core-remove-'))
  file = path.join(dir, 'INSTRUCTIONS.md')
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

const around = (block: string): string => `${USER_BEFORE}\n\n${block}\n\n${USER_AFTER}\n`
const userOnly = `${USER_BEFORE}\n\n${USER_AFTER}\n`
const snapshot = (): { bytes: string; ino: number } => ({ bytes: fs.readFileSync(file, 'utf-8'), ino: fs.statSync(file).ino })
const remove = (extra: Partial<Parameters<typeof removeAnchorAt>[1]> = {}) => removeAnchorAt(file, { handle: HANDLE, identityLine: NEW_LINE, template: SERVED_TEMPLATE, ...extra })

describe('removeAnchorAt — only this agent\'s block, or the setup offer', () => {
  it('this agent\'s block goes, current or stale, marked or an exact served text: the user\'s text kept byte for byte', () => {
    for (const block of [
      renderAnchorBlock(NEW_LINE, HANDLE),
      renderAnchorBlock('I am @example-relay on AgentChat. A line served long ago.', HANDLE),
      ['<!-- agentchat:start -->', servedLine(), '<!-- agentchat:end -->'].join('\n'),
    ]) {
      fs.writeFileSync(file, around(block))
      expect(remove()).toMatchObject({ action: 'removed', kept: null, claimed: HANDLE })
      expect(fs.readFileSync(file, 'utf-8')).toBe(userOnly)
    }
  })

  it('the setup offer and its declined variant go (they are AgentChat\'s own), with or without a handle', () => {
    for (const block of [renderUnregisteredBlock(COPY), renderDeclinedBlock(COPY)]) {
      fs.writeFileSync(file, around(block))
      expect(remove({ handle: null }).action).toBe('removed')
      expect(fs.readFileSync(file, 'utf-8')).toBe(userOnly)
    }
  })

  it('a block the user wrote inside the markers is left, even when it names this agent, and said', () => {
    for (const words of ['My own AgentChat rules: answer briefly.', `My rules for AgentChat (written by me): I am @${HANDLE} there.`]) {
      fs.writeFileSync(file, around(['<!-- agentchat:start -->', words, '<!-- agentchat:end -->'].join('\n')))
      const before = snapshot()
      const result = remove()
      expect(result).toMatchObject({ action: 'kept', kept: 'hand_edited', claimed: null })
      expect(result.detail).toBe(`left your edited AgentChat block in ${file}; remove it by hand if you no longer want it`)
      expect(snapshot()).toEqual(before)
    }
  })

  it('another agent\'s block is left, and named', () => {
    fs.writeFileSync(file, around(renderAnchorBlock(servedLine('someone-else'), 'someone-else')))
    const before = snapshot()
    const result = remove()
    expect(result).toMatchObject({ action: 'kept', kept: 'other_agent', claimed: 'someone-else' })
    expect(result.detail).toContain("left @someone-else's AgentChat block")
    expect(snapshot()).toEqual(before)
  })

  it('with no handle (no identity in the home) an identity block is nobody\'s to remove: left', () => {
    fs.writeFileSync(file, around(renderAnchorBlock(NEW_LINE, HANDLE)))
    const before = snapshot()
    expect(remove({ handle: null })).toMatchObject({ action: 'kept', kept: 'other_agent', claimed: HANDLE })
    expect(snapshot()).toEqual(before)
  })

  it('a file with more than one AgentChat block is left whole: which are this agent\'s is not certain', () => {
    fs.writeFileSync(file, `${USER_BEFORE}\n\n${renderAnchorBlock(NEW_LINE, HANDLE)}\n\n${['<!-- agentchat:start -->', 'mine', '<!-- agentchat:end -->'].join('\n')}\n`)
    const before = snapshot()
    expect(remove()).toMatchObject({ action: 'kept', kept: 'several_blocks' })
    expect(snapshot()).toEqual(before)
  })

  it('no file and no block are no-ops; nothing is created', () => {
    expect(remove().action).toBe('noop')
    expect(fs.existsSync(file)).toBe(false)
    fs.writeFileSync(file, userOnly)
    const before = snapshot()
    expect(remove().action).toBe('noop')
    expect(snapshot()).toEqual(before)
  })

  it('keeps a CRLF file CRLF, whether it ends with a line break, and a byte-order mark', () => {
    const crlf = (t: string): string => t.replace(/\n/g, '\r\n')
    fs.writeFileSync(file, crlf(`﻿${USER_BEFORE}\n\n${renderAnchorBlock(NEW_LINE, HANDLE)}\n\n${USER_AFTER}`))
    expect(remove().action).toBe('removed')
    expect(fs.readFileSync(file, 'utf-8')).toBe(crlf(`﻿${USER_BEFORE}\n\n${USER_AFTER}`))
  })
})

describe('writeOfferAt — the setup offer takes nothing of anyone\'s', () => {
  it('appends where there is no block, and replaces only the offer or its declined variant', () => {
    fs.writeFileSync(file, `${USER_BEFORE}\n`)
    expect(writeOfferAt(file, renderUnregisteredBlock(COPY)).action).toBe('written')
    expect(fs.readFileSync(file, 'utf-8')).toBe(`${USER_BEFORE}\n\n${renderUnregisteredBlock(COPY)}\n`)
    expect(writeOfferAt(file, renderDeclinedBlock(COPY)).action).toBe('written')
    expect(fs.readFileSync(file, 'utf-8')).toBe(`${USER_BEFORE}\n\n${renderDeclinedBlock(COPY)}\n`)
  })

  it('leaves a block edited by hand, an identity block, and several blocks, and says so', () => {
    for (const block of [
      ['<!-- agentchat:start -->', 'My own AgentChat rules.', '<!-- agentchat:end -->'].join('\n'),
      renderAnchorBlock(NEW_LINE, HANDLE),
      `${renderUnregisteredBlock(COPY)}\n\n${renderAnchorBlock(NEW_LINE, HANDLE)}`,
    ]) {
      fs.writeFileSync(file, around(block))
      const before = snapshot()
      const result = writeOfferAt(file, renderUnregisteredBlock(COPY))
      expect(result.action).toBe('kept')
      expect(result.detail).toContain('the offer is not written over')
      expect(snapshot()).toEqual(before)
    }
  })
})

describe('logout takes out only this agent\'s block', () => {
  function fixture(): { home: string; anchor: string; commands: ReturnType<typeof createIdentityCommands> } {
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
    writeCredentials(home, { api_key: `ac_${'w'.repeat(32)}`, handle: 'probe' })
    mockServedTexts('probe')
    return { home, anchor, commands: createIdentityCommands(profile) }
  }
  const capture = (): string[] => {
    const out: string[] = []
    vi.spyOn(console, 'log').mockImplementation((v) => out.push(String(v)))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    return out
  }

  it('removes this agent\'s block (read with the kept texts), keeps the user\'s text', () => {
    const { home, anchor, commands } = fixture()
    // An unmarked block in the served words: this agent's only by the kept texts' exact line.
    writeTextsCacheFile(home, 'generic', { ...textsFor('probe'), identity_line: 'Probe speaks here as @probe on AgentChat.', identity_line_template: 'Probe speaks here as @<handle> on AgentChat.' }, new Date())
    fs.writeFileSync(anchor, `${USER_BEFORE}\n\n<!-- agentchat:start -->\nProbe speaks here as @probe on AgentChat.\n<!-- agentchat:end -->\n`)
    const out = capture()
    expect(commands.runLogout()).toBe(0)
    expect(fs.readFileSync(anchor, 'utf-8')).toBe(`${USER_BEFORE}\n`)
    expect(out.join('\n')).toContain('identity line removed')
  })

  it('leaves a block the user wrote, and another agent\'s, and says so', () => {
    for (const block of [['<!-- agentchat:start -->', 'I am @probe here, and these are my rules.', '<!-- agentchat:end -->'].join('\n'), renderAnchorBlock(servedLine('someone-else'), 'someone-else')]) {
      const { anchor, commands } = fixture()
      const text = `${USER_BEFORE}\n\n${block}\n`
      fs.writeFileSync(anchor, text)
      const out = capture()
      expect(commands.runLogout()).toBe(0)
      expect(fs.readFileSync(anchor, 'utf-8')).toBe(text)
      expect(out.join('\n')).toMatch(/left (your edited|@someone-else's) AgentChat block in .*; remove it by hand if you no longer want it/)
      vi.restoreAllMocks()
    }
  })
})
