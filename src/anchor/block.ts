import * as fs from 'node:fs'
import * as path from 'node:path'
import { integration as kit } from 'agentchatme'
import { atomicWriteFile } from '../util/fsutil.js'
import { isSetupOfferBody } from './offer.js'

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

/** Whose identity block a removal may take out: this agent's (the served line and template recognise its unmarked blocks exactly). */
export interface RemoveAnchorOptions {
  /** The agent being signed out or uninstalled; null when the home holds none (then only the setup offer is AgentChat's to remove). */
  readonly handle: string | null
  /** The served identity line, when texts are in hand (the identity-home cache will do). */
  readonly identityLine?: string | null
  /** The served `identity_line_template`, when in hand. */
  readonly template?: string | null
}

export interface RemoveAnchorResult {
  /** `removed`: AgentChat's block for this agent (or the setup offer) is gone; `kept`: a block that is not was left; `noop`: no file, or no block. */
  readonly action: 'removed' | 'noop' | 'kept'
  /** Why a block was left: edited by hand, another agent's, or more than one block (which are this agent's is not certain). */
  readonly kept: 'hand_edited' | 'other_agent' | 'several_blocks' | null
  /** The handle the block is AgentChat's for (the kit's `owner`), or null. */
  readonly claimed: string | null
  /** What was done, in words, naming the file. */
  readonly detail: string
}

/**
 * Take AgentChat out of the file — only what AgentChat placed for this
 * agent: its identity block (the kit's strict `owner` is `handle`: its handle
 * line, or a whole text that is exactly a served one), or the wizard's setup
 * offer or its declined variant. A block edited by hand, another agent's
 * block, or a file with more than one AgentChat block is left exactly as it
 * is, and the result says so. The rest of the file is kept as it was (line
 * breaks, whether it ends with one, a byte-order mark; the blank lines next
 * to the block become exactly one), and the write is atomic
 * (`writeInstructionFile`). Throws when the file exists but cannot be read
 * or written, as `hasAnchorAt` does.
 */
export function removeAnchorAt(filePath: string, options: RemoveAnchorOptions): RemoveAnchorResult {
  const result = (action: RemoveAnchorResult['action'], kept: RemoveAnchorResult['kept'], claimed: string | null, detail: string): RemoveAnchorResult => ({ action, kept, claimed, detail })
  const existing = readInstructionFile(filePath)
  if (existing === null) return result('noop', null, null, `${filePath} does not exist; no AgentChat block to remove`)
  const template = options.template ?? null
  const found = kit.anchor.find(existing.text, { template })
  if (found === null) return result('noop', null, null, `no AgentChat block in ${filePath}`)
  const handle = options.handle === null ? null : kit.anchor.normalizeHandle(options.handle)
  const owner = kit.anchor.owner(found, { ...(handle !== null ? { handle } : {}), identityLine: options.identityLine ?? null, template })
  // Taking the block out shows whether another one is left: then which are this agent's is not certain.
  if (kit.anchor.find(existing.text.slice(0, found.start) + existing.text.slice(found.end)) !== null) {
    return result('kept', 'several_blocks', owner, `left the AgentChat blocks in ${filePath}: there is more than one, so which are this agent's is not certain; remove them by hand if you no longer want them`)
  }
  const ours = isSetupOfferBody(found.body) || (handle !== null && owner === handle)
  if (!ours) {
    return owner === null
      ? result('kept', 'hand_edited', null, `left your edited AgentChat block in ${filePath}; remove it by hand if you no longer want it`)
      : result('kept', 'other_agent', owner, `left @${owner}'s AgentChat block in ${filePath} (not this agent's); remove it by hand if you no longer want it`)
  }
  const next = kit.anchor.remove(existing.text)
  if (next === existing.text) return result('noop', null, owner, `no AgentChat block in ${filePath}`)
  writeInstructionFile(filePath, existing.bom + next)
  return result('removed', null, owner, `AgentChat block removed from ${filePath}`)
}

export interface WriteOfferResult {
  /** `written`: the offer (or its declined variant) is in the file; `kept`: a block that is not AgentChat's offer is there, and was left. */
  readonly action: 'written' | 'kept'
  readonly detail: string
}

/**
 * Put the wizard's offer (or its declined variant, `block`) in the file —
 * only where it takes nothing of anyone's: after the file's own text when
 * there is no AgentChat block, or in place of the offer or declined block
 * already there. Any other block (this or another agent's identity block, one
 * edited by hand, more than one block) is left exactly as it is, and the
 * result says so. Logout writes the offer after taking this agent's block
 * out (`removeAnchorAt`), so a block it left stays. Throws as
 * `writeAnchor` does.
 */
export function writeOfferAt(filePath: string, block: string): WriteOfferResult {
  const existing = readInstructionFile(filePath)
  const text = existing?.text ?? ''
  const found = kit.anchor.find(text)
  if (found !== null) {
    const several = kit.anchor.find(text.slice(0, found.start) + text.slice(found.end)) !== null
    if (several || !isSetupOfferBody(found.body)) {
      return {
        action: 'kept',
        detail: `left the AgentChat block${several ? 's' : ''} in ${filePath} as ${several ? 'they are' : 'it is'} (not the setup offer); the offer is not written over ${several ? 'them' : 'it'} — remove ${several ? 'them' : 'it'} by hand if you no longer want ${several ? 'them' : 'it'}`,
      }
    }
  }
  writeAnchor(filePath, block)
  return { action: 'written', detail: `setup offer in ${filePath}` }
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
 * The handle a file's block is AgentChat's for, or null when there is no
 * block or it is not AgentChat's (the wizard's offer, a block edited by
 * hand). The kit's strict reading (`integration.anchor.owner`): the handle of
 * its handle line, or — with none — the handle its whole text is EXACTLY a
 * served text for (the served template filled in, or an identity line served
 * before). A sentence of the user's that says "I am @<handle>" names no
 * owner: the kit's loose `find` reading is display only. Lets an integration
 * catch a block that disagrees with its own credential — an agent told it is
 * @a while authenticating as @b hands peers an address that reaches someone
 * else — so a WRONG handle is read back, not treated as "no anchor".
 * (`identityBlockState` says the whole verdict in one sentence.)
 *
 * `template` is the served `identity_line_template` (null when no texts are
 * in hand). Throws as `hasAnchorAt` does.
 */
export function readAnchorHandleAt(filePath: string, template: string | null = null): string | null {
  const file = readInstructionFile(filePath)
  return file === null ? null : readAnchorHandleFrom(file.text, template)
}

export function readAnchorHandleFrom(text: string, template: string | null = null): string | null {
  const found = kit.anchor.find(text.replace(/^\uFEFF/, ''), { template })
  return found === null ? null : kit.anchor.owner(found, { template })
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
export function readInstructionFile(filePath: string): { bom: string; text: string } | null {
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
