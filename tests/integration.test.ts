import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Integration } from '../src/integration/integration.js'
import { readIntegrationStatus } from '../src/integration/status.js'
import { offeredInvitesPath } from '../src/integration/invites.js'
import { textsCachePath, writeCachedTexts } from '../src/integration/texts.js'
import type { RunRequest, RunRunner } from '../src/integration/runner.js'
import type { TerminalReason } from '../src/integration/connection.js'
import { startServerDouble, until, pause, type ServerDouble } from './helpers/server-double.js'
import { textsFor } from './helpers/served-texts.js'

// ─── The integration against a server double: a wake is counted before a run ─
//
// Real SDK socket, real HTTP through the SDK, a fake runner. What is pinned
// here is what the socket cannot know: whether a wake deserves a run. It does
// when the tray has something unread or an invite is pending; it does not when
// both are empty — sleep/wake and deploys must not spend a run each. And what
// the run starts with: the server's own texts, fetched, with the one pointer
// line this runtime adds.

const CLIENT = { runtime: 'generic' as const, version: '0.0.0-test' }
const POINTER = '(The AgentChat manual is the agentchat skill, at /skills/agentchat/SKILL.md; the same text is at https://agentchat.me/skill.md.)'
const KEY = 'ac_' + 'k'.repeat(32)

class FakeRunner implements RunRunner {
  readonly name = 'fake-runtime'
  readonly requests: RunRequest[] = []
  /** Acks the double had received at the moment each run started. */
  readonly acksAtStart: string[][] = []
  aborted = 0
  constructor(
    private readonly double: () => ServerDouble,
    private readonly mode: 'ok' | 'hold' | 'not_started' = 'ok',
  ) {}
  async preflight() {
    return { ok: true }
  }
  async start(request: RunRequest) {
    this.requests.push(request)
    this.acksAtStart.push(this.double().acks())
    if (this.mode === 'not_started') return { state: 'not_started' as const, exitCode: 127, durationMs: 1, detail: 'exit 127 with nothing on stdout' }
    if (this.mode === 'ok') return { state: 'ok' as const, exitCode: 0, durationMs: 1 }
    await new Promise<void>((resolve) => request.signal?.addEventListener('abort', () => resolve(), { once: true }))
    this.aborted += 1
    return { state: 'failed' as const, exitCode: null, durationMs: 1, detail: 'interrupted' }
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
  for (const i of integrations) i.stop()
  await double.close()
  fs.rmSync(home, { recursive: true, force: true })
})

async function integration(runner: RunRunner, onTerminal?: (reason: TerminalReason, detail: string) => void): Promise<Integration> {
  const i = new Integration({
    cfg: { apiKey: KEY, handle: 'me', apiBase: double.apiBase, wsBase: double.wsBase, home, workdir: path.join(home, 'w') },
    runner,
    client: CLIENT,
    manualPointer: POINTER,
    profile: 'answer',
    budgetMs: 60_000,
    ...(onTerminal ? { onTerminal } : {}),
  })
  integrations.push(i)
  await i.start()
  return i
}

const trayCounts = (): number => double.requests.filter((r) => r === '/v1/inbox?limit=1').length
const textsFetches = (): number => double.requests.filter((r) => r.startsWith('/v1/texts')).length

/** What the server re-offers after hello for an unacked envelope — a plain `message.new`. */
const reoffered = (id: string) => ({
  type: 'message.new',
  payload: { id, conversation_id: 'conv_deferred', sender: 'peer', content: { text: 'A BODY THAT MUST NEVER BE READ' } },
})

describe('Integration — connect-time catch-up', () => {
  it('fetches the texts for its runtime, then on hello.ok: one connect wake and the invite list; the count finds both empty → no run', async () => {
    double = await startServerDouble({ tray: { waiting: 0 }, invites: [] })
    const runner = new FakeRunner(() => double)
    const i = await integration(runner)
    expect(double.requests[0]).toBe('/v1/texts?runtime=generic')
    await until(() => trayCounts() === 1 && double.requests.includes('/v1/groups/invites'), 5_000)
    await until(() => i.snapshot().runs_skipped_empty === 1)
    const snap = i.snapshot()
    expect(snap.socket).toBe('ready')
    expect(snap.wakes).toBe(1)
    expect(snap.invites).toBe(0)
    expect(snap.texts).toMatchObject({ source: 'server', version: '1', manual_version: '2.1.2' })
    expect(runner.requests).toHaveLength(0)
    expect(double.served[0]!.hello).toMatchObject({ client: 'generic', client_version: '0.0.0-test', capabilities: ['ack'] })
    expect(readIntegrationStatus(home)).toMatchObject({ version: 2, wakes: 1, texts: { source: 'server' } })
    expect(fs.existsSync(textsCachePath(home))).toBe(true)
  }, 10_000)

  it('a re-offered envelope on connect is ACKED (delivered = received) but, with nothing unread, starts no run — on every reconnect', async () => {
    double = await startServerDouble({ tray: { waiting: 0, deferred: 1 }, drain: [reoffered('msg_deferred')] })
    const runner = new FakeRunner(() => double)
    const i = await integration(runner)
    await until(() => i.snapshot().runs_skipped_empty === 1, 5_000)
    expect(i.snapshot().wakes).toBe(2) // the connect wake + the re-offered frame, coalesced into one cycle
    expect(trayCounts()).toBe(1)
    await until(() => double.acks().includes('msg_deferred'))

    // The server drops the socket (a deploy); the reconnect re-offers again.
    double.served[0]!.socket.close(1011, 'server restart')
    await until(() => double.served.length === 2 && i.snapshot().socket === 'ready', 5_000)
    await until(() => i.snapshot().runs_skipped_empty === 2, 5_000)
    await pause(200)
    expect(runner.requests).toHaveLength(0)
    expect(i.snapshot().runs_started).toBe(0)
    expect(JSON.stringify(i.snapshot())).not.toContain('BODY')
  }, 20_000)

  it('a live message (the tray has a card) is one wake cycle → one run, with the served wake text; the frame was acked before the run started', async () => {
    double = await startServerDouble({ tray: { waiting: 0 } })
    const runner = new FakeRunner(() => double)
    const i = await integration(runner)
    await until(() => i.snapshot().runs_skipped_empty === 1, 5_000) // the connect wake, empty
    double.setTray({ waiting: 1 })
    double.send({ type: 'message.new', payload: { id: 'msg_live', conversation_id: 'conv_1', sender: 'peer', content: { text: 'BODY' } } })
    await until(() => runner.requests.length === 1, 5_000)
    expect(runner.requests[0]).toMatchObject({ kind: 'wake', prompt: `${textsFor('me').wake_instruction}\n\n${POINTER}` })
    expect(runner.acksAtStart[0]).toEqual(['msg_live'])
    await pause(200)
    expect(runner.requests).toHaveLength(1)
    expect(i.snapshot()).toMatchObject({ runs_started: 1, runs_ok: 1, runs_skipped_empty: 1 })
    expect(runner.requests[0]!.prompt).not.toContain('BODY')
  }, 10_000)

  it('a `wake` frame (reminder) is handled exactly like a message.new: one coalesced wake → one run; nothing acked for it', async () => {
    double = await startServerDouble({ tray: { waiting: 0 } })
    const runner = new FakeRunner(() => double)
    const i = await integration(runner)
    await until(() => i.snapshot().runs_skipped_empty === 1, 5_000)
    double.setTray({ waiting: 1 })
    const at = new Date().toISOString()
    double.send({ type: 'wake', payload: { reason: 'reminder', conversation_id: 'conv_9', anchor_message_id: 'msg_90', step: 1, at } })
    double.send({ type: 'wake', payload: { reason: 'reminder', conversation_id: 'conv_8', anchor_message_id: 'msg_80', step: 2, at } })
    double.send({ type: 'message.new', payload: { id: 'msg_x', conversation_id: 'conv_9', sender: 'peer' } })
    await until(() => runner.requests.length === 1, 5_000)
    await pause(300)
    expect(runner.requests).toHaveLength(1)
    expect(runner.requests[0]!.kind).toBe('wake')
    expect(i.snapshot().wakes).toBe(4) // connect + 2 reminders + 1 message, in two cycles
    expect(double.acks()).toEqual(['msg_x'])
  }, 10_000)

  it('a non-empty tray on connect is exactly one wake → one run; the card itself is never read', async () => {
    double = await startServerDouble({ tray: { waiting: 3 } })
    const runner = new FakeRunner(() => double)
    const i = await integration(runner)
    await until(() => i.snapshot().wakes === 1)
    await until(() => runner.requests.length === 1, 5_000)
    expect(i.snapshot().runs_skipped_empty).toBe(0)
    expect(runner.requests[0]).toMatchObject({ kind: 'wake' })
    expect(JSON.stringify(i.snapshot())).not.toContain('PREVIEW')
  }, 10_000)

  it('a refused key is terminal with reason auth, starts no run, does not reconnect, and status says terminal', async () => {
    double = await startServerDouble({ upgrade: 'refuse', tray: { waiting: 5 } })
    const runner = new FakeRunner(() => double)
    const terminal: Array<{ reason: TerminalReason; detail: string }> = []
    const i = await integration(runner, (reason, detail) => terminal.push({ reason, detail }))
    await until(() => terminal.length === 1)
    expect(terminal[0]!.reason).toBe('auth')
    await pause(1_500)
    expect(double.upgrades).toBe(1)
    expect(double.requests.filter((r) => !r.startsWith('/v1/texts'))).toEqual([]) // no catch-up without hello.ok
    expect(runner.requests).toHaveLength(0)
    // `closed` would read as a clean shutdown and hide the refusal.
    expect(i.snapshot().socket).toBe('terminal')
    expect(i.snapshot().last_error).toMatch(/auth rejected/)
    expect(readIntegrationStatus(home)?.socket).toBe('terminal')
  })

  it('stopAndWait interrupts the run in flight and resolves once it has ended', async () => {
    double = await startServerDouble({ tray: { waiting: 1 } })
    const runner = new FakeRunner(() => double, 'hold')
    const i = await integration(runner)
    await until(() => runner.requests.length === 1, 5_000)
    const started = Date.now()
    expect(await i.stopAndWait(2_000)).toBe(true)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(runner.aborted).toBe(1)
    expect(runner.requests[0]!.signal?.aborted).toBe(true)
    expect(i.snapshot().socket).toBe('closed')
  }, 10_000)
})

describe('Integration — invites across restarts', () => {
  it('pending invites are surfaced on connect, one run each with the served invite prompt, deduplicated against the live frame', async () => {
    double = await startServerDouble({ invites: [{ id: 'gri_1', group_id: 'grp_1', group_name: 'Ops', inviter_handle: 'bob' }] })
    const runner = new FakeRunner(() => double)
    const i = await integration(runner)
    await until(() => runner.requests.length === 1)
    expect(runner.requests[0]).toMatchObject({ kind: 'invite', prompt: `${textsFor('me').invite_prompt}\n\n${POINTER}` })
    // The same invite arriving live afterwards is not a second run.
    double.send({ type: 'group.invite.received', payload: { invite_id: 'gri_1', group_id: 'grp_1' } })
    await pause(300)
    expect(runner.requests).toHaveLength(1)
    expect(i.snapshot().invites).toBe(1)
    expect(fs.existsSync(offeredInvitesPath(home))).toBe(true)
  })

  it('a daemon restart does not start one run per still-pending invite: offered once per machine', async () => {
    double = await startServerDouble({ invites: [{ id: 'gri_1' }, { id: 'gri_2' }] })
    const first = new FakeRunner(() => double)
    const a = await integration(first)
    await until(() => first.requests.length === 2, 5_000)
    a.stop()

    // Restart: the server still lists both (the agent left them pending).
    const second = new FakeRunner(() => double)
    const b = await integration(second)
    await until(() => double.requests.filter((r) => r === '/v1/groups/invites').length === 2, 5_000)
    await pause(300)
    expect(second.requests).toHaveLength(0)
    expect(b.snapshot().invites).toBe(0)
  }, 15_000)

  it('an invite whose run did not start is offered again by the restarted daemon, not lost', async () => {
    double = await startServerDouble({ invites: [{ id: 'gri_lost' }] })
    const broken = new FakeRunner(() => double, 'not_started')
    const a = await integration(broken)
    await until(() => broken.requests.length === 1, 5_000)
    await until(() => a.snapshot().runs_not_started === 1)
    a.stop()

    const healthy = new FakeRunner(() => double)
    await integration(healthy)
    await until(() => healthy.requests.length === 1, 5_000)
    expect(healthy.requests[0]!.kind).toBe('invite')
  }, 15_000)
})

describe('Integration — the served texts', () => {
  it('starts with the texts unreachable and nothing cached; a run waits; the first wake after the server answers runs with the served text', async () => {
    double = await startServerDouble({ tray: { waiting: 1 }, textsStatus: 503 })
    const runner = new FakeRunner(() => double)
    const i = await integration(runner) // does not throw
    expect(i.snapshot().texts).toMatchObject({ source: 'none' })
    // The connect wake: the tray has a card, but no text in hand → not started, ladder armed.
    await until(() => i.snapshot().runs_not_started === 1, 5_000)
    expect(runner.requests).toHaveLength(0)
    expect(i.snapshot().last_run?.detail).toMatch(/no served texts/)
    expect(i.snapshot().retry_rung).toBe(1)
    const fetchesBefore = textsFetches()

    // The server comes back; the next wake fetches on first use and runs.
    double.setTextsStatus(200)
    double.send({ type: 'message.new', payload: { id: 'msg_1', conversation_id: 'conv_1', sender: 'peer' } })
    await until(() => runner.requests.length === 1, 5_000)
    expect(textsFetches()).toBeGreaterThan(fetchesBefore)
    expect(runner.requests[0]!.prompt.startsWith(textsFor('me').wake_instruction)).toBe(true)
    expect(i.snapshot().texts).toMatchObject({ source: 'server' })
  }, 15_000)

  it('starts offline on the identity-home cache: the run uses the cached text and status says so', async () => {
    double = await startServerDouble({ tray: { waiting: 1 }, textsStatus: 503 })
    writeCachedTexts(home, 'generic', { ...textsFor('me'), wake_instruction: 'CACHED WAKE INSTRUCTION' }, new Date('2026-11-01T00:00:00Z'))
    const runner = new FakeRunner(() => double)
    const i = await integration(runner)
    await until(() => runner.requests.length === 1, 5_000)
    expect(runner.requests[0]!.prompt).toBe(`CACHED WAKE INSTRUCTION\n\n${POINTER}`)
    expect(i.snapshot().texts).toMatchObject({ source: 'cache', fetched_at: '2026-11-01T00:00:00.000Z' })
  }, 10_000)
})
