import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  anchorIsCurrentAt,
  readAnchorHandleAt,
  readAnchorHandleFrom,
  upsertAnchorBlock,
  stripAnchorBlock,
} from '../src/anchor/block.js'
import { renderDeclinedBlock, renderUnregisteredBlock } from '../src/anchor/offer.js'
import { HANDLE, OLD_BLOCKS, SERVED_TEMPLATE, USER_AFTER, USER_BEFORE, servedLine } from './fixtures/old-anchor-blocks.js'

// node:fs with a renameSync and a writeFileSync that a test can make fail, so
// the atomic write is exercised on a real disk with a real failure in the
// middle of it.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync), writeFileSync: vi.fn(actual.writeFileSync) }
})

// The anchor module edits a fenced block in a file it is TOLD about. It has no
// notion of which coding agent owns that file — picking the file was the job
// that once stamped one agent's handle into another agent's instructions.
// The block's shape is the SDK kit's; the words are the server's.

const line = (handle: string): string => `I am @${handle} on AgentChat (api.agentchat.me). Served line, test copy.`
const block = (handle: string): string => renderAnchorBlock(line(handle), handle)
const posix = process.platform !== 'win32'
const root = typeof process.getuid === 'function' && process.getuid() === 0

let dir: string
const fileA = (): string => path.join(dir, 'A.md')
const fileB = (): string => path.join(dir, 'B.md')
const strays = (): string[] => fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-core-anchor-'))
})
afterEach(() => {
  vi.mocked(fs.renameSync).mockReset()
  vi.mocked(fs.writeFileSync).mockReset()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('renderAnchorBlock', () => {
  it('is the kit block: fences, the handle line, the served line', () => {
    expect(renderAnchorBlock(servedLine(), `@${HANDLE.toUpperCase()}`)).toBe(
      [ANCHOR_START, `<!-- agentchat:handle ${HANDLE} -->`, servedLine(), ANCHOR_END].join('\n'),
    )
  })

  it('refuses a line that does not name the handle, so nothing wrong is ever written', () => {
    expect(() => renderAnchorBlock(servedLine('someone-else'), HANDLE)).toThrow(/names @example-relay/)
    // A longer handle that starts with this one is not this one.
    expect(() => renderAnchorBlock(servedLine(`${HANDLE}-two`), HANDLE)).toThrow(/names @example-relay/)
  })
})

describe('writeAnchor', () => {
  it('creates the file and its parent directory', () => {
    const nested = path.join(dir, 'deep', 'nest', 'CLAUDE.md')
    writeAnchor(nested, block('agent-a'), 'agent-a')
    expect(fs.readFileSync(nested, 'utf-8')).toBe(`${block('agent-a')}\n`)
  })

  it('keeps the user’s own content around the block, byte for byte', () => {
    fs.writeFileSync(fileA(), '# My notes\n\nSomething I wrote.\n')
    writeAnchor(fileA(), block('agent-a'), 'agent-a')
    expect(fs.readFileSync(fileA(), 'utf-8')).toBe(`# My notes\n\nSomething I wrote.\n\n${block('agent-a')}\n`)
  })

  it('replaces rather than appends on re-write, converging to ONE block', () => {
    writeAnchor(fileA(), block('old-handle'), 'old-handle')
    writeAnchor(fileA(), block('new-handle'), 'new-handle')
    const out = fs.readFileSync(fileA(), 'utf-8')
    expect(out.split(ANCHOR_START)).toHaveLength(2)
    expect(out).toContain('@new-handle')
    expect(out).not.toContain('old-handle')
  })

  it('does not touch the file when the block is already there', () => {
    writeAnchor(fileA(), block('agent-a'), 'agent-a')
    const before = fs.statSync(fileA()).mtimeMs
    vi.mocked(fs.renameSync).mockClear()
    writeAnchor(fileA(), block('agent-a'), 'agent-a')
    expect(fs.renameSync).not.toHaveBeenCalled()
    expect(fs.statSync(fileA()).mtimeMs).toBe(before)
  })

  it('refuses — writing nothing — a block that does not name the expected handle', () => {
    fs.writeFileSync(fileA(), '# untouched\n')
    expect(() => writeAnchor(fileA(), `${ANCHOR_START}\nno handle here\n${ANCHOR_END}`, 'agent-a')).toThrow(/does not name @agent-a/)
    expect(() => writeAnchor(fileA(), block('agent-b'), 'agent-a')).toThrow(/does not name @agent-a/)
    expect(fs.readFileSync(fileA(), 'utf-8')).toBe('# untouched\n')
  })

  it('writing one file never touches another', () => {
    writeAnchor(fileB(), block('agent-b'), 'agent-b')
    const before = fs.readFileSync(fileB(), 'utf-8')
    writeAnchor(fileA(), block('agent-a'), 'agent-a')
    expect(fs.readFileSync(fileB(), 'utf-8')).toBe(before)
  })
})

describe('removeAnchorAt', () => {
  it('strips our block and leaves the rest byte-for-byte', () => {
    fs.writeFileSync(fileA(), '# Keep me\n')
    writeAnchor(fileA(), block('agent-a'), 'agent-a')
    expect(removeAnchorAt(fileA())).toBe('removed')
    expect(fs.readFileSync(fileA(), 'utf-8')).toBe('# Keep me\n')
  })

  it('is a no-op on a file with no block, and on a missing file', () => {
    fs.writeFileSync(fileA(), '# Nothing of ours\n')
    expect(removeAnchorAt(fileA())).toBe('noop')
    expect(removeAnchorAt(path.join(dir, 'absent.md'))).toBe('noop')
    expect(fs.existsSync(path.join(dir, 'absent.md'))).toBe(false)
  })
})

describe('reading the claimed handle', () => {
  it('reads back what the block announces', () => {
    writeAnchor(fileA(), block('agent-a'), 'agent-a')
    expect(readAnchorHandleAt(fileA())).toBe('agent-a')
    expect(hasAnchorAt(fileA())).toBe(true)
  })

  it('returns null when there is no block at all, or no file', () => {
    fs.writeFileSync(fileA(), '# nothing\n')
    expect(readAnchorHandleAt(fileA())).toBeNull()
    expect(hasAnchorAt(fileA())).toBe(false)
    expect(readAnchorHandleAt(path.join(dir, 'absent.md'))).toBeNull()
    expect(hasAnchorAt(path.join(dir, 'absent.md'))).toBe(false)
  })

  it('reads a WRONG handle back rather than pretending there is none', () => {
    // The detection path for machines corrupted by older releases: the block
    // says @other while the credential says something else. It must surface
    // as "claims @other", not as "no anchor".
    expect(readAnchorHandleFrom(`${ANCHOR_START}\nYou are **@other-agent** on AgentChat.\n${ANCHOR_END}\n`)).toBe('other-agent')
    expect(readAnchorHandleFrom(`${ANCHOR_START}\n${servedLine('other-agent')}\n${ANCHOR_END}\n`)).toBe('other-agent')
  })

  it('recognises an unmarked block in whatever words the server serves, through the served template', () => {
    // The day the server rewords the line, a block a user or the manual's
    // recipe wrote in the new words (no handle line) is still this agent's.
    const template = 'Hello, peers: this is @<handle>, reachable on AgentChat.'
    const text = `${ANCHOR_START}\nHello, peers: this is @${HANDLE}, reachable on AgentChat.\n${ANCHOR_END}\n`
    expect(readAnchorHandleFrom(text)).toBeNull()
    expect(readAnchorHandleFrom(text, template)).toBe(HANDLE)
  })

  it('the wizard’s offer blocks claim no handle, with or without the served template', () => {
    const copy = { invoke: 'npx -y @agentchatme/example', label: 'Example' }
    for (const offer of [renderUnregisteredBlock(copy), renderDeclinedBlock(copy)]) {
      expect(readAnchorHandleFrom(offer)).toBeNull()
      expect(readAnchorHandleFrom(offer, SERVED_TEMPLATE)).toBeNull()
    }
  })
})

describe('anchorIsCurrentAt', () => {
  it('is true only for exactly the kit block of this line and handle, alone in the file', () => {
    const current = renderAnchorBlock(servedLine(), HANDLE)
    fs.writeFileSync(fileA(), `${USER_BEFORE}\n\n${current}\n`)
    expect(anchorIsCurrentAt(fileA(), servedLine(), HANDLE)).toBe(true)
    // Another handle, or another line, is not current.
    expect(anchorIsCurrentAt(fileA(), servedLine('someone-else'), 'someone-else')).toBe(false)
    expect(anchorIsCurrentAt(fileA(), `${servedLine()} (reworded)`, HANDLE)).toBe(false)
    // A stale second block — the agent would read two identities — is not current.
    fs.writeFileSync(fileA(), `${current}\n\n${OLD_BLOCKS[5]!.block}\n`)
    expect(anchorIsCurrentAt(fileA(), servedLine(), HANDLE)).toBe(false)
    fs.writeFileSync(fileA(), `${current}\n\n${current}\n`)
    expect(anchorIsCurrentAt(fileA(), servedLine(), HANDLE)).toBe(false)
    expect(anchorIsCurrentAt(path.join(dir, 'absent.md'), servedLine(), HANDLE)).toBe(false)
  })

  it('a line that names someone else is never current (and never throws)', () => {
    fs.writeFileSync(fileA(), `${renderAnchorBlock(servedLine(), HANDLE)}\n`)
    expect(anchorIsCurrentAt(fileA(), servedLine('someone-else'), HANDLE)).toBe(false)
  })
})

describe('every block an earlier release wrote', () => {
  const next = renderAnchorBlock(servedLine(), HANDLE)

  for (const old of OLD_BLOCKS) {
    describe(old.name, () => {
      it('is found, and its handle is read (with and without the served template)', () => {
        const text = `${USER_BEFORE}\n\n${old.block}\n\n${USER_AFTER}\n`
        expect(readAnchorHandleFrom(text, SERVED_TEMPLATE)).toBe(old.handle)
        expect(readAnchorHandleFrom(text)).toBe(old.handle)
        fs.writeFileSync(fileA(), text)
        expect(hasAnchorAt(fileA())).toBe(true)
        expect(anchorIsCurrentAt(fileA(), servedLine(), HANDLE)).toBe(false)
      })

      it('in the middle of the file: replaced in place, the user’s text on both sides kept byte for byte', () => {
        fs.writeFileSync(fileA(), `${USER_BEFORE}\n\n${old.block}\n\n${USER_AFTER}\n`)
        writeAnchor(fileA(), next, HANDLE)
        expect(fs.readFileSync(fileA(), 'utf-8')).toBe(`${USER_BEFORE}\n\n${next}\n\n${USER_AFTER}\n`)
        expect(anchorIsCurrentAt(fileA(), servedLine(), HANDLE)).toBe(true)
      })

      it('at the top of the file (the shape on real machines): stays at the top', () => {
        fs.writeFileSync(fileA(), `${old.block}\n\n---\n${USER_AFTER}\n`)
        writeAnchor(fileA(), next, HANDLE)
        expect(fs.readFileSync(fileA(), 'utf-8')).toBe(`${next}\n\n---\n${USER_AFTER}\n`)
      })

      it('at the end of a file with no final line break', () => {
        fs.writeFileSync(fileA(), `${USER_BEFORE}\n\n${old.block}`)
        writeAnchor(fileA(), next, HANDLE)
        expect(fs.readFileSync(fileA(), 'utf-8')).toBe(`${USER_BEFORE}\n\n${next}\n`)
      })

      it('a second write changes nothing (idempotent)', () => {
        fs.writeFileSync(fileA(), `${USER_BEFORE}\n\n${old.block}\n\n${USER_AFTER}\n`)
        writeAnchor(fileA(), next, HANDLE)
        const once = fs.readFileSync(fileA(), 'utf-8')
        writeAnchor(fileA(), next, HANDLE)
        expect(fs.readFileSync(fileA(), 'utf-8')).toBe(once)
      })

      it('logout removes it and leaves exactly the user’s text', () => {
        fs.writeFileSync(fileA(), `${USER_BEFORE}\n\n${old.block}\n\n${USER_AFTER}\n`)
        expect(removeAnchorAt(fileA())).toBe('removed')
        expect(fs.readFileSync(fileA(), 'utf-8')).toBe(`${USER_BEFORE}\n\n${USER_AFTER}\n`)
      })

      it('in a CRLF file: the user’s lines keep their CRLF, no text is lost', () => {
        const crlf = (s: string): string => s.replace(/\n/g, '\r\n')
        fs.writeFileSync(fileA(), crlf(`${USER_BEFORE}\n\n${old.block}\n\n${USER_AFTER}\n`))
        expect(readAnchorHandleAt(fileA(), SERVED_TEMPLATE)).toBe(old.handle)
        writeAnchor(fileA(), next, HANDLE)
        const out = fs.readFileSync(fileA(), 'utf-8')
        expect(out.startsWith(crlf(USER_BEFORE))).toBe(true)
        expect(out).toContain(crlf(USER_AFTER))
        expect(out.split(ANCHOR_START)).toHaveLength(2)
        expect(readAnchorHandleAt(fileA())).toBe(HANDLE)
      })
    })
  }

  it('a file carrying a legacy block AND a current one converges to one block, where the first one was', () => {
    const legacy = OLD_BLOCKS.find((b) => b.block.startsWith('<!-- agentchat-skill:start -->'))!
    const unmarked = OLD_BLOCKS[4]!
    fs.writeFileSync(fileA(), `${USER_BEFORE}\n\n${legacy.block}\n\nmiddle text\n\n${unmarked.block}\n\n${USER_AFTER}\n`)
    writeAnchor(fileA(), next, HANDLE)
    expect(fs.readFileSync(fileA(), 'utf-8')).toBe(`${USER_BEFORE}\n\n${next}\n\nmiddle text\n\n${USER_AFTER}\n`)
  })

  it('the wizard’s offer is replaced by the identity block on registration, in place', () => {
    const offer = renderUnregisteredBlock({ invoke: 'npx -y @agentchatme/example', label: 'Example' })
    fs.writeFileSync(fileA(), `${USER_BEFORE}\n\n${offer}\n\n${USER_AFTER}\n`)
    writeAnchor(fileA(), next, HANDLE)
    expect(fs.readFileSync(fileA(), 'utf-8')).toBe(`${USER_BEFORE}\n\n${next}\n\n${USER_AFTER}\n`)
  })
})

describe('odd files', () => {
  const next = renderAnchorBlock(servedLine(), HANDLE)

  it('a marker quoted inside prose is not a fence', () => {
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
    expect(stripAnchorBlock(existing)).toBe('Docs: the plugin uses `<!-- agentchat:start -->` fences.\n\nContent the user cares about.\n')
  })

  it('a start marker with no end is not a block: nothing after it is eaten, the new block is appended', () => {
    const half = `${USER_BEFORE}\n\n${ANCHOR_START}\nI half-pasted this.\n\n${USER_AFTER}\n`
    fs.writeFileSync(fileA(), half)
    expect(hasAnchorAt(fileA())).toBe(false)
    writeAnchor(fileA(), next, HANDLE)
    expect(fs.readFileSync(fileA(), 'utf-8')).toBe(`${half}\n${next}\n`)
  })

  it('a dangling start before a real block does not swallow the text between them', () => {
    const text = `${ANCHOR_START}\nkeep me\n\n${OLD_BLOCKS[4]!.block}\n`
    fs.writeFileSync(fileA(), text)
    writeAnchor(fileA(), next, HANDLE)
    expect(fs.readFileSync(fileA(), 'utf-8')).toBe(`${ANCHOR_START}\nkeep me\n\n${next}\n`)
  })

  it('an end marker with no start is left alone', () => {
    fs.writeFileSync(fileA(), `${USER_BEFORE}\n${ANCHOR_END}\n`)
    writeAnchor(fileA(), next, HANDLE)
    expect(fs.readFileSync(fileA(), 'utf-8')).toBe(`${USER_BEFORE}\n${ANCHOR_END}\n\n${next}\n`)
  })

  it('markers with surrounding spaces still fence (whole line, trimmed)', () => {
    fs.writeFileSync(fileA(), `${USER_BEFORE}\n\n  ${ANCHOR_START}  \n${servedLine('old-agent')}\n\t${ANCHOR_END}\n`)
    expect(readAnchorHandleAt(fileA())).toBe('old-agent')
    writeAnchor(fileA(), next, HANDLE)
    expect(fs.readFileSync(fileA(), 'utf-8')).toBe(`${USER_BEFORE}\n\n${next}\n`)
  })

  it('an empty block, and a hand-edited one naming no handle, are found and replaced', () => {
    for (const inner of ['', 'my own note about AgentChat']) {
      fs.writeFileSync(fileA(), `${USER_BEFORE}\n\n${ANCHOR_START}\n${inner}${inner ? '\n' : ''}${ANCHOR_END}\n`)
      expect(hasAnchorAt(fileA())).toBe(true)
      expect(readAnchorHandleAt(fileA(), SERVED_TEMPLATE)).toBeNull()
      writeAnchor(fileA(), next, HANDLE)
      expect(fs.readFileSync(fileA(), 'utf-8')).toBe(`${USER_BEFORE}\n\n${next}\n`)
    }
  })

  it('an upper-case handle in an old block reads as the canonical lower-case handle', () => {
    expect(readAnchorHandleFrom(`${ANCHOR_START}\nYou are **@Example-Relay** on AgentChat.\n${ANCHOR_END}\n`)).toBe(HANDLE)
  })

  it('upsertAnchorBlock / stripAnchorBlock are the kit’s replace / remove', () => {
    const doubled = `${ANCHOR_START}\nfirst **@a**\n${ANCHOR_END}\n\n${ANCHOR_START}\nsecond **@b**\n${ANCHOR_END}\n`
    const out = upsertAnchorBlock(doubled, block('agent-c'))
    expect(out).toBe(`${block('agent-c')}\n`)
    expect(stripAnchorBlock(`# Keep\n\n<!-- agentchat-skill:start -->\nold\n<!-- agentchat-skill:end -->\n`)).toBe('# Keep\n')
  })
})

describe('the user’s file is never left half-written or lost', () => {
  const original = `${USER_BEFORE}\n\n${OLD_BLOCKS[4]!.block}\n\n${USER_AFTER}\n`
  const next = renderAnchorBlock(servedLine(), HANDLE)

  it('a rename that fails leaves the old file byte for byte, and no temp file behind', () => {
    fs.writeFileSync(fileA(), original)
    vi.mocked(fs.renameSync).mockImplementation(() => {
      throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' })
    })
    expect(() => writeAnchor(fileA(), next, HANDLE)).toThrow(/EIO/)
    expect(() => removeAnchorAt(fileA())).toThrow(/EIO/)
    vi.mocked(fs.renameSync).mockReset()
    expect(fs.readFileSync(fileA(), 'utf-8')).toBe(original)
    expect(strays()).toEqual([])
  })

  it('a write that dies half-way (disk full) leaves the old file byte for byte, and no temp file behind', async () => {
    fs.writeFileSync(fileA(), original)
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.mocked(fs.writeFileSync).mockImplementation(((target: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView) => {
      // Half the bytes reach the temp file, then the disk is full.
      const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      actual.writeFileSync(target, bytes.subarray(0, Math.floor(bytes.length / 2)))
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
    }) as typeof fs.writeFileSync)
    expect(() => writeAnchor(fileA(), next, HANDLE)).toThrow(/ENOSPC/)
    vi.mocked(fs.writeFileSync).mockReset()
    expect(fs.readFileSync(fileA(), 'utf-8')).toBe(original)
    expect(strays()).toEqual([])
  })

  it('a reader sees the whole old file until the swap and the whole new one after it — never part of one', async () => {
    fs.writeFileSync(fileA(), original)
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    const seen: { before: string; tmp: string; after: string }[] = []
    vi.mocked(fs.renameSync).mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      const before = actual.readFileSync(fileA(), 'utf-8')
      const tmp = actual.readFileSync(from, 'utf-8')
      actual.renameSync(from, to) // the swap is one rename(2): no in-between state exists
      seen.push({ before, tmp, after: actual.readFileSync(fileA(), 'utf-8') })
    }) as typeof fs.renameSync)
    writeAnchor(fileA(), next, HANDLE)
    const expected = `${USER_BEFORE}\n\n${next}\n\n${USER_AFTER}\n`
    expect(seen).toEqual([{ before: original, tmp: expected, after: expected }])
  })

  it.skipIf(!posix)('a symlinked instruction file stays a symlink; the file it points to gets the block', () => {
    const real = path.join(dir, 'dotfiles', 'CLAUDE.md')
    fs.mkdirSync(path.dirname(real))
    fs.writeFileSync(real, original)
    const link = path.join(dir, 'CLAUDE.md')
    fs.symlinkSync(path.relative(dir, real), link)
    writeAnchor(link, next, HANDLE)
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(real, 'utf-8')).toBe(`${USER_BEFORE}\n\n${next}\n\n${USER_AFTER}\n`)
    expect(removeAnchorAt(link)).toBe('removed')
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(real, 'utf-8')).toBe(`${USER_BEFORE}\n\n${USER_AFTER}\n`)
  })

  it.skipIf(!posix)('a symlink to a file that does not exist yet: the file is created where the link points', () => {
    const real = path.join(dir, 'dotfiles', 'AGENTS.md')
    fs.mkdirSync(path.dirname(real))
    const link = path.join(dir, 'AGENTS.md')
    fs.symlinkSync(real, link)
    writeAnchor(link, next, HANDLE)
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(real, 'utf-8')).toBe(`${next}\n`)
  })

  it.skipIf(!posix)('the file’s permission bits are kept', () => {
    fs.writeFileSync(fileA(), original)
    fs.chmodSync(fileA(), 0o640)
    writeAnchor(fileA(), next, HANDLE)
    expect(fs.statSync(fileA()).mode & 0o777).toBe(0o640)
  })

  it.skipIf(!posix || root)('a file the user made read-only is refused, not replaced', () => {
    fs.writeFileSync(fileA(), original)
    fs.chmodSync(fileA(), 0o444)
    expect(() => writeAnchor(fileA(), next, HANDLE)).toThrow(/EACCES/)
    expect(() => removeAnchorAt(fileA())).toThrow(/EACCES/)
    expect(fs.readFileSync(fileA(), 'utf-8')).toBe(original)
    fs.chmodSync(fileA(), 0o644)
  })

  it('a directory where the file should be is refused', () => {
    fs.mkdirSync(fileA())
    expect(() => writeAnchor(fileA(), next, HANDLE)).toThrow()
    expect(fs.statSync(fileA()).isDirectory()).toBe(true)
  })
})

describe('what the review of 0.4.1 found, pinned', () => {
  const next = renderAnchorBlock(servedLine(), HANDLE)
  const original = `${USER_BEFORE}\n\n${OLD_BLOCKS[4]!.block}\n\n${USER_AFTER}\n`
  const updated = `${USER_BEFORE}\n\n${next}\n\n${USER_AFTER}\n`

  it.skipIf(!posix)('a relative ../ link behind a symlinked directory updates the file the kernel reaches, and nothing else', () => {
    // real/x/CLAUDE.md is the file; real/sub/CLAUDE.md -> ../x/CLAUDE.md; home -> real/sub.
    // Text-joining home/../x would name <dir>/x/CLAUDE.md — a different file.
    const real = path.join(dir, 'real')
    fs.mkdirSync(path.join(real, 'x'), { recursive: true })
    fs.mkdirSync(path.join(real, 'sub'))
    fs.writeFileSync(path.join(real, 'x', 'CLAUDE.md'), original)
    fs.symlinkSync('../x/CLAUDE.md', path.join(real, 'sub', 'CLAUDE.md'))
    fs.mkdirSync(path.join(dir, 'x'))
    fs.writeFileSync(path.join(dir, 'x', 'CLAUDE.md'), 'an unrelated file\n')
    fs.symlinkSync(path.join(real, 'sub'), path.join(dir, 'home'))

    writeAnchor(path.join(dir, 'home', 'CLAUDE.md'), next, HANDLE)
    expect(fs.readFileSync(path.join(real, 'x', 'CLAUDE.md'), 'utf-8')).toBe(updated)
    expect(fs.readFileSync(path.join(dir, 'x', 'CLAUDE.md'), 'utf-8')).toBe('an unrelated file\n')
    expect(fs.lstatSync(path.join(real, 'sub', 'CLAUDE.md')).isSymbolicLink()).toBe(true)

    expect(removeAnchorAt(path.join(dir, 'home', 'CLAUDE.md'))).toBe('removed')
    expect(fs.readFileSync(path.join(real, 'x', 'CLAUDE.md'), 'utf-8')).toBe(`${USER_BEFORE}\n\n${USER_AFTER}\n`)
    expect(fs.readFileSync(path.join(dir, 'x', 'CLAUDE.md'), 'utf-8')).toBe('an unrelated file\n')
  })

  it.skipIf(!posix)('a symlink loop is refused and nothing is written', () => {
    fs.symlinkSync(path.join(dir, 'b.md'), path.join(dir, 'a.md'))
    fs.symlinkSync(path.join(dir, 'a.md'), path.join(dir, 'b.md'))
    expect(() => writeAnchor(path.join(dir, 'a.md'), next, HANDLE)).toThrow(/ELOOP|too many symbolic links/)
    expect(fs.readdirSync(dir).sort()).toEqual(['a.md', 'b.md'])
  })

  it.skipIf(!posix || root)('a writable file in a directory that is not: written in place, as 0.4.0 did, never refused', () => {
    const locked = path.join(dir, 'locked')
    fs.mkdirSync(locked)
    const file = path.join(locked, 'CLAUDE.md')
    fs.writeFileSync(file, original)
    fs.chmodSync(locked, 0o555)
    try {
      writeAnchor(file, next, HANDLE)
      expect(fs.readFileSync(file, 'utf-8')).toBe(updated)
      expect(removeAnchorAt(file)).toBe('removed')
      expect(fs.readFileSync(file, 'utf-8')).toBe(`${USER_BEFORE}\n\n${USER_AFTER}\n`)
      expect(fs.readdirSync(locked)).toEqual(['CLAUDE.md'])
    } finally {
      fs.chmodSync(locked, 0o755)
    }
  })

  it('a leading byte-order mark is kept, wherever the block is', () => {
    fs.writeFileSync(fileA(), `﻿${OLD_BLOCKS[4]!.block}\n\n${USER_AFTER}\n`)
    expect(readAnchorHandleAt(fileA(), SERVED_TEMPLATE)).toBe(HANDLE)
    writeAnchor(fileA(), next, HANDLE)
    expect(fs.readFileSync(fileA(), 'utf-8')).toBe(`﻿${next}\n\n${USER_AFTER}\n`)
    expect(anchorIsCurrentAt(fileA(), servedLine(), HANDLE)).toBe(true)
    expect(removeAnchorAt(fileA())).toBe('removed')
    expect(fs.readFileSync(fileA(), 'utf-8')).toBe(`﻿${USER_AFTER}\n`)
    fs.writeFileSync(fileA(), `﻿${USER_BEFORE}\n`)
    writeAnchor(fileA(), next, HANDLE)
    expect(fs.readFileSync(fileA(), 'utf-8')).toBe(`﻿${USER_BEFORE}\n\n${next}\n`)
  })

  it('a file that is not UTF-8 is never rewritten (its bytes would become U+FFFD)', () => {
    const latin1 = Buffer.concat([Buffer.from('# R'), Buffer.from([0xe9]), Buffer.from('sumé\n', 'latin1'), Buffer.from(`\n${OLD_BLOCKS[4]!.block}\n`)])
    fs.writeFileSync(fileA(), latin1)
    expect(() => writeAnchor(fileA(), next, HANDLE)).toThrow(/not UTF-8/)
    expect(() => removeAnchorAt(fileA())).toThrow(/not UTF-8/)
    expect(() => hasAnchorAt(fileA())).toThrow(/not UTF-8/)
    expect(fs.readFileSync(fileA()).equals(latin1)).toBe(true)
  })

  it('a served line that holds a marker line is refused (it would fence itself and grow the file on every write)', () => {
    for (const marker of [ANCHOR_END, ANCHOR_START, '<!-- agentchat-skill:end -->', `  ${ANCHOR_END}  `]) {
      expect(() => renderAnchorBlock(`${servedLine()}\n${marker}\nmore`, HANDLE)).toThrow(/marker/)
    }
    // A marker quoted inside a sentence is not a marker line.
    expect(() => renderAnchorBlock(`${servedLine()} (fenced by ${ANCHOR_START})`, HANDLE)).not.toThrow()
  })

  it('currency agrees with what a write would do, so status and doctor --fix converge', () => {
    // The current block inside a legacy pair: a write changes nothing … once.
    fs.writeFileSync(fileA(), `<!-- agentchat-skill:start -->\n${next}\n<!-- agentchat-skill:end -->\n`)
    writeAnchor(fileA(), next, HANDLE)
    expect(anchorIsCurrentAt(fileA(), servedLine(), HANDLE)).toBe(true)
    const once = fs.readFileSync(fileA(), 'utf-8')
    writeAnchor(fileA(), next, HANDLE)
    expect(fs.readFileSync(fileA(), 'utf-8')).toBe(once)
    // The block with no blank line before it: a write would re-space it, so it is not current — until written.
    fs.writeFileSync(fileA(), `${USER_BEFORE}\n${next}\n`)
    expect(anchorIsCurrentAt(fileA(), servedLine(), HANDLE)).toBe(false)
    writeAnchor(fileA(), next, HANDLE)
    expect(anchorIsCurrentAt(fileA(), servedLine(), HANDLE)).toBe(true)
  })
})
