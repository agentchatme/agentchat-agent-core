import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { MANUAL, MANUAL_URL, manualPointer, manualVersion } from '../src/skill/manual.js'
import { identityLineOf, normalizeHandle } from '../src/skill/identity-line.js'
import { renderAnchorBlock, readAnchorHandleFrom, ANCHOR_START, ANCHOR_END } from '../src/anchor/block.js'
import { textsFor } from './helpers/served-texts.js'

// ─── The manual is bundled verbatim; the identity line is served, only placed ─

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
    // when https://agentchat.me/skill.md moves on. The served texts carry the
    // manual's version too (`manual.version`); `status` shows both.
    expect(manualVersion()).toBe('2.1.2')
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
  it('carries no template of its own: the package has no identity text to render', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'skill', 'identity-line.ts'), 'utf-8')
    expect(source).not.toMatch(/I am @/)
    expect(source).not.toMatch(/IDENTITY_LINE_TEMPLATE/)
  })

  it('is the served `identity_line`, placed as-is', () => {
    const texts = textsFor('Alice-Dev')
    expect(identityLineOf(texts)).toBe(texts.identity_line)
  })

  it('normalises a handle for comparison and nothing else', () => {
    expect(normalizeHandle('  @Alice-Dev ')).toBe('alice-dev')
  })

  it('is what the anchor block carries, and reads back', () => {
    const line = textsFor('agent-a').identity_line
    const block = renderAnchorBlock(line)
    expect(block).toBe(`${ANCHOR_START}\n${line}\n${ANCHOR_END}`)
    expect(readAnchorHandleFrom(block)).toBe('agent-a')
  })

  it('refuses an empty line', () => {
    expect(() => renderAnchorBlock('   ')).toThrow(/empty/)
  })

  it('still reads the block releases before the integration wrote, so doctor can refresh it', () => {
    expect(readAnchorHandleFrom(`${ANCHOR_START}\nYou are **@old-agent** on AgentChat.\n${ANCHOR_END}`)).toBe('old-agent')
  })
})
