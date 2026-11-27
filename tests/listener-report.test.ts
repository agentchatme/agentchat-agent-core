import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { integration as kit, ListenerReasonKind, ListenerState } from 'agentchatme'
import { Integration } from '../src/integration/integration.js'
import { runIntegration } from '../src/integration/run.js'
import { describeListenerStopped, listenerIdPath, readListenerInstanceId, reportListenerStopped, type ListenerReportSink, type ListenerReportTiming } from '../src/integration/listener-report.js'
import { formatIntegrationStatus, readIntegrationStatus, writeIntegrationStatus, type IntegrationStatus } from '../src/integration/status.js'
import { acquireAgentLock } from '../src/daemon/agent-lock.js'
import { createIdentityCommands } from '../src/identity/commands.js'
import { credentialsPath, readCredentials, writeCredentials } from '../src/identity/credentials.js'
import type { HostProfile } from '../src/identity/host-profile.js'
import { renderAnchorBlock } from '../src/anchor/block.js'
import type { RunOutcome, RunPreflight, RunPreflightOptions, RunRequest, RunRunner } from '../src/integration/runner.js'
import { pause, startServerDouble, until, type ListenerReportPut, type ServerDouble } from './helpers/server-double.js'

// ─── The listener report (contract v1 §3.13) ────────────────────────────────
//
//   1  the integration says what is true: not_ready when the start preflight
//      fails (with the check's reason), ok once connected with the runtime
//      healthy, runs_failing while the recheck after a failed run fails or the
//      runtime check after a failed conversation run fails (health and the
//      hand-over unchanged), ok again when a run completes or a check passes
//   2  the supervisor: one reporter per identity, kept across start retries
//      (one not_ready, not one per retry; the status file fresh on every
//      retry and while it waits); only the home that holds the agent reports
//      (a standby, a home that gave the agent up: nothing); a shutdown
//      (SIGTERM) sends no `stopped`
//   3  the explicit stop: `stopped` from the commands that end the listener,
//      before the key goes; skipped with no listener, for a standby; a failure
//      is said, never thrown, and bounded

const CLIENT = { runtime: 'generic' as const, version: '0.0.0-test' }
const KEY = 'ac_' + 'k'.repeat(40)
const SIGNED_OUT = 'claude is not signed in (run `claude` once and sign in)'
const OK_RUN: RunOutcome = { state: 'ok', exitCode: 0, durationMs: 1 }

let sandbox: string
let double: ServerDouble | null
beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-listener-report-'))
  double = null
})
afterEach(async () => {
  vi.restoreAllMocks()
  await double?.close()
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

/** What `set()` was told, in order, as the kit's reporter would hold it (no sends). */
class FakeSink implements ListenerReportSink {
  readonly calls: Array<{ state: ListenerState; reasonKind: ListenerReasonKind | null }> = []
  private current: { state: ListenerState; reasonKind: ListenerReasonKind | null } | null = null
  set(state: ListenerState, reasonKind?: ListenerReasonKind): void {
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
      stopped: false,
    }
  }
  /** What it says now, as `state` or `state/reason`. */
  get now(): string | null {
    return this.current === null ? null : this.current.reasonKind === null ? this.current.state : `${this.current.state}/${this.current.reasonKind}`
  }
  /** Each change, in order (a repeat of the same state is no change). */
  get changes(): string[] {
    const out: string[] = []
    for (const c of this.calls) {
      const word = c.reasonKind === null ? c.state : `${c.state}/${c.reasonKind}`
      if (out[out.length - 1] !== word) out.push(word)
    }
    return out
  }
}

/** A runtime whose preflight, run outcome and model check are scripted, and counted. */
class ScriptedRunner implements RunRunner {
  readonly name = 'claude'
  preflights = 0
  starts = 0
  checks = 0
  readonly checkRuntime?: (options?: RunPreflightOptions) => Promise<RunPreflight>
  /** Per conversation (`conv_N`), else the default `outcome`. */
  readonly endings = new Map<string, RunOutcome>()
  constructor(
    public pre: RunPreflight = { ok: true },
    public outcome: RunOutcome = OK_RUN,
    public check: RunPreflight | 'hang' | 'held' | null = null,
  ) {
    if (check !== null) this.checkRuntime = (options) => this.runCheck(options)
  }
  async preflight(): Promise<RunPreflight> {
    this.preflights += 1
    return this.pre
  }
  async start(request: RunRequest): Promise<RunOutcome> {
    this.starts += 1
    return (request.conversationId !== undefined ? this.endings.get(request.conversationId) : undefined) ?? this.outcome
  }
  /** A `held` check answers when this is called. */
  release: ((answer: RunPreflight) => void) | null = null
  private async runCheck(options: RunPreflightOptions = {}): Promise<RunPreflight> {
    this.checks += 1
    const check = this.check
    if (check === 'held') return new Promise<RunPreflight>((resolve) => (this.release = resolve))
    if (check !== 'hang' && check !== null) return check
    return new Promise<RunPreflight>((resolve) => options.signal?.addEventListener('abort', () => resolve({ ok: false, detail: 'stopped' }), { once: true }))
  }
}

const FAILED_RUN: RunOutcome = { state: 'failed', exitCode: 1, durationMs: 1, detail: 'exit 1: API Error: 529 overloaded' }
const wake = (id: string, conversationId = 'conv_0'): void =>
  double!.send({ type: 'message.new', payload: { id, conversation_id: conversationId, sender: 'peer', content: { text: 'x' } } })

// ─── 1. what the integration says ───────────────────────────────────────────

describe('the integration says what is true', () => {
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
  const build = (runner: RunRunner, sink: FakeSink, extra: Partial<ConstructorParameters<typeof Integration>[0]> = {}): Integration => {
    const i = new Integration({
      cfg: { apiKey: KEY, handle: 'me', apiBase: double!.apiBase, wsBase: double!.wsBase, home, workdir: path.join(home, 'w') },
      runner,
      client: CLIENT,
      manualPointer: '(POINTER)',
      profile: 'answer',
      budgetMs: 60_000,
      quietMs: 50,
      maxMs: 200,
      runtimeRecheckMs: 0,
      listenerReport: sink,
      ...extra,
    })
    integrations.push(i)
    return i
  }

  it('connected with the runtime healthy → ok; a reconnect changes nothing', async () => {
    double = await startServerDouble({ tray: { waiting: 0 } })
    const sink = new FakeSink()
    const i = build(new ScriptedRunner(), sink)
    await i.start()
    await until(() => i.snapshot().socket === 'ready', 5_000)
    expect(sink.changes).toEqual(['ok'])
    double.kick()
    await until(() => double!.served.length === 2 && i.snapshot().socket === 'ready', 10_000)
    expect(sink.changes).toEqual(['ok'])
    // The status file carries what the reporter holds.
    expect(readIntegrationStatus(home)?.listener_report).toMatchObject({ instance_id: 'test-instance-0001', state: 'ok', reason_kind: null })
  }, 20_000)

  it.each([
    [SIGNED_OUT, 'not_signed_in'],
    ['codex login status failed: Not logged in (run `codex login` once and sign in)', 'not_signed_in'],
    ['claude CLI not found on PATH (spawn claude ENOENT)', 'runtime_missing'],
    ['1.0.3 (Claude Code); AgentChat requires Claude Code >= 2.1.0 (for --permission-prompts none and CLAUDE_CODE_MCP_STARTUP_WAIT_MS)', 'runtime_outdated'],
    ['preflight did not answer within 60 s', 'other'],
  ])('the start preflight fails (%s) → not_ready (%s), and it does not connect', async (detail, kind) => {
    double = await startServerDouble({ tray: { waiting: 0 } })
    const sink = new FakeSink()
    const i = build(new ScriptedRunner({ ok: false, detail }), sink)
    await expect(i.start()).rejects.toThrow(/not ready/)
    expect(sink.changes).toEqual([`not_ready/${kind}`])
    expect(double.upgrades).toBe(0)
  })

  it('a later start whose preflight passes unsays not_ready at once (a socket that cannot connect is not a runtime that cannot start), then ok when connected', async () => {
    double = await startServerDouble({ tray: { waiting: 0 }, upgrade: 503 })
    const sink = new FakeSink()
    await expect(build(new ScriptedRunner({ ok: false, detail: SIGNED_OUT }), sink).start()).rejects.toThrow()
    const i = build(new ScriptedRunner(), sink)
    await i.start()
    expect(sink.changes).toEqual(['not_ready/not_signed_in', 'ok'])
    double.setUpgrade('hello')
    await until(() => i.snapshot().socket === 'ready', 15_000)
    expect(sink.changes).toEqual(['not_ready/not_signed_in', 'ok'])
  }, 20_000)

  it('the recheck after a failed run fails → runs_failing with the check\'s reason; it passing again → ok, while health() still says runs fail; a run that completes → ok', async () => {
    double = await startServerDouble({ tray: { waiting: 1 } })
    const sink = new FakeSink()
    const runner = new ScriptedRunner()
    const i = build(runner, sink)
    await i.start()
    await until(() => runner.starts === 1 && sink.now === 'ok', 5_000)
    // Signed out: the run does not start, and the runtime's own check says why.
    runner.outcome = { state: 'not_started', exitCode: 1, durationMs: 1, detail: 'Not logged in' }
    runner.pre = { ok: false, detail: SIGNED_OUT }
    wake('m1')
    await until(() => runner.starts === 2, 5_000)
    await i.runtimeCheckDone()
    expect(sink.now).toBe('runs_failing/not_signed_in')
    expect(i.health()).toMatchObject({ ok: false })
    // Signed in again, the runs still fail: the check passes, so the report is ok; health() still gives the agent up to a waiting standby.
    runner.pre = { ok: true }
    wake('m2')
    await until(() => runner.starts === 3, 5_000)
    await i.runtimeCheckDone()
    expect(sink.now).toBe('ok')
    expect(i.health()).toMatchObject({ ok: false })
    expect(i.snapshot().runs_failing?.reason).toMatch(/checks out now, but runs still fail/)
    // A run that completes clears both.
    runner.outcome = OK_RUN
    wake('m3')
    await until(() => runner.starts === 4 && i.health().ok, 5_000)
    expect(sink.changes).toEqual(['ok', 'runs_failing/not_signed_in', 'ok'])
  }, 20_000)

  it('the runtime check after a failed conversation run fails (a usage limit, an outage) → runs_failing (runtime_check_failed); health() and the hand-over do not change; a run that completes → ok', async () => {
    double = await startServerDouble({ tray: { waiting: 1 }, conversationRunTemplate: 'RUN <conversation_id>' })
    const sink = new FakeSink()
    const runner = new ScriptedRunner({ ok: true }, OK_RUN, { ok: false, detail: 'scripted: usage limit reached' })
    runner.endings.set('conv_0', FAILED_RUN)
    const i = build(runner, sink)
    await i.start()
    await until(() => i.snapshot().could_not_process?.runtime_checks_failed === 1, 5_000)
    await until(() => sink.now === 'runs_failing/runtime_check_failed', 2_000)
    // The report only: the integration still serves (no give-up to a standby), and status does not say runs fail.
    expect(i.health()).toEqual({ ok: true })
    expect(i.snapshot().runs_failing ?? null).toBeNull()
    expect(double.processingFailures).toHaveLength(0)
    runner.endings.set('conv_0', OK_RUN)
    wake('m1')
    await until(() => sink.now === 'ok', 5_000)
    expect(sink.changes).toEqual(['ok', 'runs_failing/runtime_check_failed', 'ok'])
  }, 20_000)

  it('a runtime check that passes clears runtime_check_failed (the failure is then reported as the conversation\'s)', async () => {
    double = await startServerDouble({ tray: { waiting: 1 }, conversationRunTemplate: 'RUN <conversation_id>' })
    const sink = new FakeSink()
    const runner = new ScriptedRunner({ ok: true }, OK_RUN, { ok: false, detail: 'scripted: provider outage' })
    runner.endings.set('conv_0', FAILED_RUN)
    const i = build(runner, sink)
    await i.start()
    await until(() => sink.now === 'runs_failing/runtime_check_failed', 5_000)
    runner.check = { ok: true }
    wake('m1')
    await until(() => double!.processingFailures.length === 1, 5_000)
    await until(() => sink.now === 'ok', 2_000)
    expect(i.snapshot().could_not_process).toMatchObject({ runtime_checks_failed: 1, runtime_checks_ok: 1 })
  }, 20_000)

  it('a check that fails after another run completed meanwhile is older news: it changes nothing', async () => {
    double = await startServerDouble({ tray: { waiting: 1 }, conversationRunTemplate: 'RUN <conversation_id>' })
    const sink = new FakeSink()
    const runner = new ScriptedRunner({ ok: true }, OK_RUN, 'held')
    runner.endings.set('conv_0', FAILED_RUN)
    const i = build(runner, sink)
    await i.start()
    await until(() => runner.checks === 1, 5_000)
    // Another conversation's run completes while the check is out.
    const starts = runner.starts
    double.setTray({ waiting: 2 })
    wake('m1', 'conv_1')
    await until(() => runner.starts > starts && i.snapshot().runs_ok >= 1, 5_000)
    runner.release?.({ ok: false, detail: 'scripted: usage limit reached' })
    await until(() => i.snapshot().could_not_process?.runtime_checks_failed === 1, 5_000)
    await pause(100)
    expect(sink.changes).toEqual(['ok'])
  }, 20_000)

  it('stopping says nothing more: a check cut short by the stop is not a failed check', async () => {
    double = await startServerDouble({ tray: { waiting: 1 }, conversationRunTemplate: 'RUN <conversation_id>' })
    const sink = new FakeSink()
    const runner = new ScriptedRunner({ ok: true }, OK_RUN, 'hang')
    runner.endings.set('conv_0', FAILED_RUN)
    const i = build(runner, sink)
    await i.start()
    await until(() => runner.checks === 1, 5_000)
    expect(await i.stopAndWait(5_000)).toBe(true)
    await pause(100)
    expect(sink.changes).toEqual(['ok'])
  }, 20_000)
})

// ─── 2. the supervisor ──────────────────────────────────────────────────────

/** The reporter's timing for tests: the kit's rules, at test speed. */
const FAST: ListenerReportTiming = { coalesceMs: 20, minIntervalMs: 0, retryMs: 50, retryMaxMs: 200 }

describe('the supervisor: one reporter per identity, only while this home holds the agent', () => {
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
    return { stop: async () => { controller.abort(); return done }, done }
  }
  const reportsOf = (home: string): ListenerReportPut[] => {
    const id = readListenerInstanceId(home)
    return id === null ? [] : double!.listenerReports.filter((r) => r.body.instance_id === id)
  }
  /** Each change, in order (a re-send of the same state is no change). */
  const changesOf = (list: string[]): string[] => list.filter((word, i) => i === 0 || list[i - 1] !== word)
  const states = (home: string): string[] => reportsOf(home).map((r) => (r.body.reason_kind === undefined ? String(r.body.state) : `${String(r.body.state)}/${String(r.body.reason_kind)}`))

  it('a start preflight that keeps failing: one not_ready with its reason, not one per retry; the status file is rewritten on every retry and while it waits (pid kept); once the runtime checks out, ok', async () => {
    double = await startServerDouble({ tray: { waiting: 0 } })
    const home = path.join(sandbox, 'home')
    signIn(home, double.apiBase)
    const runner = new ScriptedRunner({ ok: false, detail: SIGNED_OUT })
    const d = daemon(home, runner, { pollMs: 100, offStatusRefreshMs: 100 })
    try {
      await until(() => runner.preflights >= 4, 10_000)
      expect(states(home)).toEqual(['not_ready/not_signed_in'])
      expect(reportsOf(home)[0]?.apiKey).toBe(KEY)
      // The id is the home's own, kept in its file.
      expect(fs.readFileSync(listenerIdPath(home), 'utf-8').trim()).toBe(readListenerInstanceId(home))
      const status = readIntegrationStatus(home)
      expect(status).toMatchObject({ socket: 'idle', pid: process.pid, last_error: expect.stringMatching(/not ready: claude is not signed in/) })
      expect(status?.listener_report).toMatchObject({ state: 'not_ready', reason_kind: 'not_signed_in', pending: false })
      expect(formatIntegrationStatus(status).join('\n')).toContain('listener report: not_ready (not_signed_in) — AgentChat has it')
      // Rewritten while it waits out its backoff (here 1.6 s and growing), not only when the message changes.
      const seen = new Set<string>()
      const until2 = Date.now() + 1_500
      while (Date.now() < until2) {
        const s = readIntegrationStatus(home)
        if (s !== null) {
          seen.add(s.updated_at)
          expect(s.pid).toBe(process.pid)
        }
        await pause(50)
      }
      expect(seen.size).toBeGreaterThanOrEqual(5)
      // Signed in to the runtime: the next retry connects, and AgentChat hears ok.
      runner.pre = { ok: true }
      await until(() => readIntegrationStatus(home)?.socket === 'ready', 15_000)
      await until(() => states(home).length === 2, 3_000)
      expect(states(home)).toEqual(['not_ready/not_signed_in', 'ok'])
    } finally {
      await d.stop()
    }
  }, 40_000)

  it('the status file is rewritten on every start retry itself, not only by the refresh while waiting', async () => {
    double = await startServerDouble({ tray: { waiting: 0 } })
    const home = path.join(sandbox, 'home')
    signIn(home, double.apiBase)
    const runner = new ScriptedRunner({ ok: false, detail: SIGNED_OUT })
    // The refresh while waiting is out of the picture here: only the retries write.
    const d = daemon(home, runner, { pollMs: 100, offStatusRefreshMs: 600_000 })
    try {
      const written: string[] = []
      for (const count of [2, 3, 4]) {
        await until(() => runner.preflights >= count, 10_000)
        await until(() => (readIntegrationStatus(home)?.updated_at ?? '') > (written[written.length - 1] ?? ''), 2_000)
        written.push(readIntegrationStatus(home)?.updated_at ?? '')
      }
      expect(new Set(written).size).toBe(3)
      expect(readIntegrationStatus(home)?.pid).toBe(process.pid)
    } finally {
      await d.stop()
    }
  }, 30_000)

  it('a standby reports nothing (it makes no listener id); the holder\'s stop sends no stopped; the standby takes over and reports ok under its own id', async () => {
    double = await startServerDouble({ tray: { waiting: 0 } })
    const home1 = path.join(sandbox, 'first-home')
    const home2 = path.join(sandbox, 'second-home')
    signIn(home1, double.apiBase)
    signIn(home2, double.apiBase)
    const a = daemon(home1, new ScriptedRunner())
    await until(() => states(home1).includes('ok'), 10_000)
    const b = daemon(home2, new ScriptedRunner())
    try {
      await until(() => (readIntegrationStatus(home2)?.standby ?? null) !== null, 10_000)
      await pause(400) // several standby polls
      expect(fs.existsSync(listenerIdPath(home2))).toBe(false)
      expect(double.listenerReports.map((r) => r.body.instance_id)).toEqual([readListenerInstanceId(home1)])
      expect(readIntegrationStatus(home2)?.listener_report ?? null).toBeNull()
      // The holder stops (a service stop): no `stopped`.
      expect(await a.stop()).toBe(0)
      await until(() => readIntegrationStatus(home2)?.socket === 'ready', 10_000)
      await until(() => states(home2).includes('ok'), 3_000)
      expect(states(home1)).toEqual(['ok'])
      expect(states(home2)).toEqual(['ok'])
      expect(readListenerInstanceId(home2)).not.toBe(readListenerInstanceId(home1))
    } finally {
      await a.stop()
      await b.stop()
    }
  }, 40_000)

  it('the holder whose runs fail reports runs_failing, gives the agent up to the waiting standby, and from then on reports nothing (not even the 30-minute re-send)', async () => {
    double = await startServerDouble({ tray: { waiting: 1 } })
    const home1 = path.join(sandbox, 'broken-home')
    const home2 = path.join(sandbox, 'healthy-home')
    signIn(home1, double.apiBase)
    signIn(home2, double.apiBase)
    const broken = new ScriptedRunner()
    // The re-send while not ok, at test speed: a home that kept its reporter would re-send within the wait below.
    const a = daemon(home1, broken, { runtimeRecheckMs: 50, unservableRecheckMs: 60_000, listenerReportTiming: { ...FAST, resendMs: 300 } })
    await until(() => readIntegrationStatus(home1)?.socket === 'ready', 10_000)
    const b = daemon(home2, new ScriptedRunner())
    try {
      await until(() => (readIntegrationStatus(home2)?.standby ?? null) !== null, 10_000)
      broken.outcome = { state: 'not_started', exitCode: 1, durationMs: 1, detail: 'Not logged in' }
      broken.pre = { ok: false, detail: SIGNED_OUT }
      wake('m1', 'conv_1')
      await until(() => readIntegrationStatus(home2)?.socket === 'ready', 15_000)
      await until(() => states(home2).includes('ok'), 3_000)
      // Re-sent while it held the agent (every 300 ms here), then nothing once it gave the agent up.
      expect(changesOf(states(home1))).toEqual(['ok', 'runs_failing/not_signed_in'])
      const count = reportsOf(home1).length
      await pause(1_000)
      expect(reportsOf(home1)).toHaveLength(count)
      expect(readIntegrationStatus(home1)?.unservable?.reason).toBe('runs_failing')
    } finally {
      await a.stop()
      await b.stop()
    }
  }, 40_000)

  it('SIGTERM (a service stop, a reboot) sends no stopped, and a report under way does not hold the shutdown', async () => {
    double = await startServerDouble({ tray: { waiting: 0 } })
    const home = path.join(sandbox, 'home')
    signIn(home, double.apiBase)
    // Every report hangs: the first, `ok`, is under way when the signal comes.
    double.setListenerReportStatus('hang')
    const exits: number[] = []
    const done = runIntegration({ home, client: CLIENT, manualPointer: '(POINTER)', workdir: path.join(home, 'w'), env: {}, runner: new ScriptedRunner(), listenerReportTiming: FAST, exit: (code) => exits.push(code) })
    await until(() => double!.listenerReports.length === 1, 10_000)
    const started = Date.now()
    process.emit('SIGTERM')
    expect(await done).toBe(0)
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(exits).toEqual([0])
    await pause(200)
    expect(double.listenerReports.map((r) => r.body.state)).toEqual(['ok'])
  }, 20_000)

  it('signed out (the credentials removed): the reporter goes with the identity, and nothing is sent for it', async () => {
    double = await startServerDouble({ tray: { waiting: 0 } })
    const home = path.join(sandbox, 'home')
    signIn(home, double.apiBase)
    const d = daemon(home, new ScriptedRunner(), { pollMs: 100 })
    try {
      await until(() => states(home).includes('ok'), 10_000)
      fs.rmSync(credentialsPath(home))
      await until(() => readIntegrationStatus(home)?.handle === null, 5_000)
      await pause(300)
      expect(states(home)).toEqual(['ok'])
      expect(readIntegrationStatus(home)?.listener_report ?? null).toBeNull()
    } finally {
      await d.stop()
    }
  }, 20_000)
})

// ─── 3. the explicit stop ───────────────────────────────────────────────────

describe('reportListenerStopped: the commands that end the listener on purpose', () => {
  const ID = 'aaaaaaaaaaaaaaaaaaaaaa'
  const withListener = (home: string): void => {
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(listenerIdPath(home), `${ID}\n`)
  }

  it('sends stopped under the home\'s listener id, with the key, in one attempt', async () => {
    double = await startServerDouble()
    const home = path.join(sandbox, 'home')
    withListener(home)
    const result = await reportListenerStopped({ home, client: CLIENT, identity: { apiKey: KEY, apiBase: double.apiBase, handle: 'probe' } })
    expect(result).toEqual({ outcome: 'reported' })
    expect(double.listenerReports.map((r) => r.body)).toEqual([{ instance_id: ID, state: 'stopped' }])
    expect(double.listenerReports[0]?.apiKey).toBe(KEY)
    expect(describeListenerStopped(result)).toBe('listener: AgentChat was told it stopped on purpose')
  })

  it('nothing to stop: no key the home holds (none, or only an exported one), or no listener of this home ever reported (no id file) — no request, no line', async () => {
    double = await startServerDouble()
    const home = path.join(sandbox, 'home')
    fs.mkdirSync(home, { recursive: true })
    const identity = { apiKey: KEY, apiBase: double.apiBase, handle: 'probe' }
    expect(await reportListenerStopped({ home, client: CLIENT, identity: null })).toEqual({ outcome: 'skipped', reason: 'no_identity' })
    // An exported key is not what the home's listener serves, even with a listener id there.
    fs.writeFileSync(listenerIdPath(home), `${ID}\n`)
    expect(await reportListenerStopped({ home, client: CLIENT, identity: { ...identity, handle: null, source: 'env' } })).toEqual({ outcome: 'skipped', reason: 'no_identity' })
    fs.rmSync(listenerIdPath(home))
    expect(await reportListenerStopped({ home, client: CLIENT, identity })).toEqual({ outcome: 'skipped', reason: 'no_listener' })
    // A damaged id file is no id.
    fs.writeFileSync(listenerIdPath(home), 'not an id!\n')
    expect(await reportListenerStopped({ home, client: CLIENT, identity })).toEqual({ outcome: 'skipped', reason: 'no_listener' })
    expect(double.listenerReports).toHaveLength(0)
    expect(describeListenerStopped({ outcome: 'skipped', reason: 'no_listener' })).toBeNull()
  })

  it('a standby reports nothing: another live home holds the agent lock; this home holding it, or nobody, reports', async () => {
    double = await startServerDouble()
    const home = path.join(sandbox, 'home')
    withListener(home)
    const identity = { apiKey: KEY, apiBase: double.apiBase, handle: 'probe' }
    const other = await acquireAgentLock({ apiBase: double.apiBase, handle: 'probe', home: path.join(sandbox, 'other-home') })
    expect(other.ok).toBe(true)
    try {
      expect(await reportListenerStopped({ home, client: CLIENT, identity })).toEqual({ outcome: 'skipped', reason: 'standby' })
      expect(double.listenerReports).toHaveLength(0)
    } finally {
      if (other.ok) other.lease.release()
    }
    const own = await acquireAgentLock({ apiBase: double.apiBase, handle: 'probe', home })
    try {
      expect(await reportListenerStopped({ home, client: CLIENT, identity })).toEqual({ outcome: 'reported' })
    } finally {
      if (own.ok) own.lease.release()
    }
    expect(await reportListenerStopped({ home, client: CLIENT, identity })).toEqual({ outcome: 'reported' })
    expect(double.listenerReports).toHaveLength(2)
  })

  it('a failure is said, never thrown; a server that does not answer is given up at the bound', async () => {
    double = await startServerDouble()
    const home = path.join(sandbox, 'home')
    withListener(home)
    const identity = { apiKey: KEY, apiBase: double.apiBase, handle: 'probe' }
    double.setListenerReportStatus(503)
    const failed = await reportListenerStopped({ home, client: CLIENT, identity })
    expect(failed).toMatchObject({ outcome: 'failed', detail: expect.stringContaining('503') })
    expect(describeListenerStopped(failed)).toMatch(/^listener: could not tell AgentChat it stopped \(.*503.*\); AgentChat shows it as offline instead$/)
    expect(double.listenerReports).toHaveLength(1) // one attempt: never retried
    double.setListenerReportStatus('hang')
    const started = Date.now()
    expect(await reportListenerStopped({ home, client: CLIENT, identity, timeoutMs: 300 })).toMatchObject({ outcome: 'failed' })
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

describe('logout tells AgentChat the listener stopped, before the key goes', () => {
  const fixture = (): { home: string; commands: ReturnType<typeof createIdentityCommands>; out: string[] } => {
    const home = path.join(sandbox, 'home')
    fs.mkdirSync(home, { recursive: true })
    const profile: HostProfile = {
      label: 'Claude Code',
      id: 'claude-code',
      client: CLIENT,
      home: () => home,
      anchorFile: () => path.join(home, 'CLAUDE.md'),
      invocation: () => 'npx -y @agentchatme/claude-code',
      renderAnchor: renderAnchorBlock,
    }
    const out: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      out.push(String(line))
    })
    return { home, commands: createIdentityCommands(profile), out }
  }

  it('the report arrives while the credentials are still there; then the sign-out; the output says so', async () => {
    double = await startServerDouble()
    const { home, commands, out } = fixture()
    writeCredentials(home, { api_key: KEY, handle: 'probe', api_base: double.apiBase })
    fs.writeFileSync(listenerIdPath(home), 'bbbbbbbbbbbbbbbbbbbbbb\n')
    const keyThere: boolean[] = []
    double.onListenerReport(() => keyThere.push(fs.existsSync(credentialsPath(home))))
    expect(await commands.runLogout()).toBe(0)
    expect(double.listenerReports.map((r) => r.body)).toEqual([{ instance_id: 'bbbbbbbbbbbbbbbbbbbbbb', state: 'stopped' }])
    expect(keyThere).toEqual([true])
    expect(readCredentials(home)).toBeNull()
    expect(out.join('\n')).toContain('listener: AgentChat was told it stopped on purpose')
    expect(out.join('\n')).toContain('credentials deleted')
  })

  it('a report that fails does not stop the sign-out', async () => {
    double = await startServerDouble()
    const { home, commands, out } = fixture()
    writeCredentials(home, { api_key: KEY, handle: 'probe', api_base: double.apiBase })
    fs.writeFileSync(listenerIdPath(home), 'bbbbbbbbbbbbbbbbbbbbbb\n')
    double.setListenerReportStatus(500)
    expect(await commands.runLogout()).toBe(0)
    expect(readCredentials(home)).toBeNull()
    expect(out.join('\n')).toMatch(/listener: could not tell AgentChat it stopped \(.*500.*\)/)
  })

  it('an exported key the home does not hold is not signed out, so nothing is said to be stopped', async () => {
    double = await startServerDouble()
    const { home, commands } = fixture()
    fs.writeFileSync(listenerIdPath(home), 'bbbbbbbbbbbbbbbbbbbbbb\n')
    vi.stubEnv('AGENTCHAT_API_KEY', KEY)
    vi.stubEnv('AGENTCHAT_API_BASE', double.apiBase)
    try {
      expect(await commands.runLogout()).toBe(0)
    } finally {
      vi.unstubAllEnvs()
    }
    expect(double.listenerReports).toHaveLength(0)
  })
})

// ─── the status file ────────────────────────────────────────────────────────

describe('the status file keeps the listener report', () => {
  const base = (extra: Partial<IntegrationStatus>): IntegrationStatus => ({
    version: 2,
    updated_at: new Date().toISOString(),
    pid: process.pid,
    runtime: 'claude',
    handle: 'probe',
    profile: 'own',
    socket: 'ready',
    wakes: 0,
    wakes_absorbed: 0,
    invites: 0,
    runs_started: 0,
    runs_ok: 0,
    runs_failed: 0,
    runs_timed_out: 0,
    runs_not_started: 0,
    runs_skipped_empty: 0,
    last_run: null,
    retry_rung: 0,
    retry_due_at: null,
    last_error: null,
    texts: null,
    ...extra,
  })

  it('round-trips; one line in status: what AgentChat holds, or why it does not yet', () => {
    const home = path.join(sandbox, 'home')
    fs.mkdirSync(home, { recursive: true })
    const report = {
      instance_id: 'cccccccccccccccccccccc',
      state: 'runs_failing',
      reason_kind: 'runtime_check_failed',
      reported: null,
      pending: true,
      failures: 2,
      last_error: '503 LISTENER_REPORTS_UNAVAILABLE: Listener reports are not available right now',
      next_attempt_at: new Date(Date.now() + 4 * 60_000).toISOString(),
    }
    writeIntegrationStatus(home, base({ listener_report: report }))
    const read = readIntegrationStatus(home)
    expect(read?.listener_report).toEqual(report)
    expect(formatIntegrationStatus(read).join('\n')).toContain(
      'listener report: runs_failing (runtime_check_failed) — not delivered yet (2 attempt(s) failed, last: 503 LISTENER_REPORTS_UNAVAILABLE: Listener reports are not available right now); tried again in 4 minutes',
    )
    const held = { ...report, state: 'ok', reason_kind: null, pending: false, failures: 0, last_error: null, next_attempt_at: null, reported: { state: 'ok', reason_kind: null, at: new Date().toISOString() } }
    expect(formatIntegrationStatus(base({ listener_report: held })).join('\n')).toContain('listener report: ok — AgentChat has it (accepted just now)')
    // Nothing said yet, or no reporter: no line.
    expect(formatIntegrationStatus(base({ listener_report: { ...held, state: null, reported: null } })).join('\n')).not.toContain('listener report')
    expect(formatIntegrationStatus(base({ listener_report: null })).join('\n')).not.toContain('listener report')
  })

  it('a block it cannot read costs that block, never the file', () => {
    const home = path.join(sandbox, 'home')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'integration.status.json'), JSON.stringify({ ...base({}), listener_report: { state: 42 } }))
    const read = readIntegrationStatus(home)
    expect(read?.socket).toBe('ready')
    expect(read?.listener_report).toBeNull()
  })
})
