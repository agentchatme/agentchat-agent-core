import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentChatClient } from 'agentchatme'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Integration } from '../src/integration/integration.js'
import { couldNotProcessPath, PausedConversations } from '../src/integration/could-not-process.js'
import { RUN_CONTEXT_ENV, runContextEnv } from '../src/integration/run-context.js'
import {
  describeCouldNotProcessCounts,
  describePausedConversations,
  formatIntegrationStatus,
  readIntegrationStatus,
  repeatedFailedRuns,
  writeIntegrationStatus,
  type IntegrationCouldNotProcess,
  type IntegrationStatus,
} from '../src/integration/status.js'
import type { RunOutcome, RunPreflight, RunPreflightOptions, RunRequest, RunRunner } from '../src/integration/runner.js'
import { log } from '../src/util/log.js'
import { createIdentityCommands } from '../src/identity/commands.js'
import { writeCredentials } from '../src/identity/credentials.js'
import type { HostProfile } from '../src/identity/host-profile.js'
import { startServerDouble, until, pause, type ServerDouble } from './helpers/server-double.js'
import { mockServedTexts, textsFor } from './helpers/served-texts.js'

// ─── Could not process: the engine on conversation runs ─────────────────────
//
// Real SDK socket and receive loop against the server double, a scripted
// runner. What is pinned here is this package's side of contract v1's could
// not process: with served texts that carry `conversation_run_template`, the
// kit starts one run per conversation and the engine hands each to the runner
// as a `conversation` run with its id (invite runs stay invite runs); a run
// past its budget ends as `timedOut`; the runner's runtime check is the
// evidence a report needs, bounded and stopped; the server's `paused` answer
// is said plainly in status until the pause ends.

const CLIENT = { runtime: 'generic' as const, version: '0.0.0-test' }
const POINTER = '(The AgentChat manual is the agentchat skill.)'
const KEY = 'ac_' + 'k'.repeat(32)
/** Not the server's words: a test that passed because a fixture matched a copy would prove nothing. */
const TEMPLATE = 'SERVED CONVERSATION RUN for <conversation_id> (generic): only this one.'
const promptFor = (id: string): string => `SERVED CONVERSATION RUN for ${id} (generic): only this one.\n\n${POINTER}`

type Ending = 'ok' | 'failed' | 'timed_out' | 'not_started' | 'never'
type Check = 'ok' | 'fail' | 'hang'

/** A runner whose runs end as scripted per conversation (default `ok`), with an optional runtime check. */
class ScriptedRunner implements RunRunner {
  readonly name = 'scripted'
  readonly requests: RunRequest[] = []
  readonly checks: Array<{ aborted: boolean }> = []
  endings = new Map<string, Ending>()
  /** Present only when the runner has a check (a custom command has none). */
  readonly checkRuntime?: (options?: RunPreflightOptions) => Promise<RunPreflight>
  constructor(public check: Check | null = null) {
    if (check !== null) this.checkRuntime = (options) => this.runCheck(options)
  }
  async preflight(): Promise<RunPreflight> {
    return { ok: true }
  }
  async start(request: RunRequest): Promise<RunOutcome> {
    this.requests.push(request)
    const ending = this.endings.get(request.conversationId ?? request.kind) ?? 'ok'
    if (ending === 'never') return new Promise<RunOutcome>(() => undefined)
    if (ending === 'ok') return { state: 'ok', exitCode: 0, durationMs: 1 }
    if (ending === 'timed_out') return { state: 'timed_out', exitCode: null, durationMs: 1, detail: 'run exceeded its 1 s budget and was killed' }
    if (ending === 'not_started') return { state: 'not_started', exitCode: 127, durationMs: 1, detail: 'exit 127 with nothing on stdout' }
    return { state: 'failed', exitCode: 1, durationMs: 1, detail: 'exit 1: API Error: refused' }
  }
  private async runCheck(options: RunPreflightOptions = {}): Promise<RunPreflight> {
    const record = { aborted: false }
    this.checks.push(record)
    if (this.check === 'ok') return { ok: true }
    if (this.check === 'fail') return { ok: false, detail: 'scripted: the provider is down' }
    return new Promise<RunPreflight>((resolve) => {
      options.signal?.addEventListener(
        'abort',
        () => {
          record.aborted = true
          resolve({ ok: false, detail: 'stopped' })
        },
        { once: true },
      )
    })
  }
}

let home: string
let double: ServerDouble | null
let integrations: Integration[]

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-cnp-'))
  integrations = []
  double = null
})
afterEach(async () => {
  for (const i of integrations) await i.stopAndWait(5_000)
  await double?.close()
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

async function serve(options: Parameters<typeof startServerDouble>[0] = {}): Promise<ServerDouble> {
  double = await startServerDouble({ conversationRunTemplate: TEMPLATE, ...options })
  return double
}

async function integration(runner: RunRunner, extra: Partial<ConstructorParameters<typeof Integration>[0]> = {}, handle = 'me'): Promise<Integration> {
  const d = double!
  const i = new Integration({
    cfg: { apiKey: KEY, handle, apiBase: d.apiBase, wsBase: d.wsBase, home, workdir: path.join(home, 'w') },
    runner,
    client: CLIENT,
    manualPointer: POINTER,
    profile: 'own',
    budgetMs: 60_000,
    quietMs: 50,
    maxMs: 200,
    ...extra,
  })
  integrations.push(i)
  await i.start()
  return i
}

const reports = (): ServerDouble['processingFailures'] => double!.processingFailures

describe('conversation runs reach the runner as conversation runs', () => {
  it('one run per card, kind `conversation` with its id, the served template for that conversation and the pointer; the log, last_run and the status file name the conversation', async () => {
    const info = vi.spyOn(log, 'info')
    await serve({ tray: { waiting: 2 } })
    const runner = new ScriptedRunner()
    const i = await integration(runner)
    await until(() => runner.requests.length === 2 && i.snapshot().runs_ok === 2, 5_000)
    expect(runner.requests.map((r) => [r.kind, r.conversationId, r.prompt])).toEqual([
      ['conversation', 'conv_0', promptFor('conv_0')],
      ['conversation', 'conv_1', promptFor('conv_1')],
    ])
    // Never content, and the identity line still rides along as before.
    expect(JSON.stringify(runner.requests)).not.toContain('MUST NEVER BE LOGGED')
    expect(runner.requests[0]?.identityLine).toBe(textsFor('me').identity_line)
    const logged = info.mock.calls.map(([line]) => String(line))
    expect(logged.some((line) => /^run start kind=conversation conv=conv_0 id=\S+ budget=60s$/.test(line))).toBe(true)
    expect(logged.some((line) => /^run ok kind=conversation conv=conv_1 id=\S+ /.test(line))).toBe(true)
    expect(i.snapshot().last_run).toMatchObject({ kind: 'conversation', conversation_id: 'conv_1', state: 'ok' })
    expect(readIntegrationStatus(home)?.last_run).toMatchObject({ kind: 'conversation', conversation_id: 'conv_1' })
    expect(formatIntegrationStatus(readIntegrationStatus(home)).join('\n')).toMatch(/last run: conversation conv_1, ok/)
    expect(i.snapshot().recent_cycles?.at(-1)?.outcome).toBe('runs_started')
  }, 10_000)

  it('an invite run is still an invite run: invites alone → one `invite` run with the served invite prompt; cards and invites → the conversation runs, then one invite run', async () => {
    await serve({ tray: { waiting: 0, invites: ['inv_1'] } })
    const runner = new ScriptedRunner()
    const i = await integration(runner)
    await until(() => runner.requests.length === 1 && i.snapshot().runs_ok === 1, 5_000)
    expect(runner.requests[0]).toMatchObject({ kind: 'invite', prompt: `${textsFor('me').invite_prompt}\n\n${POINTER}` })
    expect(runner.requests[0]?.conversationId).toBeUndefined()
    expect(i.snapshot().last_run).toMatchObject({ kind: 'invite', conversation_id: null })

    double!.setTray({ waiting: 1, invites: ['inv_2'] })
    i.wake()
    await until(() => runner.requests.length === 3 && i.snapshot().runs_ok === 3, 5_000)
    expect(runner.requests.slice(1).map((r) => [r.kind, r.conversationId ?? null])).toEqual([
      ['conversation', 'conv_0'],
      ['invite', null],
    ])
  }, 10_000)

  it('texts without the template (an older server): one run for the whole tray, kind `wake`, as before', async () => {
    double = await startServerDouble({ tray: { waiting: 2 } })
    const runner = new ScriptedRunner()
    const i = await integration(runner)
    await until(() => runner.requests.length === 1 && i.snapshot().runs_ok === 1, 5_000)
    await pause(300)
    expect(runner.requests).toHaveLength(1)
    expect(runner.requests[0]).toMatchObject({ kind: 'wake', prompt: `${textsFor('me').wake_instruction}\n\n${POINTER}` })
    expect(runner.requests[0]?.conversationId).toBeUndefined()
  }, 10_000)

  it('`conversationRuns: false` (the forward mode) keeps one run for the tray even when the texts carry the template', async () => {
    await serve({ tray: { waiting: 2 } })
    const runner = new ScriptedRunner()
    const i = await integration(runner, { conversationRuns: false })
    await until(() => runner.requests.length === 1 && i.snapshot().runs_ok === 1, 5_000)
    await pause(300)
    expect(runner.requests.map((r) => r.kind)).toEqual(['wake'])
  }, 10_000)
})

describe('a failed conversation run is reported with the outcome the runner saw', () => {
  for (const [ending, outcome] of [
    ['timed_out', 'timed_out'],
    ['failed', 'failed'],
  ] as const) {
    it(`a run that ended ${ending} → reported as \`${outcome}\` through the card's anchor, with the runtime check as evidence`, async () => {
      await serve({ tray: { waiting: 1 } })
      const runner = new ScriptedRunner('ok')
      runner.endings.set('conv_0', ending)
      const i = await integration(runner)
      await until(() => reports().length === 1, 5_000)
      expect(reports()[0]).toMatchObject({ conversationId: 'conv_0', body: { through_message_id: 'msg_0', outcome, evidence: 'runtime_check' } })
      expect(reports()[0]?.idempotencyKey).toBeTruthy()
      await until(() => i.snapshot().could_not_process?.none === 1, 3_000)
      expect(i.snapshot().could_not_process).toMatchObject({ runtime_check: true, reported: 1, none: 1, runtime_checks_ok: 1 })
    }, 10_000)
  }

  it('a runner that never returns is abandoned at its deadline and counts as timed out (`timed_out` in the report)', async () => {
    await serve({ tray: { waiting: 1 } })
    const runner = new ScriptedRunner('ok')
    runner.endings.set('conv_0', 'never')
    const i = await integration(runner, { budgetMs: 200, runnerDeadlineSlackMs: 100 })
    await until(() => reports().length === 1, 5_000)
    expect(reports()[0]?.body).toMatchObject({ outcome: 'timed_out', evidence: 'runtime_check' })
    expect(i.snapshot()).toMatchObject({ runs_timed_out: 1 })
  }, 10_000)

  it('a run that did not start is not this conversation\'s failure: nothing is reported, no runtime check is spent', async () => {
    await serve({ tray: { waiting: 1 } })
    const runner = new ScriptedRunner('ok')
    runner.endings.set('conv_0', 'not_started')
    const i = await integration(runner)
    await until(() => i.snapshot().runs_not_started === 1, 5_000)
    await pause(300)
    expect(reports()).toHaveLength(0)
    expect(runner.checks).toHaveLength(0)
  }, 10_000)

  it('the server\'s `retry` runs the conversation again (the same id), after the others', async () => {
    await serve({ tray: { waiting: 2 } })
    double!.answerProcessingFailures({ action: 'retry', attempts: 1, hidden_message_ids: [], paused_until: null })
    const runner = new ScriptedRunner(null)
    runner.endings.set('conv_0', 'failed')
    const i = await integration(runner)
    // conv_0 fails; conv_1 completes after it started: that completion is the evidence (no check spent).
    await until(() => reports().length >= 1, 5_000)
    expect(reports()[0]?.body).toMatchObject({ outcome: 'failed', evidence: 'other_run_completed' })
    await until(() => runner.requests.filter((r) => r.conversationId === 'conv_0').length === 2, 5_000)
    expect(runner.requests.map((r) => r.conversationId)).toEqual(['conv_0', 'conv_1', 'conv_0'])
    expect(runner.checks).toHaveLength(0)
    await until(() => (i.snapshot().could_not_process?.reruns ?? 0) === 1, 3_000)
  }, 10_000)
})

describe('checkRuntime: the runner\'s minimal model call is the evidence, bounded', () => {
  it('ok → reported with `runtime_check` evidence; the check is counted and said in status', async () => {
    await serve({ tray: { waiting: 1 } })
    const runner = new ScriptedRunner('ok')
    runner.endings.set('conv_0', 'failed')
    const i = await integration(runner)
    await until(() => reports().length === 1, 5_000)
    expect(reports()[0]?.body).toMatchObject({ evidence: 'runtime_check' })
    expect(runner.checks).toHaveLength(1)
    await until(() => i.snapshot().could_not_process?.runtime_checks_ok === 1, 3_000)
    expect(i.snapshot().could_not_process?.last_runtime_check).toMatchObject({ ok: true })
  }, 10_000)

  it('fails → nothing is reported (a broken runtime is not the conversation\'s fault); status and doctor-facing lines say the check failed', async () => {
    const warn = vi.spyOn(log, 'warn')
    await serve({ tray: { waiting: 1 } })
    const runner = new ScriptedRunner('fail')
    runner.endings.set('conv_0', 'failed')
    const i = await integration(runner)
    await until(() => i.snapshot().could_not_process?.runtime_checks_failed === 1, 5_000)
    await pause(300)
    expect(reports()).toHaveLength(0)
    expect(i.snapshot().could_not_process?.last_runtime_check).toMatchObject({ ok: false, detail: 'scripted: the provider is down' })
    expect(warn.mock.calls.some(([line]) => String(line).startsWith('runtime check failed (scripted, ') && String(line).includes('scripted: the provider is down'))).toBe(true)
    expect(formatIntegrationStatus(readIntegrationStatus(home)).join('\n')).toContain('runtime check 0 ok, 1 failed (last: failed — scripted: the provider is down')
  }, 10_000)

  it('hangs → stopped at its deadline (its signal aborts) and counted as not ok; nothing reported', async () => {
    await serve({ tray: { waiting: 1 } })
    const runner = new ScriptedRunner('hang')
    runner.endings.set('conv_0', 'failed')
    const i = await integration(runner, { runtimeCheckDeadlineMs: 200 })
    await until(() => i.snapshot().could_not_process?.runtime_checks_failed === 1, 5_000)
    expect(runner.checks).toEqual([{ aborted: true }])
    expect(i.snapshot().could_not_process?.last_runtime_check?.detail).toBe('the runtime check did not answer within 0 s (stopped)')
    await pause(200)
    expect(reports()).toHaveLength(0)
  }, 10_000)

  it('a check still running when the integration stops is stopped with it', async () => {
    await serve({ tray: { waiting: 1 } })
    const runner = new ScriptedRunner('hang')
    runner.endings.set('conv_0', 'failed')
    const i = await integration(runner)
    await until(() => runner.checks.length === 1, 5_000)
    expect(await i.stopAndWait(5_000)).toBe(true)
    expect(runner.checks).toEqual([{ aborted: true }])
    expect(reports()).toHaveLength(0)
  }, 10_000)

  it('a runner with no runtime check (a custom command): the failure waits for another run to complete, then is reported with that evidence; status says there is no check', async () => {
    await serve({ tray: { waiting: 1 } })
    const runner = new ScriptedRunner(null)
    expect(runner.checkRuntime).toBeUndefined()
    runner.endings.set('conv_0', 'failed')
    const i = await integration(runner)
    await until(() => i.snapshot().could_not_process?.awaiting_evidence === 1, 5_000)
    expect(reports()).toHaveLength(0)
    expect(i.snapshot().could_not_process?.runtime_check).toBe(false)
    expect(formatIntegrationStatus(i.snapshot()).join('\n')).toContain(
      "no runtime check for this runtime: a failed run is reported only after another conversation's run completes",
    )
    // Another conversation's run completes: the evidence.
    double!.setTray({ waiting: 2 })
    runner.endings.set('conv_0', 'ok')
    i.wake()
    await until(() => reports().length === 1, 5_000)
    expect(reports()[0]).toMatchObject({ conversationId: 'conv_0', body: { outcome: 'failed', evidence: 'other_run_completed' } })
  }, 10_000)
})

describe('a pause is said plainly in status, until it ends', () => {
  const until24h = (): string => new Date(Date.now() + 24 * 3_600_000).toISOString()

  it('the server\'s `paused` answer → status names the conversation and when the pause ends; the ledger keeps it owner-only for a restart', async () => {
    await serve({ tray: { waiting: 1 } })
    const pausedUntil = until24h()
    double!.answerProcessingFailures({ action: 'paused', attempts: 3, hidden_message_ids: [], paused_until: pausedUntil })
    const runner = new ScriptedRunner('ok')
    runner.endings.set('conv_0', 'failed')
    const i = await integration(runner)
    await until(() => (i.snapshot().could_not_process?.paused_conversations.length ?? 0) === 1, 5_000)
    const status = readIntegrationStatus(home)
    expect(status?.could_not_process?.paused_conversations).toEqual([{ conversation_id: 'conv_0', paused_until: pausedUntil, at: expect.any(String) }])
    const lines = formatIntegrationStatus(status).join('\n')
    expect(lines).toContain(`could not process: 1 conversation paused until ${pausedUntil} (in 24 hour(s)) — conv_0: this agent's AI kept failing on messages there, so they are hidden from this agent`)
    expect(lines).toContain('1 report(s) answered (0 retry, 0 hidden, 1 paused, 0 nothing to do)')
    if (process.platform !== 'win32') expect(fs.statSync(couldNotProcessPath(home)).mode & 0o777).toBe(0o600)
    await i.stopAndWait(5_000)
    // The server mutes a paused conversation: nothing on the tray wakes it.
    double!.setTray({ waiting: 0 })

    // A restarted daemon for the same agent still says it; another agent's does not.
    const again = await integration(new ScriptedRunner('ok'))
    expect(again.snapshot().could_not_process?.paused_conversations.map((p) => p.conversation_id)).toEqual(['conv_0'])
    await again.stopAndWait(5_000)
    const other = await integration(new ScriptedRunner('ok'), {}, 'someone-else')
    expect(other.snapshot().could_not_process?.paused_conversations).toEqual([])
  }, 15_000)

  it('another answer for that conversation, or a completed run there, ends what was kept', () => {
    const ledger = new PausedConversations(home, 'me')
    ledger.record('conv_a', until24h())
    ledger.record('conv_b', until24h())
    expect(ledger.list().map((p) => p.conversation_id)).toEqual(['conv_b', 'conv_a'])
    ledger.clear('conv_a')
    expect(new PausedConversations(home, 'me').list().map((p) => p.conversation_id)).toEqual(['conv_b'])
  })

  it('an ended pause is not said, and a pause time that is not a time is not kept', () => {
    let now = Date.now()
    const ledger = new PausedConversations(home, 'me', () => now)
    ledger.record('conv_a', new Date(now + 60_000).toISOString())
    ledger.record('conv_b', 'not a time')
    expect(ledger.list().map((p) => p.conversation_id)).toEqual(['conv_a'])
    now += 61_000
    expect(ledger.list()).toEqual([])
    expect(describePausedConversations([{ conversation_id: 'conv_a', paused_until: new Date(now - 1).toISOString(), at: new Date(now).toISOString() }], now)).toBeNull()
  })

  it('several paused conversations are named (five at most) with their own ends', () => {
    const now = Date.parse('2026-11-19T12:00:00Z')
    const paused = Array.from({ length: 7 }, (_, n) => ({ conversation_id: `conv_${n}`, paused_until: new Date(now + (n + 1) * 3_600_000).toISOString(), at: new Date(now).toISOString() }))
    const line = describePausedConversations(paused, now)
    expect(line).toMatch(/^could not process: 7 conversations paused — conv_0 until 2026-11-19T13:00:00.000Z \(in 1 hour\(s\)\), conv_1 until /)
    expect(line).toContain('conv_4 until')
    expect(line).not.toContain('conv_5')
    expect(line).toContain(', and 2 more: ')
  })
})

describe('the status file: new fields read back; older and newer files still read', () => {
  const sample = (over: Partial<IntegrationStatus> = {}): IntegrationStatus => ({
    version: 2,
    updated_at: new Date().toISOString(),
    pid: 1,
    runtime: 'claude',
    handle: 'me',
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
    ...over,
  })
  const counts = (over: Partial<IntegrationCouldNotProcess> = {}): IntegrationCouldNotProcess => ({
    runtime_check: true,
    reported: 0,
    retry: 0,
    hidden: 0,
    paused: 0,
    none: 0,
    report_errors: 0,
    reruns: 0,
    reruns_capped: 0,
    awaiting_evidence: 0,
    runtime_checks_ok: 0,
    runtime_checks_failed: 0,
    last_runtime_check: null,
    paused_conversations: [],
    ...over,
  })

  it('a file an older daemon wrote (no new fields, `knock` runs) reads as before', () => {
    const old = { ...sample(), last_run: { kind: 'knock', started_at: 'x', ended_at: new Date().toISOString(), state: 'ok', exit_code: 0, duration_ms: 1, detail: null } }
    fs.writeFileSync(path.join(home, 'integration.status.json'), JSON.stringify(old))
    const read = readIntegrationStatus(home)
    expect(read?.last_run).toMatchObject({ kind: 'wake', conversation_id: null })
    expect(read?.could_not_process).toBeNull()
    expect(read?.failed_runs_in_a_row).toBeNull()
  })

  it('a run kind a newer daemon adds does not make the file unreadable (it reads as `wake`)', () => {
    const newer = { ...sample(), last_run: { kind: 'something-new', started_at: 'x', ended_at: new Date().toISOString(), state: 'ok', exit_code: 0, duration_ms: 1, detail: null } }
    fs.writeFileSync(path.join(home, 'integration.status.json'), JSON.stringify(newer))
    expect(readIntegrationStatus(home)?.last_run?.kind).toBe('wake')
  })

  it('the could-not-process block round-trips; nothing to say says nothing', () => {
    const block = counts({ reported: 2, retry: 1, hidden: 1, reruns: 2, runtime_checks_ok: 1, last_runtime_check: { at: new Date().toISOString(), ok: true, detail: null } })
    writeIntegrationStatus(home, sample({ could_not_process: block, failed_runs_in_a_row: 0 }))
    expect(readIntegrationStatus(home)?.could_not_process).toEqual(block)
    expect(describeCouldNotProcessCounts(counts())).toBeNull()
    expect(formatIntegrationStatus(sample({ could_not_process: counts() })).join('\n')).not.toContain('could not process')
    expect(describeCouldNotProcessCounts(block)).toBe(
      'could not process: 2 report(s) answered (1 retry, 1 hidden, 0 paused, 0 nothing to do); 2 run(s) started again; runtime check 1 ok, 0 failed (last: ok, just now) — since the daemon started',
    )
  })

  it('runs that keep failing with no runtime reason found are a warning (conversation-run cycles only say runs_started)', () => {
    const failing = sample({
      failed_runs_in_a_row: 3,
      last_run: { kind: 'conversation', conversation_id: 'conv_9', started_at: 'x', ended_at: new Date().toISOString(), state: 'failed', exit_code: 1, duration_ms: 1000, detail: 'exit 1' },
    })
    expect(repeatedFailedRuns(failing)).toBe(3)
    expect(formatIntegrationStatus(failing).join('\n')).toContain('WARNING: the last 3 runs did not get done (latest: failed — exit 1); the cards stay on the tray')
    expect(repeatedFailedRuns(sample({ failed_runs_in_a_row: 2 }))).toBeNull()
    // A runtime reason already explains it: said there, not twice.
    expect(repeatedFailedRuns(sample({ failed_runs_in_a_row: 5, runs_failing: { reason: 'x', since: 'y', runs_missed: 5, checked_at: 'z' } }))).toBeNull()
  })
})

describe('doctor says it too', () => {
  const sample = (over: Partial<IntegrationStatus>): IntegrationStatus => ({
    version: 2, updated_at: new Date().toISOString(), pid: 1, runtime: 'x', handle: 'probe', profile: 'own', socket: 'ready',
    wakes: 1, wakes_absorbed: 0, invites: 0, runs_started: 0, runs_ok: 0, runs_failed: 0, runs_timed_out: 0, runs_not_started: 0,
    runs_skipped_empty: 0, last_run: null, retry_rung: 0, retry_due_at: null, last_error: null, texts: null, ...over,
  })
  const block = (over: Partial<IntegrationCouldNotProcess>): IntegrationCouldNotProcess => ({
    runtime_check: true, reported: 0, retry: 0, hidden: 0, paused: 0, none: 0, report_errors: 0, reruns: 0, reruns_capped: 0,
    awaiting_evidence: 0, runtime_checks_ok: 0, runtime_checks_failed: 0, last_runtime_check: null, paused_conversations: [], ...over,
  })
  async function doctor(s: IntegrationStatus): Promise<string> {
    writeCredentials(home, { api_key: KEY, handle: 'probe' })
    writeIntegrationStatus(home, s)
    mockServedTexts('probe')
    vi.spyOn(AgentChatClient.prototype, 'getMe').mockResolvedValue({ handle: 'probe', status: 'active' } as never)
    const out: string[] = []
    vi.spyOn(console, 'log').mockImplementation((v) => void out.push(String(v)))
    const profile: HostProfile = { label: 'Example', id: 'example', client: { runtime: 'generic', version: '0' }, home: () => home, invocation: () => 'example', renderAnchor: (l) => l }
    await createIdentityCommands(profile).runDoctor({})
    return out.join('\n')
  }

  it('a paused conversation is a warning that names it and when the pause ends', async () => {
    const pausedUntil = new Date(Date.now() + 3 * 3_600_000).toISOString()
    const out = await doctor(sample({ could_not_process: block({ reported: 3, paused: 1, paused_conversations: [{ conversation_id: 'conv_x', paused_until: pausedUntil, at: new Date().toISOString() }] }) }))
    expect(out).toContain(`WARN could-not-process: 1 conversation paused until ${pausedUntil} (in 3 hour(s)) — conv_x: this agent's AI kept failing on messages there`)
  })

  it('a runtime check that fails is a warning: failures are then not reported as a conversation\'s', async () => {
    const out = await doctor(sample({ could_not_process: block({ runtime_checks_failed: 1, last_runtime_check: { at: '2026-11-19T10:00:00.000Z', ok: false, detail: 'claude runtime check failed: exit 1' } }) }))
    expect(out).toContain('WARN could-not-process: the runtime check failed (claude runtime check failed: exit 1; 2026-11-19T10:00:00.000Z): while it fails, a conversation whose run fails is not reported')
  })

  it('reports and answers with nothing paused pass, with the counts; nothing at all says nothing', async () => {
    const out = await doctor(sample({ could_not_process: block({ reported: 2, retry: 1, hidden: 1, reruns: 2 }) }))
    expect(out).toContain('PASS could-not-process: 2 report(s) answered (1 retry, 1 hidden, 0 paused, 0 nothing to do); 2 run(s) started again')
    vi.restoreAllMocks()
    expect(await doctor(sample({ could_not_process: block({}) }))).not.toContain('could-not-process')
  })

  it('runs that keep failing with no runtime reason found: a warning, with the latest', async () => {
    const out = await doctor(
      sample({
        failed_runs_in_a_row: 4,
        last_run: { kind: 'conversation', conversation_id: 'conv_y', started_at: 'x', ended_at: new Date().toISOString(), state: 'timed_out', exit_code: null, duration_ms: 600_000, detail: 'run exceeded its 600 s budget and was killed' },
      }),
    )
    expect(out).toContain('WARN runs: the last 4 runs did not get done (latest: timed_out — run exceeded its 600 s budget and was killed); the cards stay on the tray')
  })
})

describe('the run context a custom command gets (`runContextEnv`)', () => {
  it('a conversation run: its kind, its run id and AGENTCHAT_CONVERSATION_ID', () => {
    const env = runContextEnv({ PATH: '/bin' }, { kind: 'conversation', runId: 'run-1', conversationId: 'conv_7' })
    expect(env).toEqual({ PATH: '/bin', AGENTCHAT_WAKE_KIND: 'conversation', AGENTCHAT_RUN_ID: 'run-1', AGENTCHAT_CONVERSATION_ID: 'conv_7' })
    expect(RUN_CONTEXT_ENV).toEqual({ wakeKind: 'AGENTCHAT_WAKE_KIND', runId: 'AGENTCHAT_RUN_ID', conversationId: 'AGENTCHAT_CONVERSATION_ID' })
  })

  it('an invite or tray run carries no conversation id, not even one inherited from the listener\'s own environment (in any case)', () => {
    const inherited = { PATH: '/bin', AGENTCHAT_CONVERSATION_ID: 'conv_stale', agentchat_conversation_id: 'conv_stale2', AGENTCHAT_RUN_ID: 'old', AGENTCHAT_WAKE_KIND: 'old' }
    for (const kind of ['invite', 'wake'] as const) {
      const env = runContextEnv(inherited, { kind, runId: 'run-2' })
      expect(env).toEqual({ PATH: '/bin', AGENTCHAT_WAKE_KIND: kind, AGENTCHAT_RUN_ID: 'run-2' })
    }
    // The caller's object is not changed.
    expect(inherited.AGENTCHAT_CONVERSATION_ID).toBe('conv_stale')
  })
})
