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

/**
 * The wire's tray count, faked: `GET /v1/inbox?wait_ms=0&limit=1` answering
 * waiting / empty, or failing (network, 5xx). Counts how often it was asked.
 */
class FakeTray {
  calls = 0
  constructor(public answer: boolean | Error = true) {}
  readonly hasWaiting = async (): Promise<boolean> => {
    this.calls += 1
    if (this.answer instanceof Error) throw this.answer
    return this.answer
  }
}

function invoker(clock: FakeClock, runner: FakeRunner, ladder: readonly number[] = RETRY_LADDER_MS, tray?: FakeTray) {
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
    ...(tray ? { trayHasWaiting: tray.hasWaiting } : {}),
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

describe('DoorbellInvoker — stop interrupts, preflight watch after an exhausted ladder', () => {
  it('stop aborts the run in flight; settled resolves once it has ended; nothing is rescheduled', async () => {
    const clock = new FakeClock()
    const runner = new FakeRunner(
      (request) =>
        new Promise<RunOutcome>((resolve) => {
          request.signal?.addEventListener('abort', () => resolve({ state: 'failed', exitCode: null, durationMs: 1, detail: 'interrupted' }), { once: true })
        }),
    )
    const inv = invoker(clock, runner)
    inv.knock('message')
    await clock.advanceAsync(2_000)
    await flush()
    expect(runner.inFlight).toBe(1)
    inv.stop()
    await inv.settled()
    expect(runner.requests[0]!.signal?.aborted).toBe(true)
    expect(runner.inFlight).toBe(0)
    expect(inv.counters().runsFailed).toBe(1)
    expect(clock.pending()).toBe(0) // no retry: stopped
  })

  it('after the ladder is exhausted, a runtime that was down and comes back earns ONE re-knock', async () => {
    const clock = new FakeClock()
    let preflightOk = false
    let mode: 'down' | 'ok' = 'down'
    const runner = new FakeRunner(() => (mode === 'down' ? notStarted() : ok()))
    runner.preflight = async () => ({ ok: preflightOk })
    const inv = new DoorbellInvoker({
      runner,
      prompts: PROMPTS,
      budgetMs: 600_000,
      debounceMs: 2_000,
      retryLadderMs: [1_000, 2_000, 3_000],
      preflightWatchMs: 10_000,
      now: () => clock.now(),
      setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
      clearTimeout: (h) => clock.clearTimeout(h),
    })
    inv.knock('message')
    await clock.advanceAsync(2_000)
    await inv.settled() // run 1 → rung 1
    await clock.advanceAsync(1_000 + 2_000)
    await inv.settled() // run 2 → rung 2
    await clock.advanceAsync(2_000 + 2_000)
    await inv.settled() // run 3 → rung 3
    await clock.advanceAsync(3_000 + 2_000)
    await inv.settled() // run 4 → exhausted; the watch is armed
    expect(runner.requests).toHaveLength(4)
    expect(inv.counters().retryRung).toBe(3)
    expect(clock.pending()).toBe(1)

    // First probe: still down. Keep watching, no run.
    await clock.advanceAsync(10_000)
    await flush()
    expect(runner.requests).toHaveLength(4)
    expect(clock.pending()).toBe(1)

    // The user signs back in.
    preflightOk = true
    mode = 'ok'
    await clock.advanceAsync(10_000)
    await flush()
    await clock.advanceAsync(2_000) // the re-knock coalesces like any other
    await inv.settled()
    expect(runner.requests).toHaveLength(5)
    expect(inv.counters().runsOk).toBe(1)
    expect(inv.counters().retryRung).toBe(0)
    expect(clock.pending()).toBe(0) // success ends the watch
  })

  it('when preflight was already ok, an exhausted ladder waits for the next knock — no re-knock, no endless probing', async () => {
    const clock = new FakeClock()
    const runner = new FakeRunner(() => failed())
    const inv = new DoorbellInvoker({
      runner,
      prompts: PROMPTS,
      budgetMs: 600_000,
      debounceMs: 2_000,
      retryLadderMs: [1_000],
      preflightWatchMs: 10_000,
      now: () => clock.now(),
      setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
      clearTimeout: (h) => clock.clearTimeout(h),
    })
    inv.knock('message')
    await clock.advanceAsync(2_000)
    await inv.settled()
    await clock.advanceAsync(1_000 + 2_000)
    await inv.settled() // exhausted
    expect(runner.requests).toHaveLength(2)
    expect(clock.pending()).toBe(1)
    await clock.advanceAsync(10_000)
    await flush()
    expect(runner.requests).toHaveLength(2)
    expect(clock.pending()).toBe(0) // the watch stopped: the failures were not readiness
    // A peer's knock still runs as always.
    inv.knock('message')
    await clock.advanceAsync(2_000)
    await inv.settled()
    expect(runner.requests).toHaveLength(3)
  })
})

describe('DoorbellInvoker — the tray count before every knock run (E1)', () => {
  it('a deferred-only tray plus the drain knocks → zero runs: one count, nothing owed', async () => {
    // Connect knock + the server's drain re-offering a deferred envelope as
    // message.new: the tray hides the deferred card, so nothing is waiting.
    const clock = new FakeClock()
    const runner = new FakeRunner()
    const tray = new FakeTray(false)
    const inv = invoker(clock, runner, RETRY_LADDER_MS, tray)
    inv.knock('connect')
    inv.knock('message')
    inv.knock('message')
    await clock.advanceAsync(2_000)
    await inv.settled()
    expect(runner.requests).toHaveLength(0)
    expect(tray.calls).toBe(1)
    expect(inv.counters()).toMatchObject({ knocks: 3, absorbed: 2, runsStarted: 0, runsSkippedEmpty: 1, retryRung: 0 })

    // The next reconnect drains the same deferred envelope again: still no run.
    inv.knock('connect')
    inv.knock('message')
    await clock.advanceAsync(2_000)
    await inv.settled()
    expect(runner.requests).toHaveLength(0)
    expect(inv.counters().runsSkippedEmpty).toBe(2)
  })

  it('a live message (the tray has a card) → exactly one run', async () => {
    const clock = new FakeClock()
    const runner = new FakeRunner()
    const tray = new FakeTray(true)
    const inv = invoker(clock, runner, RETRY_LADDER_MS, tray)
    inv.knock('message')
    await clock.advanceAsync(2_000)
    await inv.settled()
    expect(tray.calls).toBe(1)
    expect(runner.requests).toHaveLength(1)
    expect(runner.requests[0]).toMatchObject({ kind: 'knock', prompt: 'KNOCK PROMPT' })
    expect(inv.counters()).toMatchObject({ runsStarted: 1, runsOk: 1, runsSkippedEmpty: 0 })
  })

  it('a count that fails (network, 5xx) starts the run anyway — a failed count is not an empty tray', async () => {
    const clock = new FakeClock()
    const runner = new FakeRunner()
    const tray = new FakeTray(new Error('AgentChat API 503: upstream unavailable'))
    const inv = invoker(clock, runner, RETRY_LADDER_MS, tray)
    inv.knock('message')
    await clock.advanceAsync(2_000)
    await inv.settled()
    expect(tray.calls).toBe(1)
    expect(runner.requests).toHaveLength(1)
    expect(inv.counters()).toMatchObject({ runsStarted: 1, runsSkippedEmpty: 0 })
  })

  it('the burst follow-on finds the tray empty → no second run', async () => {
    // Live-fire leg 3 at 1.2 s spacing: the third knock lands mid-run and
    // earns one follow-on; the first run already answered everything.
    const clock = new FakeClock()
    const runner = new FakeRunner()
    runner['script'] = runner.holding()
    const tray = new FakeTray(true)
    const inv = invoker(clock, runner, RETRY_LADDER_MS, tray)
    inv.knock('message')
    inv.knock('message')
    await clock.advanceAsync(2_000)
    expect(runner.requests).toHaveLength(1)
    inv.knock('message') // mid-run
    await clock.advanceAsync(2_000)
    tray.answer = false // the run replied to all three
    runner.release(ok())
    await flush()
    await inv.settled()
    expect(tray.calls).toBe(2)
    expect(runner.requests).toHaveLength(1)
    expect(runner.maxInFlight).toBe(1)
    expect(inv.counters()).toMatchObject({ runsStarted: 1, runsOk: 1, runsSkippedEmpty: 1 })
  })

  it('the ladder re-knock finds the tray empty → no run, and the rung is reset', async () => {
    const clock = new FakeClock()
    const runner = new FakeRunner(() => failed())
    const tray = new FakeTray(true)
    const inv = invoker(clock, runner, RETRY_LADDER_MS, tray)
    inv.knock('message')
    await clock.advanceAsync(2_000)
    await inv.settled()
    expect(inv.counters()).toMatchObject({ runsFailed: 1, retryRung: 1, retryDueAt: 62_000 })

    // Before the re-knock lands, the agent's own session settled the card.
    tray.answer = false
    await clock.advanceAsync(60_000) // the delayed knock
    await clock.advanceAsync(2_000) // its debounce
    await inv.settled()
    expect(runner.requests).toHaveLength(1)
    expect(inv.counters()).toMatchObject({ runsSkippedEmpty: 1, retryRung: 0, retryDueAt: null })
    expect(clock.pending()).toBe(0) // nothing left scheduled: nothing is owed

    // A later failure starts the ladder from its first rung again.
    tray.answer = true
    inv.knock('message')
    await clock.advanceAsync(2_000)
    await inv.settled()
    expect(inv.counters()).toMatchObject({ runsFailed: 2, retryRung: 1 })
    expect(inv.counters().retryDueAt).toBe(clock.now() + 60_000)
  })

  it('an empty count while a re-knock is pending cancels it and ends the preflight watch', async () => {
    const clock = new FakeClock()
    const runner = new FakeRunner(() => failed())
    const tray = new FakeTray(true)
    const inv = invoker(clock, runner, RETRY_LADDER_MS, tray)
    inv.knock('message')
    await clock.advanceAsync(2_000)
    await inv.settled()
    expect(inv.counters().retryDueAt).toBe(62_000)
    tray.answer = false
    inv.knock('message') // a frame for something already settled
    await clock.advanceAsync(2_000)
    await inv.settled()
    expect(inv.counters()).toMatchObject({ runsSkippedEmpty: 1, retryRung: 0, retryDueAt: null })
    await clock.advanceAsync(10 * 60_000)
    expect(runner.requests).toHaveLength(1)
    expect(tray.calls).toBe(2)
  })

  it('invite runs are not counted against the tray', async () => {
    const clock = new FakeClock()
    const runner = new FakeRunner()
    const tray = new FakeTray(false)
    const inv = invoker(clock, runner, RETRY_LADDER_MS, tray)
    inv.invite({ inviteId: 'gri_9', groupId: 'grp_9', groupName: 'Ops', inviterHandle: 'alice' })
    await flush()
    await inv.settled()
    expect(runner.requests).toHaveLength(1)
    expect(runner.requests[0]?.kind).toBe('invite')
    expect(tray.calls).toBe(0)
  })

  it('stop() while the count is in flight starts no run', async () => {
    const clock = new FakeClock()
    const runner = new FakeRunner()
    let answer: (v: boolean) => void = () => undefined
    const inv = new DoorbellInvoker({
      runner,
      prompts: PROMPTS,
      budgetMs: 600_000,
      debounceMs: 2_000,
      now: () => clock.now(),
      setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
      clearTimeout: (h) => clock.clearTimeout(h),
      trayHasWaiting: () => new Promise<boolean>((resolve) => (answer = resolve)),
    })
    inv.knock('message')
    await clock.advanceAsync(2_000)
    inv.stop()
    answer(true)
    await inv.settled()
    expect(runner.requests).toHaveLength(0)
  })
})

describe('DoorbellInvoker — a successful run cancels a pending re-knock (E2)', () => {
  it('failure → re-knock pending → a knock runs ok → past the rung, no extra run', async () => {
    // Codex live-fire leg 10: rung 2 was due in 300 s; a new DM ran ok and the
    // rung went to 0, but the stale re-knock still fired 4.5 min later.
    const clock = new FakeClock()
    const outcomes = [failed(), ok()]
    const runner = new FakeRunner(() => outcomes.shift() ?? ok())
    const inv = invoker(clock, runner)
    inv.knock('message')
    await clock.advanceAsync(2_000)
    await inv.settled()
    expect(inv.counters()).toMatchObject({ retryRung: 1, retryDueAt: 62_000 })

    await clock.advanceAsync(10_000)
    inv.knock('message') // a new DM, mid-outage
    await clock.advanceAsync(2_000)
    await inv.settled()
    expect(runner.requests).toHaveLength(2)
    expect(inv.counters()).toMatchObject({ runsOk: 1, retryRung: 0, retryDueAt: null })

    await clock.advanceAsync(10 * 60_000) // well past the 60 s rung
    await inv.settled()
    expect(runner.requests).toHaveLength(2)
    expect(clock.pending()).toBe(0)
  })

  it('an ok INVITE run leaves a pending knock re-knock alone — it never read the tray', async () => {
    const clock = new FakeClock()
    const outcomes = [failed(), ok(), ok()]
    const runner = new FakeRunner(() => outcomes.shift() ?? ok())
    const inv = invoker(clock, runner)
    inv.knock('message')
    await clock.advanceAsync(2_000)
    await inv.settled()
    expect(inv.counters()).toMatchObject({ retryRung: 1, retryDueAt: 62_000 })
    inv.invite({ inviteId: 'gri_1', groupId: 'grp_1', groupName: 'Ops', inviterHandle: 'alice' })
    await flush()
    await inv.settled()
    expect(inv.counters()).toMatchObject({ runsOk: 1, retryRung: 1, retryDueAt: 62_000 })
    await clock.advanceAsync(60_000)
    await clock.advanceAsync(2_000)
    await inv.settled()
    expect(runner.requests.map((r) => r.kind)).toEqual(['knock', 'invite', 'knock'])
  })
})
