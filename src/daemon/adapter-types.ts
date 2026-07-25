import type { SyncRow } from '../wire/index.js'

// ─── Runtime adapter ────────────────────────────────────────────────────────
//
// The daemon is runtime-agnostic: it receives a message and asks an adapter to
// run ONE headless agent turn to handle it. The adapter spawns the user's own
// runtime (Codex / Claude) — riding their subscription, using the AgentChat
// stdio MCP the plugin already wired — and DISCARDS the turn's text: the reply
// only reaches the wire if the agent calls agentchat_send_message. That's the
// structural loop-proofing, same as the in-session plugin.

export interface TurnContext {
  /** The AgentChat conversation the message belongs to. */
  conversationId: string
  /** @handle of the sender. */
  sender: string
  /** The message text (snippet — the agent re-reads full context via MCP). */
  text: string
  /** The message's `created_at` (ISO-8601 UTC). A headless turn has no clock;
   *  surfacing this lets it judge staleness/urgency before deciding to reply.
   *  Explicit `| undefined` so daemon.ts can pass through an absent stamp under
   *  exactOptionalPropertyTypes. */
  createdAt?: string | undefined
  /** Message type ('text' | 'structured' | 'file' | 'system'). Lets a non-text
   *  message render a clear placeholder instead of an empty body. */
  type?: string | undefined
  // ─ Platform-authored trusted context (server `message.context`) ─
  /** Sender's resolved display name, or null when unset / no context block. */
  senderDisplayName?: string | null | undefined
  /** 'system' = platform agent (authoritative); 'agent' = peer. */
  senderKind?: 'agent' | 'system' | undefined
  /** Group's human-readable name (null for DMs / when the server omitted it). */
  groupName?: string | null | undefined
  /** True when THIS agent's handle is in the server-parsed mention list. The
   *  daemon computes membership (it knows its own handle) so the adapter just
   *  renders the positive fact. */
  mentioned?: boolean | undefined
}

export interface TurnResult {
  ok: boolean
  /** true if the runtime reported an unrecoverable error (bad setup/auth). */
  fatal?: boolean
  detail?: string
}

export interface RuntimeAdapter {
  readonly name: string
  /** Verify the runtime is usable (binary present, logged in). */
  preflight(): Promise<{ ok: boolean; detail?: string }>
  /** Run one turn to handle `ctx`. Continuity per conversation is the
   *  adapter's concern (session resume). Never throws — returns TurnResult. */
  runTurn(ctx: TurnContext): Promise<TurnResult>
}
