import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { runDoorbell } from '../src/doorbell/run.js'
import { readDoorbellStatus } from '../src/doorbell/status.js'
import { alwaysOnState, markAlwaysOnWanted } from '../src/daemon/health.js'
import type { RunRunner } from '../src/doorbell/runner.js'

// ─── The supervisor is resident, follows the credential, and honours `off` ──

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-doorbell-run-'))
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

const prompts = { knock: 'K', invite: 'I' }

function runner(preflight: { ok: boolean; detail?: string }): RunRunner & { starts: number } {
  return {
    name: 'fake-runtime',
    starts: 0,
    async preflight() {
      return preflight
    },
    async start() {
      this.starts += 1
      return { state: 'ok', exitCode: 0, durationMs: 1 }
    },
  }
}

const signIn = (): void =>
  fs.writeFileSync(path.join(home, 'credentials'), JSON.stringify({ api_key: 'ac_' + 'a'.repeat(40), handle: 'probe', api_base: 'http://127.0.0.1:9' }))

async function runFor(ms: number, env: NodeJS.ProcessEnv, r: RunRunner): Promise<number> {
  const controller = new AbortController()
  const done = runDoorbell({ home, runner: r, prompts, env, signal: controller.signal })
  await new Promise((resolve) => setTimeout(resolve, ms))
  controller.abort()
  return done
}

describe('runDoorbell', () => {
  it('with no identity it idles: no socket, status idle, heartbeat cleared', async () => {
    markAlwaysOnWanted(home)
    const r = runner({ ok: true })
    const code = await runFor(400, {}, r)
    expect(code).toBe(0)
    expect(readDoorbellStatus(home)).toMatchObject({ socket: 'idle', handle: null, runtime: 'fake-runtime' })
    expect(alwaysOnState(home)).toBe('idle')
    expect(r.starts).toBe(0)
  }, 10_000)

  it('AGENTCHAT_DOORBELL=off holds no socket even with an identity', async () => {
    signIn()
    const r = runner({ ok: true })
    await runFor(400, { AGENTCHAT_DOORBELL: 'off' }, r)
    expect(readDoorbellStatus(home)).toMatchObject({ socket: 'off', handle: 'probe' })
    expect(r.starts).toBe(0)
  }, 10_000)

  it('a runtime that fails preflight is reported and retried, never fatal', async () => {
    signIn()
    const r = runner({ ok: false, detail: 'runtime CLI not found on PATH' })
    await runFor(600, {}, r)
    const status = readDoorbellStatus(home)
    expect(status?.socket).toBe('idle')
    expect(status?.last_error).toMatch(/not ready: runtime CLI not found/)
  }, 10_000)

  it('refuses to run twice for one home (leader lock)', async () => {
    const first = new AbortController()
    const a = runDoorbell({ home, runner: runner({ ok: true }), prompts, env: {}, signal: first.signal })
    await new Promise((resolve) => setTimeout(resolve, 200))
    const second = await runDoorbell({ home, runner: runner({ ok: true }), prompts, env: {}, signal: AbortSignal.abort() })
    expect(second).toBe(1)
    first.abort()
    expect(await a).toBe(0)
  }, 10_000)
})
