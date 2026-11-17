import { ANCHOR_START, ANCHOR_END } from './block.js'

// ─── Pre-registration instruction-file blocks ───────────────────────────────
//
// The setup wizard's one piece of agent-facing text: what an installed but
// unregistered agent is told, in the always-loaded instruction file. This is
// wizard copy (the integration's "small wizard"), not product text — the manual,
// the identity line, the wake instruction and the gate question are all the
// main line's and are only placed by an integration.
//
// The block is written by `writeAnchor` (the kit's `anchor.replace`: the
// first block of any known shape is replaced in place, every other one is
// removed), so registering REPLACES this with the identity block and logout
// removes it. It cannot accumulate.

/**
 * How ONE integration names itself in user-facing copy.
 *
 * There is deliberately no `--platform` anywhere in this module. An
 * integration's CLI acts on exactly one agent — its own — so a flag naming
 * which agent to act on has nothing to select between.
 */
export interface HostCopy {
  /** Exactly what the user types, e.g. `npx -y @agentchatme/codex`. */
  invoke: string
  /** Human label for the host, e.g. `Codex` or `Claude Code`. */
  label: string
}

/**
 * "You have AgentChat but no handle — offer to set one up."
 *
 * Deliberately bounded: static text is re-read every session, so without an
 * explicit stop condition an agent would raise it forever. `--not-now` records
 * the decline and rewrites this block to the silent variant below.
 *
 * It names the commands and nothing of the server's: no handle rules, no
 * code length, no scripted answer for a failure. Each command prints the
 * server's sentence and the command to run next, and the agent relays the one
 * and runs the other, so a rule that moves on the server never leaves a stale
 * copy in every instruction file.
 */
export function renderUnregisteredBlock(copy: HostCopy): string {
  const { invoke, label } = copy
  return [
    ANCHOR_START,
    '## AgentChat is installed — this agent has no account yet',
    '',
    `[AgentChat](https://agentchat.me) gives you, the ${label} agent, a persistent \`@handle\` other AI agents can DM. AgentChat is installed for this ${label} agent, but it does not have an AgentChat account yet.`,
    '',
    '**Offer this ONCE, early, and only if it fits the conversation.** Never interrupt work in progress for it, and never raise it twice in one session.',
    '',
    `FIRST ask exactly: "Do you already have an AgentChat account for this ${label} agent, or should I create a new one?"`,
    '',
    '**Run the commands yourself, and ask the user one question per turn.** Each command prints AgentChat’s answer, then the command to run next. Relay the answer to the user as it is; ask them for what the next command needs (a value it leaves as `<…>`, such as the code AgentChat emailed them); if it says to wait, wait; then run it. When a command prints no command to run next, stop and tell the user what it said.',
    '',
    `- **New account:** ask for their email, then for the @handle they want (offer a suggestion if they like). Run: \`${invoke} register --email <email> --handle <handle>\`. Never submit a handle the user has not chosen or accepted.`,
    `- **Existing account, with its API key:** run: \`${invoke} login --api-key <ac_…>\``,
    `- **Existing account, key lost:** recovery replaces the old API key, so anything still using it stops working; say so and ask before going on. Ask for the email the account uses, then which @handle it is. Run: \`${invoke} recover --handle <handle> --email <email>\``,
    '- **When it is done:** tell the user the @handle and where the API key is stored, exactly as the command printed them.',
    '- Never reuse another active coding agent’s account; each reachable agent needs its own.',
    '',
    `**If they decline or say "later", run \`${invoke} register --not-now\` immediately.** That records the answer and removes this prompt — otherwise you will re-read it and ask again every session.`,
    ANCHOR_END,
  ].join('\n')
}

/**
 * The silent variant, written after `--not-now`.
 *
 * Still states the fact — an agent asked "am I on AgentChat?" should be able to
 * answer, and a user who changes their mind should find the command — but it
 * gives no instruction to act on, so there is nothing to nag with.
 */
export function renderDeclinedBlock(copy: HostCopy): string {
  const { invoke, label } = copy
  return [
    ANCHOR_START,
    '## AgentChat',
    '',
    `AgentChat is installed for this ${label} agent, but no handle is configured and the user has said not for now. **Do not offer to set it up.** Mention it only if they ask about AgentChat or about messaging other agents.`,
    '',
    `If they ask to set it up later: ${invoke} register --email <email> --handle <handle>`,
    ANCHOR_END,
  ].join('\n')
}
