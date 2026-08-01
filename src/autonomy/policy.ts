import * as path from 'node:path'
import { z } from 'zod'
import { atomicWriteFile, readJsonFile } from '../util/fsutil.js'

// Full autonomy is a local execution policy, not an AgentChat account setting.
// Every read is scoped to both an integration home and the identity currently
// authenticated there. Replacing credentials can therefore never grant a new
// agent the previous agent's unattended authority.

const HANDLE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

const PolicySchema = z.object({
  version: z.literal(1),
  identity_handle: z.string().min(3),
  mode: z.enum(['off', 'selected', 'everyone']),
  selected_agents: z.array(z.string().min(3)).max(500),
  updated_at: z.string(),
})

export type AutonomyMode = 'off' | 'selected' | 'everyone'
export type FullAutonomyPolicy = z.infer<typeof PolicySchema>

export function normalizeAgentHandle(value: string): string | null {
  const normalized = value.trim().replace(/^@/, '').toLowerCase()
  return normalized.length >= 3 &&
    normalized.length <= 30 &&
    HANDLE.test(normalized)
    ? normalized
    : null
}

export function autonomyPath(home: string): string {
  return path.join(home, 'autonomy.json')
}

function emptyPolicy(identityHandle: string): FullAutonomyPolicy {
  return {
    version: 1,
    identity_handle: identityHandle,
    mode: 'off',
    selected_agents: [],
    updated_at: new Date(0).toISOString(),
  }
}

/** Invalid, missing, or differently scoped state always fails closed. */
export function readFullAutonomyPolicy(
  home: string,
  identityHandle: string,
): FullAutonomyPolicy {
  const identity = normalizeAgentHandle(identityHandle)
  if (identity === null) return emptyPolicy('unknown-agent')
  const parsed = PolicySchema.safeParse(readJsonFile<unknown>(autonomyPath(home)))
  if (!parsed.success || normalizeAgentHandle(parsed.data.identity_handle) !== identity) {
    return emptyPolicy(identity)
  }
  const selected = parsed.data.selected_agents
    .map(normalizeAgentHandle)
    .filter((handle): handle is string => handle !== null && handle !== identity)
  return {
    ...parsed.data,
    identity_handle: identity,
    selected_agents: [...new Set(selected)].sort(),
  }
}

export function writeFullAutonomyPolicy(
  home: string,
  identityHandle: string,
  input: { mode: AutonomyMode; selectedAgents?: string[] },
  now: Date = new Date(),
): FullAutonomyPolicy {
  const identity = normalizeAgentHandle(identityHandle)
  if (identity === null) throw new Error('cannot store autonomy for an invalid identity handle')
  const selected = (input.selectedAgents ?? [])
    .map(normalizeAgentHandle)
    .filter((handle): handle is string => handle !== null && handle !== identity)
  const policy: FullAutonomyPolicy = {
    version: 1,
    identity_handle: identity,
    mode: input.mode,
    selected_agents: [...new Set(selected)].sort().slice(0, 500),
    updated_at: now.toISOString(),
  }
  atomicWriteFile(
    autonomyPath(home),
    `${JSON.stringify(policy, null, 2)}\n`,
    0o600,
  )
  return policy
}

export function setFullAutonomyMode(
  home: string,
  identityHandle: string,
  mode: AutonomyMode,
): FullAutonomyPolicy {
  const current = readFullAutonomyPolicy(home, identityHandle)
  return writeFullAutonomyPolicy(home, identityHandle, {
    mode,
    selectedAgents: current.selected_agents,
  })
}

export function allowFullAutonomyAgent(
  home: string,
  identityHandle: string,
  peerHandle: string,
): FullAutonomyPolicy {
  const peer = normalizeAgentHandle(peerHandle)
  if (peer === null) throw new Error('invalid AgentChat handle')
  const current = readFullAutonomyPolicy(home, identityHandle)
  return writeFullAutonomyPolicy(home, identityHandle, {
    mode: 'selected',
    selectedAgents: [...current.selected_agents, peer],
  })
}

export function removeFullAutonomyAgent(
  home: string,
  identityHandle: string,
  peerHandle: string,
): FullAutonomyPolicy {
  const peer = normalizeAgentHandle(peerHandle)
  if (peer === null) throw new Error('invalid AgentChat handle')
  const current = readFullAutonomyPolicy(home, identityHandle)
  const selected = current.selected_agents.filter((handle) => handle !== peer)
  return writeFullAutonomyPolicy(home, identityHandle, {
    mode: current.mode === 'selected' && selected.length === 0 ? 'off' : current.mode,
    selectedAgents: selected,
  })
}

export function fullAutonomyAllows(
  policy: FullAutonomyPolicy,
  peerHandle: string,
): boolean {
  if (policy.mode === 'everyone') return true
  if (policy.mode !== 'selected') return false
  const peer = normalizeAgentHandle(peerHandle)
  return peer !== null && policy.selected_agents.includes(peer)
}
