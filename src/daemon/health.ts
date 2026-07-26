import * as fs from 'node:fs'
import * as path from 'node:path'

// ─── Always-on health, as the session-start hook sees it ────────────────────
//
// Two markers inside ONE identity home make "is always-on actually up?"
// answerable without shelling out to systemctl/launchctl on every session
// start:
//   • always-on.wanted  — written on install/enable, cleared on disable/uninstall.
//     Encodes user INTENT, so we only ever nag someone who opted in.
//   • daemon.heartbeat  — touched by the running daemon every 30s while
//     connected. Its age is the LIVENESS signal.
// Wanted + fresh beacon = healthy. Wanted + stale/missing beacon = down.
//
// Everything is scoped to the `home` passed in, so one integration's daemon
// health says nothing about another's — two coding agents on one machine run
// two daemons, and either can be down independently.

const ALWAYS_ON_WANTED = 'always-on.wanted'
export const HEARTBEAT_FILE = 'daemon.heartbeat'
// 3 min tolerates a brief reconnect (the daemon beats every 30s) without a
// false "down" — but a genuinely dead daemon is well past it.
const HEARTBEAT_STALE_MS = 3 * 60_000

/** Record that the user wants always-on for this agent. */
export function markAlwaysOnWanted(home: string): void {
  try {
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, ALWAYS_ON_WANTED), '')
  } catch {
    /* non-fatal: worst case the hook can't nag on a later failure */
  }
}

/** Forget the intent (user chose session-only, or uninstalled). */
export function clearAlwaysOnWanted(home: string): void {
  try {
    fs.rmSync(path.join(home, ALWAYS_ON_WANTED), { force: true })
  } catch {
    /* non-fatal */
  }
}

export function alwaysOnWanted(home: string): boolean {
  return fs.existsSync(path.join(home, ALWAYS_ON_WANTED))
}

// ─── Deliberate opt-out ─────────────────────────────────────────────────────
//
// Always-on is registered as part of installing the integration, not as a
// separate opt-in. That makes "the user turned this off" a decision we have to
// REMEMBER — otherwise the next install, upgrade or session quietly switches it
// back on, which is the one behaviour that would genuinely anger someone.
//
// `wanted` cannot carry this: it is false both for "never set up" and for
// "switched off", and those must lead to opposite actions.
const ALWAYS_ON_OPTOUT = 'always-on.optout'

/** Remember that the user switched always-on off. Survives re-install. */
export function markAlwaysOnOptOut(home: string): void {
  try {
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, ALWAYS_ON_OPTOUT), new Date().toISOString())
  } catch {
    /* non-fatal: worst case a later install re-enables it */
  }
}

/** Cleared only by an explicit `daemon install` — never implicitly. */
export function clearAlwaysOnOptOut(home: string): void {
  try {
    fs.rmSync(path.join(home, ALWAYS_ON_OPTOUT), { force: true })
  } catch {
    /* non-fatal */
  }
}

export function alwaysOnOptedOut(home: string): boolean {
  return fs.existsSync(path.join(home, ALWAYS_ON_OPTOUT))
}

/** Touch the liveness beacon. Called by the running daemon. */
export function beat(home: string): void {
  try {
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, HEARTBEAT_FILE), new Date().toISOString())
  } catch {
    /* non-fatal — a missed beat only risks a false "down" warning */
  }
}

/** Clear the beacon. The daemon calls this whenever it is resident but NOT
 *  connected, so "idle" is never mistaken for "beating". */
export function idle(home: string): void {
  try {
    fs.rmSync(path.join(home, HEARTBEAT_FILE), { force: true })
  } catch {
    /* non-fatal — a stale beacon only risks a false "healthy" for 3 minutes */
  }
}

/**
 * Always-on has THREE states, not two.
 *
 * It used to be a boolean pair, which could not tell "idle because nobody is
 * signed in" apart from "installed and broken" — so a signed-out user would be
 * nagged every session about a daemon that was behaving exactly as intended.
 *
 *   off       — the service is not installed (or was explicitly disabled).
 *   idle      — installed and resident, but there is no identity to serve.
 *               Correct and quiet: the daemon is waiting for a sign-in.
 *   connected — holding the wire; the beacon is fresh.
 *   down      — there IS an identity and the service is installed, but nothing
 *               is beating. The only state worth telling a session about.
 *
 * Pure reads, no subprocess, never throws.
 */
export type AlwaysOnState = 'off' | 'idle' | 'connected' | 'down'

export function alwaysOnState(home: string): AlwaysOnState {
  if (!alwaysOnWanted(home)) return 'off'
  // No credentials → the daemon is supposed to be idling.
  if (!fs.existsSync(path.join(home, 'credentials'))) return 'idle'
  try {
    const age = Date.now() - fs.statSync(path.join(home, HEARTBEAT_FILE)).mtimeMs
    return age <= HEARTBEAT_STALE_MS ? 'connected' : 'down'
  } catch {
    return 'down' // no beacon → never started, or long dead
  }
}

/**
 * Back-compatible view for callers that only need "should I warn?".
 * `healthy` is false ONLY in the `down` state — an idle daemon is healthy.
 */
export function alwaysOnHealth(home: string): { wanted: boolean; healthy: boolean } {
  const state = alwaysOnState(home)
  return { wanted: state !== 'off', healthy: state !== 'down' }
}
