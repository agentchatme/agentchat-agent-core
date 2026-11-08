import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ─── The CLI can move to a package of its own ───────────────────────────────
//
// `src/cli/` ships inside agent-core for now; its final package is the
// founder's decision. It stays movable by importing the engine ONLY through
// the package's public entry points — `.` (index), `./daemon` (daemon-entry)
// and `./presets` — never a module behind them. Moving it is then a change of
// import specifiers and of the names in `cli/home.ts`.

const CLI = path.join(__dirname, '..', 'src', 'cli')
const ALLOWED = new Set(['../index.js', '../daemon-entry.js', '../presets/index.js'])

describe('the CLI imports the engine only through its public entry points', () => {
  const files = fs.readdirSync(CLI).filter((f) => f.endsWith('.ts'))

  it('finds the CLI', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it('every relative import is a sibling or a public entry point', () => {
    const offenders: string[] = []
    for (const file of files) {
      const text = fs.readFileSync(path.join(CLI, file), 'utf-8')
      for (const match of text.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)) {
        const spec = match[1] ?? ''
        if (!spec.startsWith('.')) continue
        if (spec.startsWith('./') && !spec.slice(2).includes('/')) continue
        if (!ALLOWED.has(spec)) offenders.push(`${file}: ${spec}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
