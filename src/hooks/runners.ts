import { sessionStart, userPrompt, stop, type HookContext } from './engine.js'
import { readHookInput } from './hook-input.js'
import { log } from '../util/log.js'

// ─── Session hook runners ───────────────────────────────────────────────────
//
// The engine decides WHAT the agent is told; a dialect decides HOW to say it to
// one host. This is the wiring between them, and it is the same everywhere:
// read stdin, call the engine, print if there is something to print.
//
// It was duplicated per integration and the two copies were byte-identical —
// including a comment in the Claude Code copy explaining how it talks to Codex.
//
// Invariant preserved from the engine: exit code is ALWAYS 0. A failing hook
// degrades to "no AgentChat context this turn", never to a broken session.
// Diagnostics go to stderr only; stdout carries one JSON object or nothing.

/**
 * How one host wants hook output shaped. Each integration owns its own — every
 * coding agent expects a different envelope, and a shared module choosing
 * between them would be one more place to pick the wrong one.
 */
export interface HookDialect {
  sessionStartOutput(context: string): Record<string, unknown>
  stopOutput(reason: string): Record<string, unknown>
  printJson(payload: Record<string, unknown>): void
}

export interface HookRunners {
  runSessionStart(): Promise<void>
  runUserPrompt(): Promise<void>
  runStop(): Promise<void>
}

/**
 * Build the three hook entrypoints for one coding agent.
 *
 * `context` is a factory, not a value: the hooks run in a fresh process where
 * the host's env (`CODEX_HOME` and friends) must be read at call time.
 */
export function createHookRunners(context: () => HookContext, dialect: HookDialect): HookRunners {
  return {
    async runSessionStart(): Promise<void> {
      try {
        const input = await readHookInput()
        const { context: text } = await sessionStart(context(), input)
        if (text !== null) dialect.printJson(dialect.sessionStartOutput(text))
      } catch (err) {
        log.warn(`session-start hook degraded to no-op: ${String(err)}`)
      }
    },

    async runUserPrompt(): Promise<void> {
      try {
        const input = await readHookInput()
        await userPrompt(context(), input)
      } catch (err) {
        log.warn(`user-prompt hook degraded to no-op: ${String(err)}`)
      }
    },

    async runStop(): Promise<void> {
      try {
        const input = await readHookInput()
        const { reason, commit } = await stop(context(), input)
        if (reason === null) return
        // Print FIRST, commit second: the ack means "the agent has this", so a
        // failed print must not leave the message marked delivered. The engine
        // hands back `commit` precisely so this ordering lives at the call site.
        dialect.printJson(dialect.stopOutput(reason))
        await commit()
      } catch (err) {
        log.warn(`stop hook degraded to no-op: ${String(err)}`)
      }
    },
  }
}
