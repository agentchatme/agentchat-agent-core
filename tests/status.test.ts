import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  clearDoorbellStatus,
  doorbellStatusPath,
  formatDoorbellStatus,
  readDoorbellStatus,
  writeDoorbellStatus,
  type DoorbellStatus,
} from '../src/doorbell/status.js'
import { resolveRunBudgetMs, resolveRunProfile, doorbellDisabled } from '../src/doorbell/profile.js'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-status-'))
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

const sample = (over: Partial<DoorbellStatus> = {}): DoorbellStatus => ({
  version: 1,
  updated_at: new Date().toISOString(),
  pid: 123,
  runtime: 'fake',
  handle: 'me',
  profile: 'answer',
  socket: 'ready',
  ack_negotiated: true,
  knocks: 4,
  knocks_absorbed: 2,
  invites: 1,
  runs_started: 2,
  runs_ok: 1,
  runs_failed: 1,
  runs_timed_out: 0,
  runs_not_started: 0,
  runs_skipped_empty: 3,
  last_run: { kind: 'knock', started_at: new Date().toISOString(), ended_at: new Date().toISOString(), state: 'ok', exit_code: 0, duration_ms: 4_000, detail: null },
  retry_rung: 1,
  retry_due_at: new Date(Date.now() + 60_000).toISOString(),
  last_error: null,
  ...over,
})

describe('doorbell status file', () => {
  it('round-trips, private to the user', () => {
    writeDoorbellStatus(home, sample())
    expect(readDoorbellStatus(home)).toMatchObject({ socket: 'ready', knocks: 4 })
    if (process.platform !== 'win32') {
      expect(fs.statSync(doorbellStatusPath(home)).mode & 0o777).toBe(0o600)
    }
    clearDoorbellStatus(home)
    expect(readDoorbellStatus(home)).toBeNull()
  })

  it('rejects a malformed file rather than throwing', () => {
    fs.writeFileSync(doorbellStatusPath(home), '{"version":2}')
    expect(readDoorbellStatus(home)).toBeNull()
  })

  it('formats every fact status must show', () => {
    const lines = formatDoorbellStatus(sample()).join('\n')
    expect(lines).toContain('socket ready')
    expect(lines).toContain('negotiated')
    expect(lines).toContain('never acknowledges')
    expect(lines).toContain('knocks: 4 (2 absorbed')
    expect(lines).toContain('runs: 2 started, 1 ok, 1 failed')
    expect(lines).toContain('3 knock(s) found the tray empty (no run)')
    expect(lines).toContain('profile: answer (fake)')
    expect(lines).toContain('last run: knock, ok (exit 0)')
    expect(lines).toContain('retry: rung 1')
  })

  it('reads a file from an older daemon without runs_skipped_empty as 0', () => {
    const { runs_skipped_empty: _dropped, ...older } = sample()
    fs.writeFileSync(doorbellStatusPath(home), JSON.stringify(older))
    expect(readDoorbellStatus(home)).toMatchObject({ socket: 'ready', runs_skipped_empty: 0 })
  })

  it('shows a refused key as socket terminal with the close as the last error', () => {
    const lines = formatDoorbellStatus(sample({ socket: 'terminal', last_error: "auth rejected (close 1008 Invalid token) — check the agent's API key" })).join('\n')
    expect(lines).toContain('Doorbell: socket terminal')
    expect(lines).toContain('last error: auth rejected (close 1008 Invalid token)')
  })

  it('flags a stale file as a daemon that may be down', () => {
    const lines = formatDoorbellStatus(sample({ updated_at: new Date(Date.now() - 10 * 60_000).toISOString() })).join('\n')
    expect(lines).toContain('may be down')
  })

  it('says so when no status was ever recorded', () => {
    expect(formatDoorbellStatus(null)[0]).toMatch(/no status recorded yet/)
  })
})

describe('profile and switches', () => {
  it('defaults to answer and ignores unknown values', () => {
    expect(resolveRunProfile({})).toBe('answer')
    expect(resolveRunProfile({ AGENTCHAT_RUN_PROFILE: 'WORK' })).toBe('work')
    expect(resolveRunProfile({ AGENTCHAT_RUN_PROFILE: 'full' })).toBe('full')
    expect(resolveRunProfile({ AGENTCHAT_RUN_PROFILE: 'yolo' })).toBe('answer')
  })

  it('AGENTCHAT_DOORBELL=off disables; anything else does not', () => {
    expect(doorbellDisabled({ AGENTCHAT_DOORBELL: 'off' })).toBe(true)
    expect(doorbellDisabled({ AGENTCHAT_DOORBELL: 'v3' })).toBe(false)
    expect(doorbellDisabled({})).toBe(false)
  })

  it('the run budget defaults to 10 minutes and is bounded', () => {
    expect(resolveRunBudgetMs({})).toBe(600_000)
    expect(resolveRunBudgetMs({ AGENTCHAT_RUN_BUDGET_MS: '120000' })).toBe(120_000)
    expect(resolveRunBudgetMs({ AGENTCHAT_RUN_BUDGET_MS: '5' })).toBe(600_000)
    expect(resolveRunBudgetMs({ AGENTCHAT_RUN_BUDGET_MS: String(10 * 3_600_000) })).toBe(2 * 3_600_000)
  })
})
