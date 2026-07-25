import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  ANCHOR_START,
  ANCHOR_END,
  renderAnchorBlock,
  writeAnchor,
  removeAnchorAt,
  hasAnchorAt,
  readAnchorHandleAt,
  readAnchorHandleFrom,
  upsertAnchorBlock,
  stripAnchorBlock,
} from '../src/anchor/block.js'

// The anchor module edits a fenced block in a file it is TOLD about. It has no
// notion of which coding agent owns that file — picking the file was the job
// that once stamped one agent's handle into another agent's instructions.

let dir: string
const fileA = (): string => path.join(dir, 'A.md')
const fileB = (): string => path.join(dir, 'B.md')

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-core-anchor-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('writeAnchor', () => {
  it('creates the file and its parent directory', () => {
    const nested = path.join(dir, 'deep', 'nest', 'CLAUDE.md')
    writeAnchor(nested, renderAnchorBlock('agent-a'), 'agent-a')
    expect(fs.readFileSync(nested, 'utf-8')).toContain('@agent-a')
  })

  it('preserves the user’s own content around the block', () => {
    fs.writeFileSync(fileA(), '# My notes\n\nSomething I wrote.\n')
    writeAnchor(fileA(), renderAnchorBlock('agent-a'), 'agent-a')
    const out = fs.readFileSync(fileA(), 'utf-8')
    expect(out).toContain('# My notes')
    expect(out).toContain('Something I wrote.')
    expect(out).toContain('@agent-a')
  })

  it('replaces rather than appends on re-write, converging to ONE block', () => {
    writeAnchor(fileA(), renderAnchorBlock('old-handle'), 'old-handle')
    writeAnchor(fileA(), renderAnchorBlock('new-handle'), 'new-handle')
    const out = fs.readFileSync(fileA(), 'utf-8')
    expect(out.split(ANCHOR_START)).toHaveLength(2) // exactly one block
    expect(out).toContain('@new-handle')
    expect(out).not.toContain('@old-handle')
  })

  it('throws rather than shipping a block missing the handle', () => {
    // A block that does not actually name the agent would have it announce an
    // address it cannot authenticate as — fail loud instead.
    expect(() => writeAnchor(fileA(), `${ANCHOR_START}\nno handle here\n${ANCHOR_END}`, 'agent-a')).toThrow(
      /did not land/,
    )
  })

  it('writing one file never touches another', () => {
    writeAnchor(fileB(), renderAnchorBlock('agent-b'), 'agent-b')
    const before = fs.readFileSync(fileB(), 'utf-8')
    writeAnchor(fileA(), renderAnchorBlock('agent-a'), 'agent-a')
    expect(fs.readFileSync(fileB(), 'utf-8')).toBe(before)
    expect(fs.readFileSync(fileB(), 'utf-8')).toContain('@agent-b')
  })
})

describe('removeAnchorAt', () => {
  it('strips our block and leaves the rest byte-for-byte', () => {
    fs.writeFileSync(fileA(), '# Keep me\n')
    writeAnchor(fileA(), renderAnchorBlock('agent-a'), 'agent-a')
    expect(removeAnchorAt(fileA())).toBe('removed')
    expect(fs.readFileSync(fileA(), 'utf-8')).toBe('# Keep me\n')
  })

  it('is a no-op on a file with no block, and on a missing file', () => {
    fs.writeFileSync(fileA(), '# Nothing of ours\n')
    expect(removeAnchorAt(fileA())).toBe('noop')
    expect(removeAnchorAt(path.join(dir, 'absent.md'))).toBe('noop')
  })
})

describe('reading the claimed handle', () => {
  it('reads back what the block announces', () => {
    writeAnchor(fileA(), renderAnchorBlock('agent-a'), 'agent-a')
    expect(readAnchorHandleAt(fileA())).toBe('agent-a')
    expect(hasAnchorAt(fileA())).toBe(true)
  })

  it('returns null when there is no block at all', () => {
    fs.writeFileSync(fileA(), '# nothing\n')
    expect(readAnchorHandleAt(fileA())).toBeNull()
    expect(hasAnchorAt(fileA())).toBe(false)
  })

  it('reads a WRONG handle back rather than pretending there is none', () => {
    // This is the detection path for machines corrupted by older releases:
    // the block says @other while the credential says something else. It must
    // surface as "claims @other", not as "no anchor".
    const text = `${ANCHOR_START}\nYou are **@other-agent** on AgentChat.\n${ANCHOR_END}\n`
    expect(readAnchorHandleFrom(text)).toBe('other-agent')
  })
})

describe('block parsing edge cases', () => {
  it('ignores a marker quoted inside prose', () => {
    // Treating a quoted marker as a fence would eat the user's content
    // between the quote and the real block.
    const existing = [
      'Docs: the plugin uses `<!-- agentchat:start -->` fences.',
      '',
      'Content the user cares about.',
      '',
      ANCHOR_START,
      'You are **@agent-a** on AgentChat.',
      ANCHOR_END,
      '',
    ].join('\n')
    const out = stripAnchorBlock(existing)
    expect(out).toContain('Content the user cares about.')
    expect(out).toContain('Docs: the plugin uses')
    expect(out).not.toContain('@agent-a')
  })

  it('collapses multiple accumulated blocks to one on upsert', () => {
    const doubled = [
      `${ANCHOR_START}\nfirst **@a**\n${ANCHOR_END}`,
      `${ANCHOR_START}\nsecond **@b**\n${ANCHOR_END}`,
    ].join('\n\n')
    const out = upsertAnchorBlock(doubled, renderAnchorBlock('agent-c'))
    expect(out.split(ANCHOR_START)).toHaveLength(2)
    expect(out).toContain('@agent-c')
  })

  it('strips the legacy marker pair too', () => {
    const legacy = '<!-- agentchat-skill:start -->\nold\n<!-- agentchat-skill:end -->\n'
    expect(stripAnchorBlock(`# Keep\n\n${legacy}`)).toBe('# Keep\n')
  })
})
