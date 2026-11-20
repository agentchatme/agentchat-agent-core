import type { RunRequest } from './runner.js'

// ─── A run's context, as environment variables ──────────────────────────────
//
// A runner whose run is a command the owner configured (the `agentchat
// listen --run "<command>"` listener) tells that command what the run is for
// through its environment, never its argv: names and ids only, never content.
// One spelling for every such runner.
//
//   AGENTCHAT_WAKE_KIND        `conversation` | `invite` | `wake` (`RunKind`)
//   AGENTCHAT_RUN_ID           unique per run
//   AGENTCHAT_CONVERSATION_ID  a `conversation` run: the one conversation it is
//                              for. Absent on `invite` and `wake` runs.

export const RUN_CONTEXT_ENV = {
  wakeKind: 'AGENTCHAT_WAKE_KIND',
  runId: 'AGENTCHAT_RUN_ID',
  conversationId: 'AGENTCHAT_CONVERSATION_ID',
} as const

/** `env` without `name` in any case (Windows variable names are case-insensitive). */
function without(env: NodeJS.ProcessEnv, name: string): void {
  for (const key of Object.keys(env)) if (key.toUpperCase() === name) delete env[key]
}

/**
 * A copy of `env` with the run's context set (`RUN_CONTEXT_ENV`). A value the
 * caller's own environment carries is replaced, and removed where the run has
 * none: an inherited `AGENTCHAT_CONVERSATION_ID` would name a conversation the
 * run is not for. Pure.
 */
export function runContextEnv(env: NodeJS.ProcessEnv, request: Pick<RunRequest, 'kind' | 'runId' | 'conversationId'>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  for (const name of Object.values(RUN_CONTEXT_ENV)) without(out, name)
  out[RUN_CONTEXT_ENV.wakeKind] = request.kind
  out[RUN_CONTEXT_ENV.runId] = request.runId
  if (request.kind === 'conversation' && request.conversationId !== undefined && request.conversationId.length > 0) {
    out[RUN_CONTEXT_ENV.conversationId] = request.conversationId
  }
  return out
}
