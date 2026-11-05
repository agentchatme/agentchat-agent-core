import type { ChildProcess } from 'node:child_process'
import { spawnCommand, spawnCommandSync } from '../util/spawn.js'
import type { RunOutcome } from './runner.js'

// ─── Spawning one headless run ──────────────────────────────────────────────
//
// Shared by every runner: start the runtime's headless command, feed it the
// prompt, bound it, classify the exit. The run's OUTPUT IS DISCARDED — stdout
// is counted, never kept, never parsed, never logged. A run's text can quote
// peer messages, and the integration reads no message content, ever. The only
// thing retained is a short, credential-redacted tail of stderr for the
// failure diagnostic, because "exited 1" alone has cost days of debugging.
//
// Classification: `ok` on exit 0; `timed_out` when the budget killed it;
// `failed` when it was interrupted or exited non-zero after writing to stdout;
// `not_started` when it exited non-zero with NOTHING ON STDOUT — a signed-out
// CLI, a bad flag, a missing config all print their complaint on stderr and
// quit, and they are "the runtime did not get going", stderr or not. The
// stderr tail rides along in the detail either way.
//
// The run is spawned as its own process group (detached) so the whole tree
// can be signalled at once: on the budget, and when the integration is stopping
// (`signal`) — a daemon that exits with a run still going orphans a model call
// that nobody will read and that the restarted daemon would run again.

const DEFAULT_GRACE_MS = 5_000
const STDERR_TAIL_CHARS = 400

export interface SpawnRunSpec {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  /** Written to the child's stdin and closed; `null` closes stdin at once. */
  readonly stdin: string | null
  /** Kill past this. */
  readonly budgetMs: number
  /** SIGTERM first; SIGKILL this long after. */
  readonly graceMs?: number
  /**
   * Aborting it SIGTERMs the run's process group (SIGKILL after `graceMs`);
   * the outcome is `failed` with an "interrupted" detail.
   */
  readonly signal?: AbortSignal
  /** Called once when the child process has been spawned (`RunRequest.onStarted`). */
  readonly onStarted?: () => void
}

/** Strip anything key-shaped or terminal-styled from a diagnostic, and bound it. */
export function redactDiagnostic(value: string, max = STDERR_TAIL_CHARS): string {
  return value
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\b(api[_ -]?key\s*[:=]\s*)\S+/gi, '$1[redacted]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~-]{8,}\b/gi, '$1 [redacted]')
    .replace(/\bac_[A-Za-z0-9_-]{8,}\b/g, '[redacted AgentChat key]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted key]')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-max)
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    if (process.platform === 'win32') {
      spawnCommandSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } else {
      // Negative pid = the process group the child leads (spawned detached).
      process.kill(-child.pid, signal)
    }
  } catch {
    try {
      child.kill(signal)
    } catch {
      /* already gone */
    }
  }
}

/** Start the command, wait for it, classify. Never throws. */
export function spawnRun(spec: SpawnRunSpec): Promise<RunOutcome> {
  const started = Date.now()
  return new Promise<RunOutcome>((resolve) => {
    let settled = false
    let stdoutBytes = 0
    let stderrTail = ''
    let timedOut = false
    let interrupted = false
    let killTimer: ReturnType<typeof setTimeout> | null = null
    let graceTimer: ReturnType<typeof setTimeout> | null = null
    let onAbort: (() => void) | null = null

    const finish = (outcome: Omit<RunOutcome, 'durationMs'>): void => {
      if (settled) return
      settled = true
      if (killTimer) clearTimeout(killTimer)
      if (graceTimer) clearTimeout(graceTimer)
      if (onAbort) spec.signal?.removeEventListener('abort', onAbort)
      resolve({ ...outcome, durationMs: Date.now() - started })
    }

    if (spec.signal?.aborted) {
      finish({ state: 'not_started', exitCode: null, detail: 'interrupted before the runtime was started' })
      return
    }

    let child: ChildProcess
    try {
      child = spawnCommand(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: spec.env,
        stdio: [spec.stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      })
    } catch (err) {
      finish({ state: 'not_started', exitCode: null, detail: redactDiagnostic(String(err)) })
      return
    }

    if (spec.onStarted) {
      const onStarted = spec.onStarted
      child.once('spawn', () => {
        try {
          onStarted()
        } catch {
          /* the callback belongs to the invoker; a failure there is not the run's */
        }
      })
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutBytes += chunk.length // counted, never kept
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrTail = (stderrTail + String(chunk)).slice(-4 * STDERR_TAIL_CHARS)
    })

    if (spec.stdin !== null && child.stdin) {
      child.stdin.on('error', () => {
        /* the child closed stdin early; the exit code tells the story */
      })
      try {
        child.stdin.write(spec.stdin)
        child.stdin.end()
      } catch {
        /* handled by the close path */
      }
    }

    const terminate = (): void => {
      killProcessTree(child, 'SIGTERM')
      if (graceTimer) clearTimeout(graceTimer)
      graceTimer = setTimeout(() => killProcessTree(child, 'SIGKILL'), spec.graceMs ?? DEFAULT_GRACE_MS)
    }

    killTimer = setTimeout(() => {
      timedOut = true
      terminate()
    }, spec.budgetMs)

    if (spec.signal) {
      onAbort = (): void => {
        if (settled) return
        interrupted = true
        terminate()
      }
      spec.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.on('error', (err) => {
      finish({ state: 'not_started', exitCode: null, detail: redactDiagnostic(String(err)) })
    })

    child.on('close', (code, signal) => {
      const tail = redactDiagnostic(stderrTail)
      if (timedOut) {
        finish({
          state: 'timed_out',
          exitCode: code,
          detail: `run exceeded its ${Math.round(spec.budgetMs / 1000)} s budget and was killed${tail ? `: ${tail}` : ''}`,
        })
        return
      }
      if (interrupted) {
        finish({
          state: 'failed',
          exitCode: code,
          detail: `interrupted — the integration was stopping; the tray stays unread for the next run${tail ? `: ${tail}` : ''}`,
        })
        return
      }
      if (code === 0) {
        finish({ state: 'ok', exitCode: 0 })
        return
      }
      const exit = code === null ? `signal ${signal ?? 'unknown'}` : `exit ${code}`
      if (stdoutBytes === 0) {
        // Nothing on stdout: the runtime did not get going (missing, refused
        // to start, auth gate). Whatever it complained about is in the tail.
        finish({ state: 'not_started', exitCode: code, detail: `${exit} with nothing on stdout${tail ? `: ${tail}` : ''}` })
        return
      }
      finish({ state: 'failed', exitCode: code, detail: `${exit}${tail ? `: ${tail}` : ''}` })
    })
  })
}
