import type { Texts } from 'agentchatme'

// ─── The run prompts ────────────────────────────────────────────────────────
//
// A run starts with the server's own text — the wake instruction, or the
// invite prompt — exactly as `GET /v1/texts` served it for this runtime, with
// the hosted tool names already spelled the way the runtime exposes them.
// Nothing here is product text of this package: the only line added is the
// pointer to where THIS runtime keeps its local copy of the manual, which the
// server cannot know (a skill name, a path) and the integration does.
//
// Coding agents run no pre-turn gate, so there is deliberately no "the gate
// step decided …" line: the run reads the tray with the hosted inbox tool and
// judges every card with the tray's own question.

export interface RunPrompts {
  /** What a wake run starts with. */
  readonly wake: string
  /** What a group-invite run starts with. Invites are not on the tray and are never auto-accepted. */
  readonly invite: string
}

/** The served texts, then the one pointer line (`manualPointer(...)`). */
export function buildRunPrompts(
  texts: Pick<Texts, 'wake_instruction' | 'invite_prompt'>,
  manualPointer: string,
): RunPrompts {
  return {
    wake: `${texts.wake_instruction}\n\n${manualPointer}`,
    invite: `${texts.invite_prompt}\n\n${manualPointer}`,
  }
}
