import * as fs from 'node:fs'
import * as path from 'node:path'
import { vi } from 'vitest'
import { ConnectionError, HttpTransport, type Texts } from 'agentchatme'

// ─── The served texts, as a test double ─────────────────────────────────────
//
// What `GET /v1/texts?runtime=` answers, shaped like the server's response
// (packages/shared/src/types/texts.ts). The words are deliberately NOT the
// server's: a test that passed because the fixture matched a copy would prove
// nothing about the integration fetching them.

export const TEXTS_VERSION = '1'
export const MANUAL_VERSION = '2.1.2'

export function textsFor(handle: string, runtime = 'generic'): Texts {
  return {
    version: TEXTS_VERSION,
    manual: { url: 'https://agentchat.me/skill.md', version: MANUAL_VERSION },
    wake_instruction: `SERVED WAKE INSTRUCTION for ${runtime}: call agentchat_inbox first.`,
    invite_prompt: `SERVED INVITE PROMPT for ${runtime}: call agentchat_list_group_invites first.`,
    identity_line: `I am @${handle} on AgentChat (api.agentchat.me). Served identity line for ${runtime}.`,
    identity_line_template: `I am @<handle> on AgentChat (api.agentchat.me). Served identity line for ${runtime}.`,
  }
}

/**
 * Answer `GET /v1/texts` through the SDK's transport and refuse every other
 * request, so no identity-command test reaches the network. Tests that need a
 * particular call mock it at the SDK method (`AgentChatClient.prototype.getMe`,
 * `AgentChatClient.register`, …), which never reaches the transport.
 */
export function mockServedTexts(handle = 'probe', runtime = 'generic') {
  return vi.spyOn(HttpTransport.prototype, 'request').mockImplementation((async (method: string, path: string) => {
    if (method === 'GET' && path.startsWith('/v1/texts')) {
      const url = new URL(path, 'http://x')
      return { data: textsFor(handle, url.searchParams.get('runtime') ?? runtime), headers: new Headers(), status: 200, requestId: null }
    }
    throw new ConnectionError(`offline in tests: ${method} ${path}`)
  }) as never)
}

/** Keep a copy in the identity home the way the kit's TextsCache does (`texts.json`, version 1, per runtime). */
export function writeTextsCacheFile(home: string, runtime: string, texts: Texts, fetchedAt: Date): void {
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'texts.json'), JSON.stringify({ version: 1, fetched_at: fetchedAt.toISOString(), runtime, texts }))
}
