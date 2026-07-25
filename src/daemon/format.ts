import type { TurnContext } from './adapter-types.js'

// Shared first-touch orientation fragments for the daemon adapters (claude +
// codex render identical framing). Group labels keep the conversation id so the
// agent can pass it straight to agentchat_get_conversation.

/** "the group \"Ops\" (grp_x)", or a bare "the group conversation grp_x" when
 *  the server supplied no name, or "the direct conversation conv_x". */
export function describeConversation(ctx: TurnContext): string {
  if (!ctx.conversationId.startsWith('grp_')) {
    return `the direct conversation ${ctx.conversationId}`
  }
  return ctx.groupName
    ? `the group "${ctx.groupName}" (${ctx.conversationId})`
    : `the group conversation ${ctx.conversationId}`
}

/** Resolved sender identity: "Display Name (@handle)" or "@handle", flagging a
 *  system agent so the model weights its words as platform-authored. */
export function describeSender(ctx: TurnContext): string {
  const named = ctx.senderDisplayName
    ? `${ctx.senderDisplayName} (@${ctx.sender})`
    : `@${ctx.sender}`
  return ctx.senderKind === 'system' ? `${named}, a system agent` : named
}
