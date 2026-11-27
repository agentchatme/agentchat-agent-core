import * as fs from 'node:fs'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clientIdentityOf, hostIdentityOf, installMethodOf } from '../src/client-identity.js'
import { clearCredentials, clearInstallId, ensureInstallId, installIdPath, readInstallId, readRememberedHost, rememberHost, writeCredentials } from '../src/identity/credentials.js'
import {
  httpTelemetrySender,
  sendSetupVerdict,
  setupVerdictEvent,
  telemetryOff,
  TELEMETRY_PATH,
  type TelemetryRequest,
} from '../src/identity/telemetry.js'
import type { SetupVerdict } from '../src/identity/setup.js'

// ─── What an install names itself with, and the one event it sends ──────────

const INSTALL_ID = /^ins_[A-Za-z0-9_-]{22}$/
let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-telemetry-'))
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

const VERDICT: SetupVerdict = {
  state: 'listener_failing',
  next: 'the listener for @x cannot start runs: x is not signed in. Ask the person you work with.',
  command: 'npx -y @agentchatme/example status',
  needs_person: true,
  ask: 'Could you sign it in?',
  detail: 'runtime (x) not ready: x is not signed in',
  reason: 'not_signed_in',
}

describe('the install id', () => {
  it('is made once per home, ins_ and 22 base64url characters, owner-only, and kept', () => {
    expect(readInstallId(home)).toBeNull()
    const id = ensureInstallId(home)
    expect(id).toMatch(INSTALL_ID)
    expect(ensureInstallId(home)).toBe(id)
    expect(readInstallId(home)).toBe(id)
    if (process.platform !== 'win32') expect(fs.statSync(installIdPath(home)).mode & 0o777).toBe(0o600)
    // Another home has its own.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-telemetry-other-'))
    try {
      expect(ensureInstallId(other)).not.toBe(id)
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })

  it('survives logout (clearCredentials) and goes with uninstall (clearInstallId)', () => {
    writeCredentials(home, { api_key: `ac_${'k'.repeat(32)}`, handle: 'probe' })
    const id = ensureInstallId(home)
    clearCredentials(home)
    expect(readInstallId(home)).toBe(id)
    expect(clearInstallId(home)).toBe(true)
    expect(readInstallId(home)).toBeNull()
    expect(clearInstallId(home)).toBe(false)
  })

  it('a file that holds something else is replaced, never sent', () => {
    fs.writeFileSync(installIdPath(home), 'not-an-id\n')
    expect(readInstallId(home)).toBeNull()
    const id = ensureInstallId(home)
    expect(id).toMatch(INSTALL_ID)
    expect(readInstallId(home)).toBe(id)
  })
})

describe('the remembered host (what the daemon names without probing)', () => {
  it('keeps a host of the platform shape, and nothing else', () => {
    expect(readRememberedHost(home)).toBeNull()
    rememberHost(home, 'claude-code/2.1.332')
    expect(readRememberedHost(home)).toBe('claude-code/2.1.332')
    rememberHost(home, 'not a host value')
    expect(readRememberedHost(home)).toBe('claude-code/2.1.332')
  })
})

describe('the client identity names the host and the install', () => {
  it('passes host, install id and method through to the SDK identity, only when given', () => {
    expect(clientIdentityOf({ runtime: 'generic', version: '0.8.0' })).toEqual({ name: 'generic', version: '0.8.0' })
    expect(clientIdentityOf({ runtime: 'generic', version: '0.8.0', host: 'example/1.2.3', installId: 'ins_abc', installMethod: 'npx' })).toEqual({
      name: 'generic',
      version: '0.8.0',
      host: 'example/1.2.3',
      installId: 'ins_abc',
      installMethod: 'npx',
    })
  })

  it('reads the host version from a runtime’s own --version output', () => {
    expect(hostIdentityOf('claude-code', '2.1.332 (Claude Code)')).toBe('claude-code/2.1.332')
    expect(hostIdentityOf('codex', 'codex-cli 0.154.0')).toBe('codex/0.154.0')
    expect(hostIdentityOf('codex', 'codex-cli 0.155.0-alpha.2')).toBe('codex/0.155.0-alpha.2')
    expect(hostIdentityOf('x', 'unknown')).toBeNull()
  })

  it('says npx only when the code runs from npm’s exec cache; anything else is left out', () => {
    expect(installMethodOf('/home/u/.npm/_npx/0a1b2c3d/node_modules/@agentchatme/example/dist/index.js')).toBe('npx')
    expect(installMethodOf('C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\0a1b2c\\node_modules\\@agentchatme\\example\\dist\\index.js')).toBe('npx')
    expect(installMethodOf('/usr/local/lib/node_modules/@agentchatme/example/dist/index.js')).toBeNull()
    expect(installMethodOf('/home/u/.example/agentchat/bin/agentchat-daemon.mjs')).toBeNull()
  })
})

describe('the setup_verdict event', () => {
  it('carries the state, command, needs_person, reason, exit code and duration, and nothing of the verdict’s text', () => {
    const event = setupVerdictEvent(VERDICT, { command: 'status', exitCode: 0, startedAt: 1_000, now: 3_310 })
    expect(event).toEqual({
      name: 'setup_verdict',
      at: new Date(3_310).toISOString(),
      props: { state: 'listener_failing', command: 'status', needs_person: true, reason: 'not_signed_in', exit_code: 0, duration_ms: 2_310 },
    })
    expect(JSON.stringify(event)).not.toMatch(/signed in\.|person you work with|npx|runtime \(x\)/)
  })

  it('bounds what it sends: exit 0-255, duration 0-600000, a reason of another shape left out', () => {
    const odd = setupVerdictEvent({ ...VERDICT, reason: 'Not A Word' }, { command: 'login', exitCode: 999, startedAt: 0, now: 10_000_000 })
    expect(odd.props).toEqual({ state: 'listener_failing', command: 'login', needs_person: true, exit_code: 255, duration_ms: 600_000 })
    expect(setupVerdictEvent({ ...VERDICT, reason: null }, { command: 'login', exitCode: -1, startedAt: 10, now: 5 }).props).toMatchObject({ exit_code: 0, duration_ms: 0 })
  })
})

describe('sending it', () => {
  const base = { command: 'status' as const, exitCode: 0, startedAt: Date.now(), apiBase: 'http://127.0.0.1:9', apiKey: null, clientIdentity: { name: 'generic' as never, version: '0.8.0', installId: `ins_${'a'.repeat(22)}` } }

  it('AGENTCHAT_TELEMETRY=off (or 0, false, any case) sends nothing', async () => {
    for (const value of ['off', 'OFF', '0', 'false', ' False ']) {
      const seen: TelemetryRequest[] = []
      await sendSetupVerdict(VERDICT, { ...base, env: { AGENTCHAT_TELEMETRY: value }, sender: async (r) => void seen.push(r) })
      expect(seen, value).toEqual([])
      expect(telemetryOff({ AGENTCHAT_TELEMETRY: value })).toBe(true)
    }
    expect(telemetryOff({ AGENTCHAT_TELEMETRY: 'on' })).toBe(false)
    expect(telemetryOff({})).toBe(false)
  })

  it('with neither a key nor an install id there is nothing to name it by: nothing is sent', async () => {
    const seen: TelemetryRequest[] = []
    await sendSetupVerdict(VERDICT, { ...base, clientIdentity: { name: 'generic' as never, version: '0.8.0' }, env: {}, sender: async (r) => void seen.push(r) })
    expect(seen).toEqual([])
  })

  it('a sender that fails or hangs never fails or holds up the command beyond the bound', async () => {
    await expect(sendSetupVerdict(VERDICT, { ...base, env: {}, sender: async () => Promise.reject(new Error('boom')) })).resolves.toBeUndefined()
    const started = Date.now()
    let aborted = false
    await sendSetupVerdict(VERDICT, {
      ...base,
      env: {},
      timeoutMs: 150,
      sender: (r) =>
        new Promise<void>(() => {
          r.signal.addEventListener('abort', () => (aborted = true))
        }),
    })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(aborted).toBe(true)
  })

  it('under AGENTCHAT_SERVICE_DRY_RUN, with no sender given, nothing reaches the network', async () => {
    const received: string[] = []
    const server = http.createServer((req, res) => {
      received.push(String(req.url))
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      await sendSetupVerdict(VERDICT, { ...base, apiBase, env: { AGENTCHAT_SERVICE_DRY_RUN: '1' } })
      expect(received).toEqual([])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('over the network (a local server)', () => {
  let server: http.Server
  let apiBase = ''
  let requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = []
  let status = 202
  beforeEach(async () => {
    requests = []
    status = 202
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        requests.push({ method: String(req.method), url: String(req.url), headers: req.headers, body })
        res.statusCode = status
        res.setHeader('content-type', 'application/json')
        res.end(status === 202 ? JSON.stringify({ accepted: 1, dropped: 0 }) : JSON.stringify({ code: 'NOT_FOUND', message: 'no such route' }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const identity = { name: 'generic' as never, version: '0.8.0', host: 'example/1.2.3', installId: `ins_${'b'.repeat(22)}` }

  it('one POST /v1/telemetry with the SDK’s headers (the platform with the install id), version 1, one event; no key without an identity', async () => {
    await sendSetupVerdict(VERDICT, { command: 'status', exitCode: 0, startedAt: Date.now() - 50, apiBase, apiKey: null, clientIdentity: identity, env: {}, sender: httpTelemetrySender })
    expect(requests).toHaveLength(1)
    const [req] = requests
    expect(req!.method).toBe('POST')
    expect(req!.url).toBe(TELEMETRY_PATH)
    expect(req!.headers['authorization']).toBeUndefined()
    expect(req!.headers['x-agentchat-client']).toBe('generic')
    expect(req!.headers['x-agentchat-client-version']).toBe('0.8.0')
    expect(req!.headers['x-agentchat-platform']).toContain(`host="example/1.2.3"`)
    expect(req!.headers['x-agentchat-platform']).toContain(`install="ins_${'b'.repeat(22)}"`)
    const body = JSON.parse(req!.body) as { version: number; events: Array<{ name: string; props: Record<string, unknown> }> }
    expect(body.version).toBe(1)
    expect(body.events).toHaveLength(1)
    expect(body.events[0]).toMatchObject({ name: 'setup_verdict', props: { state: 'listener_failing', command: 'status', needs_person: true, reason: 'not_signed_in', exit_code: 0 } })
  })

  it('the key goes in the Authorization header when there is an identity, never in the body', async () => {
    const key = `ac_${'z'.repeat(32)}`
    await sendSetupVerdict(VERDICT, { command: 'login', exitCode: 0, startedAt: Date.now(), apiBase, apiKey: key, clientIdentity: identity, env: {}, sender: httpTelemetrySender })
    expect(requests[0]!.headers['authorization']).toBe(`Bearer ${key}`)
    expect(requests[0]!.body).not.toContain(key)
  })

  it('an older server’s 404 is silent: one attempt, nothing thrown', async () => {
    status = 404
    await expect(
      sendSetupVerdict(VERDICT, { command: 'status', exitCode: 0, startedAt: Date.now(), apiBase, apiKey: null, clientIdentity: identity, env: {}, sender: httpTelemetrySender }),
    ).resolves.toBeUndefined()
    expect(requests).toHaveLength(1)
  })
})
