import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Integration } from '../src/integration/integration.js'
import { readIntegrationStatus } from '../src/integration/status.js'
import { textsCachePath } from '../src/integration/texts.js'
import { readManualVersion } from '../src/skill/served-manual.js'
import type { RunOutcome, RunRequest, RunRunner } from '../src/integration/runner.js'
import { startServerDouble, until, pause, type ServerDouble } from './helpers/server-double.js'
import { textsFor } from './helpers/served-texts.js'

// ─── The integration on the SDK kit, against a server double ────────────────
//
// Real SDK socket and receive loop, real HTTP through the SDK, a fake runner.
// What is pinned here is this package's side of single-run mode: a wake
// deserves a run when the tray owes something (an unmuted card, a pending
// invite) and none when it does not; the run starts with the server's own
// text plus the one pointer line this runtime adds; every message.new was
// acked before the run; nothing is retried locally (the server re-wakes);
// a runner that never returns cannot hold the loop.

const CLIENT = { runtime: 'generic' as const, version: '0.0.0-test' }
const POINTER = '(The AgentChat manual is the agentchat skill, at /skills/agentchat/SKILL.md; the same text is at https://agentchat.me/skill.md.)'
const KEY = 'ac_' + 'k'.repeat(32)

type Mode = 'ok' | 'hold' | 'not_started' | 'never'

class FakeRunner implements RunRunner {
  readonly name = 'fake-runtime'
  readonly requests: RunRequest[] = []
  /** Acks the double had received at the moment each run started. */
  readonly acksAtStart: string[][] = []
  aborted = 0
  constructor(
    private readonly double: () => ServerDouble,
    public mode: Mode = 'ok',
  ) {}
  async preflight() {
    return { ok: true }
  }
  async start(request: RunRequest): Promise<RunOutcome> {
    this.requests.push(request)
    this.acksAtStart.push(this.double().acks())
    if (this.mode === 'not_started') return { state: 'not_started', exitCode: 127, durationMs: 1, detail: 'exit 127 with nothing on stdout' }
    if (this.mode === 'ok') return { state: 'ok', exitCode: 0, durationMs: 1 }
    if (this.mode === 'never') return new Promise<RunOutcome>(() => undefined)
    await new Promise<void>((resolve) => request.signal?.addEventListener('abort', () => resolve(), { once: true }))
    this.aborted += 1
    return { state: 'failed', exitCode: null, durationMs: 1, detail: 'interrupted' }
  }
}

let home: string
let double: ServerDouble
let integrations: Integration[]

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-integration-'))
  integrations = []
})
afterEach(async () => {
  for (const i of integrations) await i.stopAndWait(5_000)
  await double.close()
  fs.rmSync(home, { recursive: true, force: true })
})

async function integration(runner: RunRunner, extra: Partial<ConstructorParameters<typeof Integration>[0]> = {}): Promise<Integration> {
  const i = new Integration({
    cfg: { apiKey: KEY, handle: 'me', apiBase: double.apiBase, wsBase: double.wsBase, home, workdir: path.join(home, 'w') },
    runner,
    client: CLIENT,
    manualPointer: POINTER,
    profile: 'answer',
    budgetMs: 60_000,
    // A short coalescing window keeps the tests quick; the kit tests the window itself.
    quietMs: 50,
    maxMs: 200,
    ...extra,
  })
  integrations.push(i)
  await i.start()
  return i
}

const trayReads = (): number => double.requests.filter((r) => r.startsWith('/v1/inbox')).length
const textsFetches = (): number => double.requests.filter((r) => r.startsWith('/v1/texts')).length

/** What the server re-offers after hello for an unacked envelope — a plain `message.new`. */
const reoffered = (id: string) => ({
  type: 'message.new',
  payload: { id, conversation_id: 'conv_deferred', sender: 'peer', content: { text: 'A BODY THAT MUST NEVER BE READ' } },
})

describe('Integration — single-run mode on the kit', () => {
  it('fetches the texts for its runtime, then holds a socket offering ack, heartbeat and rewake; an empty tray on connect starts no run', async () => {
    double = await startServerDouble({ tray: { waiting: 0 }, helloCapabilities: ['ack', 'heartbeat', 'rewake'] })
    const runner = new FakeRunner(() => double)
    const i = await integration(runner)
    expect(double.requests[0]).toBe('/v1/texts?runtime=generic')
    await until(() => i.snapshot().runs_skipped_empty === 1, 5_000)
    const snap = i.snapshot()
    expect(snap).toMatchObject({ socket: 'ready', wakes: 1, runs_started: 0, retry_rung: 0, retry_due_at: null, capabilities: ['ack', 'heartbeat', 'rewake'] })
    expect(snap.texts).toMatchObject({ source: 'server', version: '1', manual_version: '2.1.2' })
    expect(runner.requests).toHaveLength(0)
    expect(double.served[0]!.hello).toMatchObject({ client: 'generic', client_version: '0.0.0-test' })
    expect(double.served[0]!.hello?.['capabilities']).toEqual(expect.arrayContaining(['ack', 'heartbeat', 'rewake']))
    // No invite listing any more: pending invites are on the tray (D4).
    expect(double.requests.some((r) => r.startsWith('/v1/groups/invites'))).toBe(false)
    expect(readIntegrationStatus(home)).toMatchObject({ version: 2, wakes: 1, capabilities: ['ack', 'heartbeat', 'rewake'] })
    expect(fs.existsSync(textsCachePath(home))).toBe(true)
  }, 10_000)

  it('a re-offered envelope is ACKED (delivered = received) but, with nothing on the tray, starts no run', async () => {
    double = await startServerDouble({ tray: { waiting: 0, deferred: 1 }, drain: [reoffered('msg_deferred')] })
    const runner = new FakeRunner(() => double)
    const i = await integration(runner)
    await until(() => double.acks().includes('msg_deferred'))
    await until(() => i.snapshot().runs_skipped_empty >= 1, 5_000)
    await pause(300)
    expect(runner.requests).toHaveLength(0)
  }, 10_000)

  it('a live message with a card on the tray is one cycle → one run: the served wake text and the pointer; the frame acked before the run', async () => {
    double = await startServerDouble({ tray: { waiting: 0 } })
    const runner = new FakeRunner(() => double)
    const i = await integration(runner)
    await until(() => i.snapshot().runs_skipped_empty === 1, 5_000)
    double.setTray({ waiting: 1 })
    double.send({ type: 'message.new', payload: { id: 'msg_live', conversation_id: 'conv_0', sender: 'peer', content: { text: 'A BODY THAT MUST NEVER BE READ' } } })
    double.send({ type: 'message.new', payload: { id: 'msg_live2', conversation_id: 'conv_0', sender: 'peer', content: { text: 'x' } } })
    await until(() => runner.requests.length === 1, 5_000)
    await pause(300)
    expect(runner.requests).toHaveLength(1)
    const [request] = runner.requests
    expect(request).toMatchObject({ kind: 'wake', budgetMs: 60_000 })
    expect(request?.prompt).toBe(`${textsFor('me').wake_instruction}\n\n${POINTER}`)
    expect(runner.acksAtStart[0]).toEqual(expect.arrayContaining(['msg_live']))
    expect(JSON.stringify(runner.requests)).not.toContain('MUST NEVER BE READ')
  }, 10_000)

  it('this agent\'s own echo is no wake', async () => {
    double = await startServerDouble({ tray: { waiting: 1 } })
    const runner = new FakeRunner(() => double)
    const i = await integration(runner)
    await until(() => runner.requests.length === 1, 5_000)
    const wakes = i.snapshot().wakes
    double.send({ type: 'message.new', payload: { id: 'msg_echo', conversation_id: 'conv_0', sender: 'me', content: { text: 'mine' } } })
    await until(() => double.acks().includes('msg_echo'))
    await pause(300)
    expect(i.snapshot().wakes).toBe(wakes)
    expect(runner.requests).toHaveLength(1)
  }, 10_000)

  it('a reminder wake frame and an unanswered re-wake (contract v1) each start one run; nothing is acked for them', async () => {
    double = await startServerDouble({ tray: { waiting: 0 }, helloCapabilities: ['ack', 'heartbeat', 'rewake'] })
    const runner = new FakeRunner(() => double)
    const i = await integration(runner)
    await until(() => i.snapshot().runs_skipped_empty === 1, 5_000)
    double.setTray({ waiting: 1 })
    double.send({ type: 'wake', payload: { reason: 'reminder', conversation_id: 'conv_0', anchor_message_id: 'msg_0', step: 1, at: new Date().toISOString() } })
    await until(() => runner.requests.length === 1, 5_000)
    double.send({ type: 'wake', payload: { reason: 'unanswered', conversation_ids: ['conv_0'], step: 2, at: new Date().toISOString() } })
    await until(() => runner.requests.length === 2, 5_000)
    expect(double.acks()).toEqual([])
  }, 10_000)

  it('a tray of muted cards only owes nothing: no run', async () => {
    double = await startServerDouble({ tray: { waiting: 2, muted: 2 } })
    const runner = new FakeRunner(() => double)
    const i = await integration(runner)
    await until(() => i.snapshot().runs_skipped_empty === 1, 5_000)
    expect(runner.requests).toHaveLength(0)
  }, 10_000)

  it('a pending invite on the tray alone is an invite run with the served invite prompt; with cards it rides along in the wake run', async () => {
    double = await startServerDouble({ tray: { waiting: 0, invites: ['inv_1'] } })
    const runner = new FakeRunner(() => double)
    const i = await integration(runner)
    await until(() => runner.requests.length === 1, 5_000)
    expect(runner.requests[0]).toMatchObject({ kind: 'invite' })
    expect(runner.requests[0]?.prompt).toBe(`${textsFor('me').invite_prompt}\n\n${POINTER}`)
    expect(JSON.stringify(runner.requests[0])).not.toContain('A GROUP NAME')

    double.setTray({ waiting: 1, invites: ['inv_1'] })
    double.send({ type: 'group.invite.received', payload: { invite_id: 'inv_2', group_id: 'grp_2' } })
    await until(() => runner.requests.length === 2, 5_000)
    expect(runner.requests[1]).toMatchObject({ kind: 'wake' })
    expect(runner.requests[1]?.prompt).toBe(`${textsFor('me').wake_instruction}\n\n${textsFor('me').invite_prompt}\n\n${POINTER}`)
    expect(i.snapshot().invites).toBe(1)
  }, 10_000)

  it('an invite two completed runs left pending is dismissed once (the kit\'s single-run rule); then it costs no run', async () => {
    double = await startServerDouble({ tray: { waiting: 0, invites: ['gri_1'] } })
    const runner = new FakeRunner(() => double)
    const i = await integration(runner)
    await until(() => runner.requests.length === 1, 5_000)
    await pause(200)
    expect(double.dismissed).toEqual([])
    // A second wake: the invite is still pending after this completed run too.
    double.send({ type: 'group.invite.received', payload: { invite_id: 'gri_1' } })
    await until(() => double.dismissed.length === 1, 5_000)
    expect(runner.requests).toHaveLength(2)
    expect(double.dismissed).toEqual(['gri_1'])
    // Off the tray now: the next wake finds nothing owed.
    const skipped = i.snapshot().runs_skipped_empty
    double.send({ type: 'message.new', payload: { id: 'msg_after', conversation_id: 'conv_x', sender: 'peer', content: { text: 'x' } } })
    await until(() => i.snapshot().runs_skipped_empty === skipped + 1, 5_000)
    expect(runner.requests).toHaveLength(2)
  }, 10_000)

  it('a run that did not complete counts for nothing: the invite is not dismissed', async () => {
    double = await startServerDouble({ tray: { waiting: 0, invites: ['gri_2'] } })
    const runner = new FakeRunner(() => double, 'not_started')
    await integration(runner)
    await until(() => runner.requests.length === 1, 5_000)
    double.send({ type: 'group.invite.received', payload: { invite_id: 'gri_2' } })
    await until(() => runner.requests.length === 2, 5_000)
    await pause(300)
    expect(double.dismissed).toEqual([])
  }, 10_000)

  it('a run that did not start leaves the cards on the tray and retries nothing locally (the server re-wakes)', async () => {
    double = await startServerDouble({ tray: { waiting: 1 } })
    const runner = new FakeRunner(() => double, 'not_started')
    const i = await integration(runner)
    await until(() => runner.requests.length === 1, 5_000)
    await pause(600)
    expect(runner.requests).toHaveLength(1)
    expect(i.snapshot()).toMatchObject({ runs_not_started: 1, retry_rung: 0, retry_due_at: null, last_run: { state: 'not_started' } })
  }, 10_000)

  it('a runner that never returns is abandoned past its budget plus the slack; the next wake runs', async () => {
    double = await startServerDouble({ tray: { waiting: 1 } })
    const runner = new FakeRunner(() => double, 'never')
    const i = await integration(runner, { budgetMs: 200, runnerDeadlineSlackMs: 200 })
    await until(() => i.snapshot().runs_timed_out === 1, 5_000)
    expect(i.snapshot().last_run?.detail).toMatch(/did not return/)
    runner.mode = 'ok'
    double.send({ type: 'message.new', payload: { id: 'msg_next', conversation_id: 'conv_0', sender: 'peer', content: { text: 'x' } } })
    await until(() => i.snapshot().runs_ok === 1, 5_000)
  }, 10_000)

  it('a refused key reads socket blocked with the refusal as the last error and starts no run', async () => {
    double = await startServerDouble({ upgrade: 'refuse', tray: { waiting: 3 } })
    const runner = new FakeRunner(() => double)
    const i = await integration(runner)
    await until(() => i.snapshot().socket === 'blocked', 5_000)
    expect(i.snapshot().last_error).toMatch(/auth rejected \(close 1008 Invalid token\)/)
    await pause(500)
    expect(runner.requests).toHaveLength(0)
    expect(double.upgrades).toBe(1)
  }, 10_000)

  it('stopAndWait interrupts the run in flight (its signal) and resolves once it has ended', async () => {
    double = await startServerDouble({ tray: { waiting: 1 } })
    const runner = new FakeRunner(() => double, 'hold')
    const i = await integration(runner)
    await until(() => runner.requests.length === 1, 5_000)
    expect(await i.stopAndWait(5_000)).toBe(true)
    expect(runner.aborted).toBe(1)
    expect(i.snapshot().socket).toBe('closed')
  }, 10_000)
})

describe('Integration — what the run is told, and what is recorded', () => {
  it('each run carries the wake that started it: messages, reminder, unanswered with its step, invite', async () => {
    double = await startServerDouble({ tray: { waiting: 0 }, helloCapabilities: ['ack', 'heartbeat', 'rewake'] })
    const runner = new FakeRunner(() => double)
    const i = await integration(runner)
    await until(() => i.snapshot().runs_skipped_empty === 1, 5_000)
    double.setTray({ waiting: 1 })
    double.send({ type: 'message.new', payload: { id: 'msg_w1', conversation_id: 'conv_0', sender: 'peer', content: { text: 'x' } } })
    await until(() => runner.requests.length === 1, 5_000)
    double.send({ type: 'wake', payload: { reason: 'reminder', conversation_id: 'conv_0', anchor_message_id: 'msg_0', step: 1, at: new Date().toISOString() } })
    await until(() => runner.requests.length === 2, 5_000)
    double.send({ type: 'wake', payload: { reason: 'unanswered', conversation_ids: ['conv_0'], step: 3, at: new Date().toISOString() } })
    await until(() => runner.requests.length === 3, 5_000)
    double.setTray({ waiting: 0, invites: ['gri_9'] })
    double.send({ type: 'group.invite.received', payload: { invite_id: 'gri_9' } })
    await until(() => runner.requests.length === 4, 5_000)
    expect(runner.requests.map((r) => r.wake)).toEqual([{ reason: 'messages' }, { reason: 'reminder' }, { reason: 'unanswered', step: 3 }, { reason: 'invite' }])
  }, 15_000)

  it('dismissIgnoredInvites: false — two completed runs leave an invite pending and nothing is dismissed', async () => {
    double = await startServerDouble({ tray: { waiting: 0, invites: ['gri_3'] } })
    const runner = new FakeRunner(() => double)
    await integration(runner, { dismissIgnoredInvites: false })
    await until(() => runner.requests.length === 1, 5_000)
    double.send({ type: 'group.invite.received', payload: { invite_id: 'gri_3' } })
    await until(() => runner.requests.length === 2, 5_000)
    double.send({ type: 'group.invite.received', payload: { invite_id: 'gri_3' } })
    await until(() => runner.requests.length === 3, 5_000)
    await pause(300)
    expect(double.dismissed).toEqual([])
  }, 15_000)

  it('the status file keeps the recent wake cycles: outcomes and counts, a bounded failure line', async () => {
    double = await startServerDouble({ tray: { waiting: 1 } })
    const runner = new FakeRunner(() => double, 'not_started')
    const i = await integration(runner)
    await until(() => (i.snapshot().recent_cycles ?? []).length >= 1, 5_000)
    const status = readIntegrationStatus(home)
    expect(status?.recent_cycles?.[0]).toMatchObject({ outcome: 'run_not_started', cards: 1, invites: 0 })
    expect((status?.recent_cycles?.[0]?.failure ?? '').length).toBeLessThanOrEqual(240)
    expect(JSON.stringify(status?.recent_cycles)).not.toContain('PREVIEW')
  }, 10_000)
})

describe('Integration — the served texts', () => {
  it('with the texts unreachable and nothing cached, a wake starts no run; once the server answers, the next wake runs with the served text', async () => {
    double = await startServerDouble({ tray: { waiting: 1 }, textsStatus: 503 })
    const runner = new FakeRunner(() => double)
    const i = await integration(runner)
    await until(() => i.snapshot().runs_not_started === 1, 5_000)
    expect(runner.requests).toHaveLength(0)
    double.setTextsStatus(200)
    double.send({ type: 'message.new', payload: { id: 'msg_1', conversation_id: 'conv_0', sender: 'peer', content: { text: 'x' } } })
    await until(() => runner.requests.length === 1, 5_000)
    expect(runner.requests[0]?.prompt.startsWith(textsFor('me').wake_instruction)).toBe(true)
    expect(textsFetches()).toBeGreaterThanOrEqual(2)
  }, 10_000)

  it('starts offline on the identity-home copy: the run uses the cached text and status says so', async () => {
    double = await startServerDouble({ tray: { waiting: 1 }, textsStatus: 503 })
    const cached = { ...textsFor('me'), wake_instruction: 'CACHED WAKE INSTRUCTION' }
    fs.writeFileSync(textsCachePath(home), JSON.stringify({ version: 1, fetched_at: '2026-11-01T00:00:00.000Z', runtime: 'generic', texts: cached }))
    const runner = new FakeRunner(() => double)
    const i = await integration(runner)
    await until(() => runner.requests.length === 1, 5_000)
    expect(runner.requests[0]?.prompt).toBe(`CACHED WAKE INSTRUCTION\n\n${POINTER}`)
    expect(i.snapshot().texts).toMatchObject({ source: 'cache', fetched_at: '2026-11-01T00:00:00.000Z' })
  }, 10_000)

  it('the skill file follows the announced manual (downloaded from the served address, no credentials sent)', async () => {
    const body = '---\nname: agentchat\nversion: 7.0.0\n---\n\nThe manual.\n'
    double = await startServerDouble({ tray: { waiting: 0 }, manual: { version: '7.0.0', body } })
    const manualPath = path.join(home, 'skills', 'agentchat', 'SKILL.md')
    await integration(new FakeRunner(() => double), { manualPath })
    await until(() => readManualVersion(manualPath) === '7.0.0', 5_000)
    expect(fs.readFileSync(manualPath, 'utf-8')).toBe(body)
    expect(double.manualAuth).toEqual([undefined])
  }, 10_000)
})

describe('Integration — what is never read', () => {
  it('the tray is read with the SDK (cards counted, previews never kept); trays are read once per cycle', async () => {
    double = await startServerDouble({ tray: { waiting: 1 } })
    const runner = new FakeRunner(() => double)
    const i = await integration(runner)
    await until(() => runner.requests.length === 1, 5_000)
    expect(trayReads()).toBe(1)
    expect(JSON.stringify(i.snapshot())).not.toContain('PREVIEW')
    expect(fs.readFileSync(path.join(home, 'integration.status.json'), 'utf-8')).not.toContain('PREVIEW')
  }, 10_000)
})
