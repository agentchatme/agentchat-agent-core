import * as path from 'node:path'
import * as fs from 'node:fs'
import { log } from '../util/log.js'
import { acquireLeaderLock } from '../daemon/leader-lock.js'
import { acquireAgentLock, agentLockPath, agentLockRefusal, clearStandby, markStandby, standbyWaiting } from '../daemon/agent-lock.js'
import type { Lease, LeaseOptions } from '../util/lease.js'
import type { DaemonConfig } from '../daemon/config.js'
import { resolveIdentity, credentialsPath } from '../identity/credentials.js'
import { resolveDaemonConfig } from '../daemon/config.js'
import { idle } from '../daemon/health.js'
import type { IntegrationClient } from '../client-identity.js'
import { Integration, PREFLIGHT_DEADLINE_MS, withDeadline } from './integration.js'
import { INTEGRATION_ENV, INTEGRATION_ENV_LEGACY, INTEGRATION_ENV_LEGACY_REMOVAL, integrationDisabledBy, resolveRunBudgetMs, resolveRunProfile, type RunProfile } from './profile.js'
import { isRunnerFactory, type RunRunner, type RunnerSource } from './runner.js'
import { writeIntegrationStatus, type IntegrationRunsFailing, type IntegrationStandby, type IntegrationStatus, type IntegrationUnservable } from './status.js'

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
/** While another daemon serves this agent: how often to look whether it still does (and rewrite the status file, so it never reads as a daemon that is down). */
const STANDBY_POLL_MS = 30_000
/** After giving the agent up because this home could not serve it: when to check again (the runtime; then the lease). */
const UNSERVABLE_RECHECK_MS = 60_000
/** A home whose key the server refused tries again this much later (a new hello with the same key). */
const BLOCKED_RETRY_MS = 5 * 60_000
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
  /**
   * Serve only the agent the home's `credentials` hold: `AGENTCHAT_API_KEY`
   * in the environment is ignored (default false: it overrides, as for every
   * integration). The `agentchat` listener sets it.
   */
  credentialsFromHomeOnly?: boolean
  /** See `IntegrationOptions.dismissIgnoredInvites` (default true). */
  dismissIgnoredInvites?: boolean
  /** Test seam: while another daemon serves this agent, how often to look again (30 s). */
  standbyPollMs?: number
  /** Test seam: `IntegrationOptions.runtimeRecheckMs`. */
  runtimeRecheckMs?: number
  /** Test seam: after giving the agent up, when to look again (60 s; 5 min after a refused key). */
  unservableRecheckMs?: number
  /** Test seam: the agent and home leases' timing (`LeaseOptions`). */
  lease?: LeaseOptions
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Identity fingerprint: changes when the user signs out, signs in, or swaps to
 * a different agent. Comparing it is how the supervisor notices without caring
 * why.
 */
function fingerprint(home: string, envKey: boolean): string | null {
  const id = resolveIdentity(home, { envKey })
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

/** The agent is served by another daemon (or this home waits to serve again): not a failure, no backoff. */
class StandbyError extends Error {}

/** A home that gave its agent up because it could not serve it, and when it looks again. */
interface Unservable {
  readonly kind: IntegrationUnservable['reason']
  readonly detail: string
  readonly since: string
  readonly retryAt: number
  readonly runsFailing: IntegrationRunsFailing | null
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

  // Wakes the loop's wait early (a credential change, a lost lock).
  let nudged = false
  // Stops checks in flight (a give-up recheck's probes) when the daemon stops.
  const stopChecks = new AbortController()
  opts.signal?.addEventListener('abort', () => stopChecks.abort(), { once: true })

  // Taken for the PROCESS, not for a connection: one resident daemon per
  // identity home, signed in or not. A lease: should another daemon ever take
  // it (this one stalled past the lease), this one stands down and exits now.
  const lock = await acquireLeaderLock(home, opts.lease ?? {})
  if (lock === null) return 1
  let homeLost: string | null = null
  lock.onLost((why) => {
    homeLost = why
    nudged = true
    log.error(`lost this home's daemon lock (${why}) — another daemon serves ${home} now; this one exits`)
  })

  const envKey = opts.credentialsFromHomeOnly !== true
  const identityOf = () => resolveIdentity(home, { envKey })
  const disabledBy = integrationDisabledBy(env)
  const disabled = disabledBy !== null
  let live: Integration | null = null
  let liveFingerprint: string | null = null
  let observedFingerprint: string | null = null
  /** Consecutive start failures, for backoff. Reset on success or on a new credential. */
  let failures = 0
  let lastFailure: string | null = null
  let shuttingDown = false
  /** The agent lock (one agent, one listener), held for as long as an integration is live. */
  let agentLock: Lease | null = null
  /** Set by the lease when a renewal finds it no longer this process's: stand down at once. */
  let agentLost: string | null = null
  /** Another daemon serves this agent: who, for status. */
  let standby: IntegrationStandby | null = null
  /** This home gave the agent up because it could not serve it; when to look again. */
  let unservable: Unservable | null = null
  /** The runner the last integration used: what checks the runtime while this home waits to serve again. */
  let lastRunner: RunRunner | null = null
  /** The resolved identity for the current credential: an env-key standby does not ask /v1/agents/me on every poll. */
  let cachedCfg: { fp: string; cfg: DaemonConfig } | null = null
  /** The agent lock's file (for the standby marker beside it), once the identity is known. */
  let agentLockFile: string | null = null
  const releaseAgent = (): void => {
    agentLock?.release()
    agentLock = null
    agentLost = null
  }
  const stopWaiting = (): void => {
    if (agentLockFile !== null) clearStandby(agentLockFile, home)
  }
  /** Lock renewals that failed, for status: the home lock's and the agent lock's. */
  const leaseErrors = (): NonNullable<IntegrationStatus['lease_errors']> | null => {
    const count = lock.renewErrors + (agentLock?.renewErrors ?? 0)
    return count === 0 ? null : { count, last: agentLock?.lastRenewError ?? lock.lastRenewError }
  }

  const offStatus = (handle: string | null): void =>
    writeIntegrationStatus(home, {
      version: 2,
      updated_at: new Date().toISOString(),
      pid: process.pid,
      runtime: opts.runner.name,
      handle,
      profile,
      workdir,
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
      standby,
      runs_failing: unservable?.runsFailing ?? null,
      unservable: unservable === null ? null : { reason: unservable.kind, detail: unservable.detail, since: unservable.since, retry_at: new Date(unservable.retryAt).toISOString() },
      lease_errors: leaseErrors(),
    })

  const disconnect = (why: string): void => {
    if (live === null) return
    log.info(`${why} — disconnecting (a run in flight is interrupted), staying resident`)
    live.stop()
    live = null
    liveFingerprint = null
    releaseAgent()
    idle(home)
  }

  // The loop notices `shuttingDown` within a tick and takes the one exit path
  // below: stop the integration, give an interrupted run its grace, release, exit.
  const shutdown = (sig: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    stopChecks.abort()
    log.info(`${sig} — shutting down`)
  }
  const onSigint = (): void => shutdown('SIGINT')
  const onSigterm = (): void => shutdown('SIGTERM')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)

  // Best-effort accelerator so signing in connects in about a second instead of
  // waiting out a poll. fs.watch is unreliable on some filesystems, so the poll
  // below is the real guarantee and this is pure upside.
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
    if (disabledBy === INTEGRATION_ENV_LEGACY) {
      log.warn(`${INTEGRATION_ENV_LEGACY} is the old name of ${INTEGRATION_ENV} (agent contract v1 schedules its removal for ${INTEGRATION_ENV_LEGACY_REMOVAL}); set ${INTEGRATION_ENV}=off instead`)
    }
  }
  idle(home)
  offStatus(null)

  for (;;) {
    if (shuttingDown || opts.signal?.aborted) break
    const fp = fingerprint(home, envKey)
    const identityChanged = fp !== observedFingerprint
    if (homeLost !== null) break
    if (identityChanged) {
      disconnect(fp === null ? 'signed out' : 'identity changed')
      observedFingerprint = fp
      failures = 0
      lastFailure = null
      stopWaiting()
      standby = null
      unservable = null
      cachedCfg = null
      agentLockFile = null
      if (fp === null || disabled) offStatus(fp === null ? null : identityOf()?.handle ?? null)
    }

    if (fp === null) {
      // Signed out, or never signed in. Idle.
    } else if (disabled) {
      // Signed in, switched off. Resident, silent.
    } else if (live !== null && fp === liveFingerprint) {
      // Serving. Stand down at once if the agent lock is no longer ours, and
      // give the agent up while this home cannot serve it — so a healthy
      // listener for the same agent (a standby) can take over.
      const health = live.health()
      if (agentLost !== null) {
        const why = agentLost
        disconnect(`the agent lock is no longer this home's (${why})`)
        lastFailure = `@${cachedCfg?.cfg.handle ?? '?'}: ${why}; another listener serves this agent now`
      } else if (!health.ok) {
        const handle = cachedCfg?.cfg.handle ?? '?'
        const kind: Unservable['kind'] = health.runsFailing === null ? 'key_refused' : 'runs_failing'
        // A refused key cannot serve at all: given up whatever waits. Failing
        // runs are given up only to a healthy listener that is actually
        // waiting; a lone install keeps its socket — wakes keep arriving, are
        // counted and start runs (each the quickest way back).
        if (kind === 'key_refused' || (agentLockFile !== null && standbyWaiting(agentLockFile, home))) {
          const retryMs = opts.unservableRecheckMs ?? (kind === 'key_refused' ? BLOCKED_RETRY_MS : UNSERVABLE_RECHECK_MS)
          unservable = { kind, detail: health.reason, since: new Date().toISOString(), retryAt: Date.now() + retryMs, runsFailing: health.runsFailing }
          disconnect(`this home cannot serve @${handle} (${health.reason}): giving it up to ${kind === 'key_refused' ? 'any healthy listener' : 'the healthy listener waiting for it'}`)
          lastFailure = `this home cannot serve @${handle}: ${health.reason}. It holds no socket and starts no run; ${kind === 'runs_failing' ? 'the runtime is' : 'the key is'} checked again every ${Math.round(retryMs / 1000)} s, and it serves again when that passes and no other listener holds @${handle}.`
          log.warn(lastFailure)
          offStatus(handle)
        }
      }
    } else if (live === null) {
      try {
        // Not before its time: a home that gave the agent up retries on its own clock.
        if (unservable !== null && Date.now() < unservable.retryAt) throw new StandbyError(unservable.detail)
        const waiting: Unservable | null = unservable
        if (waiting !== null && waiting.kind === 'runs_failing' && lastRunner !== null) {
          // Runs were failing: the runtime is checked first (bounded, stopped with the daemon).
          const before: Unservable = waiting
          const checker = lastRunner
          const pre = await withDeadline(checker.preflight({ signal: stopChecks.signal }), PREFLIGHT_DEADLINE_MS, () => ({ ok: false, detail: `preflight did not answer within ${Math.round(PREFLIGHT_DEADLINE_MS / 1000)} s` })).catch(
            (err: unknown) => ({ ok: false, detail: `preflight threw: ${err instanceof Error ? err.message : String(err)}` }),
          )
          if (shuttingDown || opts.signal?.aborted) throw new StandbyError('stopping')
          if (pre.ok) unservable = null
          else unservable = { ...before, detail: `runs failing: ${checker.name}: ${pre.detail ?? 'its check failed'}`, retryAt: Date.now() + (opts.unservableRecheckMs ?? UNSERVABLE_RECHECK_MS) }
        }
        if (cachedCfg === null || cachedCfg.fp !== fp) cachedCfg = { fp, cfg: await resolveDaemonConfig({ home, workdir, client: opts.client, envKey }) }
        const cfg = cachedCfg.cfg
        agentLockFile = agentLockPath({ apiBase: cfg.apiBase, handle: cfg.handle })
        // One agent, one listener: a daemon in another home that already
        // serves this agent keeps it; this one stands by (no socket, no run)
        // and takes over when that one stops or gives it up. The lock folder
        // comes from the process environment only: a service and a shell for
        // the same user agree on it, whatever switches `env` carries.
        const attempt = await acquireAgentLock({ apiBase: cfg.apiBase, handle: cfg.handle, home }, process.env, opts.lease ?? {})
        if (!attempt.ok) {
          const current: Unservable | null = unservable
          if (current !== null) {
            // Still unable to serve, and another listener holds the agent: wait, without saying it is healthy.
            unservable = { ...current, retryAt: Date.now() + (opts.unservableRecheckMs ?? (current.kind === 'key_refused' ? BLOCKED_RETRY_MS : UNSERVABLE_RECHECK_MS)) }
            throw new StandbyError(current.detail)
          }
          const msg = agentLockRefusal({ handle: cfg.handle, home }, attempt.holder, attempt.path)
          standby = { home: attempt.holder?.home ?? null, pid: attempt.holder?.pid ?? null, since: attempt.holder?.acquired_at ?? null }
          if (msg !== lastFailure) log.warn(msg)
          lastFailure = msg
          // A healthy standby says it is waiting (the holder hands over failing runs only to one).
          markStandby(attempt.path, home)
          throw new StandbyError(msg)
        }
        stopWaiting()
        if (standby !== null) log.info(`@${cfg.handle}: the other listener stopped; this one serves the agent now`)
        if (unservable !== null) log.info(`@${cfg.handle}: no other listener holds the agent; this home serves it again (${unservable.detail})`)
        standby = null
        unservable = null
        agentLock = attempt.lease
        attempt.lease.onLost((why) => {
          agentLost = why
          nudged = true
        })
        const runner = isRunnerFactory(opts.runner) ? opts.runner.create(cfg) : opts.runner
        lastRunner = runner
        const candidate = new Integration({
          cfg,
          runner,
          client: opts.client,
          manualPointer: opts.manualPointer,
          ...(opts.manualPath !== undefined ? { manualPath: opts.manualPath } : {}),
          profile,
          budgetMs,
          ...(opts.dismissIgnoredInvites !== undefined ? { dismissIgnoredInvites: opts.dismissIgnoredInvites } : {}),
          ...(opts.runtimeRecheckMs !== undefined ? { runtimeRecheckMs: opts.runtimeRecheckMs } : {}),
          statusExtra: () => ({ lease_errors: leaseErrors() }),
        })
        await candidate.start()
        live = candidate
        liveFingerprint = fp
        failures = 0
        lastFailure = null
      } catch (err) {
        releaseAgent()
        live = null
        liveFingerprint = null
        if (err instanceof StandbyError) {
          // Standing by, or waiting to serve again: the status file is rewritten
          // every poll, so `status` never reads it as a daemon that is down.
          offStatus(cachedCfg?.cfg.handle ?? identityOf()?.handle ?? null)
        } else {
          // Runtime not ready (host CLI missing or not signed in), network
          // down, whatever. Stay resident and try again later — exiting would
          // just make the service manager restart us in a loop. Backed off and
          // de-duplicated so a condition that lasts days does not fill the log.
          const msg = String(err instanceof Error ? err.message : err)
          if (msg !== lastFailure) {
            log.warn(`not connecting yet: ${msg}`)
            lastFailure = msg
            offStatus(identityOf()?.handle ?? null)
          }
          failures += 1
        }
        idle(home)
      }
    }

    // Wait out the poll interval, but wake as soon as the watcher fires so a
    // sign-in connects in well under a second. Exponential backoff while a
    // start keeps failing, capped — the watcher still wakes us instantly when
    // credentials change, so backing off never delays a real sign-in.
    const waitMs = homeLost !== null ? 0 : standby !== null || unservable !== null ? (opts.standbyPollMs ?? STANDBY_POLL_MS) : failures === 0 ? POLL_MS : Math.min(POLL_MS * 2 ** Math.min(failures, 6), MAX_BACKOFF_MS)
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
  releaseAgent()
  stopWaiting()
  idle(home)
  lock.release()
  if (homeLost !== null) return 1
  if (shuttingDown) {
    log.info('shutdown complete')
    ;(opts.exit ?? process.exit)(0)
  }
  return 0
}
