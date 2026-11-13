import { killProcessTree } from '../integration/spawn-run.js'
import { spawnCommand } from './spawn.js'

// ─── A short command whose answer we need (`--version`, a sign-in check) ────
//
// Was `spawnSync` with a timeout, which on timeout kills only the direct child:
// on Windows the npm `.cmd` shim (the real process under it keeps running), and
// the npm launcher of a runtime that starts its native binary as a child. A sync
// spawn then also waits for those survivors to close the output pipes it reads —
// blocking the whole daemon, socket included. A probe is therefore async: on
// timeout the whole tree is killed (its process group on POSIX, `taskkill /T /F`
// on Windows), its exit is waited for, and a tree that will not die is given up
// on after a bound — the probe always answers.

export interface ProbeResult {
  /** Why it did not answer: it could not be started, or it timed out. */
  readonly error?: Error
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

export interface ProbeOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly timeoutMs: number
  readonly cwd?: string
  /** Aborting it stops the probe as a timeout would (its tree killed, its exit waited for). */
  readonly signal?: AbortSignal
}

/** After a probe is killed: how long its exit is waited for before it is given up on. */
export const PROBE_KILL_WAIT_MS = 5_000
const MAX_OUTPUT = 64 * 1024

export function runProbe(command: string, args: readonly string[], options: ProbeOptions): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnCommand>
    try {
      child = spawnCommand(command, [...args], {
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group on POSIX, so the whole tree can be killed.
        detached: process.platform !== 'win32',
        windowsHide: true,
      })
    } catch (err) {
      resolve({ error: err instanceof Error ? err : new Error(String(err)), status: null, stdout: '', stderr: '', timedOut: false })
      return
    }
    const proc = child
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let stopped = false
    let finished = false
    let giveUp: NodeJS.Timeout | null = null
    const finish = (result: ProbeResult): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (giveUp !== null) clearTimeout(giveUp)
      resolve(result)
    }
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString('utf-8')
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString('utf-8')
    })
    const stop = (error: Error, byTimeout: boolean): void => {
      if (timedOut || finished) return
      timedOut = byTimeout
      stopped = true
      killProcessTree(proc, 'SIGKILL')
      // Its exit (every pipe closed) is the answer; a tree that will not die is given up on.
      giveUp = setTimeout(() => {
        proc.stdout?.destroy()
        proc.stderr?.destroy()
        finish({ error, status: null, stdout, stderr, timedOut })
      }, PROBE_KILL_WAIT_MS)
      proc.once('close', () => finish({ error, status: null, stdout, stderr, timedOut }))
    }
    const timer = setTimeout(() => stop(new Error(`${command} ${args.join(' ')} did not answer within ${Math.round(options.timeoutMs / 1000)} s`), true), options.timeoutMs)
    const onAbort = (): void => stop(new Error(`${command} ${args.join(' ')} was stopped`), false)
    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
    proc.on('error', (err) => finish({ error: err, status: null, stdout, stderr, timedOut }))
    proc.on('close', (code) => {
      options.signal?.removeEventListener('abort', onAbort)
      if (!stopped) finish({ status: code, stdout, stderr, timedOut })
    })
  })
}
