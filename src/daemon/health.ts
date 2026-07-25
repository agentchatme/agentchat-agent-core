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

/** Touch the liveness beacon. Called by the running daemon. */
export function beat(home: string): void {
  try {
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, HEARTBEAT_FILE), new Date().toISOString())
  } catch {
    /* non-fatal — a missed beat only risks a false "down" warning */
  }
}

/**
 * The health the session-start hook acts on. `wanted:false` means the user
 * never opted into always-on (or turned it off) → the hook stays silent.
 * `wanted:true, healthy:false` means always-on was set up but the daemon isn't
 * beating → the hook warns. Pure reads (two stats), no subprocess, never throws.
 */
export function alwaysOnHealth(home: string): { wanted: boolean; healthy: boolean } {
  if (!alwaysOnWanted(home)) return { wanted: false, healthy: true }
  try {
    const age = Date.now() - fs.statSync(path.join(home, HEARTBEAT_FILE)).mtimeMs
    return { wanted: true, healthy: age <= HEARTBEAT_STALE_MS }
  } catch {
    return { wanted: true, healthy: false } // no beacon → never started, or long dead
  }
}
