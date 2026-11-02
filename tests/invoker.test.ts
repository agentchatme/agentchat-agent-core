import { describe, expect, it } from 'vitest'
import { DoorbellInvoker, RETRY_LADDER_MS } from '../src/doorbell/invoker.js'
import type { RunOutcome, RunRequest, RunRunner } from '../src/doorbell/runner.js'
import { FakeClock, flush } from './helpers/fake-clock.js'

// ─── Knock → one run; never two; failures climb the ladder one rung per outage ─

type Script = (request: RunRequest) => Promise<RunOutcome> | RunOutcome

class FakeRunner implements RunRunner {
  readonly name = 'fake-runtime'
  readonly requests: RunRequest[] = []
  inFlight = 0
  maxInFlight = 0
  private releasers: Array<(outcome: RunOutcome) => void> = []

  constructor(private script: Script = () => ok()) {}

  async preflight() {
    return { ok: true }
  }

  async start(request: RunRequest): Promise<RunOutcome> {
    this.requests.push(request)
    this.inFlight += 1
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      return await this.script(request)
    } finally {
      this.inFlight -= 1
    }
  }

  /** A script that blocks until the test releases it. */
  holding(): Script {
    return () =>
      new Promise<RunOutcome>((resolve) => {
        this.releasers.push(resolve)
      })
  }

  release(outcome: RunOutcome = ok()): void {
    const next = this.releasers.shift()
    if (next) next(outcome)
  }
}

const ok = (): RunOutcome => ({ state: 'ok', exitCode: 0, durationMs: 10 })
const failed = (): RunOutcome => ({ state: 'failed', exitCode: 1, durationMs: 10, detail: 'exit 1' })
const notStarted = (): RunOutcome => ({ state: 'not_started', exitCode: 127, durationMs: 1, detail: 'exit 127 before any output' })
const timedOut = (): RunOutcome => ({ state: 'timed_out', exitCode: null, durationMs: 600_000, detail: 'killed' })

const PROMPTS = { knock: 'KNOCK PROMPT', invite: 'INVITE PROMPT' }

function invoker(clock: FakeClock, runner: FakeRunner, ladder: readonly number[] = RETRY_LADDER_MS) {
  return new DoorbellInvoker({
    runner,
    prompts: PROMPTS,
    budgetMs: 600_000,
    debounceMs: 2_000,
    retryLadderMs: ladder,
    now: () => clock.now(),
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (h) => clock.clearTimeout(h),
    runId: () => `run-${runner.requests.length + 1}`,
  })
}

describe('DoorbellInvoker — knocks', () => {
  it('coalesces a burst into one run with the fixed knock prompt and the budget', async () => {
    const clock = new FakeClock()
    const runner = new FakeRunner()
    const inv = invoker(clock, runner)
    inv.knock('message')
    inv.knock('message')
    inv.knock('message')
    await clock.advanceAsync(2_000)
    await inv.settled()
    expect(runner.requests).toHaveLength(1)
    expect(runner.requests[0]).toMatchObject({ kind: 'knock', prompt: 'KNOCK PROMPT', budgetMs: 600_000 })
    expect(inv.counters()).toMatchObject({ knocks: 3, absorbed: 2, runsStarted: 1, runsOk: 1, retryRung: 0 })
  })

  it('never runs two at once: a knock during a run earns exactly ONE more run after it', async () => {
    const clock = new FakeClock()
    const runner = new FakeRunner()
    runner['script'] = runner.holding()
    const inv = invoker(clock, runner)
    inv.knock('message')
    await clock.advanceAsync(2_000)
    expect(runner.requests).toHaveLength(1)

    // Ten knocks while the run is in flight.
    for (let i = 0; i < 10; i++) {
      inv.knock('message')
      await clock.advanceAsync(2_000)
    }
    expect(runner.requests).toHaveLength(1)
    expect(runner.maxInFlight).toBe(1)

    runner.release(ok())
    await flush()
    // Exactly one follow-up run — not ten.
    expect(runner.requests).toHaveLength(2)
    runner.release(ok())
    await flush()
    await clock.advanceAsync(10_000)
    expect(runner.requests).toHaveLength(2)
    expect(runner.maxInFlight).toBe(1)
  })

  it('a run that fails to start schedules the ladder (60 s first)', async () => {
    const clock = new FakeClock()
    const runner = new FakeRunner(() => notStarted())
    const inv = invoker(clock, runner)
    inv.knock('connect')
    await clock.advanceAsync(2_000)
    await inv.settled()
    expect(runner.requests).toHaveLength(1)
    expect(inv.counters()).toMatchObject({ runsNotStarted: 1, retryRung: 1, retryDueAt: 2_000 + 60_000 })

    await clock.advanceAsync(60_000) // the delayed knock
    await clock.advanceAsync(2_000) // its debounce
    await inv.settled()
    expect(runner.requests).toHaveLength(2)
    expect(inv.counters().retryRung).toBe(2)
  })

  it('a failed run and a timed-out run climb the ladder too; success resets it', async () => {
    const clock = new FakeClock()
    const outcomes = [failed(), timedOut(), ok()]
    const runner = new FakeRunner(() => outcomes.shift() ?? ok())
    const inv = invoker(clock, runner)
    inv.knock('message')
    await clock.advanceAsync(2_000)
    await inv.settled()
    expect(inv.counters()).toMatchObject({ runsFailed: 1, retryRung: 1 })

    await clock.advanceAsync(62_000)
    await inv.settled()
    expect(inv.counters()).toMatchObject({ runsTimedOut: 1, retryRung: 2 })

    await clock.advanceAsync(302_000)
    await inv.settled()
    expect(inv.counters()).toMatchObject({ runsOk: 1, retryRung: 0, retryDueAt: null })
    expect(runner.requests).toHaveLength(3)
  })

  it('one outage climbs ONE rung: a knock that fails while a retry is pending does not replace it', async () => {
    const clock = new FakeClock()
    const runner = new FakeRunner(() => failed())
    const inv = invoker(clock, runner)
    inv.knock('message')
    await clock.advanceAsync(2_000)
    await inv.settled()
    expect(inv.counters()).toMatchObject({ retryRung: 1, retryDueAt: 62_000 })

    // A peer writes again mid-outage; that run fails too.
    await clock.advanceAsync(10_000)
    inv.knock('message')
    await clock.advanceAsync(2_000)
    await inv.settled()
    expect(runner.requests).toHaveLength(2)
    // Still rung 1, still the SOONER deadline.
    expect(inv.counters()).toMatchObject({ retryRung: 1, retryDueAt: 62_000 })
  })

  it('the ladder is exhausted after its last rung and waits for the next knock', async () => {
    const clock = new FakeClock()
    const runner = new FakeRunner(() => failed())
    const inv = invoker(clock, runner, [10, 20])
    inv.knock('message')
    await clock.advanceAsync(2_000)
    await inv.settled()
    await clock.advanceAsync(2_010)
    await inv.settled()
    await clock.advanceAsync(2_020)
    await inv.settled()
    expect(runner.requests).toHaveLength(3)
    expect(inv.counters().retryRung).toBe(2)
    await clock.advanceAsync(100_000)
    expect(runner.requests).toHaveLength(3) // nothing more scheduled
    inv.knock('message')
    await clock.advanceAsync(2_000)
    await inv.settled()
    expect(runner.requests).toHaveLength(4)
  })

  it('a runner that throws is treated as not started, never dropped', async () => {
    const clock = new FakeClock()
    const runner = new FakeRunner(() => {
      throw new Error('boom')
    })
    const inv = invoker(clock, runner)
    inv.knock('message')
    await clock.advanceAsync(2_000)
    await inv.settled()
    expect(inv.counters()).toMatchObject({ runsNotStarted: 1, retryRung: 1 })
    expect(inv.counters().lastRun?.detail).toContain('boom')
  })

  it('records the last run for status', async () => {
    const clock = new FakeClock()
    const runner = new FakeRunner()
    const inv = invoker(clock, runner)
    inv.knock('message')
    await clock.advanceAsync(2_000)
    await inv.settled()
    expect(inv.counters().lastRun).toMatchObject({ kind: 'knock', state: 'ok', exit_code: 0 })
  })

  it('stop cancels pending knocks and retries', async () => {
    const clock = new FakeClock()
    const runner = new FakeRunner(() => failed())
    const inv = invoker(clock, runner)
    inv.knock('message')
    await clock.advanceAsync(2_000)
    await inv.settled()
    inv.stop()
    await clock.advanceAsync(10 * 60_000)
    expect(runner.requests).toHaveLength(1)
  })
})

describe('DoorbellInvoker — invites', () => {
  const invite = (id: string) => ({ inviteId: id, groupId: 'grp_1', groupName: 'Ops', inviterHandle: 'alice' })

  it('starts one invite run with the fixed invite prompt, deduplicated by invite id', async () => {
    const clock = new FakeClock()
    const runner = new FakeRunner()
    const inv = invoker(clock, runner)
    expect(inv.invite(invite('gri_1'))).toBe(true)
    expect(inv.invite(invite('gri_1'))).toBe(false)
    await inv.settled()
    await flush()
    expect(runner.requests).toHaveLength(1)
    expect(runner.requests[0]).toMatchObject({ kind: 'invite', prompt: 'INVITE PROMPT' })
    expect(inv.counters().invites).toBe(1)
  })

  it('serializes invite runs and knock runs on one worker', async () => {
    const clock = new FakeClock()
    const runner = new FakeRunner()
    runner['script'] = runner.holding()
    const inv = invoker(clock, runner)
    inv.invite(invite('gri_1'))
    await flush()
    inv.knock('message')
    await clock.advanceAsync(2_000)
    expect(runner.requests).toHaveLength(1)
    runner.release(ok())
    await flush()
    expect(runner.requests).toHaveLength(2)
    expect(runner.requests[1]?.kind).toBe('knock')
    expect(runner.maxInFlight).toBe(1)
    runner.release(ok())
    await flush()
  })

  it('a failed invite run does not climb the knock ladder — the invite stays pending server-side', async () => {
    const clock = new FakeClock()
    const runner = new FakeRunner(() => failed())
    const inv = invoker(clock, runner)
    inv.invite(invite('gri_2'))
    await flush()
    await inv.settled()
    expect(inv.counters()).toMatchObject({ runsFailed: 1, retryRung: 0, retryDueAt: null })
  })
})
