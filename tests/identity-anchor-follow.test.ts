import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { renderAnchorBlock, writeAnchor } from '../src/anchor/block.js'
import { followIdentityAnchor, IDENTITY_ANCHOR_ATTEMPTS } from '../src/anchor/follow.js'
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
  it('a texts change re-places a stale block: in place, the user\'s text around it kept, exactly what install would write', () => {
    fs.writeFileSync(file, around(renderAnchorBlock(servedLine(), HANDLE)))
    const result = follow()
    expect(result).toMatchObject({ outcome: 'updated', path: file, claimed: HANDLE })
    const text = fs.readFileSync(file, 'utf-8')
    expect(text).toBe(`${around(renderAnchorBlock(NEW_LINE, HANDLE))}\n`)
    expect(text.indexOf(USER_BEFORE)).toBe(0)
    expect(text).toContain(USER_AFTER)
    // The same file install's writeAnchor makes from the old one.
    const viaInstall = path.join(dir, 'install.md')
    fs.writeFileSync(viaInstall, around(renderAnchorBlock(servedLine(), HANDLE)))
    writeAnchor(viaInstall, renderAnchorBlock(NEW_LINE, HANDLE), HANDLE)
    expect(text).toBe(fs.readFileSync(viaInstall, 'utf-8'))
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('an identical block is not rewritten (same bytes, same inode), whatever its line endings or the space around it', () => {
    fs.writeFileSync(file, around(renderAnchorBlock(NEW_LINE, HANDLE)))
    let before = snapshot()
    expect(follow()).toMatchObject({ outcome: 'unchanged', claimed: HANDLE })
    expect(snapshot()).toEqual(before)

    fs.writeFileSync(file, around(renderAnchorBlock(NEW_LINE, HANDLE)).replace(/\n/g, '\r\n'))
    before = snapshot()
    expect(follow()).toMatchObject({ outcome: 'unchanged' })
    expect(snapshot()).toEqual(before)

    // No blank line around the block, trailing spaces inside it: the text is the same.
    fs.writeFileSync(file, `${USER_BEFORE}\n${renderAnchorBlock(NEW_LINE, HANDLE).replace(NEW_LINE, `  ${NEW_LINE}  \n`)}\n${USER_AFTER}`)
    before = snapshot()
    expect(follow()).toMatchObject({ outcome: 'unchanged' })
    expect(snapshot()).toEqual(before)
  })

  it('a missing block is not created: no file stays no file; a file without a block stays as it is', () => {
    expect(follow()).toMatchObject({ outcome: 'absent', claimed: null })
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.readdirSync(dir)).toEqual([])

    fs.writeFileSync(file, `${USER_BEFORE}\n\n${USER_AFTER}\n`)
    const before = snapshot()
    const result = follow()
    expect(result.outcome).toBe('absent')
    expect(result.detail).toContain('nothing placed')
    expect(snapshot()).toEqual(before)
  })

  it('the setup offer and its declined variant are never touched', () => {
    for (const offer of [renderUnregisteredBlock(COPY), renderDeclinedBlock(COPY), renderUnregisteredBlock({ invoke: 'x', label: 'Other Host' })]) {
      fs.writeFileSync(file, around(offer))
      const before = snapshot()
      expect(follow()).toMatchObject({ outcome: 'setup_offer', claimed: null })
      expect(snapshot()).toEqual(before)
    }
  })

  it('a block edited by hand — no handle line, and words in which no handle can be read — is the user\'s: left as it is', () => {
    const handEdited = ['<!-- agentchat:start -->', '## My AgentChat notes', '', 'Answer peers only during work hours; never share the repo.', '<!-- agentchat:end -->'].join('\n')
    fs.writeFileSync(file, around(handEdited))
    const before = snapshot()
    const result = follow()
    expect(result).toMatchObject({ outcome: 'hand_edited', claimed: null })
    expect(result.detail).toContain('edited by hand')
    expect(snapshot()).toEqual(before)

    // The served line with its handle line taken out and its words changed: no handle reads from it.
    const rewritten = ['<!-- agentchat:start -->', servedLine().replace(`I am @${HANDLE}`, 'Me, the relay,'), '<!-- agentchat:end -->'].join('\n')
    fs.writeFileSync(file, around(rewritten))
    const before2 = snapshot()
    expect(follow()).toMatchObject({ outcome: 'hand_edited' })
    expect(snapshot()).toEqual(before2)
  })

  it('a block that keeps this agent\'s handle line is AgentChat\'s, whatever its text says: it follows the served line', () => {
    const edited = ['<!-- agentchat:start -->', `<!-- agentchat:handle ${HANDLE} -->`, 'Some other words entirely.', '<!-- agentchat:end -->'].join('\n')
    fs.writeFileSync(file, around(edited))
    expect(follow()).toMatchObject({ outcome: 'updated' })
    expect(fs.readFileSync(file, 'utf-8')).toBe(`${around(renderAnchorBlock(NEW_LINE, HANDLE))}\n`)
  })

  it('another agent\'s block is untouched — by its handle line, or by the served template\'s words without one', () => {
    fs.writeFileSync(file, around(renderAnchorBlock(servedLine('someone-else'), 'someone-else')))
    let before = snapshot()
    let result = follow()
    expect(result).toMatchObject({ outcome: 'other_agent', claimed: 'someone-else' })
    expect(result.detail).toContain('@someone-else')
    expect(result.detail).toContain(`@${HANDLE}`)
    expect(snapshot()).toEqual(before)

    fs.writeFileSync(file, around(['<!-- agentchat:start -->', servedLine('someone-else'), '<!-- agentchat:end -->'].join('\n')))
    before = snapshot()
    result = follow()
    expect(result).toMatchObject({ outcome: 'other_agent', claimed: 'someone-else' })
    expect(snapshot()).toEqual(before)
  })

  it('an unmarked block is read by the served template\'s words only with the @: proven with a template no earlier wording matches', () => {
    // Words no earlier release wrote: only the served template recognises them.
    const template = 'On AgentChat my address is @<handle>; peers reach me there.'
    const theirs = ['<!-- agentchat:start -->', template.replace('<handle>', 'someone-else'), '<!-- agentchat:end -->'].join('\n')
    fs.writeFileSync(file, around(theirs))
    const before = snapshot()
    expect(follow({ template })).toMatchObject({ outcome: 'other_agent', claimed: 'someone-else' })
    // Without the template nothing reads a handle from those words: hand-edited.
    expect(follow({ template: null })).toMatchObject({ outcome: 'hand_edited', claimed: null })
    expect(snapshot()).toEqual(before)

    // This agent's, in those words: recognised by the template, brought to the served block.
    fs.writeFileSync(file, around(['<!-- agentchat:start -->', template.replace('<handle>', HANDLE), '<!-- agentchat:end -->'].join('\n')))
    expect(follow({ template })).toMatchObject({ outcome: 'updated', claimed: HANDLE })
    expect(fs.readFileSync(file, 'utf-8')).toBe(`${around(renderAnchorBlock(NEW_LINE, HANDLE))}\n`)
  })

  it('words that match a wording without naming an @handle claim nothing: a sentence of the user\'s is not another agent, nor this one', () => {
    // The kit's wording match reads `asked` (or this agent's handle) from these; an unattended write needs the @.
    for (const words of ['When I am asked about AgentChat, answer briefly.', `Remember: I am ${HANDLE} on AgentChat only at work.`]) {
      fs.writeFileSync(file, around(['<!-- agentchat:start -->', words, '<!-- agentchat:end -->'].join('\n')))
      const before = snapshot()
      expect(follow(), words).toMatchObject({ outcome: 'hand_edited', claimed: null })
      expect(snapshot()).toEqual(before)
    }
  })

  it('the served text in an older shape (no handle line, or the legacy fences) is brought to the current shape once, then left', () => {
    for (const older of [
      ['<!-- agentchat:start -->', NEW_LINE, '<!-- agentchat:end -->'].join('\n'),
      ['<!-- agentchat-skill:start -->', NEW_LINE, '<!-- agentchat-skill:end -->'].join('\n'),
    ]) {
      fs.writeFileSync(file, around(older))
      const result = follow()
      expect(result.outcome).toBe('updated')
      expect(result.detail).toContain('older shape')
      expect(fs.readFileSync(file, 'utf-8')).toBe(`${around(renderAnchorBlock(NEW_LINE, HANDLE))}\n`)
      const before = snapshot()
      expect(follow()).toMatchObject({ outcome: 'unchanged' })
      expect(snapshot()).toEqual(before)
    }
  })

  it('a file with more than one AgentChat block is left as it is: a write would remove the other one', () => {
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
      expect(follow()).toMatchObject({ outcome: 'several_blocks' })
      expect(snapshot()).toEqual(before)
    }
  })

  it('every block an earlier release wrote for this agent is brought to the served line, in place', () => {
    for (const old of OLD_BLOCKS.filter((b) => b.handle === HANDLE)) {
      fs.writeFileSync(file, around(old.block))
      const result = follow()
      expect(result.outcome, old.name).toBe('updated')
      expect(fs.readFileSync(file, 'utf-8'), old.name).toBe(`${around(renderAnchorBlock(NEW_LINE, HANDLE))}\n`)
    }
  })

  it('keeps a byte-order mark, a symlinked file stays a symlink, the permission bits stay', () => {
    fs.writeFileSync(file, `﻿${around(renderAnchorBlock(servedLine(), HANDLE))}`)
    expect(follow()).toMatchObject({ outcome: 'updated' })
    expect(fs.readFileSync(file, 'utf-8')).toBe(`﻿${around(renderAnchorBlock(NEW_LINE, HANDLE))}\n`)
    if (!posix) return
    const real = path.join(dir, 'dotfiles', 'real.md')
    fs.mkdirSync(path.dirname(real))
    fs.writeFileSync(real, around(renderAnchorBlock(servedLine(), HANDLE)), { mode: 0o640 })
    fs.chmodSync(real, 0o640)
    const link = path.join(dir, 'LINKED.md')
    fs.symlinkSync(real, link)
    expect(followIdentityAnchor({ filePath: link, handle: HANDLE, identityLine: NEW_LINE, template: SERVED_TEMPLATE })).toMatchObject({ outcome: 'updated' })
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(real, 'utf-8')).toContain(NEW_LINE)
    expect(fs.statSync(real).mode & 0o777).toBe(0o640)
  })

  it('a served line that does not name this agent is never written', () => {
    fs.writeFileSync(file, around(renderAnchorBlock(servedLine(), HANDLE)))
    const before = snapshot()
    const result = follow({ identityLine: servedLine('someone-else') })
    expect(result).toMatchObject({ outcome: 'failed' })
    expect(result.detail).toContain(`@${HANDLE}`)
    expect(snapshot()).toEqual(before)
  })

  it('a file it cannot read or write is a failure in words, never a throw, and is left as it is', () => {
    fs.writeFileSync(file, Buffer.from([0xff, 0xfe, 0x00, 0x41]))
    const bytes = fs.readFileSync(file)
    const result = follow()
    expect(result.outcome).toBe('failed')
    expect(result.detail).toContain('not UTF-8')
    expect(fs.readFileSync(file).equals(bytes)).toBe(true)

    if (!posix || root) return
    fs.writeFileSync(file, around(renderAnchorBlock(servedLine(), HANDLE)))
    fs.chmodSync(file, 0o444)
    const before = snapshot()
    const readOnly = follow()
    expect(readOnly.outcome).toBe('failed')
    expect(readOnly.detail).toContain('could not write')
    expect(snapshot()).toEqual(before)
  })
})

describe('followIdentityAnchor — a concurrent edit is never written over', () => {
  it('an edit saved between the decision and the write: decided again on the new text, the edit kept', () => {
    fs.writeFileSync(file, around(renderAnchorBlock(servedLine(), HANDLE)))
    let calls = 0
    const tempAtHook: boolean[] = []
    const result = follow({
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

  it('an edit that makes the block the user\'s (handle line taken out, words changed): nothing is written', () => {
    fs.writeFileSync(file, around(renderAnchorBlock(servedLine(), HANDLE)))
    const theirs = around(['<!-- agentchat:start -->', 'My own words now.', '<!-- agentchat:end -->'].join('\n'))
    const result = follow({ beforeWrite: () => fs.writeFileSync(file, theirs) })
    expect(result.outcome).toBe('hand_edited')
    expect(fs.readFileSync(file, 'utf-8')).toBe(theirs)
  })

  it('a file that keeps changing is left as the user has it after a few tries', () => {
    fs.writeFileSync(file, around(renderAnchorBlock(servedLine(), HANDLE)))
    let n = 0
    const result = follow({ beforeWrite: () => fs.appendFileSync(file, `\nedit ${++n}\n`) })
    expect(result.outcome).toBe('edited_meanwhile')
    expect(n).toBe(IDENTITY_ANCHOR_ATTEMPTS)
    const text = fs.readFileSync(file, 'utf-8')
    expect(text).toContain(`edit ${IDENTITY_ANCHOR_ATTEMPTS}`)
    // The block the daemon decided to replace is still the old one: none of its writes happened.
    expect(text).toContain(servedLine())
    expect(text).not.toContain(NEW_LINE)
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('a file removed meanwhile is not re-created, whenever it goes', () => {
    fs.writeFileSync(file, around(renderAnchorBlock(servedLine(), HANDLE)))
    // Removed at the last moment, with the new text already beside it.
    const result = follow({ beforeWrite: () => fs.rmSync(file, { force: true }) })
    expect(result.outcome).toBe('absent')
    expect(fs.readdirSync(dir)).toEqual([])
  })
})

describe('isSetupOfferBody', () => {
  it('recognises both wizard blocks whatever the host, and nothing else', () => {
    const body = (block: string): string => block.split('\n').slice(1, -1).join('\n')
    expect(isSetupOfferBody(body(renderUnregisteredBlock(COPY)))).toBe(true)
    expect(isSetupOfferBody(body(renderDeclinedBlock(COPY)))).toBe(true)
    expect(isSetupOfferBody(body(renderDeclinedBlock({ invoke: 'y', label: 'Another' })).replace(/\n/g, '\r\n'))).toBe(true)
    expect(isSetupOfferBody(servedLine())).toBe(false)
    expect(isSetupOfferBody('## AgentChat\n\nMy own notes about AgentChat.')).toBe(false)
    expect(isSetupOfferBody('')).toBe(false)
  })
})
