import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Texts } from 'agentchatme'
import {
  TEXTS_REFRESH_MS,
  TEXTS_RETRY_MS,
  TextsStore,
  loadTexts,
  readCachedTexts,
  textsCachePath,
  writeCachedTexts,
  type TextsClient,
} from '../src/integration/texts.js'
import { buildRunPrompts } from '../src/integration/prompts.js'
import { FakeClock, flush } from './helpers/fake-clock.js'
import { textsFor } from './helpers/served-texts.js'

// ─── The served texts: fetched at start, daily, and on first use; cached ────
//
// No text lives in this package. What is tested is the plumbing around the
// server's answer: it is fetched, it is cached in the identity home, a daemon
// that comes up offline starts on the cache, and a run with nothing in hand
// waits rather than inventing a prompt.

class FakeTextsClient implements TextsClient {
  calls: string[] = []
  constructor(public answer: Texts | Error | (() => Texts | Error)) {}
  readonly texts = {
    get: async (options: { runtime: string }): Promise<Texts> => {
      this.calls.push(options.runtime)
      const value = typeof this.answer === 'function' ? this.answer() : this.answer
      if (value instanceof Error) throw value
      return value
    },
  }
}

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-texts-'))
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

const down = (): Error => new Error('fetch failed: ECONNREFUSED')

function store(client: TextsClient, clock: FakeClock, extra: Partial<ConstructorParameters<typeof TextsStore>[0]> = {}): TextsStore {
  return new TextsStore({
    home,
    runtime: 'generic',
    client,
    now: () => new Date(clock.now()),
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (h) => clock.clearTimeout(h),
    ...extra,
  })
}

describe('TextsStore', () => {
  it('fetches at start, serves the server’s words, and caches them in the identity home with the fetch time', async () => {
    const clock = new FakeClock()
    clock.advance(1_700_000_000_000)
    const client = new FakeTextsClient(textsFor('me'))
    const s = store(client, clock)
    expect(s.source).toBe('none')
    await s.start()
    expect(client.calls).toEqual(['generic'])
    expect(s.source).toBe('server')
    expect(s.current()?.wake_instruction).toContain('SERVED WAKE INSTRUCTION')
    const cached = JSON.parse(fs.readFileSync(textsCachePath(home), 'utf-8')) as { version: number; fetched_at: string; runtime: string; texts: Texts }
    expect(cached).toMatchObject({ version: 1, runtime: 'generic', fetched_at: new Date(clock.now()).toISOString() })
    expect(cached.texts.identity_line).toContain('@me')
    if (process.platform !== 'win32') expect(fs.statSync(textsCachePath(home)).mode & 0o777).toBe(0o600)
    s.stop()
  })

  it('refreshes every 24 h and picks up a changed text', async () => {
    const clock = new FakeClock()
    let text = textsFor('me')
    const client = new FakeTextsClient(() => text)
    const s = store(client, clock)
    await s.start()
    expect(client.calls).toHaveLength(1)
    await clock.advanceAsync(TEXTS_REFRESH_MS - 1)
    expect(client.calls).toHaveLength(1)
    text = { ...text, wake_instruction: 'A NEWER WAKE INSTRUCTION' }
    await clock.advanceAsync(1)
    await flush()
    expect(client.calls).toHaveLength(2)
    expect(s.current()?.wake_instruction).toBe('A NEWER WAKE INSTRUCTION')
    await clock.advanceAsync(TEXTS_REFRESH_MS)
    await flush()
    expect(client.calls).toHaveLength(3)
    s.stop()
  })

  it('a daemon that starts offline runs on the cache, retries hourly, and goes back to the server when it answers', async () => {
    const clock = new FakeClock()
    writeCachedTexts(home, 'generic', { ...textsFor('me'), wake_instruction: 'CACHED WAKE INSTRUCTION' }, new Date(clock.now()))
    const client = new FakeTextsClient(down())
    const s = store(client, clock)
    expect(s.source).toBe('cache')
    expect(s.current()?.wake_instruction).toBe('CACHED WAKE INSTRUCTION')
    await s.start() // does not throw
    expect(client.calls).toHaveLength(1)
    expect(s.source).toBe('cache')
    // First use: one more attempt (the start fetch failed), then the cache.
    const texts = await s.ensure()
    expect(client.calls).toHaveLength(2)
    expect(texts?.wake_instruction).toBe('CACHED WAKE INSTRUCTION')
    // The retry timer is the hourly one, not the daily one.
    await clock.advanceAsync(TEXTS_RETRY_MS)
    await flush()
    expect(client.calls).toHaveLength(3)
    // The server comes back.
    client.answer = textsFor('me')
    await clock.advanceAsync(TEXTS_RETRY_MS)
    await flush()
    expect(s.source).toBe('server')
    expect(s.current()?.wake_instruction).toContain('SERVED WAKE INSTRUCTION')
    // And first use no longer re-fetches: the server has answered this process.
    const before = client.calls.length
    await s.ensure()
    expect(client.calls).toHaveLength(before)
    s.stop()
  })

  it('offline with nothing cached: starts anyway with nothing in hand; first use fetches; a run gets null until the server answers', async () => {
    const clock = new FakeClock()
    const client = new FakeTextsClient(down())
    const s = store(client, clock)
    await s.start()
    expect(s.source).toBe('none')
    expect(s.current()).toBeNull()
    expect(await s.ensure()).toBeNull()
    expect(client.calls).toHaveLength(2)
    client.answer = textsFor('me')
    const texts = await s.ensure()
    expect(texts).not.toBeNull()
    expect(s.source).toBe('server')
    expect(fs.existsSync(textsCachePath(home))).toBe(true)
    s.stop()
  })

  it('a malformed answer counts as a failed fetch and keeps what is in hand', async () => {
    const clock = new FakeClock()
    writeCachedTexts(home, 'generic', textsFor('me'), new Date(clock.now()))
    const client = new FakeTextsClient({ version: '1' } as unknown as Texts)
    const s = store(client, clock)
    await s.start()
    expect(s.source).toBe('cache')
    expect(s.current()?.wake_instruction).toContain('SERVED WAKE INSTRUCTION')
    s.stop()
  })

  it('coalesces concurrent fetches and ignores a late answer after stop()', async () => {
    const clock = new FakeClock()
    let release: (t: Texts) => void = () => undefined
    const client: TextsClient = {
      texts: { get: () => new Promise<Texts>((resolve) => (release = resolve)) },
    }
    const s = store(client, clock)
    const a = s.refresh()
    const b = s.refresh()
    expect(a).toBe(b)
    s.stop()
    release(textsFor('me'))
    await a
    expect(s.source).toBe('none') // stopped before the answer: nothing taken
  })

  it('the cache is per runtime: another runtime’s cache is not this one’s', () => {
    writeCachedTexts(home, 'generic', textsFor('me'), new Date())
    expect(readCachedTexts(home, 'generic')).not.toBeNull()
    expect(readCachedTexts(home, 'hermes')).toBeNull()
  })
})

describe('loadTexts (the CLI’s one fetch with the cache as fallback)', () => {
  it('server answers → the server’s words, cached', async () => {
    const loaded = await loadTexts({ home, runtime: 'generic', client: new FakeTextsClient(textsFor('me')) })
    expect(loaded?.source).toBe('server')
    expect(readCachedTexts(home, 'generic')?.texts.identity_line).toContain('@me')
  })

  it('server down → the cache; neither → null', async () => {
    expect(await loadTexts({ home, runtime: 'generic', client: new FakeTextsClient(down()) })).toBeNull()
    writeCachedTexts(home, 'generic', textsFor('me'), new Date('2026-11-01T00:00:00Z'))
    const loaded = await loadTexts({ home, runtime: 'generic', client: new FakeTextsClient(down()) })
    expect(loaded).toMatchObject({ source: 'cache', fetched_at: '2026-11-01T00:00:00.000Z' })
  })
})

describe('buildRunPrompts', () => {
  it('is the served text, then the one pointer line — nothing of this package’s own', () => {
    const prompts = buildRunPrompts(textsFor('me'), '(POINTER)')
    expect(prompts.wake).toBe(`${textsFor('me').wake_instruction}\n\n(POINTER)`)
    expect(prompts.invite).toBe(`${textsFor('me').invite_prompt}\n\n(POINTER)`)
    expect(prompts.wake.split('\n\n')).toHaveLength(2)
  })
})
