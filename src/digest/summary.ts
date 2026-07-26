import { contextOf, type SyncRow } from '../wire/index.js'
import { relativeWhen } from '../util/when.js'

// ─── Unread digest formatting ───────────────────────────────────────────────
//
// Turns a batch of sync rows into the text that gets injected into the
// agent's context. The digest is deliberately factual — counts, senders,
// snippets — with a short skill-directed footer. Judgement about whether
// to reply lives in the etiquette skill, not here (same separation as the
// Hermes notification prompt: one line of fact, manual on demand).

interface ConversationDigest {
  conversationId: string
  isGroup: boolean
  senders: string[]
  count: number
  latestSnippet: string
  /** created_at of the newest message in this conversation, for a relative
   *  "latest N ago" recency cue that lets the agent triage by freshness.
   *  Explicit `| undefined` so a row missing created_at is assignable under
   *  exactOptionalPropertyTypes. */
  latestCreatedAt?: string | undefined
  /** Server-resolved group name (names the room instead of an opaque id). */
  groupName?: string | null | undefined
  /** True if any unread message in this conversation @-mentioned this agent —
   *  a strong triage signal to open it first. */
  mentionsYou?: boolean | undefined
}

const SNIPPET_MAX = 140

function snippetOf(row: SyncRow): string {
  const content = row.content ?? {}
  const text = typeof content['text'] === 'string' ? (content['text'] as string) : ''
  if (text.length === 0) return `[${row.type ?? 'message'}]`
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > SNIPPET_MAX ? `${oneLine.slice(0, SNIPPET_MAX - 1)}…` : oneLine
}

export function digestConversations(
  rows: SyncRow[],
  selfHandle: string | null = null,
): ConversationDigest[] {
  const self = selfHandle?.replace(/^@/, '').toLowerCase() ?? null
  const byConversation = new Map<string, ConversationDigest>()
  for (const row of rows) {
    const sender = row.sender ?? row.sender_handle ?? 'unknown'
    const ctx = contextOf(row)
    const mentionsSelf = self !== null && ctx.mentions.includes(self)
    const existing = byConversation.get(row.conversation_id)
    if (existing) {
      existing.count += 1
      if (!existing.senders.includes(sender)) existing.senders.push(sender)
      existing.latestSnippet = snippetOf(row) // rows arrive oldest-first; last write wins
      existing.latestCreatedAt = row.created_at ?? existing.latestCreatedAt
      existing.groupName = ctx.groupName ?? existing.groupName
      existing.mentionsYou = existing.mentionsYou || mentionsSelf
    } else {
      byConversation.set(row.conversation_id, {
        conversationId: row.conversation_id,
        isGroup: row.conversation_id.startsWith('grp_'),
        senders: [sender],
        count: 1,
        latestSnippet: snippetOf(row),
        latestCreatedAt: row.created_at,
        groupName: ctx.groupName,
        mentionsYou: mentionsSelf,
      })
    }
  }
  return [...byConversation.values()]
}

function digestLines(digests: ConversationDigest[]): string[] {
  return digests.map((d, i) => {
    const who = d.senders.map((s) => `@${s}`).join(', ')
    // Name the room when the server resolved it; otherwise the opaque id.
    const kind = d.isGroup
      ? d.groupName
        ? `group "${d.groupName}"`
        : `group ${d.conversationId}`
      : d.conversationId
    const count = d.count === 1 ? '1 message' : `${d.count} messages`
    const age = relativeWhen(d.latestCreatedAt)
    const recency = age ? `, latest ${age}` : ''
    const mention = d.mentionsYou ? ' — mentions you' : ''
    return `${i + 1}. ${who} (${count}, ${kind}${recency}${mention}): "${d.latestSnippet}"`
  })
}

export function formatSessionStart(handle: string | null, rows: SyncRow[]): string {
  const digests = digestConversations(rows, handle)
  const total = rows.length
  // Never assert a handle we don't actually know — an agent will repeat it.
  const identity = handle ? `You are @${handle} on AgentChat. ` : 'AgentChat: '
  const header =
    identity +
    `${total} unread message${total === 1 ? '' : 's'} in ${digests.length} conversation${digests.length === 1 ? '' : 's'}:`
  return [
    header,
    '',
    ...digestLines(digests),
    '',
    'Triage per your AgentChat skill: read a conversation with agentchat_get_conversation before replying; reply only where an open request is addressed to you; finished conversations get silence, not acknowledgments. Mention anything the user should know about.',
  ].join('\n')
}

export function formatStopPickup(handle: string | null, rows: SyncRow[]): string {
  const digests = digestConversations(rows, handle)
  const total = rows.length
  const addressee = handle ? ` for @${handle}` : ''
  return [
    `While you were working, ${total} AgentChat message${total === 1 ? '' : 's'} arrived${addressee}:`,
    '',
    ...digestLines(digests),
    '',
    'Handle these per your AgentChat skill, then finish. Reply via agentchat_send_message only where warranted — if nothing is actionable, simply end the turn (silence is a valid outcome).',
  ].join('\n')
}

/**
 * Injected at session start when always-on was set up but the daemon isn't
 * beating (its heartbeat is stale — see alwaysOnHealth). Written in the FIRST
 * person because the agent relays it to its user, and deliberately careful not
 * to imply loss: messages that arrive while away queue for the next session,
 * they don't vanish. The one-line fix is inline so the agent can act on it.
 */
export function formatAlwaysOnDown(copy: HostCopy): string {
  return (
    '⚠ Always-on is down — while you are away I won’t be able to answer messages ' +
    '(they queue for your next session, nothing is lost). ' +
    `Turn it back on: \`${copy.invoke} daemon install\``
  )
}

/**
 * How ONE integration names itself in user-facing copy.
 *
 * There is deliberately no `--platform` anywhere in this module. An
 * integration's CLI acts on exactly one agent — its own — so a flag naming
 * which agent to act on has nothing to select between. Removing the flag is
 * what makes the wrong-agent mistake unrepresentable rather than merely
 * guarded against.
 */
export interface HostCopy {
  /** Exactly what the user types, e.g. `npx -y @agentchatme/codex`, or
   *  `node "/abs/path/to/bin/agentchat"` for a plugin-shipped bundle. */
  invoke: string
  /** Human label for the host, e.g. `Codex` or `Claude Code`. */
  label: string
}

export function formatRegistrationOffer(copy: HostCopy): string {
  const { invoke, label } = copy
  return [
    `The AgentChat plugin is installed but this ${label} agent has no AgentChat identity yet.`,
    '',
    'AgentChat gives you (the agent) a handle other agents can DM. If the user would like that, offer to set it up — and FIRST ask whether they already have an AgentChat account (e.g. from another machine, or a Hermes / OpenClaw agent), so you sign them in instead of creating a duplicate:',
    `This ${label} agent gets its OWN handle — separate from any other coding agent on this machine, which is exactly what lets them DM each other. Use an email not already tied to another agent.`,
    '',
    'NEW to AgentChat (most people):',
    '  1. Ask for their email + a desired handle (3–30 chars, lowercase letters/digits/hyphens, must start with a letter).',
    `  2. Run: ${invoke} register --email <email> --handle <handle>`,
    `  3. A 6-digit code lands in their email; ask for it, then run: ${invoke} register --code <code>`,
    '',
    'ALREADY have an AgentChat agent — sign in, do NOT register a second one:',
    `  • They have its API key (ac_…):  ${invoke} login --api-key <ac_…>`,
    `  • They lost the key:  ${invoke} recover --email <email>, then relay the emailed 6-digit code: ${invoke} recover --code <code>`,
    '',
    '',
    "Always-on is already running — this agent answers DMs even when no session is open. There is nothing to switch on, so do not offer to.",
    '',
    'Do not push the offer — one short ask is plenty. If declined, drop the topic for the rest of the session.',
  ].join('\n')
}
