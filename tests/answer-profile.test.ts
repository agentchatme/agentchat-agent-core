import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  ANSWER_SETTINGS,
  claudeCodePreset,
  claudeRunArgs,
  workdirPaths,
  workdirReadRules,
} from '../src/presets/index.js'
import { installFakeClaude, readFakeRuns } from './helpers/fake-runtimes.js'

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
