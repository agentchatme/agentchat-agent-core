import { spawnCommand } from '../util/spawn.js'
import type { PendingRequest } from './pending.js'

export interface NotificationPlan {
  command: string
  args: string[]
}

function bodyOf(record: PendingRequest): string {
  const peers = record.peer_agents.slice(0, 3).join(', ') || 'another agent'
  const more = record.peer_agents.length > 3 ? ` and ${record.peer_agents.length - 3} more` : ''
  return `@${record.identity_handle} has a request from ${peers}${more} waiting for review.`
}

/** Exported for deterministic cross-platform tests; no command is run here. */
export function pendingNotificationPlan(
  record: PendingRequest,
  runtimeOs: NodeJS.Platform = process.platform,
): NotificationPlan | null {
  const title = 'AgentChat request needs review'
  const body = bodyOf(record)

  if (runtimeOs === 'darwin') {
    return {
      command: '/usr/bin/osascript',
      args: [
        '-e',
        'on run argv',
        '-e',
        'display notification (item 2 of argv) with title (item 1 of argv)',
        '-e',
        'end run',
        title,
        body,
      ],
    }
  }

  if (runtimeOs === 'linux') {
    return { command: 'notify-send', args: ['--app-name=AgentChat', title, body] }
  }

  if (runtimeOs === 'win32') {
    const encodedBody = Buffer.from(body, 'utf-8').toString('base64')
    const script = [
      `$body=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedBody}'))`,
      "$title='AgentChat request needs review'",
      '$safeTitle=[Security.SecurityElement]::Escape($title)',
      '$safeBody=[Security.SecurityElement]::Escape($body)',
      '$xml=New-Object Windows.Data.Xml.Dom.XmlDocument',
      '$xml.LoadXml("<toast><visual><binding template=\"ToastGeneric\"><text>$safeTitle</text><text>$safeBody</text></binding></visual></toast>")',
      '$toast=[Windows.UI.Notifications.ToastNotification]::new($xml)',
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('AgentChat').Show($toast)",
    ].join(';')
    return {
      command: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    }
  }

  return null
}

/** Best-effort local alert. A desktop-notification failure never affects ACK. */
export function notifyPendingRequest(record: PendingRequest): void {
  if (process.env['AGENTCHAT_DESKTOP_NOTIFICATIONS'] === '0') return
  const plan = pendingNotificationPlan(record)
  if (plan === null) return
  try {
    const child = spawnCommand(plan.command, plan.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.once('error', () => {})
    child.unref()
  } catch {
    // Unsupported desktop session, missing notify-send, or OS policy denial.
    // The durable session/dashboard notices remain available.
  }
}
