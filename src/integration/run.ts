import * as path from 'node:path'
import * as fs from 'node:fs'
import { log } from '../util/log.js'
import { acquireLeaderLock } from '../daemon/leader-lock.js'
import { resolveIdentity, credentialsPath } from '../identity/credentials.js'
import { resolveDaemonConfig } from '../daemon/config.js'
import { idle } from '../daemon/health.js'
import type { IntegrationClient } from '../client-identity.js'
import { Integration } from './integration.js'
import { integrationDisabledBy, resolveRunBudgetMs, resolveRunProfile, type RunProfile } from './profile.js'
import { isRunnerFactory, type RunnerSource } from './runner.js'
import { writeIntegrationStatus } from './status.js'

// ─── The resident supervisor ────────────────────────────────────────────────
//
// This process is RESIDENT. It is registered as a service when the integration
// is installed, and from then on it simply exists — whether or not anyone has
// signed in. Installation and authentication are different lifecycles (the
// shape every comparable daemon uses: tailscaled runs before `tailscale up`,
// and logging out idles it rather than uninstalling it).
//
//   no credentials              → idle. No socket, no retries, no CPU. Just watch.
//   credentials                 → connect and wake.
//   credentials change          → follow them.
//   AGENTCHAT_INTEGRATION=off   → stay resident, hold nothing, wake nothing.
//
// A refused key is not this loop's case: the SDK's client stays up in
// `blocked` and tries a fresh hello every 10–15 minutes (`status` reads
// `socket blocked` meanwhile), so a rotated-back key or a reinstated account
// reconnects on its own, and a different key is simply a credential change.
//
// The only thing that removes this process is an explicit `daemon disable`.
//
// SIGTERM/SIGINT (launchd/systemd stop, Ctrl-C) interrupts a run in flight:
// the integration SIGTERMs the run's process group and this process waits up
// to SHUTDOWN_GRACE_MS for it before exiting. A daemon that exited at once
// left the detached run orphaned, and the restarted daemon's connect found
// the same tray and started a second run beside it.

/** How often to re-read the identity. A `stat`; the watcher usually beats it. */
const POLL_MS = 5_000
/** How often the watcher flag is consulted while waiting out a poll. */
const TICK_MS = 250
/** Ceiling for retry backoff when the runtime simply is not usable yet. */
const MAX_BACKOFF_MS = 5 * 60_000
/**
 * How long a shutdown waits for an interrupted run to end before the process
 * exits. The runner SIGTERMs the run's process group at once and SIGKILLs 5 s
 * later, so this is normally over in well under a second. Below launchd's
 * `ExitTimeOut` (15 s in the plist this package writes).
 */
const SHUTDOWN_GRACE_MS = 10_000
const MAX_LOG_BYTES = 5 * 1024 * 1024
const KEEP_LOG_BYTES = 1024 * 1024

export interface RunIntegrationOpts {
  /** THE identity home for the agent this daemon serves. */
  home: string
  /** How to start one headless run: a runner, or a factory that builds one per identity (`RunnerFactory`). */
  runner: RunnerSource
  /** How this integration names itself to the server: the texts runtime and its own version. */
  client: IntegrationClient
  /** The one pointer line a run prompt ends with: how THIS runtime reaches its copy of the manual (`manualPointer(...)`). */
  manualPointer: string
  /**
   * The skill file that follows the served manual (`<skills dir>/agentchat/SKILL.md`):
   * whenever the texts in hand announce a version the file does not carry, the
   * announced manual is downloaded, checked and written over it. Absent, the
   * daemon leaves the manual to the CLI's install and `doctor --fix`.
   */
  manualPath?: string
  /** Scratch dir for runs. The integration decides where; this package never derives one. */
  workdir: string
  /** Defaults to `AGENTCHAT_RUN_PROFILE`, then `answer`. */
  profile?: RunProfile
  /** Defaults to `AGENTCHAT_RUN_BUDGET_MS`, then 10 minutes. */
  budgetMs?: number
  /** Ends the loop (tests). Production runs until SIGTERM/SIGINT. */
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  /** Test seam: what a signal-initiated shutdown calls last. Defaults to `process.exit`. */
  exit?: (code: number) => void
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Identity fingerprint: changes when the user signs out, signs in, or swaps to
 * a different agent. Comparing it is how the supervisor notices without caring
 * why.
 */
function fingerprint(home: string): string | null {
  const id = resolveIdentity(home)
  return id === null ? null : `${id.apiKey}:${id.handle ?? ''}`
}

/** Bound launchd's append-only file without losing the most recent diagnosis. */
function boundDaemonLog(home: string): void {
  const file = path.join(home, 'daemon.log')
  try {
    const size = fs.statSync(file).size
    if (size <= MAX_LOG_BYTES) return
    const fd = fs.openSync(file, 'r')
    try {
      const keep = Buffer.alloc(Math.min(KEEP_LOG_BYTES, size))
      fs.readSync(fd, keep, 0, keep.length, size - keep.length)
      fs.writeFileSync(
        file,
        `[agentchat:info] older daemon log output truncated at ${new Date().toISOString()}\n${keep.toString('utf-8')}`,
      )
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    /* absent/unreadable log is not a runtime failure */
  }
}

/**
 * Run the integration daemon. Returns only on a condition that makes running
 * pointless — another daemon already holding this home's lock — or when
 * `signal` aborts (tests).
 */
export async function runIntegration(opts: RunIntegrationOpts): Promise<number> {
  const home = path.resolve(opts.home)
  const workdir = path.resolve(opts.workdir)
  const env = opts.env ?? process.env
  const profile = opts.profile ?? resolveRunProfile(env)
  const budgetMs = opts.budgetMs ?? resolveRunBudgetMs(env)
  boundDaemonLog(home)

  // A resident service's output goes to a log file nobody sees until something
  // is wrong, and an empty log is useless for "is the integration working?".
  if (process.env['AGENTCHAT_LOG_LEVEL'] === undefined) process.env['AGENTCHAT_LOG_LEVEL'] = 'info'

  // Taken for the PROCESS, not for a connection: one resident daemon per
  // identity home, signed in or not.
  const lock = acquireLeaderLock(home)
  if (lock === null) return 1

  const disabledBy = integrationDisabledBy(env)
  const disabled = disabledBy !== null
  let live: Integration | null = null
  let liveFingerprint: string | null = null
  let observedFingerprint: string | null = null
  /** Consecutive start failures, for backoff. Reset on success or on a new credential. */
  let failures = 0
  let lastFailure: string | null = null
  let shuttingDown = false

  const offStatus = (handle: string | null): void =>
    writeIntegrationStatus(home, {
      version: 2,
      updated_at: new Date().toISOString(),
      pid: process.pid,
      runtime: opts.runner.name,
      handle,
      profile,
      socket: disabled ? 'off' : 'idle',
      wakes: 0,
      wakes_absorbed: 0,
      invites: 0,
      runs_started: 0,
      runs_ok: 0,
      runs_failed: 0,
      runs_timed_out: 0,
      runs_not_started: 0,
      runs_skipped_empty: 0,
      last_run: null,
      retry_rung: 0,
      retry_due_at: null,
      last_error: lastFailure,
      texts: null,
    })

  const disconnect = (why: string): void => {
    if (live === null) return
    log.info(`${why} — disconnecting (a run in flight is interrupted), staying resident`)
    live.stop()
    live = null
    liveFingerprint = null
    idle(home)
  }

  // The loop notices `shuttingDown` within a tick and takes the one exit path
  // below: stop the integration, give an interrupted run its grace, release, exit.
  const shutdown = (sig: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    log.info(`${sig} — shutting down`)
  }
  const onSigint = (): void => shutdown('SIGINT')
  const onSigterm = (): void => shutdown('SIGTERM')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)

  // Best-effort accelerator so signing in connects in about a second instead of
  // waiting out a poll. fs.watch is unreliable on some filesystems, so the poll
  // below is the real guarantee and this is pure upside.
  let nudged = false
  try {
    fs.mkdirSync(home, { recursive: true })
    const watcher = fs.watch(home, (_event, filename) => {
      if (filename === null || String(filename).startsWith('credentials')) nudged = true
    })
    watcher.on('error', (err) => {
      log.warn(`credential watcher unavailable; polling instead: ${String(err)}`)
      try {
        watcher.close()
      } catch {
        /* already closed */
      }
    })
    watcher.unref()
  } catch {
    /* polling covers it */
  }

  log.info(`integration resident for ${home} (${credentialsPath(home)}) — ${opts.client.runtime} ${opts.client.version}`)
  if (disabled) {
    log.info(`${disabledBy}=off — holding no socket and starting no run; the hosted tools and the manual still work in every session`)
  }
  idle(home)
  offStatus(null)

  for (;;) {
    if (shuttingDown || opts.signal?.aborted) break
    const fp = fingerprint(home)
    const identityChanged = fp !== observedFingerprint
    if (identityChanged) {
      disconnect(fp === null ? 'signed out' : 'identity changed')
      observedFingerprint = fp
      failures = 0
      lastFailure = null
      if (fp === null || disabled) offStatus(fp === null ? null : resolveIdentity(home)?.handle ?? null)
    }

    if (fp === null) {
      // Signed out, or never signed in. Idle.
    } else if (disabled) {
      // Signed in, switched off. Resident, silent.
    } else if (fp !== liveFingerprint) {
      try {
        const cfg = await resolveDaemonConfig({ home, workdir, client: opts.client })
        const runner = isRunnerFactory(opts.runner) ? opts.runner.create(cfg) : opts.runner
        const candidate = new Integration({
          cfg,
          runner,
          client: opts.client,
          manualPointer: opts.manualPointer,
          ...(opts.manualPath !== undefined ? { manualPath: opts.manualPath } : {}),
          profile,
          budgetMs,
        })
        await candidate.start()
        live = candidate
        liveFingerprint = fp
        failures = 0
        lastFailure = null
      } catch (err) {
        // Runtime not ready (host CLI missing or not signed in), network
        // down, whatever. Stay resident and try again later — exiting would
        // just make the service manager restart us in a loop. Backed off and
        // de-duplicated so a condition that lasts days does not fill the log.
        const msg = String(err instanceof Error ? err.message : err)
        if (msg !== lastFailure) {
          log.warn(`not connecting yet: ${msg}`)
          lastFailure = msg
          offStatus(resolveIdentity(home)?.handle ?? null)
        }
        failures += 1
        live = null
        liveFingerprint = null
        idle(home)
      }
    }

    // Wait out the poll interval, but wake as soon as the watcher fires so a
    // sign-in connects in well under a second. Exponential backoff while a
    // start keeps failing, capped — the watcher still wakes us instantly when
    // credentials change, so backing off never delays a real sign-in.
    const waitMs = failures === 0 ? POLL_MS : Math.min(POLL_MS * 2 ** Math.min(failures, 6), MAX_BACKOFF_MS)
    nudged = false
    const deadline = Date.now() + waitMs
    while (!nudged && !shuttingDown && !opts.signal?.aborted && Date.now() < deadline) {
      await sleep(TICK_MS)
    }
  }

  process.off('SIGINT', onSigint)
  process.off('SIGTERM', onSigterm)
  if (live !== null) {
    const ended = await live.stopAndWait(SHUTDOWN_GRACE_MS)
    if (!ended) log.warn(`a run in flight did not end within ${Math.round(SHUTDOWN_GRACE_MS / 1000)}s of being interrupted — exiting anyway`)
    live = null
  }
  idle(home)
  lock.release()
  if (shuttingDown) {
    log.info('shutdown complete')
    ;(opts.exit ?? process.exit)(0)
  }
  return 0
}
