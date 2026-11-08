import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  clearIntegrationStatus,
  formatIntegrationStatus,
  integrationStatusPath,
  legacyStatusPath,
  readIntegrationStatus,
  writeIntegrationStatus,
  type IntegrationStatus,
} from '../src/integration/status.js'
import { integrationDisabled, integrationDisabledBy, resolveRunBudgetMs, resolveRunProfile } from '../src/integration/profile.js'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-status-'))
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

const sample = (over: Partial<IntegrationStatus> = {}): IntegrationStatus => ({
  version: 2,
  updated_at: new Date().toISOString(),
  pid: 123,
  runtime: 'fake',
  handle: 'me',
  profile: 'answer',
  socket: 'ready',
  wakes: 4,
  wakes_absorbed: 2,
  invites: 1,
  runs_started: 2,
  runs_ok: 1,
  runs_failed: 1,
  runs_timed_out: 0,
  runs_not_started: 0,
  runs_skipped_empty: 3,
  last_run: { kind: 'wake', started_at: new Date().toISOString(), ended_at: new Date().toISOString(), state: 'ok', exit_code: 0, duration_ms: 4_000, detail: null },
  retry_rung: 1,
  retry_due_at: new Date(Date.now() + 60_000).toISOString(),
  last_error: null,
  texts: { source: 'server', fetched_at: new Date(Date.now() - 2 * 3_600_000).toISOString(), version: '1', manual_version: '2.1.2' },
  ...over,
})

/** What a daemon from before the rename writes (`doorbell.status.json`, version 1, `knocks`). */
const legacySample = () => ({
  version: 1,
  updated_at: new Date().toISOString(),
  pid: 99,
  runtime: 'fake',
  handle: 'me',
  profile: 'answer',
  socket: 'ready',
  ack_negotiated: true,
  knocks: 7,
  knocks_absorbed: 3,
  invites: 0,
  runs_started: 1,
  runs_ok: 1,
  runs_failed: 0,
  runs_timed_out: 0,
  runs_not_started: 0,
  runs_skipped_empty: 2,
  last_run: { kind: 'knock', started_at: new Date().toISOString(), ended_at: new Date().toISOString(), state: 'ok', exit_code: 0, duration_ms: 1_000, detail: null },
  retry_rung: 0,
  retry_due_at: null,
  last_error: null,
})

describe('integration status file', () => {
  it('round-trips under the new name and keys, private to the user', () => {
    writeIntegrationStatus(home, sample())
    expect(fs.existsSync(integrationStatusPath(home))).toBe(true)
    expect(fs.existsSync(legacyStatusPath(home))).toBe(false)
    const written = JSON.parse(fs.readFileSync(integrationStatusPath(home), 'utf-8')) as Record<string, unknown>
    expect(written['wakes']).toBe(4)
    expect(written).not.toHaveProperty('knocks')
    expect(readIntegrationStatus(home)).toMatchObject({ socket: 'ready', wakes: 4, wakes_absorbed: 2, texts: { source: 'server' } })
    if (process.platform !== 'win32') {
      expect(fs.statSync(integrationStatusPath(home)).mode & 0o777).toBe(0o600)
    }
    clearIntegrationStatus(home)
    expect(readIntegrationStatus(home)).toBeNull()
  })

  it('reads the file a daemon from before the rename writes: knocks → wakes, kind knock → wake, no texts', () => {
    fs.writeFileSync(legacyStatusPath(home), JSON.stringify(legacySample()))
    const status = readIntegrationStatus(home)
    expect(status).toMatchObject({ version: 2, socket: 'ready', wakes: 7, wakes_absorbed: 3, runs_skipped_empty: 2, texts: null })
    expect(status?.last_run?.kind).toBe('wake')
    expect(status).not.toHaveProperty('knocks')
  })

  it('prefers the current file when both exist, and clear removes both', () => {
    fs.writeFileSync(legacyStatusPath(home), JSON.stringify(legacySample()))
    writeIntegrationStatus(home, sample({ wakes: 4 }))
    expect(readIntegrationStatus(home)?.wakes).toBe(4)
    clearIntegrationStatus(home)
    expect(fs.existsSync(legacyStatusPath(home))).toBe(false)
    expect(fs.existsSync(integrationStatusPath(home))).toBe(false)
  })

  it('reads an older file without runs_skipped_empty or texts', () => {
    const { runs_skipped_empty: _dropped, texts: _texts, ...older } = sample()
    fs.writeFileSync(integrationStatusPath(home), JSON.stringify(older))
    expect(readIntegrationStatus(home)).toMatchObject({ socket: 'ready', runs_skipped_empty: 0, texts: null })
  })

  it('rejects a malformed file rather than throwing', () => {
    fs.writeFileSync(integrationStatusPath(home), '{"version":3}')
    expect(readIntegrationStatus(home)).toBeNull()
  })

  it('formats every fact status must show', () => {
    const lines = formatIntegrationStatus(sample()).join('\n')
    expect(lines).toContain('Integration: socket ready')
    expect(lines).toContain('acknowledged on receipt')
    expect(lines).toContain('wakes: 4 (2 absorbed')
    expect(lines).toContain('runs: 2 started, 1 ok, 1 failed')
    expect(lines).toContain('3 wake(s) found the tray empty (no run)')
    expect(lines).toContain('texts: served (v1, manual 2.1.2, fetched 2 hour(s) ago')
    expect(lines).toContain('profile: answer (fake)')
    expect(lines).toContain('last run: wake, ok (exit 0)')
    expect(lines).toContain('retry: rung 1')
    expect(lines).not.toMatch(/doorbell|knock/i)
  })

  it('says where the texts came from when they are cached, or missing', () => {
    expect(formatIntegrationStatus(sample({ texts: { source: 'cache', fetched_at: new Date(Date.now() - 86_400_000 * 2).toISOString(), version: '1', manual_version: '2.1.2' } })).join('\n')).toContain(
      'texts: from the identity-home cache (v1, manual 2.1.2, fetched 2 day(s) ago',
    )
    expect(formatIntegrationStatus(sample({ texts: { source: 'none', fetched_at: null, version: null, manual_version: null } })).join('\n')).toContain('texts: not fetched yet')
    expect(formatIntegrationStatus(sample({ texts: null })).join('\n')).toContain('texts: not fetched yet')
  })

  it('shows a refused key as socket blocked with the close as the last error', () => {
    const lines = formatIntegrationStatus(sample({ socket: 'blocked', last_error: "auth rejected (close 1008 Invalid token) — check the agent's API key" })).join('\n')
    expect(lines).toContain('Integration: socket blocked')
    expect(lines).toContain('last error: auth rejected (close 1008 Invalid token)')
  })

  it('reads `terminal` from a daemon before the rename as `blocked` — in the current file and in the legacy one', () => {
    fs.writeFileSync(integrationStatusPath(home), JSON.stringify({ ...sample(), socket: 'terminal' }))
    expect(readIntegrationStatus(home)?.socket).toBe('blocked')
    clearIntegrationStatus(home)
    fs.writeFileSync(legacyStatusPath(home), JSON.stringify({ ...legacySample(), socket: 'terminal' }))
    expect(readIntegrationStatus(home)?.socket).toBe('blocked')
    // Never written back out under the old word.
    writeIntegrationStatus(home, sample({ socket: 'blocked' }))
    expect(fs.readFileSync(integrationStatusPath(home), 'utf-8')).not.toContain('terminal')
  })

  it('flags a stale file as a daemon that may be down', () => {
    const lines = formatIntegrationStatus(sample({ updated_at: new Date(Date.now() - 10 * 60_000).toISOString() })).join('\n')
    expect(lines).toContain('may be down')
  })

  it('says so when no status was ever recorded', () => {
    expect(formatIntegrationStatus(null)[0]).toMatch(/no status recorded yet/)
  })
})

describe('profile and switches', () => {
  it('defaults to answer and ignores unknown values', () => {
    expect(resolveRunProfile({})).toBe('answer')
    expect(resolveRunProfile({ AGENTCHAT_RUN_PROFILE: 'WORK' })).toBe('work')
    expect(resolveRunProfile({ AGENTCHAT_RUN_PROFILE: 'full' })).toBe('full')
    expect(resolveRunProfile({ AGENTCHAT_RUN_PROFILE: 'yolo' })).toBe('answer')
  })

  it('AGENTCHAT_INTEGRATION=off disables; the old AGENTCHAT_DOORBELL=off still does for one release; anything else does not', () => {
    expect(integrationDisabled({ AGENTCHAT_INTEGRATION: 'off' })).toBe(true)
    expect(integrationDisabledBy({ AGENTCHAT_INTEGRATION: 'off' })).toBe('AGENTCHAT_INTEGRATION')
    expect(integrationDisabled({ AGENTCHAT_DOORBELL: 'off' })).toBe(true)
    expect(integrationDisabledBy({ AGENTCHAT_DOORBELL: 'off' })).toBe('AGENTCHAT_DOORBELL')
    // The new spelling wins when both are set.
    expect(integrationDisabled({ AGENTCHAT_INTEGRATION: 'on', AGENTCHAT_DOORBELL: 'off' })).toBe(false)
    expect(integrationDisabled({ AGENTCHAT_INTEGRATION: 'v3' })).toBe(false)
    expect(integrationDisabled({})).toBe(false)
  })

  it('the run budget defaults to 10 minutes and is bounded', () => {
    expect(resolveRunBudgetMs({})).toBe(600_000)
    expect(resolveRunBudgetMs({ AGENTCHAT_RUN_BUDGET_MS: '120000' })).toBe(120_000)
    expect(resolveRunBudgetMs({ AGENTCHAT_RUN_BUDGET_MS: '5' })).toBe(600_000)
    expect(resolveRunBudgetMs({ AGENTCHAT_RUN_BUDGET_MS: String(10 * 3_600_000) })).toBe(2 * 3_600_000)
  })
})

describe('recent wake cycles in status', () => {
  const cycle = (outcome: string, failure: string | null = null) => ({ at: new Date().toISOString(), outcome, cards: 1, invites: 0, failure })
  it('counts the failed cycles in a row at the end; one success breaks the run', async () => {
    const { failedCyclesInARow, REPEATED_FAILED_CYCLES } = await import('../src/integration/status.js')
    expect(failedCyclesInARow({ recent_cycles: [] })).toBeNull()
    expect(failedCyclesInARow({ recent_cycles: [cycle('run_failed'), cycle('run_completed')] })).toBeNull()
    expect(failedCyclesInARow({ recent_cycles: [cycle('run_completed'), cycle('run_failed'), cycle('abandoned', 'past its deadline')] })).toMatchObject({ count: 2, latest: { outcome: 'abandoned' } })
    expect(REPEATED_FAILED_CYCLES).toBe(3)
  })

  it('status prints the last cycle, and a warning after three failed in a row', async () => {
    const { formatIntegrationStatus } = await import('../src/integration/status.js')
    const base = { version: 2 as const, updated_at: new Date().toISOString(), pid: 1, runtime: 'x', handle: 'h', profile: 'answer', socket: 'ready' as const, wakes: 3, wakes_absorbed: 0, invites: 0, runs_started: 3, runs_ok: 0, runs_failed: 3, runs_timed_out: 0, runs_not_started: 0, runs_skipped_empty: 0, last_run: null, retry_rung: 0, retry_due_at: null, last_error: null, texts: null }
    const ok = formatIntegrationStatus({ ...base, recent_cycles: [cycle('run_completed')] }).join('\n')
    expect(ok).toMatch(/cycles: 1 recent; the last one run_completed/)
    expect(ok).not.toMatch(/WARNING/)
    const bad = formatIntegrationStatus({ ...base, recent_cycles: [cycle('run_failed'), cycle('run_failed'), cycle('run_failed', 'exit 1')] }).join('\n')
    expect(bad).toMatch(/WARNING: the last 3 wake cycles did not get done \(latest: run_failed — exit 1\)/)
  })
})

describe('backpressure in status', () => {
  it('a paused intake is a warning line; not paused (or unknown) prints nothing', async () => {
    const { formatIntegrationStatus } = await import('../src/integration/status.js')
    const base = { version: 2 as const, updated_at: new Date().toISOString(), pid: 1, runtime: 'x', handle: 'h', profile: 'answer', socket: 'ready' as const, wakes: 0, wakes_absorbed: 0, invites: 0, runs_started: 0, runs_ok: 0, runs_failed: 0, runs_timed_out: 0, runs_not_started: 0, runs_skipped_empty: 0, last_run: null, retry_rung: 0, retry_due_at: null, last_error: null, texts: null }
    expect(formatIntegrationStatus({ ...base, intake_paused: true }).join('\n')).toMatch(/WARNING: the socket is refusing new messages/)
    expect(formatIntegrationStatus({ ...base, intake_paused: false }).join('\n')).not.toMatch(/refusing new messages/)
    expect(formatIntegrationStatus({ ...base }).join('\n')).not.toMatch(/refusing new messages/)
  })
})
