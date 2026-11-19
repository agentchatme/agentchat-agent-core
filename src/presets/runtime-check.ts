import * as fs from 'node:fs'
import type { RunPreflight } from '../integration/runner.js'
import { spawnRunCapturing } from '../integration/spawn-run.js'

// ─── The runtime check: does the agent's AI answer right now? ───────────────
//
// After a conversation's run failed, and no other run has completed since,
// the SDK kit asks the runner whether the runtime works (`checkRuntime`): an
// `ok` is the evidence that the failure belongs to that conversation (a
// provider refusal, a crash on its content), and the kit reports it (could
// not process). So the check must prove the model answers NOW, through the
// same binary, account and environment the runs use — a `--version` or a
// sign-in check passes during a provider outage, and an outage reported as
// the conversation's failure would hide its messages.
//
// The check is one headless run of the runtime with a fixed prompt: no peer
// content, no AgentChat tools, nothing a run could act on, in an empty folder
// of its own. Exit 0 with some text is not enough (a usage limit, a low
// credit balance or an expired sign-in can print a sentence and still be no
// answer): a runtime whose result says what happened is judged on it
// (`judge`, e.g. Claude Code's JSON result). For that, the first
// `RUNTIME_CHECK_OUTPUT_BYTES` of its stdout are kept for the check alone —
// the prompt is ours, so it holds no peer content — read, and dropped; never
// logged. Only "it answered" and a bounded, redacted diagnostic come back. It
// is bounded so that its kill path ends inside the engine's 60 s deadline, and
// it stops (its process group killed) when the integration stops.

/** The fixed prompt: nothing from any peer, nothing to act on. */
export const RUNTIME_CHECK_PROMPT = 'Reply with the single word OK.'

/**
 * The check's own budget. Past it the probe is SIGTERMed, SIGKILLed 5 s later
 * and given up 5 s after that: 55 s at most, inside the engine's
 * `RUNTIME_CHECK_DEADLINE_MS` (60 s).
 */
export const RUNTIME_CHECK_BUDGET_MS = 45_000

/** The most of a check's stdout kept for its `judge` (a result line is a few kB); more is not read. */
export const RUNTIME_CHECK_OUTPUT_BYTES = 128 * 1024

/** The name of the empty folder a runtime check runs in, beside the runtime's own config. */
export const RUNTIME_CHECK_DIR = 'agentchat-runtime-check'

/**
 * The variables an AgentChat key travels in (the daemon's own, the listener's
 * Codex bearer variable): never in a runtime check's environment, whatever
 * the runs carry. The check needs no key.
 */
export const RUNTIME_CHECK_KEY_ENV: readonly string[] = ['AGENTCHAT_API_KEY', 'AGENTCHAT_LISTENER_API_KEY']

/** `env` without the key variables (`RUNTIME_CHECK_KEY_ENV` and `also`), in any case. */
function withoutKeys(env: NodeJS.ProcessEnv, also: readonly string[]): NodeJS.ProcessEnv {
  const names = new Set([...RUNTIME_CHECK_KEY_ENV, ...also].map((name) => name.toUpperCase()))
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) if (!names.has(key.toUpperCase())) out[key] = value
  return out
}

export interface RuntimeCheckSpec {
  /** The runtime's name, for the diagnostic. */
  readonly label: string
  readonly command: string
  readonly args: readonly string[]
  /** An empty folder of the check's own (created owner-only). */
  readonly cwd: string
  /** The runs' environment; the key variables are taken out (`RUNTIME_CHECK_KEY_ENV`, `keyEnv`). */
  readonly env: NodeJS.ProcessEnv
  /** Another variable this runtime's runs carry a key in (a Codex runner's `keyEnv`). */
  readonly keyEnv?: string
  readonly signal?: AbortSignal
  /**
   * Reads the runtime's answer (its stdout, bounded) after an exit 0: null
   * when it is a good answer, else why not (ids and flags only, never the
   * text). Absent: exit 0 with something on stdout is ok.
   */
  readonly judge?: (stdout: string) => string | null
  /** Test seam: `RUNTIME_CHECK_BUDGET_MS`. */
  readonly budgetMs?: number
}

/** Run the check once: ok when the runtime exited 0 having printed an answer. Never throws. */
export async function runRuntimeCheck(spec: RuntimeCheckSpec): Promise<RunPreflight> {
  if (spec.signal?.aborted === true) return { ok: false, detail: `${spec.label} runtime check: stopped before it started` }
  try {
    fs.mkdirSync(spec.cwd, { recursive: true, mode: 0o700 })
  } catch (err) {
    return { ok: false, detail: `${spec.label} runtime check: could not create its folder ${spec.cwd}: ${err instanceof Error ? err.message : String(err)}` }
  }
  const { outcome, stdout } = await spawnRunCapturing({
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    env: withoutKeys(spec.env, spec.keyEnv !== undefined ? [spec.keyEnv] : []),
    stdin: RUNTIME_CHECK_PROMPT,
    budgetMs: spec.budgetMs ?? RUNTIME_CHECK_BUDGET_MS,
    requireStdout: true,
    ...(spec.signal !== undefined ? { signal: spec.signal } : {}),
  }, spec.judge !== undefined ? RUNTIME_CHECK_OUTPUT_BYTES : 0)
  if (outcome.state !== 'ok') return { ok: false, detail: `${spec.label} runtime check ${outcome.state.replace('_', ' ')}${outcome.detail ? `: ${outcome.detail}` : ''}` }
  const verdict = spec.judge === undefined ? null : spec.judge(stdout)
  return verdict === null ? { ok: true } : { ok: false, detail: `${spec.label} runtime check failed: exit 0, but ${verdict}` }
}
