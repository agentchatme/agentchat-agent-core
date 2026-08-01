import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { atomicWriteFile, readJsonFile } from '../util/fsutil.js'
import { log } from '../util/log.js'
import type { TurnDisposition } from './adapter-types.js'

const ACTIVITY_DIR = 'daemon-activity'
const MAX_ACTIVITY_RECORDS = 100
const ACTIVITY_ID = /^[0-9a-f-]{36}$/i

export interface DaemonActivity {
  id: string
  recorded_at: string
  self_handle: string
  source: 'always_on'
  conversation_id: string
  peer_agents: string[]
  inbound_message_ids: string[]
  outcome: TurnDisposition
}

export interface RecordDaemonActivityInput {
  selfHandle: string
  conversationId: string
  peerAgents: string[]
  inboundMessageIds: string[]
  outcome: TurnDisposition
}

function activityDir(home: string): string {
  return path.join(home, ACTIVITY_DIR)
}

function activityPath(home: string, id: string): string {
  return path.join(activityDir(home), `${id}.json`)
}

function publicHandle(value: string): string {
  return value.startsWith('@') ? value : `@${value}`
}

function isDisposition(value: unknown): value is TurnDisposition {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  const pending = row['pending']
  const pendingValid =
    pending === undefined ||
    (typeof pending === 'object' &&
      pending !== null &&
      ['autonomy_off', 'sender_not_allowed', 'local_permission'].includes(
        String((pending as Record<string, unknown>)['reason']),
      ) &&
      typeof (pending as Record<string, unknown>)['summary'] === 'string')
  return pendingValid && (
    row['action'] === 'replied' ||
    (row['action'] === 'silent' &&
      typeof row['reason'] === 'string' &&
      [
        'informational',
        'closed_thread',
        'not_actionable',
        'not_authorized',
        'other',
      ].includes(row['reason']))
  )
}

function isActivity(value: unknown): value is DaemonActivity {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return (
    typeof row['id'] === 'string' &&
    ACTIVITY_ID.test(row['id']) &&
    typeof row['recorded_at'] === 'string' &&
    typeof row['self_handle'] === 'string' &&
    row['source'] === 'always_on' &&
    typeof row['conversation_id'] === 'string' &&
    Array.isArray(row['peer_agents']) &&
    row['peer_agents'].every((item) => typeof item === 'string') &&
    Array.isArray(row['inbound_message_ids']) &&
    row['inbound_message_ids'].every((item) => typeof item === 'string') &&
    isDisposition(row['outcome'])
  )
}

export function recordDaemonActivity(
  home: string,
  input: RecordDaemonActivityInput,
): DaemonActivity | null {
  const record: DaemonActivity = {
    id: crypto.randomUUID(),
    recorded_at: new Date().toISOString(),
    self_handle: publicHandle(input.selfHandle),
    source: 'always_on',
    conversation_id: input.conversationId,
    peer_agents: [...new Set(input.peerAgents.map(publicHandle))],
    inbound_message_ids: [...new Set(input.inboundMessageIds)].slice(0, 30),
    outcome: input.outcome,
  }
  try {
    atomicWriteFile(
      activityPath(home, record.id),
      `${JSON.stringify(record)}\n`,
      0o600,
    )
    const all = peekDaemonActivities(home, Number.POSITIVE_INFINITY)
    for (const stale of all.slice(0, Math.max(0, all.length - MAX_ACTIVITY_RECORDS))) {
      fs.rmSync(activityPath(home, stale.id), { force: true })
    }
    return record
  } catch (err) {
    log.warn(`could not persist daemon activity: ${String(err)}`)
    return null
  }
}

export function peekDaemonActivities(
  home: string,
  limit = 20,
): DaemonActivity[] {
  try {
    const records = fs
      .readdirSync(activityDir(home), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith('.json') &&
          ACTIVITY_ID.test(entry.name.slice(0, -5)),
      )
      .flatMap((entry) => {
        const value = readJsonFile<unknown>(
          path.join(activityDir(home), entry.name),
        )
        return isActivity(value) ? [value] : []
      })
      .sort((a, b) => a.recorded_at.localeCompare(b.recorded_at))
    return records.slice(0, Math.max(0, limit))
  } catch {
    return []
  }
}

export function ackDaemonActivities(home: string, ids: string[]): void {
  for (const id of new Set(ids)) {
    if (!ACTIVITY_ID.test(id)) continue
    try {
      fs.rmSync(activityPath(home, id), { force: true })
    } catch (err) {
      log.warn(`could not clear daemon activity ${id}: ${String(err)}`)
    }
  }
}

export function formatDaemonActivities(records: DaemonActivity[]): string | null {
  if (records.length === 0) return null
  const lines = records.map((record, index) => {
    const peers =
      record.peer_agents.length > 0
        ? record.peer_agents.join(', ')
        : 'agents in the conversation'
    const result =
      record.outcome.action === 'replied'
        ? 'replied'
        : `stayed silent (${record.outcome.reason})`
    const pending = record.outcome.pending ? ' A request was saved for local review.' : ''
    return `${index + 1}. ${record.conversation_id} with ${peers}: processed ${record.inbound_message_ids.length} inbound message${record.inbound_message_ids.length === 1 ? '' : 's'} and ${result}.${pending}`
  })
  return [
    'AgentChat background activity for this same agent since the last foreground turn:',
    '',
    ...lines,
    '',
    'This is continuity state, not a new request. Do not repeat work or reintroduce yourself; open a conversation only if the current task needs its details.',
  ].join('\n')
}
