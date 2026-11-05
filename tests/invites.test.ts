import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { IntegrationInvoker } from '../src/integration/invoker.js'
import { OfferedInvites, offeredInvitesPath } from '../src/integration/invites.js'
import type { RunOutcome, RunRequest, RunRunner } from '../src/integration/runner.js'
import { FakeClock, flush } from './helpers/fake-clock.js'

// ─── An invite is offered once per machine, and never lost ──────────────────
//
// A daemon restart used to start one paid run per still-pending invite: the
// "already offered" set lived in process memory. It now lives in the identity
// home. An invite whose run did not start is deliberately not recorded, so the
// next wake offers it again.

class FakeRunner implements RunRunner {
  readonly name = 'fake-runtime'
  readonly requests: RunRequest[] = []
  /** Whether this runner signals `onStarted` (a spawn-based runner does; a runner that cannot tell does not). */
  signalsStart = true
  constructor(private script: (request: RunRequest) => RunOutcome | Promise<RunOutcome> = () => ({ state: 'ok', exitCode: 0, durationMs: 1 })) {}
  set outcome(script: (request: RunRequest) => RunOutcome | Promise<RunOutcome>) {
    this.script = script
  }
  async preflight() {
    return { ok: true }
  }
  async start(request: RunRequest): Promise<RunOutcome> {
    this.requests.push(request)
    if (this.signalsStart) request.onStarted?.()
    return this.script(request)
  }
}

const PROMPTS = { wake: 'WAKE PROMPT', invite: 'INVITE PROMPT' }
const invite = (id: string) => ({ inviteId: id, groupId: 'grp_1', groupName: 'Ops', inviterHandle: 'alice' })
const notStarted = (): RunOutcome => ({ state: 'not_started', exitCode: 127, durationMs: 1, detail: 'exit 127 with nothing on stdout' })

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-invites-'))
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

function invoker(clock: FakeClock, runner: FakeRunner, offered = OfferedInvites.load(home)) {
  return new IntegrationInvoker({
    runner,
    prompts: async () => PROMPTS,
    budgetMs: 600_000,
    debounceMs: 2_000,
    now: () => clock.now(),
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (h) => clock.clearTimeout(h),
    offeredInvites: offered,
  })
}

describe('OfferedInvites', () => {
  it('persists in the identity home, private to the user, and reads back after a restart', () => {
    const a = OfferedInvites.load(home)
    expect(a.has('gri_1')).toBe(false)
    a.add('gri_1')
    a.add('gri_1') // idempotent
    expect(a.size).toBe(1)
    if (process.platform !== 'win32') expect(fs.statSync(offeredInvitesPath(home)).mode & 0o777).toBe(0o600)
    const b = OfferedInvites.load(home)
    expect(b.has('gri_1')).toBe(true)
    expect(b.has('gri_2')).toBe(false)
    b.remove('gri_1')
    expect(OfferedInvites.load(home).has('gri_1')).toBe(false)
  })

  it('a malformed file is an empty set, never a crash', () => {
    fs.writeFileSync(offeredInvitesPath(home), '{not json')
    expect(OfferedInvites.load(home).size).toBe(0)
  })

  it('is bounded', () => {
    const a = new OfferedInvites(null)
    for (let i = 0; i < 1_100; i++) a.add(`gri_${i}`)
    expect(a.size).toBe(1_000)
    expect(a.has('gri_0')).toBe(false)
    expect(a.has('gri_1099')).toBe(true)
  })
})

describe('IntegrationInvoker — invites across restarts', () => {
  it('an invite whose run started is offered once per machine: a second invoker on the same home does not run it again', async () => {
    const clock = new FakeClock()
    const first = new FakeRunner()
    const a = invoker(clock, first)
    expect(a.invite(invite('gri_1'))).toBe(true)
    await flush()
    await a.settled()
    expect(first.requests.map((r) => r.kind)).toEqual(['invite'])
    a.stop()

    // The daemon restarts; the connect-time listing offers the same invite.
    const second = new FakeRunner()
    const b = invoker(clock, second)
    expect(b.invite(invite('gri_1'))).toBe(false)
    expect(b.invite(invite('gri_2'))).toBe(true)
    await flush()
    await b.settled()
    expect(second.requests.map((r) => r.kind)).toEqual(['invite'])
  })

  it('an invite whose run FAILED (after starting) still counts as offered — the invite stays reachable through the tools', async () => {
    const clock = new FakeClock()
    const runner = new FakeRunner(() => ({ state: 'failed', exitCode: 1, durationMs: 1, detail: 'exit 1' }))
    const a = invoker(clock, runner)
    a.invite(invite('gri_f'))
    await flush()
    await a.settled()
    expect(OfferedInvites.load(home).has('gri_f')).toBe(true)
    expect(a.counters().retryRung).toBe(0) // the wake ladder is not for invites
  })

  it('the offer is on disk the moment the run has STARTED — a crash mid-run cannot re-offer it', async () => {
    const clock = new FakeClock()
    let release: (o: RunOutcome) => void = () => undefined
    const runner = new FakeRunner(() => new Promise<RunOutcome>((resolve) => (release = resolve)))
    const a = invoker(clock, runner)
    a.invite(invite('gri_crash'))
    await flush()
    // The run is in flight (never ends in this test: that is the crash).
    expect(runner.requests).toHaveLength(1)
    expect(OfferedInvites.load(home).has('gri_crash')).toBe(true)
    // A restarted daemon reads the record and does not run it again.
    const second = new FakeRunner()
    const b = invoker(clock, second)
    expect(b.invite(invite('gri_crash'))).toBe(false)
    release({ state: 'ok', exitCode: 0, durationMs: 1 })
    await a.settled()
  })

  it('a run interrupted by stop() after it started still counts as the offer — the paid call was made', async () => {
    const clock = new FakeClock()
    const runner = new FakeRunner()
    runner.outcome = (request) => {
      a.stop() // the integration stops mid-run (SIGTERM)
      return { state: 'failed', exitCode: null, durationMs: 1, detail: `interrupted ${request.runId}` }
    }
    const a = invoker(clock, runner)
    a.invite(invite('gri_s'))
    await flush()
    await a.settled()
    expect(OfferedInvites.load(home).has('gri_s')).toBe(true)
  })

  it('a run that started but never got going (signed-out CLI: exit with nothing on stdout) is taken back out and offered again on the next wake', async () => {
    const clock = new FakeClock()
    const runner = new FakeRunner(notStarted)
    const a = invoker(clock, runner)
    a.invite(invite('gri_n'))
    await flush()
    await a.settled()
    expect(runner.requests).toHaveLength(1)
    expect(OfferedInvites.load(home).has('gri_n')).toBe(false)
    // Re-offering it directly is refused while it awaits its retry (no double queue).
    expect(a.invite(invite('gri_n'))).toBe(false)

    // The runtime comes back; the next wake (any source) offers it again.
    runner.outcome = () => ({ state: 'ok', exitCode: 0, durationMs: 1 })
    a.wake('message')
    await clock.advanceAsync(2_000)
    await a.settled()
    expect(runner.requests.map((r) => r.kind)).toEqual(['invite', 'invite', 'wake'])
    expect(OfferedInvites.load(home).has('gri_n')).toBe(true)
  })

  it('a runner that cannot signal the start is recorded when its run ends (unless it never got going)', async () => {
    const clock = new FakeClock()
    const runner = new FakeRunner()
    runner.signalsStart = false
    const a = invoker(clock, runner)
    a.invite(invite('gri_late'))
    await flush()
    await a.settled()
    expect(OfferedInvites.load(home).has('gri_late')).toBe(true)
    const broken = new FakeRunner(notStarted)
    broken.signalsStart = false
    const b = invoker(clock, broken)
    b.invite(invite('gri_never'))
    await flush()
    await b.settled()
    expect(OfferedInvites.load(home).has('gri_never')).toBe(false)
  })

  it('a run with no served texts in hand does not start and the invite is kept for the next wake', async () => {
    const clock = new FakeClock()
    const runner = new FakeRunner()
    let texts: typeof PROMPTS | null = null
    const a = new IntegrationInvoker({
      runner,
      prompts: async () => texts,
      budgetMs: 600_000,
      debounceMs: 2_000,
      now: () => clock.now(),
      setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
      clearTimeout: (h) => clock.clearTimeout(h),
      offeredInvites: OfferedInvites.load(home),
    })
    a.invite(invite('gri_t'))
    await flush()
    await a.settled()
    expect(runner.requests).toHaveLength(0)
    expect(a.counters()).toMatchObject({ runsNotStarted: 1 })
    expect(a.counters().lastRun?.detail).toMatch(/no served texts/)
    texts = PROMPTS
    a.wake('connect')
    await clock.advanceAsync(2_000)
    await a.settled()
    expect(runner.requests.map((r) => r.kind)).toEqual(['invite', 'wake'])
    expect(runner.requests[0]?.prompt).toBe('INVITE PROMPT')
  })

  it('a wake run with no served texts in hand is `not_started` and climbs the ladder', async () => {
    const clock = new FakeClock()
    const runner = new FakeRunner()
    const a = new IntegrationInvoker({
      runner,
      prompts: async () => null,
      budgetMs: 600_000,
      debounceMs: 2_000,
      now: () => clock.now(),
      setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
      clearTimeout: (h) => clock.clearTimeout(h),
    })
    a.wake('message')
    await clock.advanceAsync(2_000)
    await a.settled()
    expect(runner.requests).toHaveLength(0)
    expect(a.counters()).toMatchObject({ runsStarted: 1, runsNotStarted: 1, retryRung: 1 })
  })
})
