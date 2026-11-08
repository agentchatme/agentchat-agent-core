import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { main, normalizeArgv } from '../src/cli/main.js'
import { configFromFlags, runListen } from '../src/cli/listen.js'
import { bindPositionals, renderResult } from '../src/cli/tools.js'
import { terminalSafe } from '../src/cli/terminal.js'
import { durableListenerPath, invocation, manualPathFor, resolveHome, serviceLabelForHome } from '../src/cli/home.js'
import { homeLabel, listenerChecks, removeKeyFiles } from '../src/cli/identity.js'
import { readListenerConfig } from '../src/listener/config.js'
import { alwaysOnWanted } from '../src/daemon/health.js'
import { claudeMcpConfigPath } from '../src/presets/index.js'
import { INBOX_TOOL, SEND_TOOL, startMcpDouble, type McpDouble } from './helpers/mcp-double.js'

// ─── The `agentchat` CLI: its arguments, the tools through it, install ──────

const KEY = 'ac_live_' + 'c'.repeat(40)
let tmp: string
let home: string
let saved: Record<string, string | undefined>
let out: string[]
let err: string[]

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-cli-'))
  home = path.join(tmp, 'agentchat-home')
  fs.mkdirSync(home, { recursive: true })
  saved = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'], DRY: process.env['AGENTCHAT_SERVICE_DRY_RUN'], KEY: process.env['AGENTCHAT_API_KEY'], AH: process.env['AGENTCHAT_HOME'] }
  // A sandbox HOME and a dry-run service manager: no real launchd/systemd job is ever touched.
  process.env['HOME'] = path.join(tmp, 'user')
  process.env['USERPROFILE'] = path.join(tmp, 'user')
  process.env['AGENTCHAT_SERVICE_DRY_RUN'] = '1'
  delete process.env['AGENTCHAT_API_KEY']
  delete process.env['AGENTCHAT_HOME']
  fs.mkdirSync(path.join(tmp, 'user'), { recursive: true })
  out = []
  err = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')))
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')))
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const [k, v] of [['HOME', saved['HOME']], ['USERPROFILE', saved['USERPROFILE']], ['AGENTCHAT_SERVICE_DRY_RUN', saved['DRY']], ['AGENTCHAT_API_KEY', saved['KEY']], ['AGENTCHAT_HOME', saved['AH']]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

const signIn = (apiBase: string): void => fs.writeFileSync(path.join(home, 'credentials'), JSON.stringify({ api_key: KEY, handle: 'probe', api_base: apiBase }))

describe('arguments', () => {
  it('the home: --home, else AGENTCHAT_HOME, else ~/.agentchat', () => {
    expect(resolveHome('/x/y', {})).toBe(path.resolve('/x/y'))
    expect(resolveHome(undefined, { AGENTCHAT_HOME: '/z' })).toBe(path.resolve('/z'))
    expect(resolveHome(undefined, {})).toBe(path.join(os.homedir(), '.agentchat'))
    expect(homeLabel(path.join(os.homedir(), '.agentchat'))).toBe(`~${path.sep}.agentchat`)
  })

  it('the invocation follows how it was started', () => {
    expect(invocation({})).toBe('agentchat')
    expect(invocation({ npm_command: 'exec' })).toBe('npx -y @agentchatme/agent-core')
    expect(invocation({ AGENTCHAT_CLI_NAME: 'ac' })).toBe('ac')
  })

  it('`tools call --json <args>` reads the value as the arguments; elsewhere --json is a switch', () => {
    expect(normalizeArgv(['--home', '/h', 'tools', 'call', 'x', '--json', '{}'])).toEqual(['--home', '/h', 'tools', 'call', 'x', '--args', '{}'])
    expect(normalizeArgv(['tools', 'call', 'x', '--json={"a":1}'])).toEqual(['tools', 'call', 'x', '--args={"a":1}'])
    expect(normalizeArgv(['status', '--json'])).toEqual(['status', '--json'])
  })

  it('listen/forward flags become one config, or one clear refusal', () => {
    const io = { env: {}, cwd: tmp }
    const run = configFromFlags('listen', { run: 'my-agent --once', budget: '30' }, io)
    expect(run).toMatchObject({ ok: true, config: { mode: 'run', command: 'my-agent --once', workdir: tmp, budget_ms: 30_000, with_key: false } })
    expect(configFromFlags('listen', { preset: 'codex', profile: 'work', workdir: 'sub' }, io)).toMatchObject({ ok: true, config: { mode: 'preset', preset: 'codex', profile: 'work', workdir: path.join(tmp, 'sub') } })
    expect(configFromFlags('listen', { preset: 'claude-code' }, { env: { AGENTCHAT_RUN_PROFILE: 'full' }, cwd: tmp })).toMatchObject({ ok: true, config: { profile: 'full' } })
    expect(configFromFlags('forward', { to: 'http://localhost:9/w' }, io)).toMatchObject({ ok: true, config: { mode: 'forward', url: 'http://localhost:9/w' } })

    const refused = (built: ReturnType<typeof configFromFlags>): string => (built.ok ? 'accepted' : built.error)
    expect(refused(configFromFlags('listen', {}, io))).toMatch(/Missing what to run/)
    expect(refused(configFromFlags('listen', { run: 'a', preset: 'codex' }, io))).toMatch(/not both/)
    expect(refused(configFromFlags('listen', { preset: 'nope' }, io))).toMatch(/unknown preset "nope" \(presets: claude-code, codex\)/)
    expect(refused(configFromFlags('listen', { run: 'a', profile: 'work' }, io))).toMatch(/belongs to a preset/)
    expect(refused(configFromFlags('listen', { preset: 'codex', withKey: true }, io))).toMatch(/belongs to --run/)
    expect(refused(configFromFlags('listen', { run: 'a', budget: '0' }, io))).toMatch(/seconds/)
    expect(refused(configFromFlags('forward', { to: 'http://example.com/x' }, io))).toMatch(/only to this machine/)
    expect(refused(configFromFlags('forward', {}, io))).toMatch(/Missing --to/)
  })

  it('--help and --version answer without a home; an unknown command says so', async () => {
    expect(await main(['--version'])).toBe(0)
    expect(await main(['--help'])).toBe(0)
    expect(out.join('\n')).toContain('listen --run "<command>"')
    expect(await main(['frobnicate'])).toBe(1)
    expect(err.join('\n')).toMatch(/Unknown command: frobnicate/)
    expect(await main(['listen', 'my-agent'])).toBe(1)
    expect(err.join('\n')).toMatch(/quote the command/)
  })
})

describe('the hosted tools from a shell', () => {
  let mcp: McpDouble
  beforeEach(async () => {
    mcp = await startMcpDouble({ tools: [SEND_TOOL, INBOX_TOOL] })
    signIn(mcp.apiBase)
  })
  afterEach(async () => mcp.close())

  it('tools list prints names and first lines; --json prints the server\'s definitions as given', async () => {
    expect(await main(['--home', home, 'tools', 'list'])).toBe(0)
    expect(out.join('\n')).toMatch(/agentchat_send_message\s+Send a text message on AgentChat\./)
    out.length = 0
    expect(await main(['--home', home, 'tools', 'list', '--json'])).toBe(0)
    expect(JSON.parse(out.join('\n'))).toEqual([SEND_TOOL, INBOX_TOOL])
  })

  it('tools call passes --json through untouched', async () => {
    expect(await main(['--home', home, 'tools', 'call', 'agentchat_inbox', '--json', '{"limit":3,"timeout_seconds":0}'])).toBe(0)
    expect(mcp.seen[mcp.seen.length - 1]?.params).toEqual({ name: 'agentchat_inbox', arguments: { limit: 3, timeout_seconds: 0 } })
    expect(await main(['--home', home, 'tools', 'call', 'agentchat_inbox', '--json', '[1]'])).toBe(1)
    expect(err.join('\n')).toMatch(/JSON object/)
  })

  it('send binds its words to the required parameters in the schema\'s order; inbox looks once', async () => {
    expect(await main(['--home', home, 'send', '@peer', 'hello', 'there'])).toBe(0)
    expect(mcp.seen[mcp.seen.length - 1]?.params).toEqual({ name: 'agentchat_send_message', arguments: { to: '@peer', text: 'hello there' } })
    expect(await main(['--home', home, 'send', '@peer', 'again', '--reply-to', 'msg_1'])).toBe(0)
    expect(mcp.seen[mcp.seen.length - 1]?.params).toMatchObject({ arguments: { to: '@peer', text: 'again', reply_to: 'msg_1' } })
    expect(await main(['--home', home, 'send', '@peer'])).toBe(1)
    expect(await main(['--home', home, 'inbox'])).toBe(0)
    expect(mcp.seen[mcp.seen.length - 1]?.params).toEqual({ name: 'agentchat_inbox', arguments: { timeout_seconds: 0 } })
    expect(await main(['--home', home, 'inbox', '--wait', '20', '--limit', '5'])).toBe(0)
    expect(mcp.seen[mcp.seen.length - 1]?.params).toEqual({ name: 'agentchat_inbox', arguments: { timeout_seconds: 20, limit: 5 } })
  })

  it('a tool error exits 1; what a peer wrote is printed terminal-safe', async () => {
    mcp.set({ call: () => ({ content: [{ type: 'text', text: 'peer says \u001B]0;pwned\u0007hi\u001B[2J there' }] }) })
    expect(await main(['--home', home, 'inbox'])).toBe(0)
    expect(out[out.length - 1]).toBe('peer says hi there')
    mcp.set({ call: () => ({ content: [{ type: 'text', text: 'AWAITING_REPLY' }], isError: true }) })
    expect(await main(['--home', home, 'send', '@peer', 'x'])).toBe(1)
  })

  it('the key never reaches the output', async () => {
    await main(['--home', home, 'tools', 'list', '--json'])
    await main(['--home', home, 'inbox', '--raw'])
    expect([...out, ...err].join('\n')).not.toContain(KEY)
  })
})

describe('pure helpers', () => {
  it('bindPositionals: the last required parameter takes the rest; none required is refused', () => {
    expect(bindPositionals({ name: 't', inputSchema: { required: ['a', 'b'] } }, ['1', '2', '3'])).toEqual({ a: '1', b: '2 3' })
    expect(bindPositionals({ name: 't', inputSchema: { required: ['a', 'b'] } }, ['1'])).toBeInstanceOf(Error)
    expect(bindPositionals({ name: 't', inputSchema: {} }, ['1'])).toBeInstanceOf(Error)
  })

  it('renderResult: text items, else the structured part, else a placeholder', () => {
    expect(renderResult({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] })).toBe('a\nb')
    expect(renderResult({ content: [], structuredContent: { ok: true } })).toBe('{\n  "ok": true\n}')
    expect(renderResult({ content: [{ type: 'image' }] })).toBe('[image content]')
  })

  it('terminalSafe keeps newlines and tabs, drops escapes and controls', () => {
    expect(terminalSafe('a\tb\nc\u001B[31mred\u001B[0m\u0007\u009B2J\r')).toBe('a\tb\ncred')
  })
})

describe('listen --install / --uninstall (dry run, sandbox HOME)', () => {
  const io = (extra: Record<string, unknown> = {}) => ({ out: (l: string) => out.push(l), err: (l: string) => err.push(l), cwd: tmp, ...extra })

  it('writes listener.json, a durable copy and the service definition; uninstall removes the service and the copy, keeps the config', async () => {
    const shipped = path.join(tmp, 'listener-daemon.js')
    fs.writeFileSync(shipped, '// the shipped listener bundle\n')
    expect(await runListen(home, 'listen', { run: 'my-agent --once', install: true }, io({ shipped }))).toBe(0)
    expect(readListenerConfig(home)).toMatchObject({ ok: true, config: { mode: 'run', command: 'my-agent --once', workdir: tmp } })
    expect(fs.readFileSync(durableListenerPath(home), 'utf-8')).toContain('shipped listener bundle')
    expect(alwaysOnWanted(home)).toBe(true)
    expect(out.join('\n')).toMatch(new RegExp(`Listener installed \\(${serviceLabelForHome(home)}\\)`))
    expect(out.join('\n')).toMatch(/idles until this home has an identity/)
    if (process.platform === 'darwin') {
      const plist = fs.readFileSync(path.join(tmp, 'user', 'Library', 'LaunchAgents', `me.agentchat.${serviceLabelForHome(home)}.plist`), 'utf-8')
      expect(plist).toContain(durableListenerPath(home))
      expect(plist).toContain(home)
      // The command lives in listener.json, never in the service definition.
      expect(plist).not.toContain('my-agent')
    }

    // `listen --install` alone re-installs what is saved.
    out.length = 0
    expect(await runListen(home, 'listen', { install: true }, io({ shipped }))).toBe(0)
    expect(out.join('\n')).toContain('runs `my-agent --once`')

    expect(await runListen(home, 'listen', { uninstall: true }, io())).toBe(0)
    expect(fs.existsSync(durableListenerPath(home))).toBe(false)
    expect(alwaysOnWanted(home)).toBe(false)
    expect(readListenerConfig(home).ok).toBe(true)
  })

  it('forward --install creates the bearer secret and says where it is', async () => {
    const shipped = path.join(tmp, 'listener-daemon.js')
    fs.writeFileSync(shipped, '//\n')
    expect(await runListen(home, 'forward', { to: 'http://localhost:7777/wake', install: true }, io({ shipped }))).toBe(0)
    expect(fs.existsSync(path.join(home, 'forward.secret'))).toBe(true)
    expect(out.join('\n')).toContain(path.join(home, 'forward.secret'))
    expect(out.join('\n')).not.toMatch(/whfwd_/)
  })

  it('a foreground listen without an identity refuses with the next step', async () => {
    expect(await runListen(home, 'listen', { run: 'x' }, io())).toBe(1)
    expect(err.join('\n')).toMatch(/No AgentChat identity .* register/)
  })
})

describe('logout and doctor', () => {
  it('logout removes the key from a preset\'s tool config too', () => {
    const file = claudeMcpConfigPath(home)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ key: KEY }))
    expect(removeKeyFiles(home)).toHaveLength(1)
    expect(fs.existsSync(file)).toBe(false)
    expect(removeKeyFiles(home)).toEqual([])
  })

  it('doctor checks a missing workdir, an unknown preset, a bad forward address', () => {
    const base = { version: 1 as const, updated_at: 'x' }
    expect(listenerChecks(home, { ...base, mode: 'run', command: 'a', with_key: false, workdir: path.join(tmp, 'gone') }).find((c) => c.name === 'workdir')?.verdict).toBe('FAIL')
    expect(listenerChecks(home, { ...base, mode: 'preset', preset: 'nope', profile: 'answer', workdir: tmp }).find((c) => c.name === 'preset')?.verdict).toBe('FAIL')
    expect(listenerChecks(home, { ...base, mode: 'forward', url: 'http://example.com/', workdir: tmp }).find((c) => c.name === 'forward')?.verdict).toBe('FAIL')
  })

  it('the manual lives in a skills dir under the home', () => {
    expect(manualPathFor(home)).toBe(path.join(home, 'skills', 'agentchat', 'SKILL.md'))
  })
})
