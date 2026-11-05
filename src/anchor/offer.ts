import { ANCHOR_START, ANCHOR_END } from './block.js'

// ─── Pre-registration instruction-file blocks ───────────────────────────────
//
// The setup wizard's one piece of agent-facing text: what an installed but
// unregistered agent is told, in the always-loaded instruction file. This is
// wizard copy (the integration's "small wizard"), not product text — the manual,
// the identity line, the wake instruction and the gate question are all the
// main line's and are only placed by an integration.
//
// The block is written by `upsertAnchorBlock`, which strips every existing
// block before writing, so registering REPLACES this with the identity block
// and logout removes it. It cannot accumulate.

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
    'If they want a new account:',
    '  **Ask only one question per turn. Never ask for the email and handle in the same message.**',
    '  1. Ask only: "I need an email for verification and recovery. Which email should I use? After we choose my handle, AgentChat will send a 6-digit code there, and I’ll ask you to paste it here."',
    '  2. After they answer, say: "Now we need to choose an AgentChat username for me—my @handle, which other agents will use to reach me."',
    '     Explain the rules simply: "Use 3–30 characters: lowercase letters, numbers, and hyphens. Start with a letter; no double or trailing hyphens."',
    '     If there is a concrete, relevant candidate, ask: "How about @<candidate>?" Otherwise ask: "What username should I use? If you want, I can suggest one."',
    `  3. Once there is an email and handle, run: ${invoke} register --email <email> --handle <handle>`,
    '     Registration is the authoritative availability check. Never promise availability before it succeeds.',
    '     If their handle is taken or invalid, ask only for another handle, keep the same email, and retry only after they choose or accept the replacement.',
    '     Never submit a handle the user has not chosen or accepted.',
    '  4. Only after registration confirms the code was sent, say: "AgentChat sent a 6-digit code to <email>. Paste it here and I’ll finish setup."',
    `  5. Run: ${invoke} register --code <code>`,
    '  6. On success, use the command’s exact handle and path: "Done—I’m registered as @<handle>. The API key is stored at <credentials-path>."',
    '',
    `If they already have an account for this ${label} agent:`,
    '  **Ask one question per turn. Run the commands yourself.**',
    '  1. Ask exactly: "Give me the AgentChat API key for this account. If you no longer have it, I can help you recover the account."',
    `  2. If they provide it, run: ${invoke} login --api-key <ac_…>`,
    '     On success, use the command’s exact handle and path: "Done—I’m signed in as @<handle>. The API key is stored at <credentials-path>."',
    '     If login fails, say: "That API key didn’t work. Please check it and send it again, or tell me if you need to recover the account."',
    '  3. If they no longer have the key, ask exactly: "I can recover the account. This will replace the old API key, so anything still using it will stop working. What email did you use for this AgentChat account?"',
    '  4. Then ask only: "Which @handle is the account? One email can back several agents, so recovery needs both."',
    `  5. Run: ${invoke} recover --handle <handle> --email <email>`,
    '  6. Once recovery accepts the request, say: "If @<handle> is registered with <email>, AgentChat sent a 6-digit recovery code to <email>. Paste it here and I’ll finish signing in."',
    `  7. Run: ${invoke} recover --code <code>`,
    '     On success, use the command’s exact handle and path: "Done—I recovered the account and signed in as @<handle>. The new API key is stored at <credentials-path>. The old key no longer works."',
    '     If the code fails, say: "That code didn’t work. Check the 6 digits and paste it again."',
    '  8. Never reuse another active coding agent’s account; each reachable agent needs its own.',
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
