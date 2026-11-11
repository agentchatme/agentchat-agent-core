import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  INTEGRATION_ENV,
  INTEGRATION_ENV_LEGACY,
  INTEGRATION_ENV_LEGACY_REMOVAL,
  integrationDisabledBy,
} from '../src/integration/profile.js'

// ─── Legacy environment names remove themselves ─────────────────────────────
//
// Every old environment name agent-core still reads is listed here with the
// removal date the agent contract (v1, section 7, "Old integration
// settings") gives it. From that day this test fails and says what to delete,
// so nobody has to remember. Until then the old name keeps meaning what the
// operator set — an `off` captured into a service unit stays off.
//
// The inventory below keeps the list honest: every AGENTCHAT* name in the
// source is either current or legacy-with-a-date. A new legacy reader cannot
// slip in without a removal date.

interface LegacyEnv {
  readonly name: string
  readonly replacement: string
  /** UTC day, from the contract. */
  readonly removal: string
  readonly remove: string
}

const LEGACY: readonly LegacyEnv[] = [
  {
    name: INTEGRATION_ENV_LEGACY,
    replacement: INTEGRATION_ENV,
    removal: INTEGRATION_ENV_LEGACY_REMOVAL,
    remove:
      'INTEGRATION_ENV_LEGACY / INTEGRATION_ENV_LEGACY_REMOVAL and the legacy branch of integrationDisabledBy (src/integration/profile.ts), the warning in src/integration/run.ts, their exports in src/index.ts, and the README sentence; then drop this entry',
  },
]

/** Names agent-core reads today that are not legacy. */
const CURRENT = new Set([
  'AGENTCHAT_API_KEY',
  'AGENTCHAT_API_BASE',
  'AGENTCHAT_LOG_LEVEL',
  'AGENTCHAT_INTEGRATION',
  'AGENTCHAT_RUN_PROFILE',
  'AGENTCHAT_RUN_BUDGET_MS',
  'AGENTCHAT_RUN_MAX_BUDGET_USD',
  'AGENTCHAT_LISTENER_API_KEY',
  'AGENTCHAT_SERVICE_DRY_RUN',
  // A test and headless-install knob (do not start the Windows launcher now), not an old spelling of anything.
  'AGENTCHATD_SERVICE_NO_START',
])

describe('legacy environment names', () => {
  for (const legacy of LEGACY) {
    it(`${legacy.name} is read only until ${legacy.removal}`, () => {
      const removal = Date.parse(`${legacy.removal}T00:00:00Z`)
      expect(Number.isFinite(removal)).toBe(true)
      expect(
        Date.now() < removal,
        `${legacy.removal} has passed: ${legacy.name} (replaced by ${legacy.replacement}) is removed by contract v1 — delete ${legacy.remove}`,
      ).toBe(true)
    })
  }

  it('until then, the old switch still holds and the new one wins', () => {
    expect(integrationDisabledBy({ AGENTCHAT_DOORBELL: 'off' })).toBe(INTEGRATION_ENV_LEGACY)
    expect(integrationDisabledBy({ AGENTCHAT_INTEGRATION: 'on', AGENTCHAT_DOORBELL: 'off' })).toBeNull()
    expect(integrationDisabledBy({ AGENTCHAT_INTEGRATION: 'off', AGENTCHAT_DOORBELL: 'on' })).toBe(INTEGRATION_ENV)
  })

  it('every AGENTCHAT* name in the source is current, or legacy with a removal date', () => {
    const src = path.join(__dirname, '..', 'src')
    const names = new Set<string>()
    for (const entry of fs.readdirSync(src, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
      const text = fs.readFileSync(path.join(entry.parentPath ?? entry.path, entry.name), 'utf-8')
      for (const match of text.matchAll(/['"`](AGENTCHATD?_[A-Z0-9_]+)['"`]/g)) names.add(match[1]!)
    }
    const legacy = new Set(LEGACY.map((l) => l.name))
    const unclassified = [...names].filter((n) => !CURRENT.has(n) && !legacy.has(n)).sort()
    expect(unclassified, 'classify each new name: CURRENT, or LEGACY with the contract’s removal date').toEqual([])
  })
})
