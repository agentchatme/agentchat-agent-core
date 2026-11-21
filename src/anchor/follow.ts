import { integration as kit } from 'agentchatme'
import { readInstructionFile, renderAnchorBlock, writeInstructionFile } from './block.js'
import { isSetupOfferBody } from './offer.js'

// ─── The identity block follows the served identity line ────────────────────
//
// Install, register / login / recover and `doctor --fix` place the block
// (`writeAnchor`). This is the other half: the resident daemon holds the
// served texts and, whenever they change, brings this agent's block to the
// line served now. It never places one: where there is no block, placing it
// is a setup decision, the CLI's. And it only ever rewrites a block that is
// this agent's.
//
// Which block is this agent's, precisely. The file's AgentChat block (the
// first one with the current fences, else the first legacy one: the kit's
// `anchor.find`) is replaced only when ALL of these hold:
//
//   1. it is the only AgentChat block in the file: with two, a write would
//      remove the other (`anchor.replace` keeps one), and the other may be a
//      block of the user's or another agent's;
//   2. it is not the wizard's setup offer or its declined variant
//      (`isSetupOfferBody`);
//   3. it claims a handle: its handle line (`<!-- agentchat:handle h -->`),
//      or, for a block an earlier release wrote without one, the words of the
//      served template or of the two wordings earlier releases wrote — and
//      then only when those words name the handle with its `@` (`@h`), as
//      every served line and every earlier wording does. The kit's wording
//      match alone does not need the `@`, so "When I am asked about …" would
//      read as claiming `asked`; an unattended write needs more than that;
//   4. that handle is this agent's;
//   5. it is not already exactly the served block: its text (between the
//      fences, without the handle line, line endings and the space around it
//      aside) differs from the served line, or it is in an older shape (no
//      handle line, or the legacy fences) — the same text in the current
//      shape, so it is recognised by its handle line from then on, and
//      `status` and `doctor` read it as current.
//
// A block that fails 3 is HAND-EDITED: no handle line, and no `@handle` in
// words an AgentChat release wrote. It is the user's, and is left as it is
// (the rule the Hermes integration keeps for SOUL.md). A block that keeps its
// handle line is AgentChat's, whatever its text says: the handle line is the
// marker of a block AgentChat placed and keeps current, the way a version
// manager owns the fenced lines it wrote into a shell profile. So words typed
// inside such a block are replaced on the next follow — at the next daemon
// start (the kept copy of the texts is followed then too) or texts change.
//
// The write keeps the user's file as `writeAnchor` does: the block replaced
// where it stands, the text around it kept (the blank lines next to it become
// exactly one), a byte-order mark kept, the file replaced atomically
// (`writeInstructionFile`). The decision is made on one read. The new text is
// then written and flushed to a temp file beside the user's, and only then,
// right before the rename, the file is read again: if it changed (or is
// gone), nothing is written and the decision is made again on what is there
// now (a few times at most). What is left is the instant between that last
// read and the rename: an edit saved exactly then is not seen. No lock that
// editors honour exists, so that instant is as small as the window gets.

/**
 * - `updated` — this agent's block held other text (or the served text in an older shape); it holds the served block now.
 * - `unchanged` — it already is the served block; nothing was written.
 * - `absent` — no file, or no AgentChat block in it; nothing was created.
 * - `setup_offer` — the block is the wizard's offer (or its declined variant); left as it is.
 * - `hand_edited` — the block claims no handle (rule 3); left as it is.
 * - `other_agent` — the block is another agent's; left as it is.
 * - `several_blocks` — the file holds more than one AgentChat block; left as it is.
 * - `edited_meanwhile` — the file kept changing between the read and the write; left as it is.
 * - `failed` — the file could not be read or written, or the served line does not name this agent.
 */
export type IdentityAnchorOutcome =
  | 'updated'
  | 'unchanged'
  | 'absent'
  | 'setup_offer'
  | 'hand_edited'
  | 'other_agent'
  | 'several_blocks'
  | 'edited_meanwhile'
  | 'failed'

export interface IdentityAnchorResult {
  readonly outcome: IdentityAnchorOutcome
  readonly path: string
  /** The handle the block claims, when one could be read (for `other_agent`, the other agent's); null otherwise. */
  readonly claimed: string | null
  /** What happened, in words, for the log and the status file. */
  readonly detail: string
}

export interface FollowIdentityAnchorOptions {
  /** The host's always-loaded instruction file. */
  readonly filePath: string
  /** The agent this daemon serves. */
  readonly handle: string
  /** The served identity line (`texts.identity_line`). */
  readonly identityLine: string
  /** The served `identity_line_template`: recognises a block an earlier release wrote without a handle line, in today's words. */
  readonly template?: string | null
  /**
   * Test seam: called at the last moment of each write — the new text written
   * and flushed beside the file, before the file is read again for the rename.
   */
  readonly beforeWrite?: () => void
}

/** Attempts in all (the first decision, and the ones made again after the file changed under it) before leaving it for now. */
export const IDENTITY_ANCHOR_ATTEMPTS = 3

const normalized = (text: string): string => text.replace(/\r\n/g, '\n').trim()

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `@handle` as a whole handle in `text` (not the prefix of a longer one), any letter case. */
function namesWithAt(text: string, handle: string): boolean {
  return new RegExp(`@${escapeRegExp(handle)}(?![A-Za-z0-9_-])`, 'i').test(text)
}

/** The handle a block claims under rule 3: its handle line's, or its words' when they name it with the `@`. */
function claimedHandle(found: NonNullable<ReturnType<typeof kit.anchor.find>>): string | null {
  if (found.handle === null) return null
  if (found.marked) return found.handle
  return namesWithAt(found.body, found.handle) ? found.handle : null
}

/** The file changed between the decision and the rename; the write was not made. */
class ChangedMeanwhile extends Error {}

type Decision = { readonly write: false; readonly result: IdentityAnchorResult } | { readonly write: true; readonly next: string; readonly reshaped: boolean }

function noFile(filePath: string): IdentityAnchorResult {
  return { outcome: 'absent', path: filePath, claimed: null, detail: `${filePath} does not exist; nothing placed (install or \`doctor --fix\` places the identity line)` }
}

function decide(text: string, options: FollowIdentityAnchorOptions, handle: string): Decision {
  const { filePath } = options
  const leave = (outcome: IdentityAnchorOutcome, claimed: string | null, detail: string): Decision => ({ write: false, result: { outcome, path: filePath, claimed, detail } })
  const template = options.template ?? null
  const found = kit.anchor.find(text, { template })
  if (found === null) return leave('absent', null, `no AgentChat block in ${filePath}; nothing placed (install or \`doctor --fix\` places the identity line)`)
  // Taking the block out shows whether another one is left: a second block, or
  // stray fences that fence one once the first is gone (hand-made nesting).
  if (kit.anchor.find(text.slice(0, found.start) + text.slice(found.end), { template }) !== null) {
    return leave('several_blocks', claimedHandle(found), `${filePath} holds more than one AgentChat block; left as it is (\`doctor --fix\` keeps one)`)
  }
  if (isSetupOfferBody(found.body)) {
    return leave('setup_offer', null, `${filePath} holds the setup offer (no account), not @${handle}'s identity line; left as it is (\`doctor --fix\` places the identity line)`)
  }
  const claimed = claimedHandle(found)
  if (claimed === null) {
    return leave('hand_edited', null, `the AgentChat block in ${filePath} has no handle line and names no @handle in words an AgentChat release wrote: edited by hand, left as it is`)
  }
  if (claimed !== handle) {
    return leave('other_agent', claimed, `the AgentChat block in ${filePath} is @${claimed}'s, but this daemon serves @${handle}; left as it is (\`doctor\` reports the mismatch)`)
  }
  let block: string
  try {
    block = renderAnchorBlock(options.identityLine, handle)
  } catch (err) {
    return leave('failed', claimed, `the served identity line was not placed in ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const sameText = found.body === normalized(options.identityLine)
  const currentShape = found.marked && !found.legacy
  if (sameText && currentShape) {
    return leave('unchanged', claimed, `the identity line for @${handle} in ${filePath} is the served one`)
  }
  return { write: true, next: kit.anchor.replace(text, block), reshaped: sameText }
}

/**
 * Bring this agent's identity block in `filePath` to the served line, under
 * the rules above. Never creates a block (nor the file), never touches one
 * that is not this agent's, and never throws: every outcome, a failure
 * included, is a result.
 */
export function followIdentityAnchor(options: FollowIdentityAnchorOptions): IdentityAnchorResult {
  const { filePath } = options
  const handle = kit.anchor.normalizeHandle(options.handle)
  const failed = (what: string, err: unknown): IdentityAnchorResult => ({
    outcome: 'failed',
    path: filePath,
    claimed: handle,
    detail: `${what}: ${err instanceof Error ? err.message : String(err)}`,
  })
  for (let attempt = 0; attempt < IDENTITY_ANCHOR_ATTEMPTS; attempt++) {
    let file: { bom: string; text: string } | null
    try {
      file = readInstructionFile(filePath)
    } catch (err) {
      return { ...failed(`could not read ${filePath}`, err), claimed: null }
    }
    if (file === null) return noFile(filePath)
    const decision = decide(file.text, options, handle)
    if (!decision.write) return decision.result
    const decidedOn = file
    try {
      writeInstructionFile(filePath, decidedOn.bom + decision.next, {
        // Only ever a replacement: a file removed meanwhile is not made again.
        mustExist: true,
        // The last moment before the rename: what was decided on must still be what is there.
        beforeReplace: () => {
          options.beforeWrite?.()
          const now = readInstructionFile(filePath)
          if (now === null || now.bom !== decidedOn.bom || now.text !== decidedOn.text) throw new ChangedMeanwhile()
        },
      })
    } catch (err) {
      if (err instanceof ChangedMeanwhile || (err as NodeJS.ErrnoException).code === 'ENOENT') continue
      return failed(`could not write the identity line to ${filePath}`, err)
    }
    // The block landed: this agent's, with the served text (whatever else the file holds by now).
    let landed: ReturnType<typeof kit.anchor.find> = null
    try {
      const back = readInstructionFile(filePath)
      landed = back === null ? null : kit.anchor.find(back.text)
    } catch {
      landed = null
    }
    if (landed === null || landed.handle !== handle || !landed.marked || landed.body !== normalized(options.identityLine)) {
      return { outcome: 'failed', path: filePath, claimed: handle, detail: `${filePath} did not read back with the served identity line for @${handle} after the write` }
    }
    return {
      outcome: 'updated',
      path: filePath,
      claimed: handle,
      detail: decision.reshaped
        ? `the identity line for @${handle} in ${filePath} was the served text in an older shape; it now is the served block`
        : `the identity line for @${handle} in ${filePath} now is the served one`,
    }
  }
  return {
    outcome: 'edited_meanwhile',
    path: filePath,
    claimed: null,
    detail: `${filePath} changed while the identity line was being replaced (${IDENTITY_ANCHOR_ATTEMPTS} attempts); left as it is, tried again on the next texts change or daemon start`,
  }
}
