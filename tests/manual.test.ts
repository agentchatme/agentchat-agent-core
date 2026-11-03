import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { MANUAL, MANUAL_URL, manualCarriesIdentityLine, manualPointer, manualVersion } from '../src/skill/manual.js'
import { IDENTITY_LINE_TEMPLATE, renderIdentityLine } from '../src/skill/identity-line.js'
import { renderAnchorBlock, readAnchorHandleFrom, ANCHOR_START, ANCHOR_END } from '../src/anchor/block.js'

// ─── The manual is bundled verbatim; the identity line is the manual's ──────

const SOURCE = path.join(__dirname, '..', 'src', 'skill', 'agentchat.skill.md')

describe('the bundled manual', () => {
  it('is byte-identical to src/skill/agentchat.skill.md (regenerate with scripts/embed-manual.mjs)', () => {
    // `.gitattributes` pins LF; the normalization below only guards a checkout
    // that ignored it, so the comparison is about content, not line endings.
    expect(MANUAL).toBe(fs.readFileSync(SOURCE, 'utf-8').replace(/\r\n/g, '\n'))
  })

  it('is the published skill: front matter names it and versions it', () => {
    expect(MANUAL.startsWith('---\nname: agentchat\n')).toBe(true)
    expect(manualVersion()).toMatch(/^\d+\.\d+\.\d+$/)
    expect(MANUAL).toContain(MANUAL_URL.replace('https://', ''))
  })

  it('is the version the platform publishes — a stale bundle is a deliberate choice, not drift', () => {
    // Bump this with the two-command refresh (README § Refreshing the manual)
    // when https://agentchat.me/skill.md moves on. The Hermes and OpenClaw
    // doorbells place the same version.
    expect(manualVersion()).toBe('2.1.2')
  })

  it('carries the identity line template verbatim — the engine writes what the manual publishes', () => {
    expect(manualCarriesIdentityLine()).toBe(true)
    expect(MANUAL).toContain(IDENTITY_LINE_TEMPLATE)
  })

  it('is not this package’s own words: it names no CLI invocation of ours', () => {
    expect(MANUAL).not.toContain('npx -y @agentchatme/')
  })

  it('the pointer line names the skill and the public address', () => {
    const pointer = manualPointer('at ~/skills/agentchat/SKILL.md')
    expect(pointer).toContain('agentchat skill')
    expect(pointer).toContain(MANUAL_URL)
  })
})

describe('the identity line', () => {
  it('substitutes the handle and nothing else', () => {
    const line = renderIdentityLine('@Alice-Dev')
    expect(line).toBe(IDENTITY_LINE_TEMPLATE.split('<handle>').join('alice-dev'))
    expect(line).not.toContain('<handle>')
    expect(line).toContain('I am @alice-dev on AgentChat')
  })

  it('refuses an empty handle', () => {
    expect(() => renderIdentityLine('  @ ')).toThrow(/empty/)
  })

  it('is what the anchor block carries, and reads back', () => {
    const block = renderAnchorBlock('agent-a')
    expect(block).toBe(`${ANCHOR_START}\n${renderIdentityLine('agent-a')}\n${ANCHOR_END}`)
    expect(readAnchorHandleFrom(block)).toBe('agent-a')
  })

  it('still reads the pre-doorbell block so doctor can refresh it', () => {
    expect(readAnchorHandleFrom(`${ANCHOR_START}\nYou are **@old-agent** on AgentChat.\n${ANCHOR_END}`)).toBe('old-agent')
  })
})
