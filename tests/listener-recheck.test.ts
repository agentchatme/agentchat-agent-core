import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import type { integration as kit, ListenerReasonKind, ListenerState } from 'agentchatme'
import { Integration } from '../src/integration/integration.js'
import { runIntegration } from '../src/integration/run.js'
import { RecheckSchedule, RUNS_FAILING_RECHECK_MS, type RecheckTimerHandle, type RecheckTimers } from '../src/integration/failing-recheck.js'
import { listenerIdPath, readListenerInstanceId, type ListenerReportSink, type ListenerReportTiming } from '../src/integration/listener-report.js'
import { readIntegrationStatus } from '../src/integration/status.js'
import { acquireAgentLock, agentLockPath } from '../src/daemon/agent-lock.js'
import type { RunOutcome, RunPreflight, RunPreflightOptions, RunRequest, RunRunner } from '../src/integration/runner.js'
import { pause, startServerDouble, until, type ListenerReportPut, type ServerDouble } from './helpers/server-double.js'

// ─── The listener report: runs_failing re-checked, and the off switch ───────
//
//   1  the clock: 30 min, 1 h, 2 h, then every 4 h; measured from when a
//      re-check ended, so a late timer is one re-check, never a burst
//   2  while the report says runs_failing, the integration looks again: the
//      start preflight first (no model call); then, only when the runtime
//      check is what failed, that check once; passing → ok, and it stops.
//      Never while a run is under way; never after a stop or once the
//      supervisor stopped the reporter
//   3  the supervisor: a lost lock, a hand-over and SIGTERM end it
//   4  AGENTCHAT_INTEGRATION=off: one `stopped` at start, under the home's id
//      and key; none without an id, for an exported key, or as a standby;
//      never again in the same process, never on SIGTERM

const CLIENT = { runtime: 'generic' as const, version: '0.0.0-test' }
const KEY = 'ac_' + 'k'.repeat(40)
const MIN = 60_000
const HOUR = 60 * MIN
const SIGNED_OUT = 'claude is not signed in (run `claude` once and sign in)'
const OK_RUN: RunOutcome = { state: 'ok', exitCode: 0, durationMs: 1 }
const FAILED_RUN: RunOutcome = { state: 'failed', exitCode: 1, durationMs: 1, detail: 'exit 1: API Error: usage limit reached' }
const USAGE_LIMIT: RunPreflight = { ok: false, detail: 'scripted: usage limit reached' }

let sandbox: string
let double: ServerDouble | null
beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-listener-recheck-'))
  double = null
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await double?.close()
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

/** Let promise callbacks and I/O callbacks run. */
async function flush(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r))
}

/**
 * The re-check's clock, by hand. `advance(ms)` moves it at once (a machine
 * that slept, a clock that jumped, or just time passing in a test) and fires
 * every timer due by then, each after the previous one's work settled — so a
 * schedule that armed its next re-check from the missed due time would fire
 * again here, in a burst.
 */
class FakeTimers implements RecheckTimers {
  now = 0
  private seq = 0
  private readonly timers = new Map<number, { due: number; ms: number; fn: () => void }>()
  /** Every wait ever armed, in order. */
  readonly history: number[] = []
  setTimeout(fn: () => void, ms: number): RecheckTimerHandle {
    const id = ++this.seq
    this.history.push(ms)
    this.timers.set(id, { due: this.now + ms, ms, fn })
    return id as unknown as RecheckTimerHandle
  }
  clearTimeout(handle: RecheckTimerHandle): void {
    this.timers.delete(handle as unknown as number)
  }
  /** The waits armed now. */
  get armed(): number[] {
    return [...this.timers.values()].map((t) => t.ms)
  }
  /** Returns how many timers fired. */
  async advance(ms: number, settle: () => Promise<void> = () => flush()): Promise<number> {
    this.now += ms
    let fired = 0
    for (;;) {
      let next: [number, { due: number; fn: () => void }] | null = null
      for (const entry of this.timers) if (entry[1].due <= this.now && (next === null || entry[1].due < next[1].due)) next = entry
      if (next === null) break
      this.timers.delete(next[0])
      fired += 1
      next[1].fn()
      await settle()
    }
    return fired
  }
}

/** What `set()` was told, in order, as the kit's reporter would hold it (no sends); `stopped` as the supervisor's `dropListener` leaves it. */
class FakeSink implements ListenerReportSink {
  readonly calls: Array<{ state: ListenerState; reasonKind: ListenerReasonKind | null }> = []
  private current: { state: ListenerState; reasonKind: ListenerReasonKind | null } | null = null
  stopped = false
  set(state: ListenerState, reasonKind?: ListenerReasonKind): void {
    if (this.stopped) return
    const entry = { state, reasonKind: state === 'ok' || state === 'stopped' ? null : (reasonKind ?? 'other') }
    this.calls.push(entry)
    this.current = entry
  }
  status(): kit.ListenerReporterStatus {
    return {
      instanceId: 'test-instance-0001',
      state: this.current?.state ?? null,
      reasonKind: this.current?.reasonKind ?? null,
      reported: null,
      pending: this.current !== null,
      failures: 0,
      lastError: null,
      nextAttemptAt: null,
      stopped: this.stopped,
    }
  }
  get now(): string | null {
    return this.current === null ? null : this.current.reasonKind === null ? this.current.state : `${this.current.state}/${this.current.reasonKind}`
  }
  get changes(): string[] {
    const out: string[] = []
    for (const c of this.calls) {
      const word = c.reasonKind === null ? c.state : `${c.state}/${c.reasonKind}`
      if (out[out.length - 1] !== word) out.push(word)
    }
    return out
  }
}

/** A runtime whose preflight, runs and model check are scripted and counted; a run can be held open. */
class Runner implements RunRunner {
  readonly name = 'claude'
  preflights = 0
  starts = 0
  checks = 0
  /** Model checks whose signal aborted before they answered. */
  checkAborts = 0
  pre: RunPreflight = { ok: true }
  /** `hang`: answers only when its signal aborts. */
  check: RunPreflight | 'hang' = USAGE_LIMIT
  outcome: RunOutcome = OK_RUN
  readonly endings = new Map<string, RunOutcome>()
  /** While true, a run stays open until `finish()` (or its stop). */
  hold = false
  private open: ((outcome: RunOutcome) => void) | null = null
  private heldPreflight: ((answer: RunPreflight) => void) | null = null
  private holdPreflight = false
  /** The next preflight stays open until the returned function answers it. */
  holdNextPreflight(): (answer: RunPreflight) => void {
    this.holdPreflight = true
    return (answer) => {
      this.holdPreflight = false
      const held = this.heldPreflight
      this.heldPreflight = null
      held?.(answer)
    }
  }
  /** A held preflight has been asked and not answered yet. */
  get preflightOpen(): boolean {
    return this.heldPreflight !== null
  }
  async preflight(): Promise<RunPreflight> {
    this.preflights += 1
    if (this.holdPreflight && this.heldPreflight === null) return new Promise<RunPreflight>((resolve) => (this.heldPreflight = resolve))
    return this.pre
  }
  async start(request: RunRequest): Promise<RunOutcome> {
    this.starts += 1
    const ending = (request.conversationId !== undefined ? this.endings.get(request.conversationId) : undefined) ?? this.outcome
    if (!this.hold) return ending
    return new Promise<RunOutcome>((resolve) => {
      this.open = resolve
      request.signal.addEventListener('abort', () => resolve({ state: 'failed', exitCode: null, durationMs: 1, detail: 'stopped' }), { once: true })
    })
  }
  get running(): boolean {
    return this.open !== null
  }
  finish(outcome: RunOutcome): void {
    const open = this.open
    this.open = null
    open?.(outcome)
  }
  async checkRuntime(options: RunPreflightOptions = {}): Promise<RunPreflight> {
    this.checks += 1
    const check = this.check
    if (check !== 'hang') return check
    return new Promise<RunPreflight>((resolve) =>
      options.signal?.addEventListener(
        'abort',
        () => {
          this.checkAborts += 1
          resolve({ ok: false, detail: 'stopped' })
        },
        { once: true },
      ),
    )
  }
}

const wake = (id: string, conversationId = 'conv_0'): void =>
  double!.send({ type: 'message.new', payload: { id, conversation_id: conversationId, sender: 'peer', content: { text: 'x' } } })

// ─── 1. the clock ───────────────────────────────────────────────────────────

describe('RecheckSchedule: a growing gap, measured from when a re-check ended', () => {
  it('30 min, 1 h, 2 h, then every 4 h', () => {
    expect(RUNS_FAILING_RECHECK_MS).toEqual([30 * MIN, HOUR, 2 * HOUR, 4 * HOUR])
  })

  it('the ladder, the last gap repeating; stop clears it; a new episode starts from the first gap', async () => {
    const timers = new FakeTimers()
    const at: number[] = []
    const s = new RecheckSchedule({ timers, gapsMs: [10, 20, 40], recheck: async () => void at.push(timers.now) })
    expect(s.start()).toBe(true)
    expect(s.start()).toBe(false) // one under way keeps its place
    expect(timers.armed).toEqual([10])
    for (const step of [10, 20, 40, 40, 40]) expect(await timers.advance(step)).toBe(1)
    expect(at).toEqual([10, 30, 70, 110, 150])
    s.stop()
    expect(timers.armed).toEqual([])
    expect(await timers.advance(1_000)).toBe(0)
    s.start()
    expect(timers.armed).toEqual([10])
  })

  it('a timer that fires 10 h late is one re-check, not the ones it missed', async () => {
    const timers = new FakeTimers()
    let count = 0
    const s = new RecheckSchedule({ timers, recheck: async () => void (count += 1) })
    s.start()
    expect(await timers.advance(10 * HOUR)).toBe(1)
    expect(count).toBe(1)
    expect(timers.armed).toEqual([HOUR])
  })

  it('a stop while a re-check is under way: nothing armed after it; a new episode meanwhile keeps its own one timer', async () => {
    const timers = new FakeTimers()
    let release: (() => void) | null = null
    const episodes: number[] = []
    const s = new RecheckSchedule({
      timers,
      gapsMs: [10, 20],
      recheck: (episode) => {
        episodes.push(episode)
        return new Promise<void>((r) => (release = r))
      },
    })
    s.start()
    await timers.advance(10)
    expect(timers.armed).toEqual([]) // nothing armed while one is under way
    const first = episodes[0] as number
    s.stop()
    expect(s.current(first)).toBe(false)
    s.start()
    expect(timers.armed).toEqual([10])
    release!()
    await s.done()
    await flush()
    expect(timers.armed).toEqual([10]) // the stale one armed nothing
  })

  it('a re-check that throws does not end the schedule; gaps must be positive', async () => {
    const timers = new FakeTimers()
    const s = new RecheckSchedule({ timers, gapsMs: [10], recheck: async () => Promise.reject(new Error('bug')) })
    s.start()
    expect(await timers.advance(10)).toBe(1)
    expect(timers.armed).toEqual([10])
    expect(() => new RecheckSchedule({ recheck: async () => {}, gapsMs: [] })).toThrow(TypeError)
    expect(() => new RecheckSchedule({ recheck: async () => {}, gapsMs: [10, 0] })).toThrow(TypeError)
  })
})

// ─── 2. the integration re-checks while runs fail ───────────────────────────

describe('while the report says runs_failing, the integration looks again', () => {
  let home: string
  let integrations: Integration[]
  beforeEach(() => {
    home = path.join(sandbox, 'home')
    fs.mkdirSync(home, { recursive: true })
    integrations = []
  })
  afterEach(async () => {
    for (const i of integrations) await i.stopAndWait(5_000)
  })
  const build = (runner: RunRunner, sink: FakeSink, timers: FakeTimers, extra: Partial<ConstructorParameters<typeof Integration>[0]> = {}): Integration => {
    const i = new Integration({
      cfg: { apiKey: KEY, handle: 'me', apiBase: double!.apiBase, wsBase: double!.wsBase, home, workdir: path.join(home, 'w') },
      runner,
      client: CLIENT,
      manualPointer: '(POINTER)',
      profile: 'answer',
      budgetMs: 60_000,
      quietMs: 50,
      maxMs: 200,
      // A conversation whose run completed may run again at the next wake (the kit paces it 60 s otherwise).
      paceMs: 1,
      runtimeRecheckMs: 0,
      listenerReport: sink,
      recheckTimers: timers,
      ...extra,
    })
    integrations.push(i)
    return i
  }
  /** A re-check's work, settled. */
  const settled = (i: Integration) => async (): Promise<void> => {
    await i.runsFailingRecheckDone()
    await flush()
  }

  /** Connected; conv_0's run failed and so did the runtime check (a usage limit): runs_failing (runtime_check_failed). */
  const usageLimited = async (extra: Partial<ConstructorParameters<typeof Integration>[0]> = {}): Promise<{ i: Integration; runner: Runner; sink: FakeSink; timers: FakeTimers }> => {
    double = await startServerDouble({ tray: { waiting: 1 }, conversationRunTemplate: 'RUN <conversation_id>' })
    const sink = new FakeSink()
    const runner = new Runner()
    runner.endings.set('conv_0', FAILED_RUN)
    const timers = new FakeTimers()
    const i = build(runner, sink, timers, extra)
    await i.start()
    await until(() => sink.now === 'runs_failing/runtime_check_failed', 5_000)
    await i.idle()
    await i.runtimeCheckDone()
    await flush()
    expect(runner.checks).toBe(1) // the kit's own check after the failed run
    expect(timers.armed).toEqual([30 * MIN])
    return { i, runner, sink, timers }
  }

  it('runtime_check_failed: at 30 min the preflight passes and the runtime check (one model call) passes → ok, and the schedule stops; health() never changed', async () => {
    const { i, runner, sink, timers } = await usageLimited()
    expect(i.health()).toEqual({ ok: true })
    const preflights = runner.preflights
    runner.check = { ok: true } // the limit reset
    expect(await timers.advance(29 * MIN, settled(i))).toBe(0)
    expect(await timers.advance(1 * MIN, settled(i))).toBe(1)
    expect(sink.now).toBe('ok')
    expect(runner.checks).toBe(2)
    expect(runner.preflights).toBe(preflights + 1)
    expect(timers.armed).toEqual([])
    expect(sink.changes).toEqual(['ok', 'runs_failing/runtime_check_failed', 'ok'])
    expect(i.health()).toEqual({ ok: true })
    expect(runner.starts).toBe(1) // a re-check starts no run
  }, 20_000)

  it('a runtime check that keeps failing: one model call per re-check, at +30 min, +1 h, +2 h, then every 4 h; the report stays', async () => {
    const { i, runner, sink, timers } = await usageLimited()
    let checks = runner.checks
    for (const [gap, next] of [
      [30 * MIN, HOUR],
      [HOUR, 2 * HOUR],
      [2 * HOUR, 4 * HOUR],
      [4 * HOUR, 4 * HOUR],
      [4 * HOUR, 4 * HOUR],
    ] as const) {
      expect(await timers.advance(gap, settled(i))).toBe(1)
      checks += 1
      expect(runner.checks).toBe(checks)
      expect(timers.armed).toEqual([next])
      expect(sink.now).toBe('runs_failing/runtime_check_failed')
    }
    expect(sink.changes).toEqual(['ok', 'runs_failing/runtime_check_failed'])
    expect(i.health()).toEqual({ ok: true })
  }, 20_000)

  it('the clock jumps 10 h: one re-check (one model call), not the four it missed', async () => {
    const { i, runner, timers } = await usageLimited()
    expect(await timers.advance(10 * HOUR, settled(i))).toBe(1)
    expect(runner.checks).toBe(2)
    expect(timers.armed).toEqual([HOUR])
  }, 20_000)

  it('runs_failing from the preflight (signed out): signed in again, the 30-min re-check passes the preflight → ok with no model call; health() as before', async () => {
    double = await startServerDouble({ tray: { waiting: 1 } })
    const sink = new FakeSink()
    const runner = new Runner()
    runner.check = { ok: true } // asked, it would pass: it must not be asked
    const timers = new FakeTimers()
    const i = build(runner, sink, timers)
    await i.start()
    await until(() => runner.starts === 1 && sink.now === 'ok', 5_000)
    runner.outcome = { state: 'not_started', exitCode: 1, durationMs: 1, detail: 'Not logged in' }
    runner.pre = { ok: false, detail: SIGNED_OUT }
    wake('m1')
    await until(() => runner.starts === 2, 5_000)
    await i.runtimeCheckDone()
    await i.idle()
    expect(sink.now).toBe('runs_failing/not_signed_in')
    expect(timers.armed).toEqual([30 * MIN])
    // Still signed out at 30 min: it stays, with the reason the preflight gives now.
    runner.pre = { ok: false, detail: 'claude CLI not found on PATH (spawn claude ENOENT)' }
    expect(await timers.advance(30 * MIN, settled(i))).toBe(1)
    expect(sink.now).toBe('runs_failing/runtime_missing')
    expect(timers.armed).toEqual([HOUR])
    // Back: the next re-check passes the preflight → ok, without a model call.
    runner.pre = { ok: true }
    expect(await timers.advance(HOUR, settled(i))).toBe(1)
    expect(sink.now).toBe('ok')
    expect(runner.checks).toBe(0)
    expect(timers.armed).toEqual([])
    expect(sink.changes).toEqual(['ok', 'runs_failing/not_signed_in', 'runs_failing/runtime_missing', 'ok'])
    // health() is not the re-check's: it still gives the agent up to a waiting standby until a run completes.
    expect(i.health()).toMatchObject({ ok: false })
    expect(i.snapshot().runs_failing?.reason).toMatch(/checks out now, but runs still fail/)
    expect(runner.starts).toBe(2)
  }, 20_000)

  it('runtime_check_failed, then the preflight fails at a re-check: the reason follows it with no model call; once the preflight passes again, the runtime check is asked', async () => {
    const { i, runner, sink, timers } = await usageLimited()
    runner.pre = { ok: false, detail: SIGNED_OUT }
    expect(await timers.advance(30 * MIN, settled(i))).toBe(1)
    expect(sink.now).toBe('runs_failing/not_signed_in')
    expect(runner.checks).toBe(1)
    expect(i.health()).toEqual({ ok: true }) // no hand-over for it
    runner.pre = { ok: true }
    runner.check = { ok: true }
    expect(await timers.advance(HOUR, settled(i))).toBe(1)
    expect(runner.checks).toBe(2)
    expect(sink.now).toBe('ok')
    expect(timers.armed).toEqual([])
  }, 20_000)

  it('no model call while a run is under way: that re-check is skipped and the schedule kept; the run that completes → ok, and it stops', async () => {
    const { i, runner, sink, timers } = await usageLimited()
    runner.hold = true
    runner.endings.set('conv_0', OK_RUN)
    const preflights = runner.preflights
    wake('m1')
    await until(() => runner.running, 5_000)
    expect(await timers.advance(30 * MIN, settled(i))).toBe(1)
    expect(runner.checks).toBe(1)
    expect(runner.preflights).toBe(preflights)
    expect(timers.armed).toEqual([HOUR])
    expect(sink.now).toBe('runs_failing/runtime_check_failed')
    runner.finish(OK_RUN)
    await until(() => sink.now === 'ok', 5_000)
    expect(timers.armed).toEqual([])
    expect(await timers.advance(10 * HOUR, settled(i))).toBe(0)
    expect(runner.checks).toBe(1)
  }, 20_000)

  it('a run that starts while the re-check\'s model call is out stops that call; the cut call says nothing, and the run decides', async () => {
    const { i, runner, sink, timers } = await usageLimited()
    runner.check = 'hang'
    expect(await timers.advance(30 * MIN)).toBe(1)
    await until(() => runner.checks === 2, 5_000)
    runner.hold = true
    wake('m1')
    await until(() => runner.running, 5_000)
    await until(() => runner.checkAborts === 1, 5_000)
    await i.runsFailingRecheckDone()
    expect(runner.checks).toBe(2)
    expect(sink.changes).toEqual(['ok', 'runs_failing/runtime_check_failed'])
    expect(timers.armed).toEqual([HOUR])
    runner.finish(OK_RUN)
    await until(() => sink.now === 'ok', 5_000)
    expect(timers.armed).toEqual([])
  }, 20_000)

  it('a wake waiting out its quiet window (a cycle starts within seconds): that re-check is skipped, before its preflight', async () => {
    const { i, runner, timers } = await usageLimited({ quietMs: 1_500, maxMs: 3_000 })
    const preflights = runner.preflights
    wake('m1')
    await until(() => i.snapshot().wakes >= 2, 5_000)
    expect(await timers.advance(30 * MIN, settled(i))).toBe(1)
    expect(runner.preflights).toBe(preflights)
    expect(runner.checks).toBe(1)
    expect(timers.armed).toEqual([HOUR])
  }, 20_000)

  it('the kit\'s own runtime check under way: that re-check is skipped (never two model calls at once)', async () => {
    const { i, runner, timers } = await usageLimited()
    runner.check = 'hang'
    wake('m1') // conv_0 fails again; the kit asks its own check, which stays out
    await until(() => runner.checks === 2, 5_000)
    const preflights = runner.preflights
    expect(await timers.advance(30 * MIN, settled(i))).toBe(1)
    expect(runner.checks).toBe(2)
    expect(runner.preflights).toBe(preflights)
    expect(timers.armed).toEqual([HOUR])
  }, 20_000)

  it('the kit asking its own check while the re-check\'s model call is out stops that call first: one model call at a time', async () => {
    const { i, runner, sink, timers } = await usageLimited()
    runner.check = 'hang'
    expect(await timers.advance(30 * MIN)).toBe(1)
    await until(() => runner.checks === 2, 5_000)
    runner.check = USAGE_LIMIT
    // The kit's seam (what `ReceiveLoop` calls after a failed run).
    const kitCheck = (i as unknown as { checkRuntime(): Promise<RunPreflight> }).checkRuntime()
    expect(runner.checkAborts).toBe(1)
    expect(await kitCheck).toMatchObject({ ok: false })
    expect(runner.checks).toBe(3)
    await i.runsFailingRecheckDone()
    expect(sink.now).toBe('runs_failing/runtime_check_failed')
    expect(timers.armed).toEqual([HOUR])
  }, 20_000)

  it.each([
    ['fails', FAILED_RUN, 'runs_failing/runtime_check_failed'],
    ['completes', OK_RUN, 'ok'],
  ] as const)('a run that starts (and %s) while the re-check\'s preflight is out: that older answer is dropped', async (_what, ending, after) => {
    const { i, runner, sink, timers } = await usageLimited()
    const answer = runner.holdNextPreflight()
    expect(await timers.advance(30 * MIN)).toBe(1)
    await until(() => runner.preflightOpen, 5_000)
    runner.endings.set('conv_0', ending)
    wake('m1')
    await until(() => runner.starts === 2, 5_000)
    await i.idle()
    await i.runtimeCheckDone()
    await until(() => sink.now === after, 5_000)
    const checks = runner.checks
    answer({ ok: false, detail: SIGNED_OUT }) // older than the run: it must not bring not_signed_in back
    await i.runsFailingRecheckDone()
    await flush()
    expect(sink.now).toBe(after)
    expect(runner.checks).toBe(checks)
    expect(timers.armed).toEqual(after === 'ok' ? [] : [HOUR])
  }, 20_000)

  it('a completed run ends the episode; the next failure is a new one, from 30 min again', async () => {
    const { i, runner, sink, timers } = await usageLimited()
    expect(await timers.advance(30 * MIN, settled(i))).toBe(1)
    expect(timers.armed).toEqual([HOUR])
    runner.endings.set('conv_0', OK_RUN)
    wake('m1')
    await until(() => sink.now === 'ok', 5_000)
    expect(timers.armed).toEqual([])
    await i.idle()
    runner.endings.set('conv_0', FAILED_RUN)
    wake('m2')
    await until(() => sink.now === 'runs_failing/runtime_check_failed', 5_000)
    expect(timers.armed).toEqual([30 * MIN])
  }, 20_000)

  it('a runtime check that passes by the existing path (after a failed run) ends the schedule too', async () => {
    const { i, runner, sink, timers } = await usageLimited()
    runner.check = { ok: true }
    wake('m1') // conv_0 fails again; the kit's own check now passes
    await until(() => sink.now === 'ok', 5_000)
    await i.idle()
    expect(timers.armed).toEqual([])
  }, 20_000)

  it('none after a stop: the timer goes with it', async () => {
    const { i, runner, timers } = await usageLimited()
    expect(await i.stopAndWait(5_000)).toBe(true)
    const preflights = runner.preflights
    expect(timers.armed).toEqual([])
    expect(await timers.advance(10 * HOUR)).toBe(0)
    expect(runner.checks).toBe(1)
    expect(runner.preflights).toBe(preflights)
  }, 20_000)

  it('none once the supervisor stopped the reporter (this home no longer holds the agent): the due re-check does nothing and ends the schedule', async () => {
    const { i, runner, sink, timers } = await usageLimited()
    sink.stopped = true // what the supervisor's dropListener leaves
    const preflights = runner.preflights
    expect(await timers.advance(30 * MIN, settled(i))).toBe(1)
    expect(runner.checks).toBe(1)
    expect(runner.preflights).toBe(preflights)
    expect(timers.armed).toEqual([])
  }, 20_000)
})

// ─── 3. the supervisor ──────────────────────────────────────────────────────

/** The reporter's timing for tests: the kit's rules, at test speed. */
const FAST: ListenerReportTiming = { coalesceMs: 20, minIntervalMs: 0, retryMs: 50, retryMaxMs: 200 }

const signIn = (home: string, apiBase: string): void => {
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'credentials'), JSON.stringify({ api_key: KEY, handle: 'probe', api_base: apiBase }))
}
const daemon = (home: string, runner: RunRunner, extra: Partial<Parameters<typeof runIntegration>[0]> = {}) => {
  const controller = new AbortController()
  const done = runIntegration({
    home,
    client: CLIENT,
    manualPointer: '(POINTER)',
    workdir: path.join(home, 'w'),
    env: {},
    standbyPollMs: 200,
    unservableRecheckMs: 300,
    lease: { renewMs: 100 },
    listenerReportTiming: FAST,
    runner,
    signal: controller.signal,
    ...extra,
  })
  return {
    stop: async () => {
      controller.abort()
      return done
    },
    done,
  }
}
const reportsOf = (home: string): ListenerReportPut[] => {
  const id = readListenerInstanceId(home)
  return id === null ? [] : double!.listenerReports.filter((r) => r.body.instance_id === id)
}
const states = (home: string): string[] => reportsOf(home).map((r) => (r.body.reason_kind === undefined ? String(r.body.state) : `${String(r.body.state)}/${String(r.body.reason_kind)}`))

/** A process that keeps running until killed: a live holder of a lock. */
function sleeper(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' })
}

/** A lease file as another process would have written it. */
function leaseFile(file: string, h: { pid: number; renewed_at: number; home: string }): void {
  fs.writeFileSync(file, `${h.pid}\n${JSON.stringify({ pid: h.pid, token: 'their-token', host: os.hostname(), home: h.home, acquired_at: new Date(h.renewed_at).toISOString(), renewed_at: h.renewed_at })}\n`)
}

describe('the supervisor: only the home that holds the agent re-checks', () => {
  /** A daemon whose conv_0 run fails and whose runtime check fails: runs_failing (runtime_check_failed) reported, the re-check armed. */
  const failingDaemon = async (home: string, extra: Partial<Parameters<typeof runIntegration>[0]> = {}) => {
    signIn(home, double!.apiBase)
    const runner = new Runner()
    runner.endings.set('conv_0', FAILED_RUN)
    const timers = new FakeTimers()
    const d = daemon(home, runner, { recheckTimers: timers, ...extra })
    await until(() => states(home).includes('runs_failing/runtime_check_failed'), 10_000)
    await until(() => timers.armed.length === 1, 5_000)
    expect(timers.armed).toEqual([30 * MIN])
    return { d, runner, timers }
  }

  it('a lost agent lock ends it at once: nothing armed, no model call when it would have been due', async () => {
    double = await startServerDouble({ tray: { waiting: 1 }, conversationRunTemplate: 'RUN <conversation_id>' })
    const home = path.join(sandbox, 'home')
    const { d, runner, timers } = await failingDaemon(home, { lease: { renewMs: 50 } })
    const other = sleeper()
    try {
      leaseFile(agentLockPath({ apiBase: double.apiBase, handle: 'probe' }), { pid: other.pid ?? 0, renewed_at: Date.now(), home: '/the/other/home' })
      await until(() => timers.armed.length === 0, 5_000)
      runner.check = { ok: true }
      expect(await timers.advance(10 * HOUR)).toBe(0)
      expect(runner.checks).toBe(1)
      expect(changesOf(states(home))).toEqual(['ok', 'runs_failing/runtime_check_failed'])
    } finally {
      other.kill('SIGKILL')
      await d.stop()
    }
  }, 30_000)

  it('the hand-over to a waiting standby ends it: the home that gave the agent up arms nothing more', async () => {
    double = await startServerDouble({ tray: { waiting: 1 } })
    const home1 = path.join(sandbox, 'broken-home')
    const home2 = path.join(sandbox, 'healthy-home')
    signIn(home1, double.apiBase)
    signIn(home2, double.apiBase)
    const broken = new Runner()
    const timers = new FakeTimers()
    const a = daemon(home1, broken, { runtimeRecheckMs: 50, unservableRecheckMs: 60_000, recheckTimers: timers })
    await until(() => readIntegrationStatus(home1)?.socket === 'ready', 10_000)
    const b = daemon(home2, new Runner())
    try {
      await until(() => (readIntegrationStatus(home2)?.standby ?? null) !== null, 10_000)
      broken.outcome = { state: 'not_started', exitCode: 1, durationMs: 1, detail: 'Not logged in' }
      broken.pre = { ok: false, detail: SIGNED_OUT }
      wake('m1', 'conv_1')
      await until(() => readIntegrationStatus(home2)?.socket === 'ready', 15_000)
      expect(changesOf(states(home1))).toEqual(['ok', 'runs_failing/not_signed_in'])
      expect(timers.history).toEqual([30 * MIN]) // armed while it held the agent
      expect(timers.armed).toEqual([]) // and cleared when it gave it up
      broken.pre = { ok: true }
      const preflights = broken.preflights
      expect(await timers.advance(10 * HOUR)).toBe(0)
      expect(broken.preflights).toBe(preflights)
      expect(changesOf(states(home1))).toEqual(['ok', 'runs_failing/not_signed_in'])
    } finally {
      await a.stop()
      await b.stop()
    }
  }, 40_000)

  it('SIGTERM ends it at the signal, before the loop looks: a re-check due right after does nothing, and no stopped is sent', async () => {
    double = await startServerDouble({ tray: { waiting: 1 }, conversationRunTemplate: 'RUN <conversation_id>' })
    const home = path.join(sandbox, 'home')
    signIn(home, double.apiBase)
    const runner = new Runner()
    runner.endings.set('conv_0', FAILED_RUN)
    const timers = new FakeTimers()
    const exits: number[] = []
    const done = runIntegration({ home, client: CLIENT, manualPointer: '(POINTER)', workdir: path.join(home, 'w'), env: {}, runner, listenerReportTiming: FAST, recheckTimers: timers, exit: (code) => exits.push(code) })
    await until(() => states(home).includes('runs_failing/runtime_check_failed'), 10_000)
    await until(() => timers.armed.length === 1, 5_000)
    runner.check = { ok: true }
    const preflights = runner.preflights
    process.emit('SIGTERM')
    // At once, in the same tick as the signal: the loop has not looked yet.
    expect(await timers.advance(30 * MIN)).toBe(1)
    expect(runner.checks).toBe(1)
    expect(runner.preflights).toBe(preflights)
    expect(await done).toBe(0)
    expect(exits).toEqual([0])
    expect(timers.armed).toEqual([])
    await pause(200)
    expect(states(home)).not.toContain('stopped')
    expect(changesOf(states(home))).toEqual(['ok', 'runs_failing/runtime_check_failed'])
  }, 30_000)
})

describe('the supervisor: SIGTERM with a re-check under way', () => {
  it('its preflight answers after the signal: no model call starts', async () => {
    double = await startServerDouble({ tray: { waiting: 1 }, conversationRunTemplate: 'RUN <conversation_id>' })
    const home = path.join(sandbox, 'home')
    signIn(home, double.apiBase)
    const runner = new Runner()
    runner.endings.set('conv_0', FAILED_RUN)
    const timers = new FakeTimers()
    const exits: number[] = []
    const done = runIntegration({ home, client: CLIENT, manualPointer: '(POINTER)', workdir: path.join(home, 'w'), env: {}, runner, listenerReportTiming: FAST, recheckTimers: timers, exit: (code) => exits.push(code) })
    await until(() => states(home).includes('runs_failing/runtime_check_failed'), 10_000)
    await until(() => timers.armed.length === 1, 5_000)
    await pause(300) // the recheck after the failed run is over
    runner.check = { ok: true }
    const answer = runner.holdNextPreflight()
    expect(await timers.advance(30 * MIN)).toBe(1)
    await until(() => runner.preflightOpen, 5_000)
    process.emit('SIGTERM')
    answer({ ok: true }) // in the same tick: the loop has not looked yet
    expect(await done).toBe(0)
    expect(exits).toEqual([0])
    expect(runner.checks).toBe(1)
    await pause(200)
    expect(changesOf(states(home))).toEqual(['ok', 'runs_failing/runtime_check_failed'])
  }, 30_000)
})

/** Each change, in order (a re-send of the same state is no change). */
function changesOf(list: string[]): string[] {
  return list.filter((word, i) => i === 0 || list[i - 1] !== word)
}

// ─── 4. the off switch ──────────────────────────────────────────────────────

describe('AGENTCHAT_INTEGRATION=off: AgentChat is told the listener is off on purpose, once', () => {
  const ID = 'dddddddddddddddddddddd'
  const withListenerId = (home: string): void => {
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(listenerIdPath(home), `${ID}\n`)
  }
  const stoppedReports = (): ListenerReportPut[] => double!.listenerReports.filter((r) => r.body.state === 'stopped')

  it.each([['AGENTCHAT_INTEGRATION'], ['AGENTCHAT_DOORBELL']])('%s=off with a listener id and the home\'s key: one stopped at start, under that id with that key; not again on later polls, nor after a sign-out and sign-in in the same process', async (name) => {
    double = await startServerDouble()
    const home = path.join(sandbox, 'home')
    withListenerId(home)
    signIn(home, double.apiBase)
    const runner = new Runner()
    const d = daemon(home, runner, { env: { [name]: 'off' }, pollMs: 50, tickMs: 10 })
    try {
      await until(() => double!.listenerReports.length === 1, 5_000)
      expect(double.listenerReports.map((r) => r.body)).toEqual([{ instance_id: ID, state: 'stopped' }])
      expect(double.listenerReports[0]?.apiKey).toBe(KEY)
      await pause(500) // many polls
      fs.rmSync(path.join(home, 'credentials'))
      await until(() => readIntegrationStatus(home)?.handle === null, 5_000)
      signIn(home, double.apiBase)
      await until(() => readIntegrationStatus(home)?.handle === 'probe', 5_000)
      await pause(300)
      expect(double.listenerReports).toHaveLength(1)
      // Switched off: no socket, no run, no lock, no reporter.
      expect(double.upgrades).toBe(0)
      expect(runner.starts).toBe(0)
      expect(readIntegrationStatus(home)).toMatchObject({ socket: 'off', listener_report: null })
    } finally {
      await d.stop()
    }
  }, 20_000)

  it('no listener id in the home (AgentChat never knew this listener): nothing is sent, and none is made', async () => {
    double = await startServerDouble()
    const home = path.join(sandbox, 'home')
    signIn(home, double.apiBase)
    const d = daemon(home, new Runner(), { env: { AGENTCHAT_INTEGRATION: 'off' }, pollMs: 50, tickMs: 10 })
    try {
      await until(() => readIntegrationStatus(home)?.socket === 'off', 5_000)
      await pause(400)
      expect(double.listenerReports).toHaveLength(0)
      expect(fs.existsSync(listenerIdPath(home))).toBe(false)
    } finally {
      await d.stop()
    }
  }, 20_000)

  it('an exported key the home does not hold: nothing is sent, even with a listener id there', async () => {
    double = await startServerDouble()
    const home = path.join(sandbox, 'home')
    withListenerId(home)
    vi.stubEnv('AGENTCHAT_API_KEY', KEY)
    vi.stubEnv('AGENTCHAT_API_BASE', double.apiBase)
    const d = daemon(home, new Runner(), { env: { AGENTCHAT_INTEGRATION: 'off' }, pollMs: 50, tickMs: 10 })
    try {
      await until(() => readIntegrationStatus(home)?.socket === 'off', 5_000)
      await pause(400)
      expect(double.listenerReports).toHaveLength(0)
    } finally {
      await d.stop()
    }
  }, 20_000)

  it('another live home holds the agent (this one would be a standby): nothing is sent', async () => {
    double = await startServerDouble()
    const home = path.join(sandbox, 'home')
    withListenerId(home)
    signIn(home, double.apiBase)
    const other = await acquireAgentLock({ apiBase: double.apiBase, handle: 'probe', home: path.join(sandbox, 'other-home') })
    expect(other.ok).toBe(true)
    const d = daemon(home, new Runner(), { env: { AGENTCHAT_INTEGRATION: 'off' }, pollMs: 50, tickMs: 10 })
    try {
      await until(() => readIntegrationStatus(home)?.socket === 'off', 5_000)
      await pause(400)
      expect(double.listenerReports).toHaveLength(0)
    } finally {
      await d.stop()
      if (other.ok) other.lease.release()
    }
  }, 20_000)

  it('SIGTERM sends nothing: the one stopped is the start\'s, never the shutdown\'s', async () => {
    double = await startServerDouble()
    const home = path.join(sandbox, 'home')
    withListenerId(home)
    signIn(home, double.apiBase)
    const exits: number[] = []
    const done = runIntegration({ home, client: CLIENT, manualPointer: '(POINTER)', workdir: path.join(home, 'w'), env: { AGENTCHAT_INTEGRATION: 'off' }, runner: new Runner(), pollMs: 50, tickMs: 10, exit: (code) => exits.push(code) })
    await until(() => stoppedReports().length === 1, 5_000)
    process.emit('SIGTERM')
    expect(await done).toBe(0)
    expect(exits).toEqual([0])
    await pause(300)
    expect(stoppedReports()).toHaveLength(1)
  }, 20_000)

  it('signed in only after the start, still switched off: told once then', async () => {
    double = await startServerDouble()
    const home = path.join(sandbox, 'home')
    withListenerId(home)
    const d = daemon(home, new Runner(), { env: { AGENTCHAT_INTEGRATION: 'off' }, pollMs: 50, tickMs: 10 })
    try {
      await until(() => readIntegrationStatus(home)?.socket === 'off', 5_000)
      await pause(200)
      expect(double.listenerReports).toHaveLength(0)
      signIn(home, double.apiBase)
      await until(() => stoppedReports().length === 1, 5_000)
      await pause(300)
      expect(double.listenerReports).toHaveLength(1)
    } finally {
      await d.stop()
    }
  }, 20_000)
})
