import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  readCredentials,
  writeCredentials,
  clearCredentials,
  resolveIdentity,
  readPending,
  writePending,
  clearPending,
} from '../src/identity/credentials.js'
import {
  getContinuations,
  recordContinuation,
  setPendingAck,
  takePendingAck,
  resetSession,
  shouldOfferRegistration,
  recordRegistrationOffer,
} from '../src/identity/state.js'
import {
  markAlwaysOnWanted,
  clearAlwaysOnWanted,
  alwaysOnHealth,
  beat,
} from '../src/daemon/health.js'

// ─── The property this library exists to guarantee ──────────────────────────
//
// Every function takes an identity home and touches nothing outside it. This
// is what makes "one integration clobbered another agent's files" structurally
// impossible rather than merely guarded against — there is no code path here
// that could reach a second home, because no function ever learns of one.
//
// Each test drives the SAME operation against two homes and asserts the other
// is byte-identical afterwards.

let homeA: string
let homeB: string

const KEY_A = 'ac_live_' + 'a'.repeat(40)
const KEY_B = 'ac_live_' + 'b'.repeat(40)

beforeEach(() => {
  homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-core-a-'))
  homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-core-b-'))
  delete process.env['AGENTCHAT_API_KEY']
  delete process.env['AGENTCHAT_API_BASE']
})

afterEach(() => {
  fs.rmSync(homeA, { recursive: true, force: true })
  fs.rmSync(homeB, { recursive: true, force: true })
})

/** Content hash of every file under a directory — the "byte-identical" oracle. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string): void => {
    if (!fs.existsSync(d)) return
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else out[path.relative(dir, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
    }
  }
  walk(dir)
  return out
}

describe('credentials are scoped to the home they are given', () => {
  it('two homes hold two independent identities', () => {
    writeCredentials(homeA, { api_key: KEY_A, handle: 'agent-a' })
    writeCredentials(homeB, { api_key: KEY_B, handle: 'agent-b' })

    expect(readCredentials(homeA)?.handle).toBe('agent-a')
    expect(readCredentials(homeB)?.handle).toBe('agent-b')
    expect(resolveIdentity(homeA)?.apiKey).toBe(KEY_A)
    expect(resolveIdentity(homeB)?.apiKey).toBe(KEY_B)
  })

  it('clearing one home leaves the other byte-identical', () => {
    writeCredentials(homeA, { api_key: KEY_A, handle: 'agent-a' })
    writeCredentials(homeB, { api_key: KEY_B, handle: 'agent-b' })
    const before = snapshot(homeB)

    expect(clearCredentials(homeA)).toBe(true)

    expect(readCredentials(homeA)).toBeNull()
    expect(readCredentials(homeB)?.handle).toBe('agent-b')
    expect(snapshot(homeB)).toEqual(before)
  })

  it('a pending registration in one home is invisible to the other', () => {
    writePending(homeA, {
      kind: 'register',
      pending_id: 'pnd_a',
      email: 'a@example.com',
      handle: 'agent-a',
      created_at: new Date().toISOString(),
    })
    expect(readPending(homeA)?.pending_id).toBe('pnd_a')
    expect(readPending(homeB)).toBeNull()

    clearPending(homeA)
    expect(readPending(homeA)).toBeNull()
  })

  it('credentials are written 0600', () => {
    writeCredentials(homeA, { api_key: KEY_A, handle: 'agent-a' })
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(homeA, 'credentials')).mode & 0o777).toBe(0o600)
    }
  })

  it('AGENTCHAT_API_KEY overrides the file without borrowing another home’s handle', () => {
    writeCredentials(homeA, { api_key: KEY_A, handle: 'agent-a' })
    process.env['AGENTCHAT_API_KEY'] = 'ac_live_' + 'z'.repeat(40)

    // The env key is a GLOBAL override (CI, externally-managed secrets), so it
    // applies to whichever home is asked — it is not host-specific.
    const a = resolveIdentity(homeA)
    expect(a?.source).toBe('env')
    // …but the handle still comes from that home's own file, since the env
    // carries no handle. Home A knows its handle:
    expect(a?.handle).toBe('agent-a')
    // …and home B, which has no credential file, reports no handle rather
    // than inheriting A's. A handle leaking across homes here is exactly the
    // "agent announces someone else's address" failure.
    expect(resolveIdentity(homeB)?.handle).toBeNull()
  })
})

describe('hook state is scoped to the home it is given', () => {
  it('continuation counters do not bleed between homes', () => {
    recordContinuation(homeA, 'sess-1')
    recordContinuation(homeA, 'sess-1')
    expect(getContinuations(homeA, 'sess-1')).toBe(2)
    // Same session id, different agent — must be its own counter.
    expect(getContinuations(homeB, 'sess-1')).toBe(0)
  })

  it('a pending ack cursor belongs to exactly one home', () => {
    setPendingAck(homeA, 'sess-1', 'del_' + '0'.repeat(32))
    expect(takePendingAck(homeB, 'sess-1')).toBeNull()
    expect(takePendingAck(homeA, 'sess-1')).toBe('del_' + '0'.repeat(32))
    // Read-and-clear: a second take is empty.
    expect(takePendingAck(homeA, 'sess-1')).toBeNull()
  })

  it('resetting a session in one home leaves the other untouched', () => {
    recordContinuation(homeA, 'sess-1')
    recordContinuation(homeB, 'sess-1')
    const before = snapshot(homeB)

    resetSession(homeA, 'sess-1')

    expect(getContinuations(homeA, 'sess-1')).toBe(0)
    expect(getContinuations(homeB, 'sess-1')).toBe(1)
    expect(snapshot(homeB)).toEqual(before)
  })

  it('the registration-offer cooldown is per agent, not per machine', () => {
    expect(shouldOfferRegistration(homeA)).toBe(true)
    recordRegistrationOffer(homeA)
    expect(shouldOfferRegistration(homeA)).toBe(false)
    // A second agent has not been offered anything yet.
    expect(shouldOfferRegistration(homeB)).toBe(true)
  })
})

describe('always-on health is per agent', () => {
  it('reports not-wanted until the user opts in', () => {
    expect(alwaysOnHealth(homeA)).toEqual({ wanted: false, healthy: true })
  })

  it('wanted with no beacon reads as down', () => {
    markAlwaysOnWanted(homeA)
    expect(alwaysOnHealth(homeA)).toEqual({ wanted: true, healthy: false })
  })

  it('wanted with a fresh beacon reads as healthy', () => {
    markAlwaysOnWanted(homeA)
    beat(homeA)
    expect(alwaysOnHealth(homeA)).toEqual({ wanted: true, healthy: true })
  })

  it('one agent being down says nothing about the other', () => {
    markAlwaysOnWanted(homeA)
    markAlwaysOnWanted(homeB)
    beat(homeB)
    expect(alwaysOnHealth(homeA).healthy).toBe(false)
    expect(alwaysOnHealth(homeB).healthy).toBe(true)
  })

  it('opting out clears the intent so the hook stops warning', () => {
    markAlwaysOnWanted(homeA)
    clearAlwaysOnWanted(homeA)
    expect(alwaysOnHealth(homeA)).toEqual({ wanted: false, healthy: true })
  })
})

describe('service units are named exactly as the integration asks', () => {
  it('uses the label verbatim — no re-prefixing', async () => {
    const { planForTest } = await import('../src/daemon/service.js')
    const p = planForTest({ label: 'agentchatd-codex', home: homeA, entry: '/opt/x/daemon.js' })
    // Re-prefixing produced `agentchatd-agentchatd-codex`, so uninstall and
    // status silently addressed a unit that never existed.
    expect(p.label).toBe('agentchatd-codex')
  })

  it('captures the host env the integration says its adapter needs', async () => {
    const { planForTest } = await import('../src/daemon/service.js')
    const p = planForTest({
      label: 'agentchatd-codex',
      home: homeA,
      entry: '/opt/x/daemon.js',
      env: { CODEX_HOME: '/custom/codex' },
    })
    expect(p.env['CODEX_HOME']).toBe('/custom/codex')
    // PATH is always captured: a systemd/launchd unit does not inherit the
    // login shell, so without it the adapter cannot find its runtime binary.
    expect(p.env['PATH']).toBeDefined()
  })
})
