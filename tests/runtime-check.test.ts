import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  ClaudeRunner,
  CodexRunner,
  LISTENER_KEY_ENV,
  RUNTIME_CHECK_PROMPT,
  RUNTIME_CHECK_SETTINGS,
  claudeCodePreset,
  claudeRuntimeCheckArgs,
  claudeRuntimeCheckJudge,
  claudeRuntimeCheckWorkdir,
  CODEX_ANSWER_DISABLED_FEATURES,
  CODEX_RUNTIME_CHECK_DISABLED_FEATURES,
  codexPreset,
  codexRuntimeCheckArgs,
  codexRuntimeCheckJudge,
  codexRuntimeCheckWorkdir,
  runRuntimeCheck,
} from '../src/presets/index.js'
import { installFakeClaude, installFakeCodex, readFakeRuns, type FakeRuntime } from './helpers/fake-runtimes.js'

// ─── The presets' runtime check: a minimal model call, nothing more ─────────
//
// After a conversation's run failed, the kit asks the runner whether the
// runtime works; `ok` makes the failure that conversation's. So the check is
// a real headless run of the runtime — the same binary and environment as the
// runs — with a fixed prompt, no peer content, no AgentChat tools, in an empty
// folder of its own, its output discarded, and stopped (its process killed)
// when asked to. The fake binaries record what they were started with.

const posix = process.platform !== 'win32'
const KEY = 'ac_live_' + 'k'.repeat(40)

let sandbox: string
let home: string
const originalPath = process.env['PATH']
beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-check-'))
  home = path.join(sandbox, 'home')
  fs.mkdirSync(home, { recursive: true })
})
afterEach(() => {
  process.env['PATH'] = originalPath
  fs.rmSync(sandbox, { recursive: true, force: true })
})

/** The fake on PATH, and the environment the runner's runs inherit — with a key in it that must not reach the check. */
const withFake = (fake: FakeRuntime, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  process.env['PATH'] = `${fake.binDir}${path.delimiter}${originalPath ?? ''}`
  return {
    ...process.env,
    FAKE_RUNTIME_RECORD: fake.recordPath,
    CLAUDE_CONFIG_DIR: path.join(sandbox, '.claude'),
    CODEX_HOME: path.join(sandbox, '.codex'),
    AGENTCHAT_API_KEY: KEY,
    [LISTENER_KEY_ENV]: KEY,
    ...extra,
  }
}

const real = (p: string): string => fs.realpathSync(p)

/** True once `pid` is gone. */
function gone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

async function eventually(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return cond()
}

describe('Claude Code: one `claude -p` with no tool of any kind', () => {
  it('the flags, pinned: no MCP server (strict, no config), no built-in tool, no hooks, never waiting; the key-store deny rules as on every run', () => {
    expect(claudeRuntimeCheckArgs(['/h', '/c/.claude.json'])).toEqual([
      '-p', '--output-format', 'json', '--no-session-persistence',
      '--strict-mcp-config',
      '--tools', '',
      '--permission-prompts', 'none',
      '--settings', RUNTIME_CHECK_SETTINGS,
      ...(posix ? ['--disallowedTools', 'Read(//h),Read(//h/**),Read(//c/.claude.json),Read(//c/.claude.json/**)'] : []),
    ])
    // No hooks; CLAUDE.md and memory off again in the settings, as ANSWER_SETTINGS does (a settings file's env wins over the process's);
    // verbose output off (`viewMode` overrides `verbose`; both outranked only by the `--verbose` flag, never passed, and managed settings).
    expect(JSON.parse(RUNTIME_CHECK_SETTINGS)).toEqual({
      env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
      disableAllHooks: true,
      verbose: false,
      viewMode: 'default',
    })
    expect(claudeRuntimeCheckArgs()).not.toContain('--verbose')
    expect(claudeRuntimeCheckArgs()).not.toContain('--mcp-config')
  })

  for (const profile of ['own', 'answer', 'work', 'full'] as const) {
    it(`${profile}: the listener's runner checks with the run's binary and environment, in its own empty folder, with the fixed prompt on stdin and no key anywhere`, async () => {
      const fake = installFakeClaude(sandbox)
      const env = withFake(fake)
      const runner = claudeCodePreset.runner({ home, workdir: path.join(sandbox, 'work'), profile, apiKey: KEY, apiBase: 'https://api.example', env })
      expect(runner.checkRuntime).toBeTypeOf('function')
      expect(await runner.checkRuntime!()).toEqual({ ok: true })
      const [check] = readFakeRuns(fake)
      expect(check?.stdin).toBe(RUNTIME_CHECK_PROMPT)
      expect(check?.argv.slice(0, 9)).toEqual(['-p', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config', '--tools', '', '--permission-prompts', 'none'])
      expect(check?.argv).not.toContain('--mcp-config')
      expect(check?.argv).not.toContain('--allowedTools')
      expect(check?.mcpConfig).toBeNull()
      expect(real(check?.cwd ?? '')).toBe(real(claudeRuntimeCheckWorkdir(path.join(sandbox, '.claude'))))
      expect(fs.readdirSync(claudeRuntimeCheckWorkdir(path.join(sandbox, '.claude')))).toEqual([])
      // No key in its environment, whatever the daemon inherited; no instruction file or memory in its context.
      expect(JSON.stringify(check?.env)).not.toContain(KEY)
      expect(check?.env['CLAUDE_CODE_DISABLE_CLAUDE_MDS']).toBe('1')
      expect(check?.env['CLAUDE_CODE_DISABLE_AUTO_MEMORY']).toBe('1')
      expect(check?.env['CLAUDE_CONFIG_DIR']).toBe(path.join(sandbox, '.claude'))
      if (posix) expect(check?.argv.at(-1)).toContain(`Read(/${home})`)
    }, 20_000)
  }

  it('a provider that refuses (exit 1 after its error) and a run that prints nothing are not ok; the diagnostic is the redacted stderr, never the output', async () => {
    const fake = installFakeClaude(sandbox)
    const runner = new ClaudeRunner({ configDir: path.join(sandbox, '.claude'), workdir: path.join(sandbox, 'w'), profile: 'own', denyReadPaths: [home], env: withFake(fake, { FAKE_RUNTIME_RUN_MODE: 'fail' }) })
    const failed = await runner.checkRuntime()
    expect(failed.ok).toBe(false)
    expect(failed.detail).toMatch(/^claude runtime check failed: exit 1: API Error: the provider refused this request$/)
    expect(failed.detail).not.toContain('must be discarded')

    const silent = new ClaudeRunner({ configDir: path.join(sandbox, '.claude'), workdir: path.join(sandbox, 'w'), profile: 'own', denyReadPaths: [home], env: withFake(fake, { FAKE_RUNTIME_RUN_MODE: 'silent' }) })
    expect(await silent.checkRuntime()).toEqual({ ok: false, detail: 'claude runtime check failed: exit 0 with nothing on stdout' })
  }, 20_000)

  it('exit 0 is not enough: an error result (a usage limit, a low balance, an expired sign-in) or plain text is not ok, and its text is never in the detail', async () => {
    const fake = installFakeClaude(sandbox)
    const runner = (mode: string): ClaudeRunner =>
      new ClaudeRunner({ configDir: path.join(sandbox, '.claude'), workdir: path.join(sandbox, 'w'), profile: 'own', denyReadPaths: [home], env: withFake(fake, { FAKE_RUNTIME_RUN_MODE: mode }) })
    const errored = await runner('error_exit0').checkRuntime()
    expect(errored).toEqual({
      ok: false,
      detail: 'claude runtime check failed: exit 0, but the result is not a success (type result, subtype success, is_error true, api_error_status 400, terminal_reason api_error)',
    })
    const text = await runner('text').checkRuntime()
    expect(text).toEqual({ ok: false, detail: 'claude runtime check failed: exit 0, but its answer is not a JSON result' })
    for (const r of [errored, text]) expect(r.detail).not.toContain('must be discarded')
  }, 20_000)

  it('the judge: a result object — success, no error, a turn, and an answer that says OK — as Claude Code 2.1.328 prints it', () => {
    // Shapes as seen against a stand-in provider (texts shortened): an answer, and an API error, which is
    // `subtype: "success"` with `is_error: true` — so the subtype alone says nothing.
    const answer = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, api_error_status: null, terminal_reason: 'completed', num_turns: 1, result: 'OK', session_id: 's' })
    const apiError = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, num_turns: 1, api_error_status: 401, api_error_type: 'authentication_error', terminal_reason: 'api_error', result: 'Invalid API key · Fix external API key' })
    expect(claudeRuntimeCheckJudge(`${answer}\n`)).toBeNull()
    expect(claudeRuntimeCheckJudge(JSON.stringify({ ...JSON.parse(answer), result: 'OK.' }))).toBeNull()
    expect(claudeRuntimeCheckJudge(JSON.stringify({ ...JSON.parse(answer), result: 'ok' }))).toBeNull()
    expect(claudeRuntimeCheckJudge(apiError)).toBe('the result is not a success (type result, subtype success, is_error true, api_error_status 401, terminal_reason api_error)')
    expect(claudeRuntimeCheckJudge(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true }))).toBe('the result is not a success (type result, subtype error_during_execution, is_error true)')
    expect(claudeRuntimeCheckJudge(JSON.stringify({ type: 'result', subtype: 'success' }))).toBe('the result is not a success (type result, subtype success, is_error ?)')
    expect(claudeRuntimeCheckJudge('OK')).toBe('its answer is not a JSON result')
    // A line before the result (a warning) does not hide it.
    expect(claudeRuntimeCheckJudge(`a warning\n${answer}`)).toBeNull()
    expect(claudeRuntimeCheckJudge(apiError)).not.toContain('Invalid API key')
  })

  it('the judge: no turn (num_turns 0 or missing) is not an answer, and neither is a success whose text is not OK; the text is never in the reason', () => {
    const base = { type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', num_turns: 1, result: 'OK' }
    expect(claudeRuntimeCheckJudge(JSON.stringify({ ...base, num_turns: 0 }))).toBe('the result has no turn (num_turns 0)')
    const { num_turns: _turns, ...noTurns } = base
    expect(claudeRuntimeCheckJudge(JSON.stringify(noTurns))).toBe('the result has no turn (num_turns ?)')
    for (const text of ["I can't help with that. PEER-LIKE TEXT", 'Okay', 'token', '', 'Credit balance is too low']) {
      const reason = claudeRuntimeCheckJudge(JSON.stringify({ ...base, result: text }))
      expect(reason, text).toBe('the result does not answer OK')
    }
    expect(claudeRuntimeCheckJudge(JSON.stringify({ ...base, result: null }))).toBe('the result does not answer OK')
    expect(claudeRuntimeCheckJudge(JSON.stringify({ ...base, result: "I can't help with that. PEER-LIKE TEXT" }))).not.toContain('PEER-LIKE')
  })

  it('the judge: verbose output (a JSON array of every message) is judged on its last result, as Claude Code 2.1.328 prints it', () => {
    // As seen with `--verbose`, the `verbose` setting or `viewMode: "verbose"` (stand-in provider, fields shortened):
    // one line, `[init, assistant, result]`.
    const init = { type: 'system', subtype: 'init', cwd: '/x/agentchat-runtime-check', tools: [], mcp_servers: [], model: 'claude-opus-5-5', permissionMode: 'default' }
    const assistant = { type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] }, parent_tool_use_id: null }
    const ok = { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'OK', terminal_reason: 'completed', api_error_status: null }
    const apiError = { type: 'result', subtype: 'success', is_error: true, num_turns: 1, result: 'API Error: 400 refused', terminal_reason: 'api_error', api_error_status: 400 }
    expect(claudeRuntimeCheckJudge(JSON.stringify([init, assistant, ok]))).toBeNull()
    expect(claudeRuntimeCheckJudge(`${JSON.stringify([init, assistant, ok])}\n`)).toBeNull()
    expect(claudeRuntimeCheckJudge(JSON.stringify([init, apiError]))).toBe('the result is not a success (type result, subtype success, is_error true, api_error_status 400, terminal_reason api_error)')
    expect(claudeRuntimeCheckJudge(JSON.stringify([init, { ...ok, num_turns: 0 }]))).toBe('the result has no turn (num_turns 0)')
    expect(claudeRuntimeCheckJudge(JSON.stringify([init, assistant, { ...ok, result: 'Not that' }]))).toBe('the result does not answer OK')
    // The last result counts: an earlier good one does not cover a later error.
    expect(claudeRuntimeCheckJudge(JSON.stringify([init, ok, apiError]))).toMatch(/^the result is not a success/)
    // No result in it, or nothing that is a message.
    expect(claudeRuntimeCheckJudge(JSON.stringify([init, assistant]))).toBe('its answer is a list of messages with no result')
    expect(claudeRuntimeCheckJudge('[1]')).toBe('its answer is a list of messages with no result')
    expect(claudeRuntimeCheckJudge('[]')).toBe('its answer is a list of messages with no result')
    // An array cut off by the capture is not JSON: not ok.
    expect(claudeRuntimeCheckJudge(JSON.stringify([init, assistant, ok]).slice(0, 80))).toBe('its answer is not a JSON result')
  })

  it('the runner: verbose output (a setting the flags cannot turn off, e.g. a managed one) still passes; a non-OK answer or no turn does not', async () => {
    const fake = installFakeClaude(sandbox)
    const runner = (extra: NodeJS.ProcessEnv): ClaudeRunner =>
      new ClaudeRunner({ configDir: path.join(sandbox, '.claude'), workdir: path.join(sandbox, 'w'), profile: 'own', denyReadPaths: [home], env: withFake(fake, extra) })
    expect(await runner({ FAKE_RUNTIME_VERBOSE: '1' }).checkRuntime()).toEqual({ ok: true })
    expect(await runner({ FAKE_RUNTIME_VERBOSE: '1', FAKE_RUNTIME_RUN_MODE: 'error_exit0' }).checkRuntime()).toEqual({
      ok: false,
      detail: 'claude runtime check failed: exit 0, but the result is not a success (type result, subtype success, is_error true, api_error_status 400, terminal_reason api_error)',
    })
    const notOk = await runner({ FAKE_RUNTIME_RUN_MODE: 'not_ok' }).checkRuntime()
    expect(notOk).toEqual({ ok: false, detail: 'claude runtime check failed: exit 0, but the result does not answer OK' })
    expect(await runner({ FAKE_RUNTIME_RUN_MODE: 'no_turns' }).checkRuntime()).toEqual({ ok: false, detail: 'claude runtime check failed: exit 0, but the result has no turn (num_turns 0)' })
    expect(notOk.detail).not.toContain('must be discarded')
  }, 20_000)

  it('a check that hangs is stopped when its signal aborts: the process is killed and the answer is not ok', async () => {
    const fake = installFakeClaude(sandbox)
    const pids = path.join(sandbox, 'pids.json')
    const runner = new ClaudeRunner({
      configDir: path.join(sandbox, '.claude'),
      workdir: path.join(sandbox, 'w'),
      profile: 'own',
      denyReadPaths: [home],
      env: withFake(fake, { FAKE_RUNTIME_RUN_MODE: 'hang', FAKE_RUNTIME_RUN_PIDS: pids }),
    })
    const controller = new AbortController()
    const started = Date.now()
    const answer = runner.checkRuntime({ signal: controller.signal })
    expect(await eventually(() => fs.existsSync(pids) && fs.statSync(pids).size > 0, 10_000)).toBe(true)
    controller.abort()
    const result = await answer
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/^claude runtime check failed: interrupted/)
    expect(Date.now() - started).toBeLessThan(20_000)
    const [pid] = JSON.parse(fs.readFileSync(pids, 'utf-8')) as number[]
    expect(await eventually(() => gone(pid!), 10_000)).toBe(true)
  }, 30_000)

  it('already stopped: nothing is started', async () => {
    const fake = installFakeClaude(sandbox)
    const runner = new ClaudeRunner({ configDir: path.join(sandbox, '.claude'), workdir: path.join(sandbox, 'w'), profile: 'own', denyReadPaths: [home], env: withFake(fake) })
    const controller = new AbortController()
    controller.abort()
    expect(await runner.checkRuntime({ signal: controller.signal })).toEqual({ ok: false, detail: 'claude runtime check: stopped before it started' })
    expect(readFakeRuns(fake)).toHaveLength(0)
  })
})

describe('Codex: one `codex exec` in an empty folder, read-only, with the AgentChat server switched off', () => {
  it('the flags, pinned: the runs\' URL keeps the agentchat table valid, and `enabled=false` switches it off', () => {
    expect(codexRuntimeCheckArgs('/c/check', 'https://api.example/mcp')).toEqual([
      'exec', '--json', '--skip-git-repo-check', '--ephemeral', '-C', '/c/check',
      '--sandbox', 'read-only',
      '-c', 'web_search="disabled"',
      '--disable', 'memories', '--disable', 'plugins', '--disable', 'apps', '--disable', 'hooks',
      '-c', 'mcp_servers.agentchat.url="https://api.example/mcp"',
      '-c', 'mcp_servers.agentchat.enabled=false',
      '-',
    ])
    // Without a URL (config.toml defines the table, as such runs need), only the switch.
    expect(codexRuntimeCheckArgs('/c/check')).toEqual([
      'exec', '--json', '--skip-git-repo-check', '--ephemeral', '-C', '/c/check', '--sandbox', 'read-only',
      '-c', 'web_search="disabled"',
      '--disable', 'memories', '--disable', 'plugins', '--disable', 'apps', '--disable', 'hooks',
      '-c', 'mcp_servers.agentchat.enabled=false', '-',
    ])
    // The features an answer run turns off, and the user's hooks (`hooks`, Feature::CodexHooks at the 0.154.0 floor).
    expect(CODEX_RUNTIME_CHECK_DISABLED_FEATURES).toEqual(['memories', 'plugins', 'apps', 'hooks'])
    for (const feature of ['memories', 'plugins', 'apps']) expect(CODEX_ANSWER_DISABLED_FEATURES).toContain(feature)
    // No reasoning effort of ours: a model that does not take `low` would refuse every check. The runs' effort applies.
    expect(codexRuntimeCheckArgs('/c/check').join(' ')).not.toContain('reasoning')
  })

  it('the judge: a completed turn with an agent message, as Codex 0.154.0 prints it; anything less is not an answer, and no text is in the reason', () => {
    // As seen against a stand-in provider (one event per line; the metadata warning is an `error` item).
    const lines = (...events: object[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n'
    const started = { type: 'thread.started', thread_id: '01a1f68f-394f-7e12-9d33-05a89172b741' }
    const warning = { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Model metadata for `fake-model` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.' } }
    const turn = { type: 'turn.started' }
    const message = { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'OK' } }
    const done = { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }
    const refused = { type: 'turn.failed', error: { message: '{"error":{"type":"invalid_request_error","message":"SECRET REFUSAL TEXT"}}' } }
    expect(codexRuntimeCheckJudge(lines(started, warning, turn, message, done))).toBeNull()
    expect(codexRuntimeCheckJudge(lines(started, warning, turn, { type: 'error', message: 'SECRET REFUSAL TEXT' }, refused))).toBe('the turn failed (turn.failed)')
    // A failure anywhere in the events is a failure, whatever else is there.
    expect(codexRuntimeCheckJudge(lines(started, turn, message, refused, done))).toBe('the turn failed (turn.failed)')
    expect(codexRuntimeCheckJudge(lines(started, turn, message))).toBe('the turn did not complete (no turn.completed)')
    expect(codexRuntimeCheckJudge(lines(started, turn, done))).toBe('the turn completed with no agent message')
    expect(codexRuntimeCheckJudge(lines(started, turn, { type: 'item.completed', item: { id: 'i', type: 'agent_message', text: '  ' } }, done))).toBe('the turn completed with no agent message')
    expect(codexRuntimeCheckJudge(lines(started, turn, { type: 'item.completed', item: { id: 'i', type: 'reasoning', text: 'thinking' } }, done))).toBe('the turn completed with no agent message')
    // Not JSON events at all; a capture cut off inside the last event loses it.
    expect(codexRuntimeCheckJudge('OK\n')).toBe('its answer holds no JSON event')
    expect(codexRuntimeCheckJudge('')).toBe('its answer holds no JSON event')
    expect(codexRuntimeCheckJudge(lines(started, turn, message) + JSON.stringify(done).slice(0, 20))).toBe('the turn did not complete (no turn.completed)')
    for (const reason of [codexRuntimeCheckJudge(lines(started, turn, refused))]) expect(reason).not.toContain('SECRET')
  })

  for (const profile of ['own', 'answer', 'work', 'full'] as const) {
    it(`${profile}: the listener's runner checks with the run's binary and CODEX_HOME, no key in its environment, the fixed prompt on stdin`, async () => {
      const fake = installFakeCodex(sandbox)
      const env = withFake(fake)
      const runner = codexPreset.runner({ home, workdir: path.join(sandbox, 'work'), profile, apiKey: KEY, apiBase: 'https://api.example', env })
      expect(await runner.checkRuntime!()).toEqual({ ok: true })
      const [check] = readFakeRuns(fake)
      const dir = codexRuntimeCheckWorkdir(path.join(sandbox, '.codex'))
      expect(check?.argv).toEqual(codexRuntimeCheckArgs(dir, 'https://api.example/mcp'))
      expect(check?.stdin).toBe(RUNTIME_CHECK_PROMPT)
      expect(real(check?.cwd ?? '')).toBe(real(dir))
      expect(check?.env['CODEX_HOME']).toBe(path.join(sandbox, '.codex'))
      expect(JSON.stringify(check?.env)).not.toContain(KEY)
      expect(check?.env[LISTENER_KEY_ENV]).toBeUndefined()
      // No `mcp list` is needed for it, whatever the profile.
      expect(readFakeRuns(fake)).toHaveLength(1)
    }, 20_000)
  }

  it('an integration\'s runner (the URL pinned) checks with that URL; a refused runner checks nothing', async () => {
    const fake = installFakeCodex(sandbox)
    const env = withFake(fake)
    const base = { codexHome: path.join(sandbox, '.codex'), workdir: path.join(sandbox, 'work'), profile: 'own' as const, apiKey: () => KEY, keyEnv: 'AGENTCHAT_API_KEY', env }
    const pinned = new CodexRunner({ ...base, pinMcpUrl: 'https://api.example/mcp' })
    expect(await pinned.checkRuntime()).toEqual({ ok: true })
    expect(readFakeRuns(fake)[0]?.argv).toContain('mcp_servers.agentchat.url="https://api.example/mcp"')
    const refused = new CodexRunner({ ...base, refuse: 'no run may start: the reason' })
    expect(await refused.checkRuntime()).toEqual({ ok: false, detail: 'no run may start: the reason' })
    expect(readFakeRuns(fake)).toHaveLength(1)
  }, 20_000)

  it('a provider error (exit 1) is not ok', async () => {
    const fake = installFakeCodex(sandbox)
    const runner = new CodexRunner({ codexHome: path.join(sandbox, '.codex'), workdir: path.join(sandbox, 'w'), profile: 'own', apiKey: () => null, keyEnv: 'AGENTCHAT_API_KEY', pinMcpUrl: 'https://api.example/mcp', env: withFake(fake, { FAKE_RUNTIME_RUN_MODE: 'fail' }) })
    const result = await runner.checkRuntime()
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/^codex runtime check failed: exit 1/)
  }, 20_000)

  it('exit 0 is not enough: a failed turn, a turn with no agent message, no completed turn, or plain text is not ok; no text is in the detail', async () => {
    const fake = installFakeCodex(sandbox)
    const runner = (mode: string): CodexRunner =>
      new CodexRunner({ codexHome: path.join(sandbox, '.codex'), workdir: path.join(sandbox, 'w'), profile: 'own', apiKey: () => null, keyEnv: 'AGENTCHAT_API_KEY', pinMcpUrl: 'https://api.example/mcp', env: withFake(fake, { FAKE_RUNTIME_RUN_MODE: mode }) })
    const results = {
      error_exit0: await runner('error_exit0').checkRuntime(),
      no_message: await runner('no_message').checkRuntime(),
      no_turn: await runner('no_turn').checkRuntime(),
      text: await runner('text').checkRuntime(),
    }
    expect(results).toEqual({
      error_exit0: { ok: false, detail: 'codex runtime check failed: exit 0, but the turn failed (turn.failed)' },
      no_message: { ok: false, detail: 'codex runtime check failed: exit 0, but the turn completed with no agent message' },
      no_turn: { ok: false, detail: 'codex runtime check failed: exit 0, but the turn did not complete (no turn.completed)' },
      text: { ok: false, detail: 'codex runtime check failed: exit 0, but its answer holds no JSON event' },
    })
    expect(JSON.stringify(results)).not.toContain('must be discarded')
  }, 20_000)
})

describe('runRuntimeCheck: bounded by its own budget', () => {
  it('past the budget the probe is killed and the answer is timed out', async () => {
    const fake = installFakeClaude(sandbox)
    const pids = path.join(sandbox, 'pids.json')
    const env = withFake(fake, { FAKE_RUNTIME_RUN_MODE: 'hang', FAKE_RUNTIME_RUN_PIDS: pids })
    const result = await runRuntimeCheck({ label: 'claude', command: 'claude', args: ['-p'], cwd: path.join(sandbox, 'check'), env, budgetMs: 1_500 })
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/^claude runtime check timed out: run exceeded its 2 s budget and was killed/)
    const [pid] = JSON.parse(fs.readFileSync(pids, 'utf-8')) as number[]
    expect(await eventually(() => gone(pid!), 10_000)).toBe(true)
  }, 30_000)
})
