import { integration as kit } from 'agentchatme'
import { readInstructionFile } from './block.js'
import { isSetupOfferBody } from './offer.js'

// ─── The identity block follows the served identity line ────────────────────
//
// Install, register / login / recover and `doctor --fix` place the block
// (`writeAnchor`). The other half — the resident daemon bringing this agent's
// block to the line served now whenever its texts change — is the SDK kit's
// (`integration.anchor.follow`, one copy for every integration): which block
// is this agent's (`owner`: a handle line, or a whole text that is EXACTLY one
// AgentChat served), when to write (`decide`: only this agent's block, alone
// in the file, not already the served one; never a block where there is
// none), and how (the file read again right before the rename, the user's
// text, line breaks, byte-order mark and permission bits kept). A block with
// no handle line whose text is not one AgentChat served is the user's
// (`hand_edited`): a sentence of theirs that says "I am @<handle>" is theirs.
//
// What is here is this package's own: the setup offer the kit leaves alone
// (`isSetupOfferBody`), the repair each "left as it is" names (the CLI's
// `doctor --fix`), and the same reading for `status` and `doctor`
// (`identityBlockState`, on the kit's `decide` and `owner`), so the three say
// one thing about the block.

/** The kit's outcomes (`integration.anchor.FollowOutcome`): `updated`, `unchanged`, `absent`, `setup_offer`, `hand_edited`, `other_agent`, `several_blocks`, `edited_meanwhile`, `failed`. */
export type IdentityAnchorOutcome = Awaited<ReturnType<typeof kit.anchor.follow>>['outcome']

export interface IdentityAnchorResult {
  readonly outcome: IdentityAnchorOutcome
  readonly path: string
  /** The handle the block is AgentChat's for (for `other_agent`, the other agent's); null otherwise. */
  readonly claimed: string | null
  /** What happened, in words, for the log and the status file — with the repair, where one applies. */
  readonly detail: string
}

export interface FollowIdentityAnchorOptions {
  /** The host's always-loaded instruction file. */
  readonly filePath: string
  /** The agent this daemon serves. */
  readonly handle: string
  /** The served identity line (`texts.identity_line`). */
  readonly identityLine: string
  /** The served `identity_line_template`: a block with no handle line whose text is this, filled in, is AgentChat's. */
  readonly template?: string | null
  /** Test seam: the kit's `beforeWrite` (the new text flushed beside the file, before the file is read again for the rename). */
  readonly beforeWrite?: () => void | Promise<void>
}

/** Decisions in all before a file that keeps changing is left for now (the kit's `FOLLOW_ATTEMPTS`). */
export const IDENTITY_ANCHOR_ATTEMPTS: number = kit.anchor.FOLLOW_ATTEMPTS

/** The repair a "left as it is" names, by outcome: the CLI's explicit commands, which place the served block over any block. */
const REPAIR: Partial<Record<IdentityAnchorOutcome, string>> = {
  absent: 'install or `doctor --fix` places the identity line',
  setup_offer: '`doctor --fix` places the identity line',
  hand_edited: '`doctor --fix` puts the served block back',
  several_blocks: '`doctor --fix` keeps one, this agent\'s',
  other_agent: '`doctor` reports the mismatch',
  edited_meanwhile: 'tried again on the next texts change or daemon start',
}

/**
 * Bring this agent's identity block in `filePath` to the served line: the
 * kit's `follow`, with this package's setup offer recognised and the repair
 * named. Never creates a block (nor the file), never touches one that is not
 * this agent's, and never throws.
 */
export async function followIdentityAnchor(options: FollowIdentityAnchorOptions): Promise<IdentityAnchorResult> {
  const result = await kit.anchor.follow(options.filePath, {
    handle: options.handle,
    identityLine: options.identityLine,
    template: options.template ?? null,
    isSetupOffer: isSetupOfferBody,
    ...(options.beforeWrite !== undefined ? { beforeWrite: options.beforeWrite } : {}),
  })
  const repair = REPAIR[result.outcome]
  return { outcome: result.outcome, path: result.path, claimed: result.claimed, detail: repair === undefined ? result.detail : `${result.detail} (${repair})` }
}

// ─── The same reading, for `status` and `doctor` ────────────────────────────

/** The served line a host's `anchorLoadNote` judges another file's block against (the texts in hand; nulls when none are). */
export interface AnchorServedLine {
  readonly identityLine: string | null
  readonly template: string | null
}

/**
 * What a host says when its runtime loads another file in the instruction
 * file's place (`HostProfile.anchorLoadNote`): one clause naming the file
 * the runtime loads, and whether the identity line it gets there is the
 * served one. Said by `status`, `doctor` and every daemon follow; nothing
 * writes that other file.
 */
export interface AnchorLoadNote {
  /** One clause, naming the file the runtime loads, and what to do when `ok` is false. */
  readonly note: string
  /**
   * True: the runtime loads the served identity line all the same (from the
   * other file); the note is said, nothing is wrong. False: it loads no
   * identity line, or an older one — never a PASS.
   */
  readonly ok: boolean
}

/**
 * - `current` — this agent's block, the served one (`checked: false`: no usable served line in hand to compare with);
 * - `stale` — this agent's block, older text or an older shape;
 * - `missing` — no file, or no AgentChat block in it;
 * - `setup_offer`, `hand_edited`, `other_agent`, `several_blocks` — as the follow says;
 * - `unreadable` — the file exists but cannot be read (permissions, a symlink loop, not UTF-8).
 */
export type IdentityBlockStateName = 'current' | 'stale' | 'missing' | 'setup_offer' | 'hand_edited' | 'other_agent' | 'several_blocks' | 'unreadable'

export interface IdentityBlockState {
  readonly state: IdentityBlockStateName
  /** `doctor`'s verdict: PASS only for the served block where the runtime loads it; FAIL when the file cannot be read; WARN otherwise. */
  readonly verdict: 'PASS' | 'WARN' | 'FAIL'
  /** A usable served line was in hand, so currency was compared (false: `current` means this agent's block, unchecked). */
  readonly checked: boolean
  /** The handle the block is AgentChat's for (the kit's `owner`), or null. */
  readonly claimed: string | null
  /** What the host says about the file its runtime loads instead (`anchorLoadNote`), or null when it loads this one. */
  readonly loadNote: AnchorLoadNote | null
  /** That note when the runtime does not get the served line (`loadNote.ok` false), else null: what `status --json` carries as `anchor_not_loaded`. */
  readonly notLoaded: string | null
  /** What the block is, in one clause, naming the file (no repair: `describeIdentityBlock` adds it). */
  readonly what: string
}

export interface IdentityBlockStateOptions {
  readonly handle: string
  readonly identityLine: string | null
  readonly template: string | null
  /** The host's note on the file its runtime loads instead (`anchorLoadNote`); null when it loads this one. */
  readonly loadNote?: AnchorLoadNote | null
}

type Reading =
  | { readonly kind: 'missing' }
  | { readonly kind: 'several_blocks'; readonly claimed: string | null }
  | { readonly kind: 'setup_offer' }
  | { readonly kind: 'hand_edited'; readonly named: string | null }
  | { readonly kind: 'other_agent'; readonly claimed: string }
  | { readonly kind: 'current'; readonly checked: boolean }
  | { readonly kind: 'stale' }

/** The block, by the kit's `decide` when a usable served line is in hand. Null: decide could not judge (no usable line). */
function readByDecide(text: string, handle: string, identityLine: string, template: string | null): Reading | null {
  const decision = kit.anchor.decide(text, { handle, identityLine, template, isSetupOffer: isSetupOfferBody })
  switch (decision.outcome) {
    case 'absent':
      return { kind: 'missing' }
    case 'several_blocks':
      return { kind: 'several_blocks', claimed: decision.claimed }
    case 'setup_offer':
      return { kind: 'setup_offer' }
    case 'hand_edited':
      return { kind: 'hand_edited', named: decision.named !== null && decision.named !== handle ? decision.named : null }
    case 'other_agent':
      return { kind: 'other_agent', claimed: decision.claimed ?? '?' }
    case 'unchanged':
      return { kind: 'current', checked: true }
    case 'updated':
      return { kind: 'stale' }
    default:
      // `failed`: the served line is empty, names someone else or holds a marker — nothing to compare with.
      return null
  }
}

/** The block, by the kit's `owner` alone: no usable served line in hand, so currency is not checked. */
function readByOwner(text: string, handle: string, template: string | null): Reading {
  const found = kit.anchor.find(text, { template })
  if (found === null) return { kind: 'missing' }
  if (kit.anchor.find(text.slice(0, found.start) + text.slice(found.end)) !== null) return { kind: 'several_blocks', claimed: kit.anchor.owner(found, { handle, template }) }
  if (isSetupOfferBody(found.body)) return { kind: 'setup_offer' }
  const claimed = kit.anchor.owner(found, { handle, template })
  if (claimed === null) return { kind: 'hand_edited', named: null }
  if (claimed !== handle) return { kind: 'other_agent', claimed }
  return found.marked && !found.legacy ? { kind: 'current', checked: false } : { kind: 'stale' }
}

/**
 * What the block in `filePath` is, read the way the daemon decides (the
 * kit's `decide`; its `owner` when no usable served line is in hand), for
 * `status` and `doctor`. Never throws: a file that cannot be read is
 * `unreadable`.
 */
export function identityBlockState(filePath: string, options: IdentityBlockStateOptions): IdentityBlockState {
  const handle = kit.anchor.normalizeHandle(options.handle)
  const loadNote = options.loadNote ?? null
  const notLoaded = loadNote !== null && !loadNote.ok ? loadNote.note : null
  const state = (name: IdentityBlockStateName, verdict: IdentityBlockState['verdict'], claimed: string | null, what: string, checked: boolean): IdentityBlockState => ({
    state: name,
    // A runtime that does not get the served line is never a pass.
    verdict: notLoaded !== null && verdict === 'PASS' ? 'WARN' : verdict,
    checked,
    claimed,
    loadNote,
    notLoaded,
    what,
  })
  let file: { bom: string; text: string } | null
  try {
    file = readInstructionFile(filePath)
  } catch (err) {
    return state('unreadable', 'FAIL', null, `cannot read ${filePath}: ${err instanceof Error ? err.message : String(err)}`, false)
  }
  if (file === null) return state('missing', 'WARN', null, `no identity line in ${filePath} (the file does not exist)`, options.identityLine !== null)
  const byDecide = options.identityLine === null ? null : readByDecide(file.text, handle, options.identityLine, options.template)
  const checked = byDecide !== null
  const reading = byDecide ?? readByOwner(file.text, handle, options.template)
  switch (reading.kind) {
    case 'missing':
      return state('missing', 'WARN', null, `no identity line in ${filePath}`, checked)
    case 'several_blocks':
      return state('several_blocks', 'WARN', reading.claimed, `${filePath} holds more than one AgentChat block`, checked)
    case 'setup_offer':
      return state('setup_offer', 'WARN', null, `${filePath} holds the setup offer (no account), not @${handle}'s identity line`, checked)
    case 'hand_edited':
      // An agent reading it may take the handle it names for its own: worth saying (the kit's display-only `named`), never a reason to write.
      return state(
        'hand_edited',
        'WARN',
        null,
        `the AgentChat block in ${filePath} was edited by hand (no handle line, and not a text AgentChat served), so it is left as it is${reading.named !== null ? `; it names @${reading.named}, not @${handle}` : ''}`,
        checked,
      )
    case 'other_agent':
      return state('other_agent', 'WARN', reading.claimed, `${filePath} says @${reading.claimed} but this agent is @${handle}`, checked)
    case 'current':
      return reading.checked
        ? state('current', 'PASS', handle, `@${handle} in ${filePath}`, true)
        : state('current', 'WARN', handle, `@${handle} in ${filePath} (currency not checked: served texts unavailable)`, false)
    case 'stale':
      return state('stale', 'WARN', handle, `${filePath} carries an older identity text for @${handle}`, checked)
  }
}

/**
 * The one sentence `status` and `doctor` say about the block: what it is,
 * the repair (`fix`: the command that places the served block, e.g.
 * `npx -y @agentchatme/example doctor --fix`), and the host's note on the
 * file its runtime loads instead, when there is one. The repair is said only
 * where it changes something: not for the served block, nor for a file it
 * cannot read.
 */
export function describeIdentityBlock(state: IdentityBlockState, fix: string): string {
  const repair =
    state.state === 'current' || state.state === 'unreadable'
      ? null
      : state.state === 'hand_edited'
        ? `\`${fix}\` puts the served block back`
        : `repair with \`${fix}\``
  return [state.what, repair].filter((part): part is string => part !== null).join(' — ') + (state.loadNote !== null ? `; ${state.loadNote.note}` : '')
}
