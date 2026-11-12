import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  ANSWER_SETTINGS,
  CODEX_ANSWER_DISABLED_FEATURES,
  claudeCodePreset,
  claudeRunArgs,
  codexPreset,
  codexRunArgs,
  LISTENER_KEY_ENV,
  workdirPaths,
  workdirReadRules,
} from '../src/presets/index.js'
import { installFakeClaude, installFakeCodex, readFakeRuns } from './helpers/fake-runtimes.js'

// ─── The `answer` profile: what a peer-started run can reach ────────────────
//
// `answer` is the default, and an `answer` run is started by any unread
// message — a stranger's cold DM included. Private data + untrusted input + a
// way out is the leak; so an `answer` run gets the AgentChat tools, file reads
// inside its own workdir, and nothing else: no web, no shell, no read outside
// the workdir. These tests fail if any of that is ever widened.

const posix = process.platform !== 'win32'
const KEY = 'ac_live_' + 'k'.repeat(40)

let sandbox: string
const originalPath = process.env['PATH']
beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-answer-'))
})
afterEach(() => {
  process.env['PATH'] = originalPath
  fs.rmSync(sandbox, { recursive: true, force: true })
})

/** The value after `flag`, or null. */
function valueOf(argv: readonly string[], flag: string): string | null {
  const at = argv.indexOf(flag)
  return at < 0 ? null : (argv[at + 1] ?? null)
}

/** The rules of a comma/space-separated rule list, as Claude Code splits it. */
function rulesOf(list: string | null): string[] {
  return list === null ? [] : list.split(/[,\s]+/).filter((r) => r.length > 0)
}

/**
 * The guard: every way an `answer` argv could re-open the leak. `workdirs` are
 * the only paths a file allow rule may name (each spelling of the workdir).
 */
function assertClaudeAnswerIsConfined(argv: readonly string[], workdirs: readonly string[]): void {
  expect(argv).not.toContain('--dangerously-skip-permissions')
  expect(argv).not.toContain('--allow-dangerously-skip-permissions')
  expect(argv).not.toContain('--add-dir')
  expect(valueOf(argv, '--permission-mode')).toBe('default')
  expect(valueOf(argv, '--permission-prompts')).toBe('none')

  // The built-in set: exactly the read tools. No web, no shell, no edits.
  expect(rulesOf(valueOf(argv, '--tools')).sort()).toEqual(['Glob', 'Grep', 'Read'])

  // Pre-approved: the hosted tools, and Read on the workdir's own tree. Never a
  // bare Read/Glob/Grep (every path), never the web or the shell, never a
  // pattern that reaches past the workdir.
  const allowed = rulesOf(valueOf(argv, '--allowedTools'))
  expect(allowed).toContain('mcp__agentchat__*')
  for (const rule of allowed) {
    if (rule === 'mcp__agentchat__*') continue
    for (const banned of ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      expect(rule, `bare ${banned} allows it on every path`).not.toBe(banned)
    }
    expect(rule).not.toMatch(/^(WebFetch|WebSearch|Bash|Glob|Grep|Edit|Write)\b/)
    const match = /^Read\(\/\/(.*)\)$/.exec(rule)
    expect(match, `unexpected allow rule ${rule}`).not.toBeNull()
    const target = `/${match?.[1] ?? ''}`
    const under = workdirs.some((w) => target === w || target === `${w}/**`)
    expect(under, `${rule} reaches outside ${workdirs.join(' | ')}`).toBe(true)
    expect(target).not.toMatch(/^\/\*\*|^\/$|~/)
  }

  // Denied by name as well: even a widened --tools could not bring them back.
  const denied = rulesOf(valueOf(argv, '--disallowedTools'))
  for (const tool of ['WebFetch', 'WebSearch', 'Bash']) expect(denied).toContain(tool)

  // Reads outside the working directories refused whatever the user's own allow rules say.
  const settings = JSON.parse(valueOf(argv, '--settings') ?? '{}') as { permissions?: { blockReadsOutsideWorkingDirectories?: unknown; allow?: unknown; additionalDirectories?: unknown } }
  expect(settings.permissions?.blockReadsOutsideWorkingDirectories).toBe(true)
  expect(settings.permissions?.allow).toBeUndefined()
  expect(settings.permissions?.additionalDirectories).toBeUndefined()
}

describe('Claude Code answer: confined to the workdir (regression guard)', () => {
  it('the argv never gains WebFetch, WebSearch, Bash or an unscoped Read — with or without the options a caller can pass', () => {
    const variants = [
      claudeRunArgs('answer', { workdir: '/w' }),
      claudeRunArgs('answer', { workdir: '/w', denyReadPaths: ['/h', '/u/.claude.json'], mcpConfigPath: '/h/presets/claude-code.mcp.json', maxBudgetUsd: '2' }),
      claudeRunArgs('answer'),
    ]
    for (const argv of variants) assertClaudeAnswerIsConfined(argv, ['/w'])
  })

  it('the guard itself trips on each way of re-opening the leak', () => {
    const good = claudeRunArgs('answer', { workdir: '/w' })
    const swap = (flag: string, value: string): string[] => {
      const argv = [...good]
      argv[argv.indexOf(flag) + 1] = value
      return argv
    }
    const bad = [
      swap('--tools', 'Read,Glob,Grep,WebFetch'),
      swap('--tools', 'Read,Glob,Grep,WebSearch'),
      swap('--tools', 'Read,Glob,Grep,Bash'),
      swap('--allowedTools', 'mcp__agentchat__*,Read'),
      swap('--allowedTools', 'mcp__agentchat__*,Grep'),
      swap('--allowedTools', 'mcp__agentchat__*,Read(//**)'),
      swap('--allowedTools', 'mcp__agentchat__*,Read(~/**)'),
      swap('--allowedTools', 'mcp__agentchat__*,Read(//Users/**)'),
      swap('--allowedTools', 'mcp__agentchat__*,WebFetch'),
      swap('--disallowedTools', 'Bash'),
      swap('--settings', '{}'),
      swap('--permission-mode', 'bypassPermissions'),
    ]
    for (const argv of bad) expect(() => assertClaudeAnswerIsConfined(argv, ['/w'])).toThrow()
    expect(ANSWER_SETTINGS).toBe('{"permissions":{"blockReadsOutsideWorkingDirectories":true}}')
  })

  it('the preset runner (what the listener and the integration both start) passes the guard, with its own workdir', async () => {
    const fake = installFakeClaude(sandbox)
    const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${originalPath ?? ''}`, FAKE_RUNTIME_RECORD: fake.recordPath, CLAUDE_CONFIG_DIR: path.join(sandbox, '.claude') }
    process.env['PATH'] = env['PATH']
    const home = path.join(sandbox, 'home')
    const workdir = path.join(sandbox, 'work')
    fs.mkdirSync(home, { recursive: true })
    const runner = claudeCodePreset.runner({ home, workdir, profile: 'answer', apiKey: KEY, apiBase: 'https://api.example', env })
    expect(await runner.preflight()).toEqual({ ok: true })
    expect((await runner.start({ kind: 'wake', prompt: 'WAKE', runId: 'r1', budgetMs: 20_000 })).state).toBe('ok')
    const [run] = readFakeRuns(fake)
    const argv = run?.argv ?? []
    assertClaudeAnswerIsConfined(argv, workdirPaths(workdir))
    if (posix) {
      // The workdir as the run sees it (its real path) is the one that is allowed.
      expect(rulesOf(valueOf(argv, '--allowedTools'))).toContain(`Read(/${fs.realpathSync(workdir)}/**)`)
      // The key store is still denied.
      expect(rulesOf(valueOf(argv, '--disallowedTools'))).toContain(`Read(/${home}/**)`)
    }
    expect(fs.realpathSync(run?.cwd ?? '')).toBe(fs.realpathSync(workdir))
  }, 20_000)
})

describe.skipIf(!posix)('Claude Code answer: the workdir path in an allow rule', () => {
  it('a plain absolute path: the dir itself and its tree; a trailing slash and a relative path are normalised', () => {
    expect(workdirReadRules('/w/')).toEqual(['Read(//w)', 'Read(//w/**)'])
    const relative = workdirReadRules('rel-workdir-that-does-not-exist')
    expect(relative).toEqual([`Read(/${path.resolve('rel-workdir-that-does-not-exist')})`, `Read(/${path.resolve('rel-workdir-that-does-not-exist')}/**)`])
  })

  it('whitespace or a comma: no rule (a comma/space-separated list would split it into other paths); the run still reads its cwd as its working directory', () => {
    const spaced = path.join(sandbox, 'my work')
    fs.mkdirSync(spaced)
    expect(workdirReadRules(spaced)).toEqual([])
    expect(workdirReadRules('/a,b')).toEqual([])
    expect(workdirReadRules('/tab\there')).toEqual([])
    const argv = claudeRunArgs('answer', { workdir: spaced })
    expect(valueOf(argv, '--allowedTools')).toBe('mcp__agentchat__*')
    // No fragment of the spaced path leaks into any rule list as a path of its own.
    for (const list of [valueOf(argv, '--allowedTools'), valueOf(argv, '--disallowedTools')]) expect(list).not.toContain('work')
    assertClaudeAnswerIsConfined(argv, [])
  })

  it('a gitignore pattern character: no rule (written rules are not escaped, so `/w*` would also allow `/wallet`)', () => {
    for (const p of ['/w*', '/w?', '/w[1]', '/w\\x', '/!w', '/#w']) expect(workdirReadRules(p), p).toEqual([])
  })

  it('the filesystem root is no work folder: no rule', () => {
    expect(workdirReadRules('/')).toEqual([])
  })

  it('a symlinked workdir: both spellings, and nothing else — an allow rule matches only when the link and its target both match', () => {
    const real = path.join(sandbox, 'real-work')
    const link = path.join(sandbox, 'link-work')
    fs.mkdirSync(real)
    fs.symlinkSync(real, link)
    const realPath = fs.realpathSync(real)
    expect(workdirPaths(link)).toEqual([link, realPath])
    expect(workdirReadRules(link)).toEqual([`Read(/${link})`, `Read(/${link}/**)`, `Read(/${realPath})`, `Read(/${realPath}/**)`])
    assertClaudeAnswerIsConfined(claudeRunArgs('answer', { workdir: link }), [link, realPath])
  })

  it.skipIf(process.platform !== 'darwin')('macOS /tmp is /private/tmp: the real path the run sees as its cwd is carried too', () => {
    const dir = fs.mkdtempSync('/tmp/agentchat-answer-tmp-')
    try {
      expect(fs.realpathSync(dir)).toBe(`/private${dir}`)
      expect(workdirReadRules(dir)).toEqual([`Read(/${dir})`, `Read(/${dir}/**)`, `Read(//private${dir})`, `Read(//private${dir}/**)`])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe.skipIf(posix)('Claude Code answer on Windows', () => {
  it('no path rule is rendered (fails closed: the run reads its cwd as its working directory, and the block refuses the rest)', () => {
    expect(workdirReadRules('C:\\w')).toEqual([])
    assertClaudeAnswerIsConfined(claudeRunArgs('answer', { workdir: 'C:\\w' }), [])
  })
})

// ─── Codex `answer` ─────────────────────────────────────────────────────────
//
// Codex can restrict a sandbox's reads, but a shell needs `:minimal`, which also
// opens /etc, /usr and read-write /tmp; so `answer` has no shell and no
// local-file tool at all, and the sandbox (for apply_patch, which has no off
// switch) reads the workdir only and writes nothing.

/** Every `-c` value of an argv, in order. */
function configOf(argv: readonly string[]): string[] {
  return argv.flatMap((arg, i) => (argv[i - 1] === '-c' ? [arg] : []))
}

/** Every `--disable` feature of an argv. */
function disabledOf(argv: readonly string[]): string[] {
  return argv.flatMap((arg, i) => (argv[i - 1] === '--disable' ? [arg] : []))
}

function assertCodexAnswerIsConfined(argv: readonly string[], workdir: string): void {
  // No legacy sandbox mode: `--sandbox read-only` reads the whole disk ($CODEX_HOME/.env included).
  expect(argv).not.toContain('--sandbox')
  expect(argv).not.toContain('-s')
  expect(argv).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  expect(argv).not.toContain('--add-dir')
  expect(argv).not.toContain('--enable')
  expect(argv[argv.indexOf('-C') + 1]).toBe(workdir)
  const config = configOf(argv)
  expect(config).toContain('approval_policy="never"')
  expect(config).not.toContain('approval_policy="on-request"')
  expect(config.filter((c) => /^sandbox_mode\b|^sandbox_workspace_write\b|^features\./.test(c))).toEqual([])

  // The shell, the local-file tools and every other way out are off.
  const disabled = disabledOf(argv)
  for (const feature of ['shell_tool', 'view_image', 'image_generation', 'plugins', 'apps', 'memories', 'browser_use', 'computer_use']) expect(disabled).toContain(feature)
  expect(config).toContain('web_search="disabled"')
  expect(config.filter((c) => c.startsWith('web_search=') || c.startsWith('tools.web_search'))).toEqual(['web_search="disabled"'])
  // No project or ancestor AGENTS.md in the run's context.
  expect(config.filter((c) => c.startsWith('project_doc_max_bytes='))).toEqual(['project_doc_max_bytes=0'])

  // The one permission profile: read the workspace root, nothing else, no write, no network.
  expect(config.filter((c) => c.startsWith('default_permissions='))).toEqual(['default_permissions="agentchat_answer"'])
  expect(config.filter((c) => c.startsWith('permissions.'))).toEqual(['permissions.agentchat_answer.filesystem={ ":workspace_roots" = "read" }'])
  for (const c of config) expect(c).not.toMatch(/":root"|":minimal"|"write"|network|danger-full-access|disk-full-read/)
}

describe('Codex answer: no shell, no local-file tool, AgentChat tools only (regression guard)', () => {
  it('the argv never gains the shell, a whole-disk sandbox, the web or a local-file tool — with or without the hosted-server overrides', () => {
    assertCodexAnswerIsConfined(codexRunArgs('answer', { workdir: '/w' }), '/w')
    const listener = codexRunArgs('answer', { workdir: '/w', mcp: { url: 'https://api.example/mcp', keyEnv: LISTENER_KEY_ENV } })
    assertCodexAnswerIsConfined(listener, '/w')
    // The overrides touch only the agentchat server; the prompt stays the last positional.
    expect(configOf(listener).filter((c) => c.startsWith('mcp_servers.')).every((c) => c.startsWith('mcp_servers.agentchat.'))).toBe(true)
    expect(listener[listener.length - 1]).toBe('-')
    expect([...CODEX_ANSWER_DISABLED_FEATURES]).toContain('shell_tool')
  })

  it('the guard itself trips on each way of re-opening the leak', () => {
    const good = codexRunArgs('answer', { workdir: '/w' })
    const without = (value: string): string[] => {
      const at = good.indexOf(value)
      return [...good.slice(0, at - 1), ...good.slice(at + 1)]
    }
    const bad = [
      ['--sandbox', 'read-only', ...good],
      [...good.slice(0, -1), '--dangerously-bypass-approvals-and-sandbox', '-'],
      without('shell_tool'),
      without('view_image'),
      without('web_search="disabled"'),
      without('project_doc_max_bytes=0'),
      without('default_permissions="agentchat_answer"'),
      [...good.slice(0, -1), '-c', 'web_search="live"', '-'],
      [...good.slice(0, -1), '-c', 'features.shell_tool=true', '-'],
      [...good.slice(0, -1), '--enable', 'shell_tool', '-'],
      good.map((a) => (a === 'permissions.agentchat_answer.filesystem={ ":workspace_roots" = "read" }' ? 'permissions.agentchat_answer.filesystem={ ":minimal" = "read", ":workspace_roots" = "read" }' : a)),
      good.map((a) => (a === 'permissions.agentchat_answer.filesystem={ ":workspace_roots" = "read" }' ? 'permissions.agentchat_answer.filesystem={ ":root" = "read" }' : a)),
      good.map((a) => (a === 'permissions.agentchat_answer.filesystem={ ":workspace_roots" = "read" }' ? 'permissions.agentchat_answer.filesystem={ ":workspace_roots" = "write" }' : a)),
    ]
    for (const argv of bad) expect(() => assertCodexAnswerIsConfined(argv, '/w')).toThrow()
  })

  it('the workdir is one argv element whatever it holds (spaces, a comma, a symlinked /tmp): never split, never quoted into a shell', () => {
    for (const workdir of ['/tmp/a b/work', '/w,x', "/w'q\"x", path.join(sandbox, 'my work')]) {
      const argv = codexRunArgs('answer', { workdir })
      expect(argv[argv.indexOf('-C') + 1]).toBe(workdir)
      assertCodexAnswerIsConfined(argv, workdir)
      // The workdir appears exactly once: `:workspace_roots` names it, no rule repeats the path.
      expect(argv.filter((a) => a.includes(workdir))).toEqual([workdir])
    }
  })

  it('the preset runner (what the listener and the integration both start) passes the guard', async () => {
    const fake = installFakeCodex(sandbox)
    const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${originalPath ?? ''}`, FAKE_RUNTIME_RECORD: fake.recordPath, CODEX_HOME: path.join(sandbox, '.codex') }
    process.env['PATH'] = env['PATH']
    const workdir = path.join(sandbox, 'work dir')
    const runner = codexPreset.runner({ home: path.join(sandbox, 'home'), workdir, profile: 'answer', apiKey: KEY, apiBase: 'https://api.example', env })
    expect(await runner.preflight()).toEqual({ ok: true })
    expect((await runner.start({ kind: 'wake', prompt: 'WAKE', runId: 'r1', budgetMs: 20_000 })).state).toBe('ok')
    const [run] = readFakeRuns(fake)
    assertCodexAnswerIsConfined(run?.argv ?? [], workdir)
    expect(JSON.stringify(run?.argv)).not.toContain(KEY)
    expect(fs.realpathSync(run?.cwd ?? '')).toBe(fs.realpathSync(workdir))
  }, 20_000)
})
