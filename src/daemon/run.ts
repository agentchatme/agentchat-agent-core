import * as path from 'node:path'
import * as fs from 'node:fs'
import { log } from '../util/log.js'
import { acquireLeaderLock } from './leader-lock.js'
import { resolveIdentity, credentialsPath } from '../identity/credentials.js'
import { resolveDaemonConfig } from './config.js'
import { Daemon } from './loop.js'
import { idle } from './health.js'
import type { RuntimeAdapter } from './adapter-types.js'

// ─── The always-on supervisor ───────────────────────────────────────────────
//
// This process is RESIDENT. It is registered as a service when the integration
// is installed, and from then on it simply exists — whether or not anyone has
// signed in.
//
// That separation is the whole design, and getting it wrong was a real defect:
// the service used to be created by `daemon install`, which refuses without
// credentials. So the daemon's EXISTENCE was tied to the user's LOGIN STATE,
// and three things followed. Installing the product did not give you always-on.
// `logout` deleted the credentials but left the service, so the daemon threw
// "no identity", exited 1, and KeepAlive restarted it — forever. And signing
// back in restored nothing, because nothing re-created the service.
//
// Installation and authentication are different lifecycles. This is the shape
// every comparable daemon uses (tailscaled is installed and running before
// `tailscale up`; logging out idles it rather than uninstalling it).
//
// So:
//   no credentials → idle. No socket, no retries, no CPU. Just watch.
//   credentials    → connect and serve.
//   credentials change (sign out, sign in, swap agents) → follow them.
//
// The only thing that removes this process is an explicit `daemon disable`.

/** How often to re-read the identity. A `stat`; the watcher usually beats it. */
const POLL_MS = 5_000
/** How often the watcher flag is consulted while waiting out a poll. */
const TICK_MS = 250
/** Ceiling for retry backoff when the runtime simply is not usable yet. */
const MAX_BACKOFF_MS = 5 * 60_000
const MAX_LOG_BYTES = 5 * 1024 * 1024
const KEEP_LOG_BYTES = 1024 * 1024

export interface RunDaemonOpts {
  /** THE identity home for the agent this daemon serves. */
  home: string
  /** How to spawn one headless turn of this integration's coding agent. */
  adapter: RuntimeAdapter
  /** Scratch dir override; defaults to `<home>/daemon-workdir`. */
  workdir?: string
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
 * Run the always-on daemon. Returns only on a condition that makes running
 * pointless — namely another daemon already holding this home's lock.
 */
export async function runDaemon(opts: RunDaemonOpts): Promise<number> {
  const home = path.resolve(opts.home)
  const workdir = opts.workdir ?? path.join(home, 'daemon-workdir')
  boundDaemonLog(home)

  // Hooks default to `warn` because they run on every session start and must
  // stay silent. A resident service is the opposite case: its output goes to a
  // log file nobody sees until something is wrong, and an empty log is useless
  // for answering "is always-on actually working?". Still overridable.
  if (process.env['AGENTCHAT_LOG_LEVEL'] === undefined) process.env['AGENTCHAT_LOG_LEVEL'] = 'info'

  // Taken for the PROCESS, not for a connection: one resident daemon per
  // identity home, signed in or not.
  const lock = acquireLeaderLock(home)
  if (lock === null) return 1

  let live: Daemon | null = null
  let liveFingerprint: string | null = null
  let observedFingerprint: string | null = null
  let adapterFingerprint: string | null = null
  /** A credential the server refused. Sit out until it CHANGES. */
  let refused: string | null = null
  /** Consecutive connect failures, for backoff. Reset on success or on a new
   *  credential — a fresh sign-in always deserves a fast first attempt. */
  let failures = 0
  /** Last failure message, so a persistent condition is logged once. */
  let lastFailure: string | null = null
  let shuttingDown = false

  const disconnect = (why: string): void => {
    if (live === null) return
    log.info(`${why} — disconnecting, staying resident`)
    live.stop()
    live = null
    liveFingerprint = null
    idle(home)
  }

  const shutdown = (sig: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    log.info(`${sig} — shutting down`)
    live?.stop()
    idle(home)
    lock.release()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  // Best-effort accelerator so signing in connects in about a second instead of
  // waiting out a poll. fs.watch is unreliable on some filesystems and network
  // mounts, so the poll below is the real guarantee and this is pure upside.
  let nudged = false
  try {
    fs.mkdirSync(home, { recursive: true })
    const watcher = fs.watch(home, (_event, filename) => {
      if (filename === null || String(filename).startsWith('credentials')) nudged = true
    })
    // Resource exhaustion and unsupported filesystems can surface as an
    // asynchronous `error` after fs.watch has returned. Without a listener
    // Node treats that as fatal; polling is already the source of truth, so
    // losing this best-effort accelerator must never take down the daemon.
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

  log.info(`always-on resident for ${home} (${credentialsPath(home)})`)
  idle(home)

  for (;;) {
    if (shuttingDown) break
    const fp = fingerprint(home)
    const identityChanged = fp !== observedFingerprint
    if (identityChanged) {
      disconnect(fp === null ? 'signed out' : 'identity changed')
      observedFingerprint = fp
      failures = 0
      lastFailure = null
      // A refusal applies only to the exact rejected credential.
      if (fp !== refused) refused = null
    }

    if (fp === null) {
      // Signed out, or never signed in. Idle — and forget any refusal, since
      // the next credential to appear deserves a fresh attempt.
      if (refused !== null) refused = null
    } else if (fp !== liveFingerprint) {
      if (fp === refused) {
        // Same key the server already rejected; wait for a different one
        // rather than hammering the endpoint.
      } else {
        try {
          const cfg = await resolveDaemonConfig({ home, workdir })
          // A new AgentChat identity must not inherit the previous identity's
          // Codex/Claude conversation transcripts.
          if (adapterFingerprint !== fp) {
            opts.adapter.reset?.(`${cfg.apiBase}:${cfg.handle}`)
            adapterFingerprint = fp
          }
          const candidate = new Daemon(cfg, opts.adapter, undefined, (failure) => {
            if (failure.kind === 'socket-auth') {
              // Auth refused: stop trying THIS credential, keep the process.
              log.warn(`credential refused (${failure.reason}) — idling until it changes`)
              refused = fp
            } else {
              // Runtime auth/setup can fail after preflight. Retry the same
              // AgentChat identity through the normal bounded supervisor loop.
              log.warn(`runtime became unhealthy (${failure.reason}) — re-running preflight`)
              failures += 1
            }
            live = null
            liveFingerprint = null
            idle(home)
          })
          await candidate.start()
          live = candidate
          liveFingerprint = fp
          failures = 0
          lastFailure = null
        } catch (err) {
          // Runtime not ready (host CLI missing or not logged in), network
          // down, whatever. Stay resident and try again later — exiting would
          // just make the service manager restart us in a loop.
          //
          // Backed off and de-duplicated: "codex CLI not found on PATH" is a
          // condition that can last days, and retrying every 5s would write
          // ~17k identical lines a day into a log meant to be readable.
          const msg = String(err instanceof Error ? err.message : err)
          if (msg !== lastFailure) {
            log.warn(`not connecting yet: ${msg}`)
            lastFailure = msg
          }
          failures += 1
          live = null
          liveFingerprint = null
          idle(home)
        }
      }
    }

    // Wait out the poll interval, but wake as soon as the watcher fires so a
    // sign-in connects in well under a second instead of up to POLL_MS. The
    // flag has to be checked DURING the wait — an earlier version only
    // consulted it afterwards, which made the watcher useless.
    // Exponential backoff while a connect keeps failing, capped — but the
    // watcher still wakes us instantly when credentials change, so backing off
    // never delays a real sign-in.
    const waitMs = failures === 0 ? POLL_MS : Math.min(POLL_MS * 2 ** Math.min(failures, 6), MAX_BACKOFF_MS)
    nudged = false
    const deadline = Date.now() + waitMs
    while (!nudged && !shuttingDown && Date.now() < deadline) {
      await sleep(TICK_MS)
    }
  }

  lock.release()
  return 0
}
