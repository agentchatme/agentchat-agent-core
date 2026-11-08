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

// A run must never hang the worker that started it. Two ways a child can
// outlive its own classification, both seen with real runtimes:
//
//   * the run's process exits, but something it started still holds its
//     stdout/stderr (a helper spawned with inherited pipes, an MCP server
//     that daemonised): Node's `close` waits for every holder of the pipes,
//     so it never comes. After `exit`, `close` gets DRAIN_MS; then the
//     leftovers of the run's process group are killed, the pipes are
//     dropped, and the run is classified by the exit it did make.
//   * a SIGKILL that does not end it (a process that escaped the group with
//     `setsid` and still holds the pipes; a process stuck in the kernel):
//     ABANDON_MS after the SIGKILL the pipes are dropped, the child is
//     unref'd, and the run is classified `timed_out` / `failed` as the
//     budget or the interrupt said — the worker moves on.

const DEFAULT_GRACE_MS = 5_000
/** After the run's process exited: how long its pipes get to close before the run is detached from them. */
const DEFAULT_DRAIN_MS = 2_000
/** After the SIGKILL: how long before a run that still has not ended is abandoned. */
const DEFAULT_ABANDON_MS = 5_000
const STDERR_TAIL_CHARS = 400

export interface SpawnRunSpec {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  /**
   * Run `command` through the platform shell (`/bin/sh -c`, `cmd.exe /d /s /c`)
   * with no `args`: for a command line the OWNER configured. Nothing derived
   * from a wake or a message is ever part of it.
   */
  readonly shell?: boolean
  /** Written to the child's stdin and closed; `null` closes stdin at once. */
  readonly stdin: string | null
  /** Kill past this. */
  readonly budgetMs: number
  /** SIGTERM first; SIGKILL this long after. */
  readonly graceMs?: number
  /** After the process exited, how long its pipes may stay open before the run is detached from them. */
  readonly drainMs?: number
  /** After the SIGKILL, how long before a run that has still not ended is abandoned. */
  readonly abandonMs?: number
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

/** Start the command, wait for it, classify. Never throws, and always resolves. */
export function spawnRun(spec: SpawnRunSpec): Promise<RunOutcome> {
  const started = Date.now()
  const graceMs = spec.graceMs ?? DEFAULT_GRACE_MS
  const drainMs = spec.drainMs ?? DEFAULT_DRAIN_MS
  const abandonMs = spec.abandonMs ?? DEFAULT_ABANDON_MS
  return new Promise<RunOutcome>((resolve) => {
    let settled = false
    let stdoutBytes = 0
    let stderrTail = ''
    let timedOut = false
    let interrupted = false
    let terminating = false
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null
    const timers = new Set<ReturnType<typeof setTimeout>>()
    let onAbort: (() => void) | null = null
    let child: ChildProcess | null = null

    const later = (ms: number, fn: () => void): void => {
      const timer = setTimeout(() => {
        timers.delete(timer)
        fn()
      }, ms)
      timers.add(timer)
    }

    const finish = (outcome: Omit<RunOutcome, 'durationMs'>): void => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      if (onAbort) spec.signal?.removeEventListener('abort', onAbort)
      resolve({ ...outcome, durationMs: Date.now() - started })
    }

    /** Stop waiting on the child's pipes and let the event loop forget it. */
    const detach = (): void => {
      if (child === null) return
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        try {
          stream?.destroy()
        } catch {
          /* already gone */
        }
      }
      try {
        child.unref()
      } catch {
        /* already gone */
      }
    }

    /** The outcome for an exit the run did make; `note` says why `close` was not waited for. */
    const classify = (code: number | null, signal: NodeJS.Signals | null, note: string | null): Omit<RunOutcome, 'durationMs'> => {
      const tail = redactDiagnostic(stderrTail)
      const extra = `${note ? ` (${note})` : ''}${tail ? `: ${tail}` : ''}`
      if (timedOut) {
        return { state: 'timed_out', exitCode: code, detail: `run exceeded its ${Math.round(spec.budgetMs / 1000)} s budget and was killed${extra}` }
      }
      if (interrupted) {
        return { state: 'failed', exitCode: code, detail: `interrupted — the integration was stopping; the tray stays unread for the next run${extra}` }
      }
      if (code === 0) return note ? { state: 'ok', exitCode: 0, detail: note } : { state: 'ok', exitCode: 0 }
      const exit = code === null ? `signal ${signal ?? 'unknown'}` : `exit ${code}`
      // Nothing on stdout: the runtime did not get going (missing, refused
      // to start, auth gate). Whatever it complained about is in the tail.
      if (stdoutBytes === 0) return { state: 'not_started', exitCode: code, detail: `${exit} with nothing on stdout${extra}` }
      return { state: 'failed', exitCode: code, detail: `${exit}${extra}` }
    }

    if (spec.signal?.aborted) {
      finish({ state: 'not_started', exitCode: null, detail: 'interrupted before the runtime was started' })
      return
    }

    try {
      child = spawnCommand(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: spec.env,
        stdio: [spec.stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
        ...(spec.shell === true ? { shell: true } : {}),
      })
    } catch (err) {
      finish({ state: 'not_started', exitCode: null, detail: redactDiagnostic(String(err)) })
      return
    }
    const proc: ChildProcess = child

    if (spec.onStarted) {
      const onStarted = spec.onStarted
      proc.once('spawn', () => {
        try {
          onStarted()
        } catch {
          /* the callback belongs to the caller; a failure there is not the run's */
        }
      })
    }

    proc.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutBytes += chunk.length // counted, never kept
    })
    proc.stderr?.on('data', (chunk: Buffer | string) => {
      stderrTail = (stderrTail + String(chunk)).slice(-4 * STDERR_TAIL_CHARS)
    })
    // A pipe torn down under us (detach, a dying child) must never surface as
    // an unhandled 'error' event.
    proc.stdout?.on('error', () => undefined)
    proc.stderr?.on('error', () => undefined)

    if (spec.stdin !== null && proc.stdin) {
      proc.stdin.on('error', () => {
        /* the child closed stdin early; the exit code tells the story */
      })
      try {
        proc.stdin.write(spec.stdin)
        proc.stdin.end()
      } catch {
        /* handled by the close path */
      }
    }

    const terminate = (): void => {
      if (terminating || settled) return
      terminating = true
      killProcessTree(proc, 'SIGTERM')
      later(graceMs, () => {
        if (settled) return
        killProcessTree(proc, 'SIGKILL')
        later(abandonMs, () => {
          if (settled) return
          // Exited but the pipes stayed open: the drain timer owns that case.
          if (exited !== null) return
          detach()
          const tail = redactDiagnostic(stderrTail)
          const why = `the run did not end ${Math.round((graceMs + abandonMs) / 1000)} s after it was signalled (SIGKILL included) — abandoned so the next wake can run${tail ? `: ${tail}` : ''}`
          finish(
            timedOut
              ? { state: 'timed_out', exitCode: null, detail: `run exceeded its ${Math.round(spec.budgetMs / 1000)} s budget; ${why}` }
              : { state: 'failed', exitCode: null, detail: `interrupted — ${why}` },
          )
        })
      })
    }

    later(spec.budgetMs, () => {
      // A run that already exited ended inside its budget; only its pipes
      // are late, and the drain timer owns that.
      if (exited !== null) return
      timedOut = true
      terminate()
    })

    if (spec.signal) {
      onAbort = (): void => {
        if (settled) return
        interrupted = true
        terminate()
      }
      spec.signal.addEventListener('abort', onAbort, { once: true })
    }

    proc.on('error', (err) => {
      finish({ state: 'not_started', exitCode: null, detail: redactDiagnostic(String(err)) })
    })

    proc.on('exit', (code, signal) => {
      exited = { code, signal }
      // `close` follows once every holder of the pipes is gone. A process the
      // run started that still holds them must not hold the worker.
      later(drainMs, () => {
        if (settled || exited === null) return
        // The run is over; what is left of its process group is a leftover.
        killProcessTree(proc, 'SIGKILL')
        detach()
        finish(classify(exited.code, exited.signal, 'a process the run started kept its output open after it exited; it was killed and the run detached from it'))
      })
    })

    proc.on('close', (code, signal) => {
      finish(classify(code, signal, null))
    })
  })
}
