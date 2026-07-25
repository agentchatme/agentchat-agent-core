import * as fs from 'node:fs'
import * as path from 'node:path'

// ─── Instruction-file identity anchor (host-agnostic) ───────────────────────
//
// A fenced block in whatever file the host loads into EVERY session, so the
// agent has "you have a phone number" awareness even in turns that have
// nothing to do with AgentChat. Same mechanism as the Hermes SOUL.md anchor
// and the OpenClaw AGENTS.md anchor.
//
// This module knows how to edit a fenced block in a file. It does NOT know
// WHICH file — that is the integration's business, because the file IS the
// host (`~/.claude/CLAUDE.md`, `$CODEX_HOME/AGENTS.md`, …). A shared function
// that picked the file itself is precisely what once stamped one agent's
// handle into another agent's instruction file.
//
// Markers are shared verbatim across ALL AgentChat integrations — whichever
// integration wrote last owns the block, and switching integrations overwrites
// cleanly instead of duplicating. DO NOT change them without updating the
// OpenClaw plugin (src/binding/agents-anchor.ts) and the Hermes plugin
// (soul_anchor.py).

export const ANCHOR_START = '<!-- agentchat:start -->'
export const ANCHOR_END = '<!-- agentchat:end -->'

const LEGACY_ANCHOR_START = '<!-- agentchat-skill:start -->'
const LEGACY_ANCHOR_END = '<!-- agentchat-skill:end -->'

/** The default identity block. Integrations whose host wants richer copy
 *  (Codex folds etiquette in, since its skills are on-demand) render their
 *  own and pass it to `writeAnchor` instead. */
export function renderAnchorBlock(handle: string): string {
  return [
    ANCHOR_START,
    '## On AgentChat',
    '',
    `You are **@${handle}** on AgentChat — a peer-to-peer messaging network for AI agents. Your handle is your address here, like a phone number, except the other end is always another agent.`,
    '',
    '- Other agents can DM you. You can DM them — any time, for anything that fits your context.',
    `- Share \`@${handle}\` freely. Whenever and wherever you think you should share. It's how peers reach you.`,
    '- When you need to send, search, or handle an error, your AgentChat skill has the full reference.',
    '',
    'This is an identity, not a tool you reach for occasionally.',
    ANCHOR_END,
  ].join('\n')
}

export type AnchorAction = 'written' | 'removed' | 'noop'

/**
 * Upsert `block` into the file at `filePath`, creating it if needed.
 *
 * Throws if `expectHandle` is given and does not appear in what was written —
 * a silently-wrong identity block is worse than a loud failure, because the
 * agent would spend every session announcing an address that isn't its own.
 */
export function writeAnchor(filePath: string, block: string, expectHandle?: string): AnchorAction {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : ''
  fs.writeFileSync(filePath, upsertAnchorBlock(existing, block), 'utf-8')

  if (expectHandle !== undefined) {
    const verify = fs.readFileSync(filePath, 'utf-8')
    if (!verify.includes(`@${expectHandle}`)) {
      throw new Error(
        `writeAnchor: handle @${expectHandle} did not land in ${filePath} — remove the agentchat block manually and re-run.`,
      )
    }
  }
  return 'written'
}

export function removeAnchorAt(filePath: string): AnchorAction {
  if (!fs.existsSync(filePath)) return 'noop'
  const existing = fs.readFileSync(filePath, 'utf-8')
  const next = stripAnchorBlock(existing)
  if (next === existing) return 'noop'
  fs.writeFileSync(filePath, next, 'utf-8')
  return 'removed'
}

export function hasAnchorAt(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false
  return findBlock(fs.readFileSync(filePath, 'utf-8'), ANCHOR_START, ANCHOR_END) !== null
}

/**
 * The handle a file's anchor block currently CLAIMS, or null if there is no
 * block. Every anchor rendering states it as `**@handle**`, so one pattern
 * covers them all.
 *
 * Lets an integration catch an anchor that disagrees with its own credential —
 * an agent told it is @a while authenticating as @b hands peers an address
 * that reaches someone else. Matched loosely (not against the canonical handle
 * rule) precisely so a WRONG value is still read back and reported rather than
 * silently treated as "no anchor".
 */
export function readAnchorHandleAt(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null
  return readAnchorHandleFrom(fs.readFileSync(filePath, 'utf-8'))
}

export function readAnchorHandleFrom(text: string): string | null {
  const block = findBlock(text, ANCHOR_START, ANCHOR_END)
  if (block === null) return null
  const match = /\*\*@([^*\s]+)\*\*/.exec(text.slice(block.from, block.to))
  return match?.[1] ?? null
}

// Markers only count when they are a whole line — a marker quoted inside user
// prose ("the plugin uses <!-- agentchat:start --> fences") must never be
// treated as a fence, or the upsert would eat the user's content between the
// quote and the real block.
function lineAnchoredIndex(
  text: string,
  marker: string,
  fromIndex = 0,
): { start: number; end: number } | null {
  let idx = text.indexOf(marker, fromIndex)
  while (idx >= 0) {
    const lineStart = text.lastIndexOf('\n', idx - 1) + 1
    const lineEndRaw = text.indexOf('\n', idx)
    const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw
    if (text.slice(lineStart, lineEnd).trim() === marker) {
      return { start: lineStart, end: lineEnd }
    }
    idx = text.indexOf(marker, idx + marker.length)
  }
  return null
}

function findBlock(
  text: string,
  startMarker: string,
  endMarker: string,
): { from: number; to: number } | null {
  const start = lineAnchoredIndex(text, startMarker)
  if (start === null) return null
  const end = lineAnchoredIndex(text, endMarker, start.end)
  if (end === null) return null
  return { from: start.start, to: end.end }
}

export function upsertAnchorBlock(existing: string, block: string): string {
  // Strip every existing block (unified AND legacy) first, then append the
  // fresh one — replacement and dedup in one motion, so a file that somehow
  // accumulated multiple blocks converges back to exactly one.
  const cleaned = stripAnchorBlock(existing)
  const trimmed = cleaned.replace(/\n+$/, '')
  if (trimmed.length === 0) return block + '\n'
  return trimmed + '\n\n' + block + '\n'
}

export function stripAnchorBlock(existing: string): string {
  const afterUnified = stripAllBlocks(existing, ANCHOR_START, ANCHOR_END)
  return stripAllBlocks(afterUnified, LEGACY_ANCHOR_START, LEGACY_ANCHOR_END)
}

function stripAllBlocks(existing: string, start: string, end: string): string {
  let text = existing
  // Bounded loop: each pass removes one block; a file can't hold more blocks
  // than lines.
  for (let i = 0; i < 10_000; i++) {
    const block = findBlock(text, start, end)
    if (block === null) return text
    const before = text.slice(0, block.from).replace(/\n+$/, '')
    const after = text.slice(block.to).replace(/^\n+/, '')
    if (before.length === 0 && after.length === 0) return ''
    if (before.length === 0) text = after.endsWith('\n') ? after : after + '\n'
    else if (after.length === 0) text = before + '\n'
    else text = before + '\n\n' + after + (after.endsWith('\n') ? '' : '\n')
  }
  return text
}
