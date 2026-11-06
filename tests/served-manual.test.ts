import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AddressInfo } from 'node:net'
import { MANUAL, manualFrontMatter, manualVersion } from '../src/skill/manual.js'
import {
  ManualFollower,
  checkManual,
  describeManualSync,
  readManualVersion,
  syncManual,
  type ManualFetch,
  type ServedManual,
} from '../src/skill/served-manual.js'
import { log } from '../src/util/log.js'

// ─── The skill file follows the served manual ───────────────────────────────
//
// The served texts announce `manual: {url, version}`; the skill file is
// brought to that version — downloaded over HTTPS, size-capped, accepted only
// when its front matter is the agentchat skill at the announced version, and
// written atomically. Every failure keeps the file that was there; the bundled
// copy is written only when there is no file at all (or when it IS the
// announced version, so there is nothing to download).

const URL_ = 'https://agentchat.me/skill.md'
const BUNDLED = manualVersion(MANUAL)!

/** A manual the bundle does not carry: front matter like the real one, a different version. */
function servedText(version: string, body = 'The served manual body.\n\n---\n\nversion: 0.0.0 (not front matter)\n'): string {
  return `---\nname: agentchat\nversion: ${version}\ndescription: The messaging platform for AI agents.\nhomepage: https://agentchat.me\n---\n\n# AgentChat\n\n${body}`
}

interface FakeFetch extends ManualFetch {
  calls: string[]
}

/** Answers every request with `answer(url)`; records the URLs asked for. */
function fakeFetch(answer: (url: string, init: RequestInit) => Response | Promise<Response>): FakeFetch {
  const calls: string[] = []
  const fn = (async (url: string, init: RequestInit) => {
    calls.push(url)
    return answer(url, init)
  }) as FakeFetch
  fn.calls = calls
  return fn
}

const ok = (text: string, headers: Record<string, string> = {}): Response =>
  new Response(text, { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8', ...headers } })

const refused = (): FakeFetch =>
  fakeFetch(() => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
  })

let dir: string
let file: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-manual-'))
  file = path.join(dir, 'skills', 'agentchat', 'SKILL.md')
})
afterEach(() => {
  vi.restoreAllMocks()
  try {
    fs.chmodSync(path.dirname(file), 0o755)
  } catch {
    /* not created */
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

function place(text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const served = (version: string, url = URL_): ServedManual => ({ url, version })

describe('syncManual — the announced version decides', () => {
  it('a file at the announced version is current: nothing fetched, nothing written', async () => {
    place(servedText('9.1.0'))
    const before = fs.statSync(file).mtimeMs
    const f = fakeFetch(() => ok(servedText('9.1.0')))
    const r = await syncManual({ path: file, served: served('9.1.0'), fetch: f })
    expect(r).toMatchObject({ state: 'current', version: '9.1.0', written: false, upToDate: true, error: null })
    expect(f.calls).toEqual([])
    expect(fs.statSync(file).mtimeMs).toBe(before)
    expect(describeManualSync(r)).toBe(`current (9.1.0) — ${file}`)
  })

  it('a different announced version is downloaded from the announced address and written over the old file', async () => {
    place(servedText('9.0.0'))
    const text = servedText('9.1.0')
    const f = fakeFetch(() => ok(text))
    const r = await syncManual({ path: file, served: served('9.1.0'), fetch: f })
    expect(f.calls).toEqual([URL_])
    expect(r).toMatchObject({ state: 'updated', source: 'download', previous: '9.0.0', version: '9.1.0', written: true, upToDate: true })
    expect(fs.readFileSync(file, 'utf-8')).toBe(text)
    expect(describeManualSync(r)).toBe(`9.1.0 downloaded from ${URL_} → ${file} (was 9.0.0)`)
  })

  it('no file yet and the version announced: downloaded, the directory made', async () => {
    const f = fakeFetch(() => ok(servedText('9.1.0')))
    const r = await syncManual({ path: file, served: served('9.1.0'), fetch: f })
    expect(r).toMatchObject({ state: 'updated', previous: null, version: '9.1.0' })
    expect(readManualVersion(file)).toBe('9.1.0')
  })

  it('the bundled copy IS the announced version: written from the bundle, no download', async () => {
    place(servedText('0.0.1'))
    const f = fakeFetch(() => ok('unused'))
    const r = await syncManual({ path: file, served: served(BUNDLED), fetch: f })
    expect(f.calls).toEqual([])
    expect(r).toMatchObject({ state: 'updated', source: 'bundled', version: BUNDLED, upToDate: true })
    expect(fs.readFileSync(file, 'utf-8')).toBe(MANUAL)
  })

  it('is fetched without credentials: no Authorization header on the request', async () => {
    let headers: HeadersInit | undefined
    const f = fakeFetch((_url, init) => {
      headers = init.headers
      return ok(servedText('9.1.0'))
    })
    await syncManual({ path: file, served: served('9.1.0'), fetch: f })
    expect(JSON.stringify(headers ?? {}).toLowerCase()).not.toContain('authorization')
  })
})

describe('syncManual — a failure keeps the existing file', () => {
  const failures: Array<[string, () => FakeFetch, RegExp, Partial<{ maxBytes: number; timeoutMs: number }>?]> = [
    ['offline', refused, /fetch failed \(ECONNREFUSED\)/],
    ['an error answer', () => fakeFetch(() => new Response('nope', { status: 503 })), /HTTP 503/],
    ['a body declared over the size cap', () => fakeFetch(() => ok(servedText('9.1.0'), { 'content-length': String(10 * 1024 * 1024) })), /over the 524288-byte cap/],
    [
      'a body streamed over the size cap (no length declared)',
      () =>
        fakeFetch(() => {
          let sent = 0
          const chunk = new TextEncoder().encode(servedText('9.1.0').padEnd(4096, 'x'))
          return new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                sent += 1
                if (sent > 64) controller.close()
                else controller.enqueue(chunk)
              },
            }),
            { status: 200 },
          )
        }),
      /over the 65536-byte cap/,
      { maxBytes: 65_536 },
    ],
    ['a body at another version than announced', () => fakeFetch(() => ok(servedText('9.2.0'))), /the body is version 9\.2\.0, the server announced 9\.1\.0/],
    ['a page that is not the manual (a captive portal)', () => fakeFetch(() => ok('<html><body>Sign in to the Wi-Fi</body></html>')), /no front matter/],
    ['another skill', () => fakeFetch(() => ok(servedText('9.1.0').replace('name: agentchat', 'name: other'))), /names "other", not the agentchat skill/],
    ['bytes that are not UTF-8', () => fakeFetch(() => new Response(new Uint8Array([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe]), { status: 200 })), /not UTF-8/],
    [
      'no answer within the timeout',
      () =>
        fakeFetch(
          (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
            }),
        ),
      /no answer from https:\/\/agentchat\.me\/skill\.md within 50 ms/,
      { timeoutMs: 50 },
    ],
  ]

  for (const [what, make, error, extra] of failures) {
    it(`${what}: kept byte for byte, the reason said`, async () => {
      const old = servedText('9.0.0')
      place(old)
      const r = await syncManual({ path: file, served: served('9.1.0'), fetch: make(), ...(extra ?? {}) })
      expect(r).toMatchObject({ state: 'kept', previous: '9.0.0', version: '9.0.0', written: false, upToDate: false })
      expect(r.error).toMatch(error)
      expect(fs.readFileSync(file, 'utf-8')).toBe(old)
      expect(describeManualSync(r)).toMatch(new RegExp(`^stale \\(have 9\\.0\\.0, served 9\\.1\\.0\\) — .*kept as it is: `))
    })
  }

  it('a non-HTTPS address is refused before any request', async () => {
    place(servedText('9.0.0'))
    const f = fakeFetch(() => ok(servedText('9.1.0')))
    const r = await syncManual({ path: file, served: served('9.1.0', 'http://agentchat.me/skill.md'), fetch: f })
    expect(f.calls).toEqual([])
    expect(r).toMatchObject({ state: 'kept', previous: '9.0.0' })
    expect(r.error).toMatch(/HTTPS only/)
  })

  it('a redirect that leaves HTTPS is not trusted', async () => {
    place(servedText('9.0.0'))
    const f = fakeFetch(() => Object.defineProperty(ok(servedText('9.1.0')), 'url', { value: 'http://mirror.example/skill.md' }))
    const r = await syncManual({ path: file, served: served('9.1.0'), fetch: f })
    expect(r).toMatchObject({ state: 'kept' })
    expect(r.error).toMatch(/redirected to http:\/\/mirror\.example\/skill\.md/)
  })

  it('a write that fails leaves the old file intact and no tmp file behind', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return // directory modes are not enforced there
    const old = servedText('9.0.0')
    place(old)
    fs.chmodSync(path.dirname(file), 0o555)
    const r = await syncManual({ path: file, served: served('9.1.0'), fetch: fakeFetch(() => ok(servedText('9.1.0'))) })
    expect(r).toMatchObject({ state: 'kept', written: false })
    expect(r.error).toMatch(/could not write/)
    expect(fs.readFileSync(file, 'utf-8')).toBe(old)
    expect(fs.readdirSync(path.dirname(file))).toEqual(['SKILL.md'])
  })
})

describe('syncManual — the bundled copy only when there is no file', () => {
  it('no file and the download fails: the bundled copy is written, and the miss is said', async () => {
    const r = await syncManual({ path: file, served: served('9.1.0'), fetch: refused() })
    expect(r).toMatchObject({ state: 'fallback', source: 'bundled', version: BUNDLED, written: true, upToDate: false })
    expect(fs.readFileSync(file, 'utf-8')).toBe(MANUAL)
    expect(describeManualSync(r)).toMatch(/^bundled copy .* served 9\.1\.0 could not be fetched: fetch failed/)
  })

  it('nothing announced (no texts in hand) and no file: the bundled copy, with nothing fetched', async () => {
    const f = fakeFetch(() => ok('unused'))
    const r = await syncManual({ path: file, served: null, fetch: f })
    expect(f.calls).toEqual([])
    expect(r).toMatchObject({ state: 'fallback', upToDate: null, error: null })
    expect(fs.readFileSync(file, 'utf-8')).toBe(MANUAL)
  })

  it('nothing announced and a file there: the file is kept as it is, whatever its version', async () => {
    const old = servedText('0.0.1')
    place(old)
    const f = fakeFetch(() => ok('unused'))
    const r = await syncManual({ path: file, served: null, fetch: f })
    expect(f.calls).toEqual([])
    expect(r).toMatchObject({ state: 'kept', upToDate: null, error: null, written: false })
    expect(fs.readFileSync(file, 'utf-8')).toBe(old)
    expect(describeManualSync(r)).toBe(`unchecked (have 0.0.1; no served version in hand) — ${file}`)
  })

  it('no file and nothing writable: failed, said so', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.chmodSync(path.dirname(file), 0o555)
    const r = await syncManual({ path: file, served: served('9.1.0'), fetch: refused() })
    expect(r.state).toBe('failed')
    expect(fs.existsSync(file)).toBe(false)
  })
})

describe('syncManual — the write is atomic', () => {
  it('replaces the file by rename (a reader sees the old file or the new one, never part of one), mode 0644, no tmp left', async () => {
    place(servedText('9.0.0'))
    const before = fs.statSync(file).ino
    await syncManual({ path: file, served: served('9.1.0'), fetch: fakeFetch(() => ok(servedText('9.1.0'))) })
    expect(fs.readdirSync(path.dirname(file))).toEqual(['SKILL.md'])
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).ino).not.toBe(before) // a new file renamed into place, not the old one rewritten
      expect(fs.statSync(file).mode & 0o777).toBe(0o644) // text to read, never executable
    }
  })
})

describe('syncManual — over a real socket', () => {
  let server: http.Server
  let base: string
  let body = servedText('9.1.0')
  beforeEach(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/skill.md') {
        res.setHeader('content-type', 'text/markdown; charset=utf-8')
        res.end(body)
      } else if (req.url === '/moved') {
        res.statusCode = 302
        res.setHeader('location', '/skill.md')
        res.end()
      } else {
        res.statusCode = 404
        res.end('not found')
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('downloads from a development server on this machine (plain HTTP to loopback), following a same-origin redirect', async () => {
    body = servedText('9.1.0')
    place(servedText('9.0.0'))
    const r = await syncManual({ path: file, served: served('9.1.0', `${base}/moved`) })
    expect(r).toMatchObject({ state: 'updated', source: 'download', version: '9.1.0' })
    expect(fs.readFileSync(file, 'utf-8')).toBe(body)
  })

  it('a 404 keeps the file', async () => {
    place(servedText('9.0.0'))
    const r = await syncManual({ path: file, served: served('9.1.0', `${base}/gone.md`) })
    expect(r).toMatchObject({ state: 'kept' })
    expect(r.error).toMatch(/HTTP 404/)
  })
})

describe('ManualFollower — the daemon follows the announced version', () => {
  it('a changed announced version triggers a download; the same version again fetches nothing', async () => {
    let current = servedText('9.1.0')
    const f = fakeFetch(() => ok(current))
    const follower = new ManualFollower({ path: file, fetch: f })
    place(servedText('9.0.0'))

    expect(await follower.follow(served('9.1.0'))).toMatchObject({ state: 'updated', version: '9.1.0' })
    expect(await follower.follow(served('9.1.0'))).toMatchObject({ state: 'current' })
    expect(f.calls).toHaveLength(1)

    current = servedText('9.2.0')
    expect(await follower.follow(served('9.2.0'))).toMatchObject({ state: 'updated', previous: '9.1.0', version: '9.2.0' })
    expect(f.calls).toHaveLength(2)
    expect(readManualVersion(file)).toBe('9.2.0')
  })

  it('calls are serialised: two follows at once download once', async () => {
    let release: (() => void) | null = null
    const f = fakeFetch(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return ok(servedText('9.1.0'))
    })
    const follower = new ManualFollower({ path: file, fetch: f })
    const a = follower.follow(served('9.1.0'))
    const b = follower.follow(served('9.1.0'))
    await vi.waitFor(() => expect(release).not.toBeNull())
    release!()
    expect((await a)?.state).toBe('updated')
    expect((await b)?.state).toBe('current')
    expect(f.calls).toHaveLength(1)
  })

  it('nothing announced: does nothing (the daemon has no texts yet)', async () => {
    const f = fakeFetch(() => ok('unused'))
    expect(await new ManualFollower({ path: file, fetch: f }).follow(null)).toBeNull()
    expect(f.calls).toEqual([])
    expect(fs.existsSync(file)).toBe(false)
  })

  it('a failure is logged once per condition, kept the file, and is tried again on the next follow', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined)
    place(servedText('9.0.0'))
    let up = false
    const f = fakeFetch(() => {
      if (!up) throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) })
      return ok(servedText('9.1.0'))
    })
    const follower = new ManualFollower({ path: file, fetch: f })
    await follower.follow(served('9.1.0'))
    await follower.follow(served('9.1.0'))
    expect(f.calls).toHaveLength(2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatch(/manual 9\.1\.0 announced but not placed \(fetch failed \(ENOTFOUND\)\) — keeping 9\.0\.0 at .*; tried again at the next texts refresh/)
    expect(readManualVersion(file)).toBe('9.0.0')
    up = true
    expect((await follower.follow(served('9.1.0')))?.state).toBe('updated')
    expect(info.mock.calls.at(-1)?.[0]).toMatch(/^manual 9\.1\.0 downloaded from/)
  })

  it('stop aborts a download in flight and nothing is written', async () => {
    const f = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
    )
    place(servedText('9.0.0'))
    const follower = new ManualFollower({ path: file, fetch: f })
    const pending = follower.follow(served('9.1.0'))
    await vi.waitFor(() => expect(f.calls).toHaveLength(1))
    follower.stop()
    expect((await pending)?.state).toBe('kept')
    expect(readManualVersion(file)).toBe('9.0.0')
    expect(await follower.follow(served('9.1.0'))).toBeNull()
  })
})

describe('checkManual — what status and doctor say', () => {
  it('current, stale, unchecked, missing — with the versions named', () => {
    expect(checkManual(file, '9.1.0')).toMatchObject({ state: 'missing', verdict: 'FAIL', summary: 'missing' })
    place(servedText('9.0.0'))
    expect(checkManual(file, '9.0.0')).toMatchObject({ state: 'current', verdict: 'PASS', summary: 'current (9.0.0)', detail: `current (9.0.0) — ${file}` })
    expect(checkManual(file, '9.1.0')).toMatchObject({ state: 'stale', verdict: 'WARN', summary: 'stale (have 9.0.0, served 9.1.0)' })
    expect(checkManual(file, null)).toMatchObject({ state: 'unchecked', verdict: 'WARN', summary: 'unchecked (have 9.0.0; no served version in hand)' })
    place('# a hand-written file with no front matter\n')
    expect(checkManual(file, '9.1.0').summary).toBe('stale (have an unversioned file, served 9.1.0)')
  })
})

describe('manualFrontMatter', () => {
  it('reads the flat fields, unquotes a quoted value, and stops at the closing fence', () => {
    const fields = manualFrontMatter('---\nname: agentchat\nversion: "2.3.0"\n---\n\nversion: 9.9.9\n\n---\n')
    expect(fields?.get('name')).toBe('agentchat')
    expect(fields?.get('version')).toBe('2.3.0')
    expect(manualVersion(servedText('9.1.0'))).toBe('9.1.0') // the body's `version:` after an hrule is not front matter
  })

  it('a fence must be a whole line; text with no front matter has none', () => {
    expect(manualVersion('---\nname: agentchat\ndescription: x\n---not a fence\nversion: 1.0.0\n---\n')).toBe('1.0.0')
    expect(manualFrontMatter('# no front matter\nversion: 1.0.0\n')).toBeNull()
    expect(manualFrontMatter('---\nname: agentchat\nversion: 1.0.0\n')).toBeNull()
    expect(manualVersion('---\nname: agentchat\n---\n\nversion: 1.0.0\n')).toBeNull()
  })
})
