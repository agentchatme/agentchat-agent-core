import { AgentChatClient, INBOX_TRAY_MAX_LIMIT, type TextsRuntime } from 'agentchatme'
import { clientIdentityOf, manualPointer, MANUAL_URL, type IntegrationClient } from '../index.js'
import { CommandRunner, ForwardRunner, type ListenerConfig, type RunnerFactory, type RunnerIdentity } from '../daemon-entry.js'
import { presetNamed, type Preset } from '../presets/index.js'
import { cliClient, manualPathFor } from './home.js'

// ─── What one listener config runs, as a runner per identity ───────────────

export interface ListenerPlan {
  /** Builds the runner for each identity the listener serves. */
  readonly runner: RunnerFactory
  /** How the listener names itself to the server; `runtime` is what the served texts are rendered for. */
  readonly client: IntegrationClient
  /** The one pointer line a run prompt ends with. */
  readonly manualPointer: string
  /** The skill file kept current from the served texts. */
  readonly manualPath: string
  readonly preset: Preset | null
}

export interface PlanOptions {
  readonly env?: NodeJS.ProcessEnv
  /** Test seam: the preset runtime's binary. */
  readonly presetCommand?: string
  /** Test seam: the forwarder's `fetch`. */
  readonly fetch?: typeof fetch
}

/** Thrown for a config that names a preset this build does not have. */
export class UnknownPresetError extends Error {}

export function planListener(home: string, config: ListenerConfig, options: PlanOptions = {}): ListenerPlan {
  const manualPath = manualPathFor(home)
  const env = options.env ?? process.env
  switch (config.mode) {
    case 'run':
      return {
        client: cliClient(),
        manualPath,
        manualPointer: manualPointer(`at ${manualPath}`),
        preset: null,
        runner: {
          name: 'command',
          create: (identity: RunnerIdentity) => new CommandRunner({ command: config.command, identity, withKey: config.with_key, env }),
        },
      }
    case 'preset': {
      const preset = presetNamed(config.preset)
      if (preset === null) throw new UnknownPresetError(`unknown preset "${config.preset}"`)
      const runtime: TextsRuntime = preset.runtime
      return {
        client: cliClient(runtime),
        manualPath,
        // A run that cannot read the identity home is pointed at the address, not at a file it is denied.
        manualPointer: preset.readsIdentityHome ? manualPointer(`at ${manualPath}`) : `(The AgentChat manual is at ${MANUAL_URL}.)`,
        preset,
        runner: {
          name: preset.name,
          create: (identity: RunnerIdentity) =>
            preset.runner({
              home: identity.home,
              workdir: identity.workdir,
              profile: config.profile,
              apiKey: identity.apiKey,
              apiBase: identity.apiBase,
              env,
              ...(options.presetCommand !== undefined ? { command: options.presetCommand } : {}),
            }),
        },
      }
    }
    case 'forward': {
      const client = cliClient()
      return {
        client,
        manualPath,
        manualPointer: manualPointer(`at ${manualPath}`),
        preset: null,
        runner: {
          name: 'forward',
          create: (identity: RunnerIdentity) => {
            const api = new AgentChatClient({
              apiKey: identity.apiKey,
              baseUrl: identity.apiBase,
              clientIdentity: clientIdentityOf(client),
              timeoutMs: 10_000,
              retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
            })
            return new ForwardRunner({
              url: config.url,
              handle: identity.handle,
              home: identity.home,
              tray: () => api.inbox.tray({ limit: INBOX_TRAY_MAX_LIMIT }),
              ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
            })
          },
        },
      }
    }
  }
}
