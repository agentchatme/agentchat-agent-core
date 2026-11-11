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

/**
 * The identity block for `handle`: the fences, the handle line and the served
 * identity line. Throws when the handle is empty or the line does not name
 * `@handle` — a silently wrong identity is worse than a loud failure: the
 * agent would hand peers an address that reaches someone else. Nothing is
 * written then.
 */
export function renderAnchorBlock(identityLine: string, handle: string): string {
  if (typeof identityLine !== 'string' || identityLine.trim().length === 0) throw new Error('renderAnchorBlock: the identity line is empty')
  if (typeof handle !== 'string' || kit.anchor.normalizeHandle(handle).length === 0) throw new Error('renderAnchorBlock: the handle is empty')
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
 * text when there is none. Creates the file if needed. The rest of the file
 * is kept as it was; the write is atomic (see `writeInstructionFile`).
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
  const existing = readIfPresent(filePath) ?? ''
  const next = kit.anchor.replace(existing, block)
  if (next !== existing) writeInstructionFile(filePath, next)
  if (expectHandle !== undefined && readIfPresent(filePath) !== next) {
    throw new Error(`writeAnchor: ${filePath} did not read back as written — remove the agentchat block manually and re-run`)
  }
  return 'written'
}

/** Remove every AgentChat block (current or legacy) from the file; the rest stays as it was. */
export function removeAnchorAt(filePath: string): AnchorAction {
  const existing = readIfPresent(filePath)
  if (existing === null) return 'noop'
  const next = kit.anchor.remove(existing)
  if (next === existing) return 'noop'
  writeInstructionFile(filePath, next)
  return 'removed'
}

/** Whether the file holds an AgentChat block of any known shape (the identity block, a legacy one, or the wizard's offer). */
export function hasAnchorAt(filePath: string): boolean {
  const text = readIfPresent(filePath)
  return text !== null && kit.anchor.find(text) !== null
}

/**
 * Whether the file's block is exactly the block for this served identity line
 * and handle, and the only AgentChat block in the file: writing it again would
 * change nothing a session reads. An older shape (no handle line, older
 * words) or a stale second block is not current, so placement and
 * `doctor --fix` rewrite it.
 */
export function anchorIsCurrentAt(filePath: string, identityLine: string, handle: string): boolean {
  const text = readIfPresent(filePath)
  if (text === null) return false
  const found = kit.anchor.find(text)
  if (found === null) return false
  let expected: string
  try {
    expected = renderAnchorBlock(identityLine, handle)
  } catch {
    return false
  }
  if (text.slice(found.start, found.end) !== expected) return false
  return kit.anchor.find(text.slice(0, found.start) + text.slice(found.end)) === null
}

/**
 * The handle a file's block currently CLAIMS, or null when there is no block
 * or it names no handle that can be read (the wizard's offer, a hand-edited
 * block). Lets an integration catch a block that disagrees with its own
 * credential — an agent told it is @a while authenticating as @b hands peers
 * an address that reaches someone else — so a WRONG handle is read back, not
 * treated as "no anchor".
 *
 * `template` is the served `identity_line_template`: it recognises an
 * unmarked block in whatever words the server serves today. Without it, the
 * handle line and the two wordings earlier releases wrote are still read.
 */
export function readAnchorHandleAt(filePath: string, template?: string | null): string | null {
  const text = readIfPresent(filePath)
  return text === null ? null : readAnchorHandleFrom(text, template)
}

export function readAnchorHandleFrom(text: string, template?: string | null): string | null {
  return kit.anchor.find(text, { template: template ?? null })?.handle ?? null
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

function readIfPresent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** Where a write to `filePath` lands: the file at the end of any symlink chain (which may not exist yet). */
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
    current = path.resolve(path.dirname(current), fs.readlinkSync(current))
  }
  throw new Error(`${filePath}: too many symbolic links`)
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
 * - under root (`sudo`), the file's owner.
 * A hard-linked file is the one case it does not keep: the other name keeps
 * the old text.
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
  }
  if (existing === null) fs.mkdirSync(path.dirname(target), { recursive: true })
  atomicWriteFile(target, data, existing === null ? undefined : existing.mode & 0o7777)
  if (existing !== null && typeof process.getuid === 'function' && process.getuid() === 0 && (existing.uid !== 0 || existing.gid !== 0)) {
    try {
      fs.chownSync(target, existing.uid, existing.gid)
    } catch {
      /* best effort: the content is written either way */
    }
  }
}
