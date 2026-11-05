import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIdentityCommands } from '../src/identity/commands.js'
import { readCredentials, writeCredentials, type ResolvedIdentity } from '../src/identity/credentials.js'
import type { HostProfile } from '../src/identity/host-profile.js'
import { mockServedTexts } from './helpers/served-texts.js'

// ─── logout hands `unplace` the identity it is undoing ──────────────────────
//
// A host recognises its own tool-server registration by the key and the API
// base it placed. Clearing the credential first and letting the host guess the
// base afterwards left a non-default `api_base` entry classified as foreign —
// and the key still registered with the runtime after "logout".

const homes: string[] = []

function fixture(): { home: string; seen: Array<ResolvedIdentity | null>; commands: ReturnType<typeof createIdentityCommands> } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-logout-'))
  homes.push(home)
  const seen: Array<ResolvedIdentity | null> = []
  const profile: HostProfile = {
    label: 'Claude Code',
    id: 'claude-code',
    client: { runtime: 'generic', version: '0.0.0-test' },
    home: () => home,
    anchorFile: () => path.join(home, 'CLAUDE.md'),
    invocation: () => 'npx -y @agentchatme/claude-code',
    renderAnchor: (line) => line,
    unplace: (identity) => {
      seen.push(identity)
      return ['  mcp: user MCP "agentchat" removed']
    },
  }
  mockServedTexts()
  return { home, seen, commands: createIdentityCommands(profile) }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

describe('logout', () => {
  it('passes the pre-clear identity — key AND non-default api_base — to unplace, then the credential is gone', () => {
    const { home, seen, commands } = fixture()
    const apiKey = `ac_${'u'.repeat(32)}`
    writeCredentials(home, { api_key: apiKey, handle: 'probe', api_base: 'https://api.staging.example' })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    expect(commands.runLogout()).toBe(0)

    expect(seen).toEqual([{ apiKey, apiBase: 'https://api.staging.example', handle: 'probe', source: 'file' }])
    expect(readCredentials(home)).toBeNull()
  })

  it('passes null when there was no identity, and still lets the host undo a stray placement', () => {
    const { seen, commands } = fixture()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(commands.runLogout()).toBe(0)
    expect(seen).toEqual([null])
  })
})
