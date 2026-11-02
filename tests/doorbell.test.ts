import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Doorbell } from '../src/doorbell/doorbell.js'
import { readDoorbellStatus } from '../src/doorbell/status.js'
import type { RunRequest, RunRunner } from '../src/doorbell/runner.js'
import type { TerminalReason } from '../src/doorbell/socket.js'
import { startServerDouble, until, pause, type ServerDouble } from './helpers/server-double.js'

// ─── The doorbell against a server double: a knock is counted before a run ──
//
// Real socket, real HTTP, a fake runner. What is pinned here is the one thing
// the socket cannot know: whether a knock deserves a run. It does when the
// tray has something waiting or an invite is pending; it does not when both
// are empty — sleep/wake and deploys must not spend a run each, and neither
// must the server's connect-time drain re-offering a DEFERRED envelope (which
// `defer` leaves stored and the tray hides).

class FakeRunner implements RunRunner {
  readonly name = 'fake-runtime'
  readonly requests: RunRequest[] = []
  aborted = 0
  constructor(private readonly hold = false) {}
  async preflight() {
    return { ok: true }
  }
  async start(request: RunRequest) {
    this.requests.push(request)
    if (!this.hold) return { state: 'ok' as const, exitCode: 0, durationMs: 1 }
    await new Promise<void>((resolve) => request.signal?.addEventListener('abort', () => resolve(), { once: true }))
    this.aborted += 1
    return { state: 'failed' as const, exitCode: null, durationMs: 1, detail: 'interrupted' }
  }
}

let home: string
let double: ServerDouble
let bells: Doorbell[]
const prompts = { knock: 'K', invite: 'I' }

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-doorbell-'))
  bells = []
})
afterEach(async () => {
  for (const b of bells) b.stop()
  await double.close()
  fs.rmSync(home, { recursive: true, force: true })
})

async function bell(runner: RunRunner, onTerminal?: (reason: TerminalReason, detail: string) => void): Promise<Doorbell> {
  const b = new Doorbell({
    cfg: { apiKey: 'ac_' + 'k'.repeat(32), handle: 'me', apiBase: double.apiBase, wsUrl: double.wsUrl, home, workdir: path.join(home, 'w') },
    runner,
    prompts,
    profile: 'answer',
    budgetMs: 60_000,
    ...(onTerminal ? { onTerminal } : {}),
  })
  bells.push(b)
  await b.start()
  return b
}

const trayCounts = (): number => double.requests.filter((r) => r === '/v1/inbox?wait_ms=0&limit=1').length

/** A drain frame: what `drainUndelivered` sends for a stored envelope — a plain `message.new`. */
const drained = (id: string) => ({
  type: 'message.new',
  payload: { id, conversation_id: 'conv_deferred', sender: 'peer', content: { text: 'A BODY THAT MUST NEVER BE READ' } },
})

describe('Doorbell — connect-time catch-up', () => {
  it('on hello.ok: one connect knock and the invite list; the count before the run finds both empty → no run', async () => {
    double = await startServerDouble({ tray: { waiting: 0 }, invites: [] })
    const runner = new FakeRunner()
    const b = await bell(runner)
    await until(() => trayCounts() === 1 && double.requests.includes('/v1/groups/invites'), 5_000)
    await until(() => b.snapshot().runs_skipped_empty === 1)
    const snap = b.snapshot()
    expect(snap.socket).toBe('ready')
    expect(snap.knocks).toBe(1)
    expect(snap.invites).toBe(0)
    expect(runner.requests).toHaveLength(0)
    expect(double.served[0]!.clientFrames).toEqual([]) // still nothing sent
  }, 10_000)

  it('E1: a deferred-only tray plus the drain re-offering it on every reconnect → zero runs', async () => {
    // Live-fire leg 7: tray 0 cards + deferred=1; the drain re-offers the
    // deferred envelope as message.new right after hello.ok; the old code
    // knocked on it and started a run that found nothing — once per reconnect.
    double = await startServerDouble({ tray: { waiting: 0, deferred: 1 }, drain: [drained('msg_deferred')] })
    const runner = new FakeRunner()
    const b = await bell(runner)
    await until(() => b.snapshot().runs_skipped_empty === 1, 5_000)
    expect(b.snapshot().knocks).toBe(2) // the connect knock + the drain frame, coalesced into one cycle
    expect(trayCounts()).toBe(1)

    // The server drops the socket (a deploy); the reconnect drains again.
    double.served[0]!.socket.close(1011, 'server restart')
    await until(() => double.served.length === 2 && b.snapshot().socket === 'ready', 5_000)
    await until(() => b.snapshot().runs_skipped_empty === 2, 5_000)
    await pause(200)
    expect(runner.requests).toHaveLength(0)
    expect(b.snapshot().runs_started).toBe(0)
    expect(JSON.stringify(b.snapshot())).not.toContain('BODY')
  }, 20_000)

  it('a live message (the tray has a card) is one knock cycle → one run', async () => {
    double = await startServerDouble({ tray: { waiting: 0 } })
    const runner = new FakeRunner()
    const b = await bell(runner)
    await until(() => b.snapshot().runs_skipped_empty === 1, 5_000) // the connect knock, empty
    double.setTray({ waiting: 1 })
    double.send({ type: 'message.new', payload: { id: 'msg_live', conversation_id: 'conv_1', sender: 'peer' } })
    await until(() => runner.requests.length === 1, 5_000)
    expect(runner.requests[0]).toMatchObject({ kind: 'knock', prompt: 'K' })
    await pause(200)
    expect(runner.requests).toHaveLength(1)
    expect(b.snapshot()).toMatchObject({ runs_started: 1, runs_ok: 1, runs_skipped_empty: 1 })
  }, 10_000)

  it('a non-empty tray on connect is exactly one knock → one run; the card itself is never read', async () => {
    double = await startServerDouble({ tray: { waiting: 3 } })
    const runner = new FakeRunner()
    const b = await bell(runner)
    await until(() => b.snapshot().knocks === 1)
    await until(() => runner.requests.length === 1, 5_000)
    expect(b.snapshot().runs_skipped_empty).toBe(0)
    expect(runner.requests[0]).toMatchObject({ kind: 'knock', prompt: 'K' })
    expect(JSON.stringify(b.snapshot())).not.toContain('PREVIEW')
  }, 10_000)

  it('pending invites are surfaced on connect, one run each, deduplicated against the live frame', async () => {
    double = await startServerDouble({ invites: [{ id: 'gri_1', group_id: 'grp_1', group_name: 'Ops', inviter_handle: 'bob' }] })
    const runner = new FakeRunner()
    const b = await bell(runner)
    await until(() => runner.requests.length === 1)
    expect(runner.requests[0]).toMatchObject({ kind: 'invite', prompt: 'I' })
    // The same invite arriving live afterwards is not a second run.
    double.send({ type: 'group.invite.received', payload: { invite_id: 'gri_1', group_id: 'grp_1' } })
    await pause(300)
    expect(runner.requests).toHaveLength(1)
    expect(b.snapshot().invites).toBe(1)
  })

  it('a refused key is terminal with reason auth, starts no run, does not reconnect, and status says terminal (E3)', async () => {
    double = await startServerDouble({ upgrade: 'refuse', tray: { waiting: 5 } })
    const runner = new FakeRunner()
    const terminal: Array<{ reason: TerminalReason; detail: string }> = []
    const b = await bell(runner, (reason, detail) => terminal.push({ reason, detail }))
    await until(() => terminal.length === 1)
    expect(terminal[0]!.reason).toBe('auth')
    await pause(1_500)
    expect(double.upgrades).toBe(1)
    expect(double.requests).toEqual([]) // no catch-up without hello.ok
    expect(runner.requests).toHaveLength(0)
    // `closed` would read as a clean shutdown and hide the refusal.
    expect(b.snapshot().socket).toBe('terminal')
    expect(b.snapshot().last_error).toMatch(/auth rejected/)
    expect(readDoorbellStatus(home)?.socket).toBe('terminal')
  })

  it('stopAndWait interrupts the run in flight and resolves once it has ended', async () => {
    double = await startServerDouble({ tray: { waiting: 1 } })
    const runner = new FakeRunner(true)
    const b = await bell(runner)
    await until(() => runner.requests.length === 1, 5_000)
    const started = Date.now()
    expect(await b.stopAndWait(2_000)).toBe(true)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(runner.aborted).toBe(1)
    expect(runner.requests[0]!.signal?.aborted).toBe(true)
    expect(b.snapshot().socket).toBe('closed')
  }, 10_000)
})
