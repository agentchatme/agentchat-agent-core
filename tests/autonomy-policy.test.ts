import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  allowFullAutonomyAgent,
  fullAutonomyAllows,
  readFullAutonomyPolicy,
  removeFullAutonomyAgent,
  setFullAutonomyMode,
} from '../src/autonomy/policy.js'

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-autonomy-'))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('identity-scoped full autonomy policy', () => {
  it('fails closed when state is missing or belongs to another identity', () => {
    expect(readFullAutonomyPolicy(home, 'local-agent')).toMatchObject({
      identity_handle: 'local-agent',
      mode: 'off',
      selected_agents: [],
    })

    allowFullAutonomyAgent(home, 'local-agent', '@alice')
    expect(readFullAutonomyPolicy(home, 'different-agent')).toMatchObject({
      identity_handle: 'different-agent',
      mode: 'off',
      selected_agents: [],
    })
  })

  it('allows only explicit peers in selected mode and preserves the list while off', () => {
    let policy = allowFullAutonomyAgent(home, 'local-agent', '@Alice')
    policy = allowFullAutonomyAgent(home, 'local-agent', 'bob-agent')

    expect(policy.mode).toBe('selected')
    expect(policy.selected_agents).toEqual(['alice', 'bob-agent'])
    expect(fullAutonomyAllows(policy, '@alice')).toBe(true)
    expect(fullAutonomyAllows(policy, 'carol')).toBe(false)

    policy = setFullAutonomyMode(home, 'local-agent', 'off')
    expect(policy.selected_agents).toEqual(['alice', 'bob-agent'])
    expect(fullAutonomyAllows(policy, 'alice')).toBe(false)

    policy = setFullAutonomyMode(home, 'local-agent', 'selected')
    expect(fullAutonomyAllows(policy, 'bob-agent')).toBe(true)
  })

  it('supports everyone and turns off when the last selected peer is removed', () => {
    let policy = setFullAutonomyMode(home, 'local-agent', 'everyone')
    expect(fullAutonomyAllows(policy, 'unlisted-agent')).toBe(true)

    policy = allowFullAutonomyAgent(home, 'local-agent', 'alice')
    expect(policy.mode).toBe('selected')
    policy = removeFullAutonomyAgent(home, 'local-agent', 'alice')
    expect(policy).toMatchObject({ mode: 'off', selected_agents: [] })
  })
})
