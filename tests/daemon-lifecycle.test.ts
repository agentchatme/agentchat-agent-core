import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  markAlwaysOnWanted,
  clearAlwaysOnWanted,
  markAlwaysOnOptOut,
  clearAlwaysOnOptOut,
  alwaysOnOptedOut,
  alwaysOnState,
  alwaysOnHealth,
  beat,
  idle,
} from '../src/daemon/health.js'

// ─── Installation and authentication are different lifecycles ───────────────
//
// The service used to be created by `daemon install`, which refuses without
// credentials. So the daemon's EXISTENCE was tied to the user's LOGIN STATE,
// and three things followed:
//
//   * installing the product did not give you always-on
//   * `logout` deleted the credentials but left the service, so the daemon
//     threw "no identity", exited 1, and KeepAlive restarted it — forever
//   * signing back in restored nothing
//
// These pin the corrected model: registered at install, idle without an
// identity, connected with one, and only ever removed on purpose.

let home: string

const signIn = (handle = 'probe'): void =>
  fs.writeFileSync(
    path.join(home, 'credentials'),
    JSON.stringify({ api_key: 'ac_live_' + 'a'.repeat(40), handle }),
  )
/** Age the registration marker past the startup grace, so "not beating" means
 *  genuinely down rather than still coming up. */
const aged = (home: string): void => {
  const marker = path.join(home, 'always-on.wanted')
  const old = new Date(Date.now() - 10 * 60_000)
  fs.utimesSync(marker, old, old)
}

const signOut = (): void => fs.rmSync(path.join(home, 'credentials'), { force: true })

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-lifecycle-'))
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

describe('the service exists independently of any identity', () => {
  it('can be registered before anyone signs in', () => {
    markAlwaysOnWanted(home)
    expect(alwaysOnState(home)).toBe('idle')
  })

  it('signing in moves it to connected, not to installed', () => {
    markAlwaysOnWanted(home)
    signIn()
    beat(home)
    expect(alwaysOnState(home)).toBe('connected')
  })

  it('signing out returns it to idle — the service survives', () => {
    markAlwaysOnWanted(home)
    signIn()
    beat(home)
    signOut()
    idle(home)
    // The regression: logout left a registered service with no identity, which
    // read as "down" and crash-looped. Idle is the correct resting state.
    expect(alwaysOnState(home)).toBe('idle')
  })

  it('signing back in reconnects with no re-install', () => {
    markAlwaysOnWanted(home)
    signIn('first')
    beat(home)
    signOut()
    idle(home)
    signIn('second')
    beat(home)
    expect(alwaysOnState(home)).toBe('connected')
  })
})

describe('only a deliberate opt-out turns it off, and it is remembered', () => {
  it('starts with no opt-out recorded', () => {
    expect(alwaysOnOptedOut(home)).toBe(false)
  })

  it('disable records the choice so a later install cannot undo it silently', () => {
    markAlwaysOnWanted(home)
    clearAlwaysOnWanted(home)
    markAlwaysOnOptOut(home)

    expect(alwaysOnState(home)).toBe('off')
    // `wanted` alone cannot express this: it is false both for "never set up"
    // and for "switched off", and those must lead to opposite actions.
    expect(alwaysOnOptedOut(home)).toBe(true)
  })

  it('an explicit re-install clears it', () => {
    markAlwaysOnOptOut(home)
    clearAlwaysOnOptOut(home)
    markAlwaysOnWanted(home)
    expect(alwaysOnOptedOut(home)).toBe(false)
    expect(alwaysOnState(home)).toBe('idle')
  })

  it('the opt-out outlives signing in and out', () => {
    markAlwaysOnOptOut(home)
    signIn()
    expect(alwaysOnOptedOut(home)).toBe(true)
    signOut()
    expect(alwaysOnOptedOut(home)).toBe(true)
  })
})

describe('only `down` is worth telling a session about', () => {
  it('a signed-out idle daemon is not a problem to report', () => {
    markAlwaysOnWanted(home)
    expect(alwaysOnState(home)).toBe('idle')
  })

  it('signed in with nothing holding the wire IS a problem', () => {
    markAlwaysOnWanted(home)
    signIn()
    idle(home)
    aged(home) // past the startup grace — this is a real failure, not a cold start
    expect(alwaysOnState(home)).toBe('down')
  })
})

describe('a service that was just registered is not reported as broken', () => {
  it('reads as `starting`, not `down`, in the moments after registration', () => {
    // The first real install did exactly this: the hook registered the service
    // and then, in the same invocation, told the user "⚠ Always-on is down".
    // The daemon simply had not drawn breath yet.
    markAlwaysOnWanted(home)
    signIn()
    expect(alwaysOnState(home)).toBe('starting')
  })

  it('`starting` is healthy — nothing to warn about', () => {
    markAlwaysOnWanted(home)
    signIn()
    expect(alwaysOnHealth(home).healthy).toBe(true)
  })

  it('becomes `connected` once it beats', () => {
    markAlwaysOnWanted(home)
    signIn()
    beat(home)
    expect(alwaysOnState(home)).toBe('connected')
  })

  it('but a service registered long ago with no beat IS down', () => {
    markAlwaysOnWanted(home)
    signIn()
    // age the marker past the startup grace
    const marker = path.join(home, 'always-on.wanted')
    const old = new Date(Date.now() - 10 * 60_000)
    fs.utimesSync(marker, old, old)
    expect(alwaysOnState(home)).toBe('down')
    expect(alwaysOnHealth(home).healthy).toBe(false)
  })
})
