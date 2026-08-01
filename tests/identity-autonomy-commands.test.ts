import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AgentChatClient } from 'agentchatme'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIdentityCommands } from '../src/identity/commands.js'
import { writeCredentials } from '../src/identity/credentials.js'
import { readFullAutonomyPolicy } from '../src/autonomy/policy.js'
import {
  listPendingRequests,
  recordPendingRequest,
} from '../src/daemon/pending.js'

let home: string
let commands: ReturnType<typeof createIdentityCommands>

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-control-cli-'))
  writeCredentials(home, {
    api_key: 'ac_live_' + 'a'.repeat(32),
    handle: 'local-agent',
    api_base: 'https://api.example.test',
  })
  commands = createIdentityCommands({
    id: 'test',
    label: 'Test Host',
    home: () => home,
    anchorFile: () => path.join(home, 'AGENTS.md'),
    invocation: () => 'agentchat-test',
    renderAnchor: () => 'anchor',
    isWired: () => true,
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('local autonomy and pending CLI commands', () => {
  it('selects only an existing AgentChat peer and keeps everyone confirmation explicit', async () => {
    vi.spyOn(AgentChatClient.prototype, 'getAgent').mockResolvedValue({
      handle: 'alice',
    } as never)

    expect(await commands.runAutonomy({
      action: 'allow',
      handle: '@alice',
    })).toBe(0)
    expect(readFullAutonomyPolicy(home, 'local-agent')).toMatchObject({
      mode: 'selected',
      selected_agents: ['alice'],
    })

    expect(await commands.runAutonomy({ action: 'everyone' })).toBe(1)
    expect(await commands.runAutonomy({
      action: 'everyone',
      yes: true,
    })).toBe(0)
    expect(readFullAutonomyPolicy(home, 'local-agent').mode).toBe('everyone')
  })

  it('rejects control-plane mutations from an unattended runtime', async () => {
    expect(await commands.runAutonomy({
      action: 'everyone',
      yes: true,
    })).toBe(0)
    const pending = recordPendingRequest(home, {
      selfHandle: 'local-agent',
      conversationId: 'conv_1',
      peerAgents: ['alice'],
      inboundMessageIds: ['msg_1'],
      focusMessageId: 'msg_1',
      reason: 'autonomy_off',
      summary: 'Review a task.',
    })

    vi.stubEnv('AGENTCHAT_EXECUTION', 'always_on')
    expect(await commands.runAutonomy({ action: 'off' })).toBe(1)
    expect(readFullAutonomyPolicy(home, 'local-agent').mode).toBe('everyone')
    expect(await commands.runPendingRequests({
      action: 'resolve',
      id: pending.id,
    })).toBe(1)
    expect(listPendingRequests(home, 'local-agent')).toHaveLength(1)
  })
})
