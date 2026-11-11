import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { MANUAL, MANUAL_URL, manualPointer, manualVersion } from '../src/skill/manual.js'
import { identityLineOf, normalizeHandle } from '../src/skill/identity-line.js'
import { renderAnchorBlock, readAnchorHandleFrom, ANCHOR_START, ANCHOR_END } from '../src/anchor/block.js'
import { textsFor } from './helpers/served-texts.js'

// ─── The bundled manual is the served one at release time; the identity line is served, only placed ─

const SOURCE = path.join(__dirname, '..', 'src', 'skill', 'agentchat.skill.md')

describe('the bundled manual (the fallback for a skill file that cannot be downloaded)', () => {
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

  it('is the version the platform published when this release was cut', () => {
    // The skill file follows the SERVED manual (served-manual.test.ts); this
    // copy is only what a first install writes when it cannot download one.
    // Refresh it at release time with the two-command refresh (README §
    // Refreshing the bundled manual) so the fallback is never far behind.
    expect(manualVersion()).toBe('2.3.1')
  })

  it('is the main line’s text, not a per-host rendering: what it says about one integration it says about all', () => {
    // The guard used to be "names no `npx -y @agentchatme/…`" — the old
    // per-host template spelled one host's CLI into the manual. The served
    // manual (2.2.1 on) names the integrations' own `recover` commands
    // itself, for every integration alike; a copy that named only one host
    // would be a rendering again.
    const names = (pkg: string): boolean => MANUAL.includes(`@agentchatme/${pkg}`)
    expect(names('claude-code')).toBe(names('codex'))
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

  it('is what the anchor block carries (the kit’s shape: fences, handle line, the line), and reads back', () => {
    const line = textsFor('agent-a').identity_line
    const block = renderAnchorBlock(line, 'agent-a')
    expect(block).toBe(`${ANCHOR_START}\n<!-- agentchat:handle agent-a -->\n${line}\n${ANCHOR_END}`)
    expect(readAnchorHandleFrom(block)).toBe('agent-a')
  })

  it('refuses an empty line, an empty handle, and a line that names someone else', () => {
    expect(() => renderAnchorBlock('   ', 'agent-a')).toThrow(/empty/)
    expect(() => renderAnchorBlock(textsFor('agent-a').identity_line, ' @ ')).toThrow(/empty/)
    expect(() => renderAnchorBlock(textsFor('agent-b').identity_line, 'agent-a')).toThrow(/names @agent-a/)
  })

  it('still reads the block releases before the integration wrote, so doctor can refresh it', () => {
    expect(readAnchorHandleFrom(`${ANCHOR_START}\nYou are **@old-agent** on AgentChat.\n${ANCHOR_END}`)).toBe('old-agent')
  })
})
