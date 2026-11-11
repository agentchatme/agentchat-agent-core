import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { runIntegration } from '../src/integration/run.js'
import { readIntegrationStatus } from '../src/integration/status.js'
import { alwaysOnState, markAlwaysOnWanted } from '../src/daemon/health.js'
import type { RunRunner } from '../src/integration/runner.js'
import { startServerDouble, until } from './helpers/server-double.js'

// ─── The supervisor is resident, follows the credential, and honours `off` ──

const CLIENT = { runtime: 'generic' as const, version: '0.0.0-test' }

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-integration-run-'))
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

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

const base = () => ({ home, client: CLIENT, manualPointer: '(POINTER)', workdir: path.join(home, 'w') })

async function runFor(ms: number, env: NodeJS.ProcessEnv, r: RunRunner): Promise<number> {
  const controller = new AbortController()
  const done = runIntegration({ ...base(), runner: r, env, signal: controller.signal })
  await new Promise((resolve) => setTimeout(resolve, ms))
  controller.abort()
  return done
}

describe('runIntegration', () => {
  it('with no identity it idles: no socket, status idle, heartbeat cleared', async () => {
    markAlwaysOnWanted(home)
    const r = runner({ ok: true })
    const code = await runFor(400, {}, r)
    expect(code).toBe(0)
    expect(readIntegrationStatus(home)).toMatchObject({ version: 2, socket: 'idle', handle: null, runtime: 'fake-runtime', wakes: 0 })
    expect(alwaysOnState(home)).toBe('idle')
    expect(r.starts).toBe(0)
  }, 10_000)

  it('AGENTCHAT_INTEGRATION=off holds no socket even with an identity', async () => {
    signIn()
    const r = runner({ ok: true })
    await runFor(400, { AGENTCHAT_INTEGRATION: 'off' }, r)
    expect(readIntegrationStatus(home)).toMatchObject({ socket: 'off', handle: 'probe' })
    expect(r.starts).toBe(0)
  }, 10_000)

  it('the previous name, AGENTCHAT_DOORBELL=off, still holds until its removal date (a service captured it into its unit)', async () => {
    signIn()
    const r = runner({ ok: true })
    await runFor(400, { AGENTCHAT_DOORBELL: 'off' }, r)
    expect(readIntegrationStatus(home)).toMatchObject({ socket: 'off', handle: 'probe' })
    expect(r.starts).toBe(0)
  }, 10_000)

  it('a runtime that fails preflight is reported and retried, never fatal', async () => {
    signIn()
    const r = runner({ ok: false, detail: 'runtime CLI not found on PATH' })
    await runFor(600, {}, r)
    const status = readIntegrationStatus(home)
    expect(status?.socket).toBe('idle')
    expect(status?.last_error).toMatch(/not ready: runtime CLI not found/)
  }, 10_000)

  it('refuses to run twice for one home (leader lock)', async () => {
    const first = new AbortController()
    const a = runIntegration({ ...base(), runner: runner({ ok: true }), env: {}, signal: first.signal })
    await new Promise((resolve) => setTimeout(resolve, 200))
    const second = await runIntegration({ ...base(), runner: runner({ ok: true }), env: {}, signal: AbortSignal.abort() })
    expect(second).toBe(1)
    first.abort()
    expect(await a).toBe(0)
  }, 10_000)
})

describe('runIntegration — shutdown', () => {
  it('SIGTERM interrupts the run in flight, waits for it, and exits 0 (a launchd stop must reach the child)', async () => {
    const double = await startServerDouble({ tray: { waiting: 1 } })
    try {
      markAlwaysOnWanted(home)
      fs.writeFileSync(
        path.join(home, 'credentials'),
        JSON.stringify({ api_key: 'ac_' + 'a'.repeat(40), handle: 'probe', api_base: double.apiBase }),
      )
      const r: RunRunner & { starts: number; aborted: number } = {
        name: 'fake-runtime',
        starts: 0,
        aborted: 0,
        async preflight() {
          return { ok: true }
        },
        async start(request) {
          this.starts += 1
          await new Promise<void>((resolve) => request.signal?.addEventListener('abort', () => resolve(), { once: true }))
          this.aborted += 1
          return { state: 'failed', exitCode: null, durationMs: 1, detail: 'interrupted' }
        },
      }
      const exits: number[] = []
      const done = runIntegration({ ...base(), runner: r, env: {}, exit: (code) => exits.push(code) })
      await until(() => r.starts === 1, 6_000)
      const started = Date.now()
      process.emit('SIGTERM')
      expect(await done).toBe(0)
      expect(Date.now() - started).toBeLessThan(3_000)
      expect(r.aborted).toBe(1)
      expect(exits).toEqual([0])
      expect(fs.existsSync(path.join(home, 'daemon.heartbeat'))).toBe(false) // idle() ran before exit
    } finally {
      await double.close()
    }
  }, 15_000)
})
