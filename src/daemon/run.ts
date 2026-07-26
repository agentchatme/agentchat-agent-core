import { log } from '../util/log.js'
import { acquireLeaderLock } from './leader-lock.js'
import { resolveDaemonConfig } from './config.js'
import { Daemon } from './loop.js'
import type { RuntimeAdapter } from './adapter-types.js'

// ─── The always-on entrypoint ───────────────────────────────────────────────
//
// One call an integration's daemon binary makes. It owns everything that is
// the same for every coding agent — identity resolution, the single-daemon
// leader lock, signal handling, holding the process open — and nothing that
// differs. The one thing that differs, "how do I spawn a headless turn of my
// runtime", arrives as the `adapter` argument.
//
// Never returns while healthy: a daemon that returns is a daemon that stopped
// answering, and the service manager would just restart it.

export interface RunDaemonOpts {
  /** THE identity home for the agent this daemon runs as. */
  home: string
  /** How to spawn one headless turn of this integration's coding agent. */
  adapter: RuntimeAdapter
  /** Scratch dir override; defaults to `<home>/daemon-workdir`. */
  workdir?: string
}

/**
 * Run the always-on daemon. Resolves to a process exit code only on a failure
 * that makes running pointless (no identity, another daemon already holds the
 * lock, the runtime is not usable).
 */
export async function runDaemon(opts: RunDaemonOpts): Promise<number> {
  let cfg
  try {
    cfg = await resolveDaemonConfig({
      home: opts.home,
      ...(opts.workdir !== undefined ? { workdir: opts.workdir } : {}),
    })
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err))
    return 1
  }

  // One daemon per identity on this box.
  const lock = acquireLeaderLock(cfg.home)
  if (lock === null) return 1

  const daemon = new Daemon(cfg, opts.adapter)
  let releasing = false
  const shutdown = (sig: string): void => {
    if (releasing) return
    releasing = true
    log.info(`${sig} — shutting down`)
    daemon.stop()
    lock.release()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  try {
    await daemon.start()
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err))
    lock.release()
    return 1
  }

  // Hold the process open; the WS client keeps event-loop work alive.
  return await new Promise<number>(() => {})
}
