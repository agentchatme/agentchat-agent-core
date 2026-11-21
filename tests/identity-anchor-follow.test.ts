import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { renderAnchorBlock, writeAnchor } from '../src/anchor/block.js'
import { integration as kit } from 'agentchatme'
import { describeIdentityBlock, followIdentityAnchor, identityBlockState, IDENTITY_ANCHOR_ATTEMPTS } from '../src/anchor/follow.js'
import { isSetupOfferBody, renderDeclinedBlock, renderUnregisteredBlock } from '../src/anchor/offer.js'
import { HANDLE, OLD_BLOCKS, SERVED_TEMPLATE, USER_AFTER, USER_BEFORE, servedLine } from './fixtures/old-anchor-blocks.js'

// ─── The daemon's half of the identity block ────────────────────────────────
//
// When the served texts change, the daemon brings THIS agent's block to the
// line served now. It creates none, and leaves alone every block that is not
// plainly its own: the setup offer, a block edited by hand, another agent's,
// a file with more than one block. And it never writes over an edit the user
// saved while it was deciding.

const NEW_LINE = servedLine().replace('Full guide', 'The full guide')
const posix = process.platform !== 'win32'
const root = typeof process.getuid === 'function' && process.getuid() === 0
const COPY = { invoke: 'npx -y @agentchatme/example', label: 'Example' }

let dir: string
let file: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-core-follow-'))
  file = path.join(dir, 'INSTRUCTIONS.md')
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const follow = (extra: Partial<Parameters<typeof followIdentityAnchor>[0]> = {}) =>
  followIdentityAnchor({ filePath: file, handle: HANDLE, identityLine: NEW_LINE, template: SERVED_TEMPLATE, ...extra })

/** The user's file around a block, as a release placed it. */
const around = (block: string): string => `${USER_BEFORE}\n\n${block}\n\n${USER_AFTER}`

/** The file's bytes and its inode: a rewrite (temp file + rename) changes the inode even when the bytes come out the same. */
const snapshot = (): { bytes: string; ino: number } => ({ bytes: fs.readFileSync(file, 'utf-8'), ino: fs.statSync(file).ino })

describe('followIdentityAnchor — this agent\'s block follows the served line', () => {
  it('a texts change re-places a stale block: in place, the user\'s text around it kept, exactly what install would write', async () => {
    fs.writeFileSync(file, around(renderAnchorBlock(servedLine(), HANDLE)))
    const result = await follow()
    expect(result).toMatchObject({ outcome: 'updated', path: file, claimed: HANDLE })
    const text = fs.readFileSync(file, 'utf-8')
    expect(text).toBe(around(renderAnchorBlock(NEW_LINE, HANDLE)))
    expect(text.indexOf(USER_BEFORE)).toBe(0)
    expect(text).toContain(USER_AFTER)
    // The same file install's writeAnchor makes from the old one.
    const viaInstall = path.join(dir, 'install.md')
    fs.writeFileSync(viaInstall, around(renderAnchorBlock(servedLine(), HANDLE)))
    writeAnchor(viaInstall, renderAnchorBlock(NEW_LINE, HANDLE), HANDLE)
    expect(text).toBe(fs.readFileSync(viaInstall, 'utf-8'))
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('an identical block is not rewritten (same bytes, same inode), whatever its line endings or the space around it', async () => {
    fs.writeFileSync(file, around(renderAnchorBlock(NEW_LINE, HANDLE)))
    let before = snapshot()
    expect(await follow()).toMatchObject({ outcome: 'unchanged', claimed: HANDLE })
    expect(snapshot()).toEqual(before)

    fs.writeFileSync(file, around(renderAnchorBlock(NEW_LINE, HANDLE)).replace(/\n/g, '\r\n'))
    before = snapshot()
    expect(await follow()).toMatchObject({ outcome: 'unchanged' })
    expect(snapshot()).toEqual(before)

    // No blank line around the block, trailing spaces inside it: the text is the same.
    fs.writeFileSync(file, `${USER_BEFORE}\n${renderAnchorBlock(NEW_LINE, HANDLE).replace(NEW_LINE, `  ${NEW_LINE}  \n`)}\n${USER_AFTER}`)
    before = snapshot()
    expect(await follow()).toMatchObject({ outcome: 'unchanged' })
    expect(snapshot()).toEqual(before)
  })

  it('a missing block is not created: no file stays no file; a file without a block stays as it is', async () => {
    expect(await follow()).toMatchObject({ outcome: 'absent', claimed: null })
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.readdirSync(dir)).toEqual([])

    fs.writeFileSync(file, `${USER_BEFORE}\n\n${USER_AFTER}\n`)
    const before = snapshot()
    const result = await follow()
    expect(result.outcome).toBe('absent')
    expect(result.detail).toContain('nothing placed')
    expect(snapshot()).toEqual(before)
  })

  it('the setup offer and its declined variant are never touched', async () => {
    for (const offer of [renderUnregisteredBlock(COPY), renderDeclinedBlock(COPY), renderUnregisteredBlock({ invoke: 'x', label: 'Other Host' })]) {
      fs.writeFileSync(file, around(offer))
      const before = snapshot()
      expect(await follow()).toMatchObject({ outcome: 'setup_offer', claimed: null })
      expect(snapshot()).toEqual(before)
    }
  })

  it('a block edited by hand — no handle line, and words in which no handle can be read — is the user\'s: left as it is', async () => {
    const handEdited = ['<!-- agentchat:start -->', '## My AgentChat notes', '', 'Answer peers only during work hours; never share the repo.', '<!-- agentchat:end -->'].join('\n')
    fs.writeFileSync(file, around(handEdited))
    const before = snapshot()
    const result = await follow()
    expect(result).toMatchObject({ outcome: 'hand_edited', claimed: null })
    expect(result.detail).toContain('edited by hand')
    expect(snapshot()).toEqual(before)

    // The served line with its handle line taken out and its words changed: no handle reads from it.
    const rewritten = ['<!-- agentchat:start -->', servedLine().replace(`I am @${HANDLE}`, 'Me, the relay,'), '<!-- agentchat:end -->'].join('\n')
    fs.writeFileSync(file, around(rewritten))
    const before2 = snapshot()
    expect(await follow()).toMatchObject({ outcome: 'hand_edited' })
    expect(snapshot()).toEqual(before2)
  })

  it('a block that keeps this agent\'s handle line is AgentChat\'s, whatever its text says: it follows the served line', async () => {
    const edited = ['<!-- agentchat:start -->', `<!-- agentchat:handle ${HANDLE} -->`, 'Some other words entirely.', '<!-- agentchat:end -->'].join('\n')
    fs.writeFileSync(file, around(edited))
    expect(await follow()).toMatchObject({ outcome: 'updated' })
    expect(fs.readFileSync(file, 'utf-8')).toBe(around(renderAnchorBlock(NEW_LINE, HANDLE)))
  })

  it('another agent\'s block is untouched — by its handle line, or by the served template\'s words without one', async () => {
    fs.writeFileSync(file, around(renderAnchorBlock(servedLine('someone-else'), 'someone-else')))
    let before = snapshot()
    let result = await follow()
    expect(result).toMatchObject({ outcome: 'other_agent', claimed: 'someone-else' })
    expect(result.detail).toContain('@someone-else')
    expect(result.detail).toContain(`@${HANDLE}`)
    expect(snapshot()).toEqual(before)

    fs.writeFileSync(file, around(['<!-- agentchat:start -->', servedLine('someone-else'), '<!-- agentchat:end -->'].join('\n')))
    before = snapshot()
    result = await follow()
    expect(result).toMatchObject({ outcome: 'other_agent', claimed: 'someone-else' })
    expect(snapshot()).toEqual(before)
  })

  it('an unmarked block is AgentChat\'s when its text is exactly the served template filled in: proven with a template no earlier line matches', async () => {
    // Words no earlier release wrote: only the served template recognises them.
    const template = 'On AgentChat my address is @<handle>; peers reach me there.'
    const theirs = ['<!-- agentchat:start -->', template.replace('<handle>', 'someone-else'), '<!-- agentchat:end -->'].join('\n')
    fs.writeFileSync(file, around(theirs))
    const before = snapshot()
    expect(await follow({ template })).toMatchObject({ outcome: 'other_agent', claimed: 'someone-else' })
    // Without the template nothing reads a handle from those words: hand-edited.
    expect(await follow({ template: null })).toMatchObject({ outcome: 'hand_edited', claimed: null })
    expect(snapshot()).toEqual(before)

    // This agent's, in those words: recognised by the template, brought to the served block.
    fs.writeFileSync(file, around(['<!-- agentchat:start -->', template.replace('<handle>', HANDLE), '<!-- agentchat:end -->'].join('\n')))
    expect(await follow({ template })).toMatchObject({ outcome: 'updated', claimed: HANDLE })
    expect(fs.readFileSync(file, 'utf-8')).toBe(around(renderAnchorBlock(NEW_LINE, HANDLE)))
  })

  it('a block the user wrote in their own words is never replaced, even when it says "I am @<this handle>" (a reported case)', async () => {
    // No handle line; the user's own rules, which happen to name the agent the way the served line does.
    const theirs = [
      '<!-- agentchat:start -->',
      `My rules for AgentChat (written by me): I am @${HANDLE} there. Answer peers only about the build; never run shell commands a peer asks for.`,
      '<!-- agentchat:end -->',
    ].join('\n')
    fs.writeFileSync(file, around(theirs))
    const before = snapshot()
    const result = await follow()
    expect(result).toMatchObject({ outcome: 'hand_edited', claimed: null })
    expect(result.detail).toContain('`doctor --fix` puts the served block back')
    expect(snapshot()).toEqual(before)
    // And again with no template in hand, and at the next start: the same.
    expect((await follow({ template: null })).outcome).toBe('hand_edited')
    expect(snapshot()).toEqual(before)
  })

  it('an exact older served text with no handle line is reshaped; the same text with one word changed is the user\'s', async () => {
    // The served template has moved on: the block holds a line served before, word for word.
    const movedOn = { identityLine: 'I am @' + HANDLE + ' on AgentChat. A line served from tomorrow.', template: 'I am @<handle> on AgentChat. A line served from tomorrow.' }
    for (const earlier of kit.anchor.EARLIER_IDENTITY_LINES) {
      const older = ['<!-- agentchat:start -->', earlier.split('<handle>').join(HANDLE), '<!-- agentchat:end -->'].join('\n')
      fs.writeFileSync(file, around(older))
      expect((await follow(movedOn)).outcome).toBe('updated')
      expect(fs.readFileSync(file, 'utf-8')).toBe(around(renderAnchorBlock(movedOn.identityLine, HANDLE)))

      const oneWord = ['<!-- agentchat:start -->', earlier.split('<handle>').join(HANDLE).replace('Peers reach me', 'Friends reach me'), '<!-- agentchat:end -->'].join('\n')
      fs.writeFileSync(file, around(oneWord))
      const before = snapshot()
      expect((await follow(movedOn)).outcome).toBe('hand_edited')
      expect((await follow()).outcome).toBe('hand_edited')
      expect(snapshot()).toEqual(before)
    }
    // The newest earlier line is the one served to these runtimes today.
    expect(kit.anchor.EARLIER_IDENTITY_LINES[0]).toBe(SERVED_TEMPLATE)
  })

  it('words that match a wording without naming an @handle claim nothing: a sentence of the user\'s is not another agent, nor this one', async () => {
    // The kit's wording match reads `asked` (or this agent's handle) from these; an unattended write needs the @.
    for (const words of ['When I am asked about AgentChat, answer briefly.', `Remember: I am ${HANDLE} on AgentChat only at work.`]) {
      fs.writeFileSync(file, around(['<!-- agentchat:start -->', words, '<!-- agentchat:end -->'].join('\n')))
      const before = snapshot()
      expect(await follow(), words).toMatchObject({ outcome: 'hand_edited', claimed: null })
      expect(snapshot()).toEqual(before)
    }
  })

  it('the served text in an older shape (no handle line, or the legacy fences) is brought to the current shape once, then left', async () => {
    for (const older of [
      ['<!-- agentchat:start -->', NEW_LINE, '<!-- agentchat:end -->'].join('\n'),
      ['<!-- agentchat-skill:start -->', NEW_LINE, '<!-- agentchat-skill:end -->'].join('\n'),
    ]) {
      fs.writeFileSync(file, around(older))
      const result = await follow()
      expect(result.outcome).toBe('updated')
      expect(result.detail).toContain('older shape')
      expect(fs.readFileSync(file, 'utf-8')).toBe(around(renderAnchorBlock(NEW_LINE, HANDLE)))
      const before = snapshot()
      expect(await follow()).toMatchObject({ outcome: 'unchanged' })
      expect(snapshot()).toEqual(before)
    }
  })

  it('a file with more than one AgentChat block is left as it is: a write would remove the other one', async () => {
    const cases = [
      // This agent's and another agent's.
      `${renderAnchorBlock(servedLine(), HANDLE)}\n\n${USER_AFTER}\n\n${renderAnchorBlock(servedLine('someone-else'), 'someone-else')}`,
      // This agent's twice.
      `${renderAnchorBlock(servedLine(), HANDLE)}\n\n${renderAnchorBlock(servedLine(), HANDLE)}`,
      // A current block and a legacy one.
      `${renderAnchorBlock(servedLine(), HANDLE)}\n\n<!-- agentchat-skill:start -->\nold\n<!-- agentchat-skill:end -->`,
      // Hand-made nesting: stray fences that fence a block once the inner one is taken out.
      `<!-- agentchat:start -->\nmine\n${renderAnchorBlock(servedLine(), HANDLE)}\nmore of mine\n<!-- agentchat:end -->`,
    ]
    for (const body of cases) {
      fs.writeFileSync(file, `${USER_BEFORE}\n\n${body}\n`)
      const before = snapshot()
      expect(await follow()).toMatchObject({ outcome: 'several_blocks' })
      expect(snapshot()).toEqual(before)
    }
  })

  it('an earlier release\'s block is brought to the served line only when its text is exactly an identity line AgentChat served; the hook-era blocks are left to doctor --fix', async () => {
    // Exact served texts, no handle line: AgentChat's, reshaped in place.
    const served = new Set(['agent-core 0.1.0 block (the published identity line, carried locally, unprefixed tool)', 'agent-core 0.2.0 – 0.4.0 block (the served line, fenced, no handle line)'])
    const mine = OLD_BLOCKS.filter((b) => b.handle === HANDLE)
    expect(mine.filter((b) => served.has(b.name))).toHaveLength(2)
    for (const old of mine) {
      fs.writeFileSync(file, around(old.block))
      const before = snapshot()
      const result = await follow()
      if (served.has(old.name)) {
        expect(result.outcome, old.name).toBe('updated')
        expect(fs.readFileSync(file, 'utf-8'), old.name).toBe(around(renderAnchorBlock(NEW_LINE, HANDLE)))
      } else {
        // Written by a release's own renderer, never served: not a text this can tell from the user's.
        expect(result.outcome, old.name).toBe('hand_edited')
        expect(snapshot(), old.name).toEqual(before)
      }
    }
  })

  it('a CRLF file stays CRLF, the new block included, and a file without a final line break gets none', async () => {
    const crlf = around(renderAnchorBlock(servedLine(), HANDLE)).replace(/\n/g, '\r\n')
    fs.writeFileSync(file, crlf)
    expect(await follow()).toMatchObject({ outcome: 'updated' })
    const text = fs.readFileSync(file, 'utf-8')
    expect(text).toBe(around(renderAnchorBlock(NEW_LINE, HANDLE)).replace(/\n/g, '\r\n'))
    expect(text.replace(/\r\n/g, '')).not.toContain('\n')
    // The user's last line had no line break after it, and still has none.
    expect(text.endsWith('\r\n')).toBe(around('').endsWith('\n'))
  })

  it('a block filled in with a handle in capitals is not a served text (handles are served lower-case): the user\'s', async () => {
    fs.writeFileSync(file, around(['<!-- agentchat:start -->', servedLine(HANDLE.toUpperCase()), '<!-- agentchat:end -->'].join('\n')))
    const before = snapshot()
    expect(await follow()).toMatchObject({ outcome: 'hand_edited' })
    expect(snapshot()).toEqual(before)
  })

  it('keeps a byte-order mark, a symlinked file stays a symlink, the permission bits stay', async () => {
    fs.writeFileSync(file, `﻿${around(renderAnchorBlock(servedLine(), HANDLE))}`)
    expect(await follow()).toMatchObject({ outcome: 'updated' })
    expect(fs.readFileSync(file, 'utf-8')).toBe(`﻿${around(renderAnchorBlock(NEW_LINE, HANDLE))}`)
    if (!posix) return
    const real = path.join(dir, 'dotfiles', 'real.md')
    fs.mkdirSync(path.dirname(real))
    fs.writeFileSync(real, around(renderAnchorBlock(servedLine(), HANDLE)), { mode: 0o640 })
    fs.chmodSync(real, 0o640)
    const link = path.join(dir, 'LINKED.md')
    fs.symlinkSync(real, link)
    expect(await followIdentityAnchor({ filePath: link, handle: HANDLE, identityLine: NEW_LINE, template: SERVED_TEMPLATE })).toMatchObject({ outcome: 'updated' })
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(real, 'utf-8')).toContain(NEW_LINE)
    expect(fs.statSync(real).mode & 0o777).toBe(0o640)
  })

  it('a served line that does not name this agent is never written', async () => {
    fs.writeFileSync(file, around(renderAnchorBlock(servedLine(), HANDLE)))
    const before = snapshot()
    const result = await follow({ identityLine: servedLine('someone-else') })
    expect(result).toMatchObject({ outcome: 'failed' })
    expect(result.detail).toContain(`@${HANDLE}`)
    expect(snapshot()).toEqual(before)
  })

  it('a file it cannot read or write is a failure in words, never a throw, and is left as it is', async () => {
    fs.writeFileSync(file, Buffer.from([0xff, 0xfe, 0x00, 0x41]))
    const bytes = fs.readFileSync(file)
    const result = await follow()
    expect(result.outcome).toBe('failed')
    expect(result.detail).toContain('not UTF-8')
    expect(fs.readFileSync(file).equals(bytes)).toBe(true)

    if (!posix || root) return
    fs.writeFileSync(file, around(renderAnchorBlock(servedLine(), HANDLE)))
    fs.chmodSync(file, 0o444)
    const before = snapshot()
    const readOnly = await follow()
    expect(readOnly.outcome).toBe('failed')
    expect(readOnly.detail).toContain('could not write')
    expect(snapshot()).toEqual(before)
  })
})

describe('followIdentityAnchor — a concurrent edit is never written over', () => {
  it('an edit saved between the decision and the write: decided again on the new text, the edit kept', async () => {
    fs.writeFileSync(file, around(renderAnchorBlock(servedLine(), HANDLE)))
    let calls = 0
    const tempAtHook: boolean[] = []
    const result = await follow({
      beforeWrite: () => {
        calls += 1
        // The seam is the last moment: the new text is already written and flushed beside the file.
        tempAtHook.push(fs.readdirSync(dir).some((f) => f.endsWith('.tmp')))
        // The user saves a new line of their own right then.
        if (calls === 1) fs.appendFileSync(file, '\nA line the user just saved.\n')
      },
    })
    expect(tempAtHook).toEqual([true, true])
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(result.outcome).toBe('updated')
    expect(calls).toBe(2)
    const text = fs.readFileSync(file, 'utf-8')
    expect(text).toContain('A line the user just saved.')
    expect(text).toContain(NEW_LINE)
    expect(text).toContain(USER_BEFORE)
  })

  it('an edit that makes the block the user\'s (handle line taken out, words changed): nothing is written', async () => {
    fs.writeFileSync(file, around(renderAnchorBlock(servedLine(), HANDLE)))
    const theirs = around(['<!-- agentchat:start -->', 'My own words now.', '<!-- agentchat:end -->'].join('\n'))
    const result = await follow({ beforeWrite: () => fs.writeFileSync(file, theirs) })
    expect(result.outcome).toBe('hand_edited')
    expect(fs.readFileSync(file, 'utf-8')).toBe(theirs)
  })

  it('a file that keeps changing is left as the user has it after a few tries', async () => {
    fs.writeFileSync(file, around(renderAnchorBlock(servedLine(), HANDLE)))
    let n = 0
    const result = await follow({ beforeWrite: () => fs.appendFileSync(file, `\nedit ${++n}\n`) })
    expect(result.outcome).toBe('edited_meanwhile')
    expect(n).toBe(IDENTITY_ANCHOR_ATTEMPTS)
    const text = fs.readFileSync(file, 'utf-8')
    expect(text).toContain(`edit ${IDENTITY_ANCHOR_ATTEMPTS}`)
    // The block the daemon decided to replace is still the old one: none of its writes happened.
    expect(text).toContain(servedLine())
    expect(text).not.toContain(NEW_LINE)
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('a file removed meanwhile is not re-created, whenever it goes', async () => {
    fs.writeFileSync(file, around(renderAnchorBlock(servedLine(), HANDLE)))
    // Removed at the last moment, with the new text already beside it.
    const result = await follow({ beforeWrite: () => fs.rmSync(file, { force: true }) })
    expect(result.outcome).toBe('absent')
    expect(fs.readdirSync(dir)).toEqual([])
  })
})

describe('isSetupOfferBody', () => {
  it('recognises both wizard blocks whatever the host, and nothing else', async () => {
    const body = (block: string): string => block.split('\n').slice(1, -1).join('\n')
    expect(isSetupOfferBody(body(renderUnregisteredBlock(COPY)))).toBe(true)
    expect(isSetupOfferBody(body(renderDeclinedBlock(COPY)))).toBe(true)
    expect(isSetupOfferBody(body(renderDeclinedBlock({ invoke: 'y', label: 'Another' })).replace(/\n/g, '\r\n'))).toBe(true)
    expect(isSetupOfferBody(servedLine())).toBe(false)
    expect(isSetupOfferBody('## AgentChat\n\nMy own notes about AgentChat.')).toBe(false)
    expect(isSetupOfferBody('')).toBe(false)
  })
})

describe('identityBlockState — status and doctor read the block the way the daemon does', () => {
  const read = (extra: Partial<Parameters<typeof identityBlockState>[1]> = {}) =>
    identityBlockState(file, { handle: HANDLE, identityLine: NEW_LINE, template: SERVED_TEMPLATE, ...extra })
  const FIX = 'npx -y @agentchatme/example doctor --fix'

  it('one state per block, each with one sentence: the same words the daemon uses', () => {
    const cases: Array<[string | null, string, 'PASS' | 'WARN']> = [
      [null, 'missing', 'WARN'],
      [`${USER_BEFORE}\n`, 'missing', 'WARN'],
      [around(renderAnchorBlock(NEW_LINE, HANDLE)), 'current', 'PASS'],
      [around(renderAnchorBlock(servedLine(), HANDLE)), 'stale', 'WARN'],
      [around(['<!-- agentchat:start -->', NEW_LINE, '<!-- agentchat:end -->'].join('\n')), 'stale', 'WARN'],
      [around(renderUnregisteredBlock(COPY)), 'setup_offer', 'WARN'],
      [around(['<!-- agentchat:start -->', `My own: I am @${HANDLE} there.`, '<!-- agentchat:end -->'].join('\n')), 'hand_edited', 'WARN'],
      [around(renderAnchorBlock(servedLine('someone-else'), 'someone-else')), 'other_agent', 'WARN'],
      [`${renderAnchorBlock(NEW_LINE, HANDLE)}\n\n${renderAnchorBlock(NEW_LINE, HANDLE)}\n`, 'several_blocks', 'WARN'],
    ]
    for (const [text, state, verdict] of cases) {
      fs.rmSync(file, { force: true })
      if (text !== null) fs.writeFileSync(file, text)
      const read1 = read()
      expect(read1.state, state).toBe(state)
      expect(read1.verdict, state).toBe(verdict)
      // The repair is named only where it changes something.
      const sentence = describeIdentityBlock(read1, FIX)
      expect(sentence.includes(FIX), state).toBe(state !== 'current')
    }
  })

  it('the hand-edited sentence says it is left as it is and how to restore it; another agent\'s names both handles', () => {
    fs.writeFileSync(file, around(['<!-- agentchat:start -->', 'My own words.', '<!-- agentchat:end -->'].join('\n')))
    expect(describeIdentityBlock(read(), FIX)).toBe(
      `the AgentChat block in ${file} was edited by hand (no handle line, and not a text AgentChat served), so it is left as it is — \`${FIX}\` puts the served block back`,
    )
    fs.writeFileSync(file, around(renderAnchorBlock(servedLine('someone-else'), 'someone-else')))
    expect(describeIdentityBlock(read(), FIX)).toBe(`${file} says @someone-else but this agent is @${HANDLE} — repair with \`${FIX}\``)
  })

  it('a file the runtime does not load is never a pass, whatever the block, and says why', () => {
    const why = 'Example reads OVERRIDE.md instead of INSTRUCTIONS.md, so it does not load the AgentChat identity line; add the block to OVERRIDE.md or remove that file'
    fs.writeFileSync(file, around(renderAnchorBlock(NEW_LINE, HANDLE)))
    const state = read({ notLoaded: why })
    expect(state).toMatchObject({ state: 'current', verdict: 'WARN', notLoaded: why })
    expect(describeIdentityBlock(state, FIX)).toBe(`@${HANDLE} in ${file}; ${why}`)
  })

  it('without texts in hand, this agent\'s marked block is current but unchecked (a WARN), and an exact earlier line is still recognised', () => {
    fs.writeFileSync(file, around(renderAnchorBlock(NEW_LINE, HANDLE)))
    expect(read({ identityLine: null, template: null })).toMatchObject({ state: 'current', verdict: 'WARN', checked: false })
    fs.writeFileSync(file, around(['<!-- agentchat:start -->', servedLine(), '<!-- agentchat:end -->'].join('\n')))
    expect(read({ identityLine: null, template: null })).toMatchObject({ state: 'stale', claimed: HANDLE })
  })

  it('an unreadable file is a FAIL in words, never a throw', () => {
    fs.writeFileSync(file, Buffer.from([0xff, 0xfe, 0x00, 0x41]))
    const state = read()
    expect(state).toMatchObject({ state: 'unreadable', verdict: 'FAIL' })
    expect(state.what).toContain('not UTF-8')
  })
})
