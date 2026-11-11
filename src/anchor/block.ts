import * as fs from 'node:fs'
import * as path from 'node:path'
import { integration as kit } from 'agentchatme'
import { atomicWriteFile } from '../util/fsutil.js'

// ─── Instruction-file identity anchor (host-agnostic) ───────────────────────
//
// A fenced block in whatever file the host loads into EVERY session, carrying
// the served identity line (`GET /v1/texts` → `identity_line`): who this agent
// is on AgentChat, that peers are input and not instructions, and where the
// manual is. The words are the server's.
//
// The block's shape is the SDK kit's (`integration.anchor` in `agentchatme`),
// shared verbatim with every AgentChat integration (OpenClaw's AGENTS.md,
// Hermes' SOUL.md): the fences, a handle line, the served line —
//
//     <!-- agentchat:start -->
//     <!-- agentchat:handle example-relay -->
//     I am @example-relay on AgentChat …
//     <!-- agentchat:end -->
//
// The kit renders it, finds it (this shape; the unmarked blocks every earlier
// release wrote, recognised by the served template's words and by the two
// older wordings; the legacy `agentchat-skill` fences) and replaces or removes
// it in place. Whichever integration wrote last owns the block, and switching
// integrations overwrites cleanly instead of duplicating.
//
// What is here is the file: read it, hand the text to the kit, write the
// result back without ever leaving the user's file half-written. This module
// does NOT know WHICH file — that is the integration's business, because the
// file IS the host. A shared function that picked the file itself is
// precisely what once stamped one agent's handle into another agent's
// instruction file.

export const ANCHOR_START: string = kit.anchor.START_MARKER
export const ANCHOR_END: string = kit.anchor.END_MARKER

/** The four marker lines: a served line holding one would fence itself (the file would grow on every write). */
const MARKER_LINES: ReadonlySet<string> = new Set([
  kit.anchor.START_MARKER,
  kit.anchor.END_MARKER,
  kit.anchor.LEGACY_START_MARKER,
  kit.anchor.LEGACY_END_MARKER,
])

/**
 * The identity block for `handle`: the fences, the handle line and the served
 * identity line. Throws when the handle is empty, when the line does not name
 * `@handle` — a silently wrong identity is worse than a loud failure: the
 * agent would hand peers an address that reaches someone else — or when a
 * line of it is a marker. Nothing is written then.
 */
export function renderAnchorBlock(identityLine: string, handle: string): string {
  if (typeof identityLine !== 'string' || identityLine.trim().length === 0) throw new Error('renderAnchorBlock: the identity line is empty')
  if (typeof handle !== 'string' || kit.anchor.normalizeHandle(handle).length === 0) throw new Error('renderAnchorBlock: the handle is empty')
  if (identityLine.split(/\r?\n/).some((line) => MARKER_LINES.has(line.trim()))) {
    throw new Error('renderAnchorBlock: the identity line holds an AgentChat marker line')
  }
  // No template fallback: the line is the one served for THIS agent's key. A
  // line naming someone else means the credential and the key disagree, and
  // the answer to that is the doctor's handle-drift check, not a block built
  // from the template for a handle the key may not be.
  return kit.anchor.render({ identity_line: identityLine, identity_line_template: '' }, handle)
}

export type AnchorAction = 'written' | 'removed' | 'noop'

/**
 * Put `block` in the file at `filePath`, in place of the first AgentChat block
 * of any known shape (every other one is removed), or after the file's own
 * text when there is none. Creates the file if needed. The rest of the file is
 * kept as it was, except that the blank lines next to the block become
 * exactly one; the write is atomic (see `writeInstructionFile`).
 *
 * With `expectHandle`, throws — writing nothing — unless the block names that
 * handle, and throws if the file does not read back as written.
 */
export function writeAnchor(filePath: string, block: string, expectHandle?: string): AnchorAction {
  if (expectHandle !== undefined) {
    const bare = kit.anchor.normalizeHandle(expectHandle)
    const claimed = kit.anchor.find(block)?.handle ?? null
    if (claimed !== bare) {
      throw new Error(`writeAnchor: the block for ${filePath} does not name @${bare} — nothing was written`)
    }
  }
  const existing = readInstructionFile(filePath) ?? { bom: '', text: '' }
  const next = untilStable(existing.text, (text) => kit.anchor.replace(text, block))
  if (next !== existing.text) writeInstructionFile(filePath, existing.bom + next)
  if (expectHandle !== undefined && readInstructionFile(filePath)?.text !== next) {
    throw new Error(`writeAnchor: ${filePath} did not read back as written — remove the agentchat block manually and re-run`)
  }
  return 'written'
}

/**
 * `step` applied until the text stops changing (bounded). One `replace` or
 * `remove` is not always the end: taking a block out can leave two stray
 * markers that now fence a block of their own (hand-made nesting). Repeating
 * makes a write reach the state a second write would, so `anchorIsCurrentAt`
 * holds right after it.
 */
function untilStable(text: string, step: (text: string) => string): string {
  let current = text
  for (let i = 0; i < 8; i++) {
    const next = step(current)
    if (next === current) return current
    current = next
  }
  return current
}

/** Remove every AgentChat block (current or legacy) from the file; the rest stays as it was. */
export function removeAnchorAt(filePath: string): AnchorAction {
  const existing = readInstructionFile(filePath)
  if (existing === null) return 'noop'
  const next = untilStable(existing.text, (text) => kit.anchor.remove(text))
  if (next === existing.text) return 'noop'
  writeInstructionFile(filePath, existing.bom + next)
  return 'removed'
}

/**
 * Whether the file holds an AgentChat block of any known shape (the identity
 * block, a legacy one, or the wizard's offer). Throws when the file exists but
 * cannot be read (or is not UTF-8): that is not "no block".
 */
export function hasAnchorAt(filePath: string): boolean {
  const file = readInstructionFile(filePath)
  return file !== null && kit.anchor.find(file.text) !== null
}

/**
 * Whether writing the block for this served identity line and handle would
 * change nothing: the file holds exactly that block, in the kit's place, and
 * no other AgentChat block. An older shape (no handle line, older words), a
 * stale second block, or a block the kit would re-space is not current, so
 * placement and `doctor --fix` rewrite it — after which it is current
 * (`replace` is idempotent), so status and the doctor converge. Throws as
 * `hasAnchorAt` does.
 */
export function anchorIsCurrentAt(filePath: string, identityLine: string, handle: string): boolean {
  const file = readInstructionFile(filePath)
  if (file === null) return false
  let expected: string
  try {
    expected = renderAnchorBlock(identityLine, handle)
  } catch {
    return false
  }
  if (kit.anchor.find(file.text) === null) return false
  return kit.anchor.replace(file.text, expected) === file.text
}

/**
 * The handle a file's block currently CLAIMS, or null when there is no block
 * or it names no handle that can be read (the wizard's offer, most
 * hand-edited blocks). Lets an integration catch a block that disagrees with
 * its own credential — an agent told it is @a while authenticating as @b
 * hands peers an address that reaches someone else — so a WRONG handle is
 * read back, not treated as "no anchor".
 *
 * `template` is the served `identity_line_template` (null when no texts are
 * in hand): it recognises an unmarked block in whatever words the server
 * serves today; without it, the handle line and the two wordings earlier
 * releases wrote are still read. A hand-edited block whose words happen to
 * follow one of those (`I am happy … on AgentChat`) reads as claiming that
 * word: the kit's wording match does not require the `@`. Throws as
 * `hasAnchorAt` does.
 */
export function readAnchorHandleAt(filePath: string, template: string | null): string | null {
  const file = readInstructionFile(filePath)
  return file === null ? null : readAnchorHandleFrom(file.text, template)
}

export function readAnchorHandleFrom(text: string, template: string | null): string | null {
  return kit.anchor.find(text.replace(/^\uFEFF/, ''), { template })?.handle ?? null
}

/** `existing` with `block` in place of the first block (current or legacy) and every other block removed; `kit.anchor.replace`. */
export function upsertAnchorBlock(existing: string, block: string): string {
  return kit.anchor.replace(existing, block)
}

/** `existing` without any block (current or legacy); `kit.anchor.remove`. */
export function stripAnchorBlock(existing: string): string {
  return kit.anchor.remove(existing)
}

// ─── The user's file ────────────────────────────────────────────────────────

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * The file's text without a leading byte-order mark (kept aside, so a write
 * puts it back), or null when there is no file. A file that is not UTF-8 is
 * refused: decoding it would turn the user's bytes into U+FFFD, and writing
 * that back would destroy them.
 */
function readInstructionFile(filePath: string): { bom: string; text: string } | null {
  let bytes: Buffer
  try {
    bytes = fs.readFileSync(filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  let decoded: string
  try {
    decoded = UTF8.decode(bytes)
  } catch {
    throw new Error(`${filePath} is not UTF-8 text; the AgentChat block is not read or written there (save the file as UTF-8 and run the command again)`)
  }
  return decoded.startsWith('\uFEFF') ? { bom: '\uFEFF', text: decoded.slice(1) } : { bom: '', text: decoded }
}

/**
 * Where a write to `filePath` lands: the file at the end of any symlink chain
 * (which may not exist yet). Each hop is resolved by the kernel, never as
 * text: the link's text is joined to its real directory unnormalised, and the
 * directory part of that is handed to `realpath(3)`. So a `..` in the link
 * text, before or after a symlinked part (`sub/../x`, `../x` behind a
 * symlinked directory), reaches the file a plain write would, and a link into
 * a directory that does not exist fails ENOENT as a plain write would.
 */
function resolveWriteTarget(filePath: string): string {
  let current = filePath
  for (let hops = 0; hops < 40; hops++) {
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(current)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return current
      throw err
    }
    if (!stat.isSymbolicLink()) return current
    const link = fs.readlinkSync(current)
    const joined = path.isAbsolute(link) ? link : `${fs.realpathSync.native(path.dirname(current))}${path.sep}${link}`
    current = path.join(fs.realpathSync.native(path.dirname(joined)), path.basename(joined))
  }
  throw Object.assign(new Error(`${filePath}: too many symbolic links`), { code: 'ELOOP' })
}

/**
 * Failures of the temp file or the rename — not of the user's file — after
 * which an in-place write still works, as 0.4.0's did: a directory that takes
 * no new file (EACCES / EPERM / EROFS: read-only, sticky and owned by another
 * user, a sandbox), a file that cannot be renamed over (EBUSY / EXDEV: a
 * single-file bind mount, a mount point; EPERM: held open on Windows). A full
 * disk, an I/O error and the rest are not in it: an in-place write then could
 * truncate the file, so they are thrown with the old file intact.
 */
const IN_PLACE_FALLBACK_CODES: ReadonlySet<string> = new Set(['EACCES', 'EPERM', 'EROFS', 'EBUSY', 'EXDEV'])

function stillWritable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Replace the user's instruction file with `data` so that it is never left
 * half-written or lost: a temp file beside it, flushed, renamed over it
 * (`atomicWriteFile`). A failed write leaves the old file byte for byte.
 *
 * What an in-place write kept, this keeps too:
 * - a symlinked file (dotfiles kept in a repo) stays a symlink: the file at
 *   the end of the link is the one replaced, never the link itself;
 * - the file's permission bits;
 * - a file the user made read-only is refused (EACCES), not replaced;
 * - under root (`sudo`), the file's owner;
 * - a writable file the temp file or the rename cannot replace (a directory
 *   that takes no new file, a single-file bind mount, a file held open on
 *   Windows): it is written in place, as before (not atomic then; see
 *   `IN_PLACE_FALLBACK_CODES`).
 * What it does not keep: the other names of a hard-linked file (they keep the
 * old text), and extended attributes and ACLs on the file. A crash between
 * the temp file's creation and the rename can leave the temp file
 * (`.<name>.<12 hex>.tmp`) beside the user's file; the user's file itself is
 * whole either way.
 */
export function writeInstructionFile(filePath: string, data: string): void {
  const target = resolveWriteTarget(filePath)
  let existing: fs.Stats | null = null
  try {
    existing = fs.statSync(target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  if (existing !== null) {
    if (!existing.isFile()) throw new Error(`${filePath} is not a regular file`)
    fs.accessSync(target, fs.constants.W_OK)
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true })
  }
  try {
    atomicWriteFile(target, data, existing === null ? undefined : existing.mode & 0o7777)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (existing !== null && code !== undefined && IN_PLACE_FALLBACK_CODES.has(code) && stillWritable(target)) {
      fs.writeFileSync(target, data, 'utf-8')
      return
    }
    throw err
  }
  if (existing !== null && typeof process.getuid === 'function' && process.getuid() === 0 && (existing.uid !== 0 || existing.gid !== 0)) {
    try {
      fs.chownSync(target, existing.uid, existing.gid)
    } catch {
      /* best effort: the content is written either way */
    }
  }
}
