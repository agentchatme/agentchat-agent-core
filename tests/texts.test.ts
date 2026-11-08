import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Texts } from 'agentchatme'
import { loadTexts, readCachedTexts, textsCachePath, type TextsClient } from '../src/integration/texts.js'
import { textsFor } from './helpers/served-texts.js'

// ─── The served texts for a CLI command: one fetch, the cached copy as fallback ─
//
// No text lives in this package. The resident integration holds the SDK kit's
// TextsCache (tested there); what is tested here is the one-shot read the CLI
// commands make, and that it shares the identity-home file with the kit.

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

describe('loadTexts (the CLI’s one fetch with the cache as fallback)', () => {
  it('server answers → the server’s words, cached', async () => {
    const loaded = await loadTexts({ home, runtime: 'generic', client: new FakeTextsClient(textsFor('me')) })
    expect(loaded?.source).toBe('server')
    expect(readCachedTexts(home, 'generic')?.texts.identity_line).toContain('@me')
  })

  it('server down → the cache; neither → null', async () => {
    expect(await loadTexts({ home, runtime: 'generic', client: new FakeTextsClient(down()) })).toBeNull()
    // The file the kit's TextsCache keeps (and the previous TextsStore wrote): version 1, per runtime.
    fs.writeFileSync(textsCachePath(home), JSON.stringify({ version: 1, fetched_at: '2026-11-01T00:00:00.000Z', runtime: 'generic', texts: textsFor('me') }))
    const loaded = await loadTexts({ home, runtime: 'generic', client: new FakeTextsClient(down()) })
    expect(loaded).toMatchObject({ source: 'cache', fetched_at: '2026-11-01T00:00:00.000Z' })
  })
})

describe('readCachedTexts', () => {
  it('reads the kept copy for this runtime only; a damaged file is no file', () => {
    expect(readCachedTexts(home, 'generic')).toBeNull()
    fs.writeFileSync(textsCachePath(home), JSON.stringify({ version: 1, fetched_at: '2026-11-01T00:00:00.000Z', runtime: 'codex', texts: textsFor('me') }))
    expect(readCachedTexts(home, 'generic')).toBeNull()
    expect(readCachedTexts(home, 'codex')?.texts.identity_line).toContain('@me')
    fs.writeFileSync(textsCachePath(home), '{not json')
    expect(readCachedTexts(home, 'codex')).toBeNull()
  })
})
