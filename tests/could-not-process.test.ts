import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentChatClient, integration as kit } from 'agentchatme'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Integration } from '../src/integration/integration.js'
import { couldNotProcessPath, PausedConversations } from '../src/integration/could-not-process.js'
import { RUN_CONTEXT_ENV, runContextEnv } from '../src/integration/run-context.js'
import {
  clearIntegrationStatus,
  describeCouldNotProcessCounts,
  describePausedConversations,
  formatIntegrationStatus,
  INTEGRATION_STATUS_STALE_MS,
  integrationStatusFresh,
  integrationStatusStaleFor,
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

type Ending = 'ok' | 'failed' | 'silent' | 'timed_out' | 'not_started' | 'never' | 'hold'
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
    if (ending === 'hold') {
      // Runs until the integration stops it.
      await new Promise<void>((resolve) => request.signal?.addEventListener('abort', () => resolve(), { once: true }))
      return { state: 'failed', exitCode: null, durationMs: 1, detail: 'interrupted' }
    }
    if (ending === 'ok') return { state: 'ok', exitCode: 0, durationMs: 1 }
    if (ending === 'timed_out') return { state: 'timed_out', exitCode: null, durationMs: 1, detail: 'run exceeded its 1 s budget and was killed' }
    if (ending === 'not_started') return { state: 'not_started', exitCode: 127, durationMs: 1, detail: 'exit 127 with nothing on stdout' }
    // What spawnRun says of a run that ran past the not-started window and then exited non-zero with nothing on stdout.
    if (ending === 'silent') return { state: 'failed', silent: true, exitCode: 1, durationMs: 6_000, detail: 'exit 1 after 6 s with nothing on stdout (it ran, then ended)' }
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
    // `kind` stays within what a status reader from before conversation runs knows; `run_kind` says it.
    expect(i.snapshot().last_run).toMatchObject({ kind: 'wake', run_kind: 'conversation', conversation_id: 'conv_1', state: 'ok' })
    expect(readIntegrationStatus(home)?.last_run).toMatchObject({ kind: 'wake', run_kind: 'conversation', conversation_id: 'conv_1' })
    expect(i.snapshot().last_ok_run_at).toBe(i.snapshot().last_run?.ended_at)
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
    expect(i.snapshot().last_run).toMatchObject({ kind: 'invite', run_kind: 'invite', conversation_id: null })

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
  it('a run that failed → reported as `failed` through the card\'s anchor, with the runtime check as evidence', async () => {
    await serve({ tray: { waiting: 1 } })
    const runner = new ScriptedRunner('ok')
    runner.endings.set('conv_0', 'failed')
    const i = await integration(runner)
    await until(() => reports().length === 1, 5_000)
    expect(reports()[0]).toMatchObject({ conversationId: 'conv_0', body: { through_message_id: 'msg_0', outcome: 'failed', evidence: 'runtime_check' } })
    expect(reports()[0]?.idempotencyKey).toBeTruthy()
    await until(() => i.snapshot().could_not_process?.none === 1, 3_000)
    expect(i.snapshot().could_not_process).toMatchObject({ runtime_check: true, reported: 1, none: 1, runtime_checks_ok: 1 })
  }, 10_000)

  // A timed-out run is reported on another conversation's completed run (the
  // runtime check does not use the tools, hooks and memory a run does).
  it('a run that timed out → `RunEnd.timedOut`, reported as `timed_out` once another conversation\'s run completed', async () => {
    await serve({ tray: { waiting: 2 } })
    const runner = new ScriptedRunner(null)
    runner.endings.set('conv_0', 'timed_out')
    const i = await integration(runner)
    await until(() => reports().length === 1, 5_000)
    expect(reports()[0]).toMatchObject({ conversationId: 'conv_0', body: { through_message_id: 'msg_0', outcome: 'timed_out', evidence: 'other_run_completed' } })
    expect(i.snapshot()).toMatchObject({ runs_timed_out: 1, runs_ok: 1 })
  }, 10_000)

  // A silent failure (it ran, then exited non-zero with nothing on stdout) is
  // as ambiguous as a timeout: a broken hook, MCP server or instruction file
  // ends a run that way, and the runtime check loads none of them.
  it('a silent failure → `RunEnd.timedOut`: never reported on the runtime check alone, reported as `timed_out` once another conversation\'s run completed', async () => {
    const warn = vi.spyOn(log, 'warn')
    await serve({ tray: { waiting: 1 } })
    const runner = new ScriptedRunner('ok')
    runner.endings.set('conv_0', 'silent')
    const i = await integration(runner)
    await until(() => i.snapshot().runs_failed === 1, 5_000)
    await pause(500)
    // The check would pass (the runtime answers), but that is no evidence for a silent failure.
    expect(reports()).toHaveLength(0)
    // Counted as a failed run (status), with its detail as spawnRun wrote it; the log says why it waits.
    expect(i.snapshot()).toMatchObject({ runs_failed: 1, runs_timed_out: 0 })
    expect(i.snapshot().last_run).toMatchObject({ state: 'failed', detail: 'exit 1 after 6 s with nothing on stdout (it ran, then ended)' })
    expect(warn.mock.calls.some(([line]) => /^run failed kind=conversation conv=conv_0 id=\S+: exit 1 after 6 s with nothing on stdout \(it ran, then ended\) — its card stays on the tray; a silent failure counts as a timeout: it is reported \(could not process\) only once another conversation's run completes/.test(String(line)))).toBe(true)
    // Another conversation's run completes: the evidence.
    double!.setTray({ waiting: 2 })
    runner.endings.set('conv_0', 'ok')
    i.wake()
    await until(() => reports().length === 1, 5_000)
    expect(reports()[0]).toMatchObject({ conversationId: 'conv_0', body: { through_message_id: 'msg_0', outcome: 'timed_out', evidence: 'other_run_completed' } })
  }, 15_000)

  it('a silent failure next to a run that completed → reported as `timed_out` with that evidence', async () => {
    await serve({ tray: { waiting: 2 } })
    const runner = new ScriptedRunner(null)
    runner.endings.set('conv_0', 'silent')
    const i = await integration(runner)
    await until(() => reports().length === 1, 5_000)
    expect(reports()[0]).toMatchObject({ conversationId: 'conv_0', body: { through_message_id: 'msg_0', outcome: 'timed_out', evidence: 'other_run_completed' } })
    expect(i.snapshot()).toMatchObject({ runs_failed: 1, runs_ok: 1 })
  }, 10_000)

  it('a runner that never returns is abandoned at its deadline and counts as timed out (`timed_out` in the report)', async () => {
    await serve({ tray: { waiting: 2 } })
    const runner = new ScriptedRunner(null)
    runner.endings.set('conv_0', 'never')
    const i = await integration(runner, { budgetMs: 200, runnerDeadlineSlackMs: 100 })
    await until(() => reports().length === 1, 5_000)
    expect(reports()[0]?.body).toMatchObject({ outcome: 'timed_out', evidence: 'other_run_completed' })
    expect(i.snapshot()).toMatchObject({ runs_timed_out: 1 })
  }, 10_000)

  it('a cycle whose conversations are all running is not an empty tray: logged as such, not counted as skipped', async () => {
    const info = vi.spyOn(log, 'info')
    await serve({ tray: { waiting: 1 } })
    const runner = new ScriptedRunner(null)
    runner.endings.set('conv_0', 'hold')
    const i = await integration(runner)
    await until(() => runner.requests.length === 1, 5_000)
    i.wake()
    await until(() => info.mock.calls.some(([line]) => String(line).startsWith('wake: nothing new to start')), 5_000)
    const line = info.mock.calls.map(([l]) => String(l)).find((l) => l.startsWith('wake: nothing new to start'))
    expect(line).toBe('wake: nothing new to start — 1 conversation(s) already running or waiting (1 card(s), 0 invite(s))')
    expect(info.mock.calls.some(([l]) => String(l).includes('nothing owed'))).toBe(false)
    expect(i.snapshot().runs_skipped_empty).toBe(0)
    expect(runner.requests).toHaveLength(1)
  }, 10_000)

  it('a kit without the could-not-process block (an older SDK) does not stop the status write: zero counts', async () => {
    const original = kit.ReceiveLoop.prototype.status
    vi.spyOn(kit.ReceiveLoop.prototype, 'status').mockImplementation(function (this: kit.ReceiveLoop) {
      const { processingFailures: _gone, ...rest } = original.call(this)
      return rest as ReturnType<typeof original>
    })
    await serve({ tray: { waiting: 0 } })
    const i = await integration(new ScriptedRunner('ok'))
    expect(i.snapshot().could_not_process).toMatchObject({ reported: 0, awaiting_evidence: 0, last_runtime_check: null, runtime_check: true })
    expect(readIntegrationStatus(home)?.could_not_process?.reported).toBe(0)
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

describe('the server\'s answer, in the log: ids and counts only', () => {
  const ids = (n: number): string[] => Array.from({ length: n }, (_, k) => `msg_h${k}`)

  it('`hidden` says how many messages were hidden from `hidden_count`, not the capped id list', async () => {
    const info = vi.spyOn(log, 'info')
    await serve({ tray: { waiting: 1 } })
    double!.answerProcessingFailures({ action: 'hidden', attempts: 2, hidden_message_ids: ids(200), hidden_count: 250, paused_until: null })
    const runner = new ScriptedRunner('ok')
    runner.endings.set('conv_0', 'failed')
    await integration(runner)
    await until(() => info.mock.calls.some(([line]) => String(line).startsWith('could not process: conv=conv_0')), 5_000)
    const line = info.mock.calls.map(([l]) => String(l)).find((l) => l.startsWith('could not process: conv=conv_0'))
    expect(line).toContain('→ server: hidden (250 message(s) are now a note for this agent, still unread)')
    expect(line).not.toContain('msg_h')
  }, 10_000)

  it('`paused` with more hidden says `hidden_count` too; a server without `hidden_count` falls back to the list', async () => {
    const warn = vi.spyOn(log, 'warn')
    const info = vi.spyOn(log, 'info')
    await serve({ tray: { waiting: 1 } })
    const pausedUntil = new Date(Date.now() + 24 * 3_600_000).toISOString()
    double!.answerProcessingFailures({ action: 'paused', attempts: 3, hidden_message_ids: ids(200), hidden_count: 321, paused_until: pausedUntil })
    const runner = new ScriptedRunner('ok')
    runner.endings.set('conv_0', 'failed')
    const i = await integration(runner)
    await until(() => warn.mock.calls.some(([line]) => String(line).startsWith('could not process: conv=conv_0')), 5_000)
    expect(warn.mock.calls.map(([l]) => String(l)).find((l) => l.startsWith('could not process: conv=conv_0'))).toContain(`paused until ${pausedUntil} (321 more message(s) hidden)`)
    await i.stopAndWait(5_000)

    // An older server: no `hidden_count`, so the list is all there is.
    double!.setTray({ waiting: 1 })
    double!.answerProcessingFailures({ action: 'hidden', attempts: 2, hidden_message_ids: ids(3), paused_until: null })
    const again = new ScriptedRunner('ok')
    again.endings.set('conv_0', 'failed')
    await integration(again)
    await until(() => info.mock.calls.some(([line]) => String(line).includes('→ server: hidden (')), 5_000)
    expect(info.mock.calls.map(([l]) => String(l)).find((l) => l.includes('→ server: hidden ('))).toContain('hidden (3 message(s) are now a note for this agent, still unread)')
  }, 15_000)
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

  it('uninstall leaves nothing behind: clearIntegrationStatus removes the ledger with the status files', () => {
    new PausedConversations(home, 'me').record('conv_a', until24h())
    writeIntegrationStatus(home, { version: 2, updated_at: new Date().toISOString(), pid: 1, runtime: 'x', handle: 'me', profile: 'own', socket: 'idle', wakes: 0, wakes_absorbed: 0, invites: 0, runs_started: 0, runs_ok: 0, runs_failed: 0, runs_timed_out: 0, runs_not_started: 0, runs_skipped_empty: 0, last_run: null, retry_rung: 0, retry_due_at: null, last_error: null, texts: null })
    fs.writeFileSync(path.join(home, 'doorbell.status.json'), '{}')
    expect(fs.existsSync(couldNotProcessPath(home))).toBe(true)
    clearIntegrationStatus(home)
    for (const file of ['integration.status.json', 'doorbell.status.json', 'could-not-process.json']) expect(fs.existsSync(path.join(home, file)), file).toBe(false)
    expect(new PausedConversations(home, 'me').list()).toEqual([])
    // A home with none of them is fine.
    expect(() => clearIntegrationStatus(home)).not.toThrow()
  })

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
    expect(read?.last_run).toMatchObject({ kind: 'wake', run_kind: 'wake', conversation_id: null })
    expect(read?.could_not_process).toBeNull()
    expect(read?.failed_runs_in_a_row).toBeNull()
    expect(read?.last_ok_run_at).toBeNull()
  })

  it('a conversation run is written with `kind: wake`, so a reader that knows only wake and invite (0.6.0 and before) still reads the file', () => {
    const lastRun = { kind: 'wake' as const, run_kind: 'conversation' as const, conversation_id: 'conv_3', started_at: 'x', ended_at: new Date().toISOString(), state: 'ok' as const, exit_code: 0, duration_ms: 1, detail: null }
    writeIntegrationStatus(home, sample({ last_run: lastRun }))
    const written = JSON.parse(fs.readFileSync(path.join(home, 'integration.status.json'), 'utf-8')) as { last_run: { kind: string } }
    // The 0.6.0 reader's enum.
    expect(['wake', 'invite', 'knock']).toContain(written.last_run.kind)
    expect(readIntegrationStatus(home)?.last_run).toMatchObject({ kind: 'wake', run_kind: 'conversation', conversation_id: 'conv_3' })
    expect(formatIntegrationStatus(readIntegrationStatus(home)).join('\n')).toContain('last run: conversation conv_3, ok')
  })

  it('a run kind a newer daemon adds does not make the file unreadable (it reads as `wake`)', () => {
    const newer = { ...sample(), last_run: { kind: 'something-new', started_at: 'x', ended_at: new Date().toISOString(), state: 'ok', exit_code: 0, duration_ms: 1, detail: null } }
    fs.writeFileSync(path.join(home, 'integration.status.json'), JSON.stringify(newer))
    expect(readIntegrationStatus(home)?.last_run).toMatchObject({ kind: 'wake', run_kind: null })
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
      last_run: { kind: 'wake', run_kind: 'conversation', conversation_id: 'conv_9', started_at: 'x', ended_at: new Date().toISOString(), state: 'failed', exit_code: 1, duration_ms: 1000, detail: 'exit 1' },
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
    // A run that got done before the check does not clear it.
    const before = await doctor(sample({ last_ok_run_at: '2026-11-19T09:59:00.000Z', could_not_process: block({ runtime_checks_failed: 1, last_runtime_check: { at: '2026-11-19T10:00:00.000Z', ok: false, detail: 'x' } }) }))
    expect(before).toContain('WARN could-not-process: the runtime check failed')
  })

  it('the failed check is said only while the status file is fresh: from one nobody has written for minutes, doctor says the daemon may be down instead', async () => {
    const failing = block({ runtime_checks_failed: 1, last_runtime_check: { at: '2026-11-19T10:00:00.000Z', ok: false, detail: 'claude runtime check failed: exit 1' } })
    const stale = await doctor(sample({ updated_at: new Date(Date.now() - 2 * 3_600_000).toISOString(), could_not_process: failing }))
    expect(stale).toContain(
      'WARN could-not-process: the daemon has not written its status for 2 hour(s) — it may be down (a running daemon rewrites it every 30 s); the runtime check that failed at 2026-11-19T10:00:00.000Z says nothing about now',
    )
    expect(stale).not.toContain('could-not-process: the runtime check failed')
    expect(stale).not.toContain('not running')
    // The same words `status` uses for a status file this old.
    expect(formatIntegrationStatus(sample({ updated_at: new Date(Date.now() - 2 * 3_600_000).toISOString() })).join('\n')).toContain('— the daemon may be down')
    vi.restoreAllMocks()
    // Just inside the window (written 2 min ago): still the daemon's word.
    const fresh = await doctor(sample({ updated_at: new Date(Date.now() - 2 * 60_000).toISOString(), could_not_process: failing }))
    expect(fresh).toContain('WARN could-not-process: the runtime check failed (claude runtime check failed: exit 1; 2026-11-19T10:00:00.000Z)')
    vi.restoreAllMocks()
    // A pause is the server's, with its own end: said whether or not the daemon runs.
    const pausedUntil = new Date(Date.now() + 3 * 3_600_000).toISOString()
    const paused = await doctor(
      sample({ updated_at: new Date(Date.now() - 2 * 3_600_000).toISOString(), could_not_process: block({ ...failing, paused: 1, paused_conversations: [{ conversation_id: 'conv_p', paused_until: pausedUntil, at: new Date().toISOString() }] }) }),
    )
    expect(paused).toContain(`WARN could-not-process: 1 conversation paused until ${pausedUntil}`)
  })

  it('freshness: written within 3 minutes is the running daemon\'s word; older, or an unreadable time, is not', () => {
    const now = Date.parse('2026-11-19T12:00:00.000Z')
    const at = (ms: number): IntegrationStatus => sample({ updated_at: new Date(now - ms).toISOString() })
    expect(INTEGRATION_STATUS_STALE_MS).toBe(180_000)
    expect(integrationStatusFresh(at(0), now)).toBe(true)
    expect(integrationStatusFresh(at(180_000), now)).toBe(true)
    expect(integrationStatusFresh(at(180_001), now)).toBe(false)
    expect(integrationStatusFresh(sample({ updated_at: 'not a time' }), now)).toBe(false)
    expect(integrationStatusFresh(null, now)).toBe(false)
    expect(integrationStatusStaleFor(at(2 * 3_600_000), now)).toBe('2 hour(s)')
    expect(integrationStatusStaleFor(at(12 * 60_000), now)).toBe('12 minutes')
    expect(integrationStatusStaleFor(at(3 * 86_400_000), now)).toBe('3 day(s)')
    expect(integrationStatusStaleFor(sample({ updated_at: 'not a time' }), now)).toBe('an unknown time')
  })

  it('a failed check followed by a run that got done is history: PASS with the counts', async () => {
    const out = await doctor(
      sample({
        last_ok_run_at: '2026-11-19T10:05:00.000Z',
        could_not_process: block({ runtime_checks_failed: 1, last_runtime_check: { at: '2026-11-19T10:00:00.000Z', ok: false, detail: 'claude runtime check failed: exit 1' } }),
      }),
    )
    expect(out).not.toContain('WARN could-not-process')
    expect(out).toContain('PASS could-not-process: 0 report(s) answered (0 retry, 0 hidden, 0 paused, 0 nothing to do); runtime check 0 ok, 1 failed (last: failed')
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
        last_run: { kind: 'wake', run_kind: 'conversation', conversation_id: 'conv_y', started_at: 'x', ended_at: new Date().toISOString(), state: 'timed_out', exit_code: null, duration_ms: 600_000, detail: 'run exceeded its 600 s budget and was killed' },
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
