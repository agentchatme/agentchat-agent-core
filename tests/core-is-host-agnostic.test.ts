import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ─── The core may not learn what a coding agent is ──────────────────────────
//
// The whole reason this package exists is that its predecessor was one CLI
// serving every coding agent, so its functions had to CHOOSE a host — and they
// chose wrong: registering one agent rewrote another's instruction file, and
// `logout --platform claude-code` deleted both agents' credentials.
//
// The fix was to make the host a compile-time fact of each integration. That
// only holds while nothing here knows a host exists. The first
// `if (host === 'claude-code')` added to this package rebuilds the old bug, so
// it is asserted mechanically rather than left to review.
//
// Prose is exempt: several comments explain the defect they prevent, and that
// history is worth keeping. Only code is checked.

const SRC = path.join(__dirname, '..', 'src')

/** Strip block and line comments so only executable code is inspected. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
}

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return tsFiles(full)
    return e.name.endsWith('.ts') ? [full] : []
  })
}

// `claude` and `codex` have no innocent meaning in this package. `cursor` does
// — the ack cursor — so it is only a violation as a product name: quoted, or
// capitalised.
const FORBIDDEN: Array<{ what: string; pattern: RegExp }> = [
  { what: 'Claude Code', pattern: /\bclaude\b/i },
  { what: 'Codex', pattern: /\bcodex\b/i },
  { what: 'Cursor', pattern: /['"`]cursor['"`]|\bCursor\b/ },
]

describe('agent-core names no coding agent', () => {
  const files = tsFiles(SRC)

  it('finds source to check (guards against a silently-empty scan)', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  for (const { what, pattern } of FORBIDDEN) {
    it(`has no reference to ${what} in code`, () => {
      const offenders: string[] = []
      for (const file of files) {
        stripComments(fs.readFileSync(file, 'utf-8'))
          .split('\n')
          .forEach((line, i) => {
            if (pattern.test(line)) {
              offenders.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`)
            }
          })
      }
      expect(
        offenders,
        `agent-core must not know ${what} exists — pass an identity home in instead:\n${offenders.join('\n')}`,
      ).toEqual([])
    })
  }

  it('exposes no host-selecting parameter', () => {
    // The exact shape of the original defect: a runtime argument naming which
    // coding agent to act on.
    const offenders: string[] = []
    for (const file of files) {
      stripComments(fs.readFileSync(file, 'utf-8'))
        .split('\n')
        .forEach((line, i) => {
          if (/--platform|\bplatform\s*[:?]|\bruntime\s*[:?]\s*['"]/.test(line)) {
            offenders.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`)
          }
        })
    }
    expect(offenders, `no host-selecting parameter may exist here:\n${offenders.join('\n')}`).toEqual([])
  })
})
