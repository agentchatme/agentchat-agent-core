import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clearCredentials, readCredentials, writeCredentials, writePending, readPending, clearPending } from '../src/identity/credentials.js'
import { recordOfferDeclined, offerDeclined, clearOfferDeclined } from '../src/identity/state.js'
import { writeAnchor, removeAnchorAt, renderAnchorBlock } from '../src/anchor/block.js'
import { markAlwaysOnWanted, clearAlwaysOnWanted, beat, idle, markAlwaysOnOptOut } from '../src/daemon/health.js'
import { writeIntegrationStatus, clearIntegrationStatus } from '../src/integration/status.js'

// ─── Every operation acts on the home it is GIVEN and nowhere else ──────────
//
// Two homes, fully populated. Every mutating operation this package offers is
// run against home A, and home B must be byte-identical before and after. This
// is the mechanical form of "every function takes an identity home; none
// resolves one".

let root: string
let homeA: string
let homeB: string

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    const full = path.join(entry.parentPath ?? entry.path, entry.name)
    out[path.relative(dir, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
  }
  return out
}

const line = (handle: string): string => `I am @${handle} on AgentChat (api.agentchat.me). Served line, test copy.`

function populate(home: string, handle: string): void {
  fs.mkdirSync(home, { recursive: true })
  writeCredentials(home, { api_key: 'ac_' + handle.padEnd(40, 'x'), handle })
  writeAnchor(path.join(home, 'ANCHOR.md'), renderAnchorBlock(line(handle)), handle)
  markAlwaysOnWanted(home)
  beat(home)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-home-scoping-'))
  homeA = path.join(root, 'a')
  homeB = path.join(root, 'b')
  populate(homeA, 'agent-a')
  populate(homeB, 'agent-b')
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('operations on home A leave home B byte-identical', () => {
  const ops: Array<[string, (home: string) => void]> = [
    ['writeCredentials', (h) => writeCredentials(h, { api_key: 'ac_' + 'n'.repeat(40), handle: 'new-agent' })],
    ['clearCredentials', (h) => void clearCredentials(h)],
    ['writePending/readPending/clearPending', (h) => {
      writePending(h, { kind: 'register', pending_id: 'pnd_1', email: 'a@example.com', handle: 'x-agent', created_at: new Date().toISOString() })
      expect(readPending(h)?.pending_id).toBe('pnd_1')
      clearPending(h)
    }],
    ['recordOfferDeclined/clearOfferDeclined', (h) => {
      recordOfferDeclined(h)
      expect(offerDeclined(h)).toBe(true)
      clearOfferDeclined(h)
    }],
    ['writeAnchor/removeAnchorAt', (h) => {
      writeAnchor(path.join(h, 'ANCHOR.md'), renderAnchorBlock(line('renamed-agent')), 'renamed-agent')
      removeAnchorAt(path.join(h, 'ANCHOR.md'))
    }],
    ['always-on markers', (h) => {
      clearAlwaysOnWanted(h)
      markAlwaysOnOptOut(h)
      idle(h)
    }],
    ['integration status', (h) => {
      writeIntegrationStatus(h, {
        version: 2, updated_at: new Date().toISOString(), pid: 1, runtime: 'r', handle: 'agent-a', profile: 'answer', socket: 'ready',
        wakes: 1, wakes_absorbed: 0, invites: 0, runs_started: 0, runs_ok: 0, runs_failed: 0, runs_timed_out: 0,
        runs_not_started: 0, runs_skipped_empty: 0, last_run: null, retry_rung: 0, retry_due_at: null, last_error: null, texts: null,
      })
      clearIntegrationStatus(h)
    }],
  ]

  for (const [name, op] of ops) {
    it(name, () => {
      const before = snapshot(homeB)
      op(homeA)
      expect(snapshot(homeB)).toEqual(before)
      expect(readCredentials(homeB)?.handle).toBe('agent-b')
    })
  }
})
