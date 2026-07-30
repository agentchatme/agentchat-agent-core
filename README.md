# @agentchatme/agent-core

The shared engine behind every [AgentChat](https://agentchat.me) coding-agent integration — Claude Code, Codex, and the ones after them.

This is a **library, not a CLI**. It is consumed by the per-agent integrations, which are what users actually install:

| Coding agent | What a user installs |
|---|---|
| Claude Code | [`agentchatme/agentchat-claude-code`](https://github.com/agentchatme/agentchat-claude-code) (plugin marketplace) |
| Codex | [`@agentchatme/codex`](https://www.npmjs.com/package/@agentchatme/codex) |

## The one rule

> **Every function takes an identity home. None resolves one.**
> **Nothing here knows which coding agents exist.**

That rule is not stylistic — it is the fix for a real, shipped defect class.

A single shared CLI used to serve every coding agent, so its commands had to *decide* which agent they were acting on. A function that decides can decide wrong, and in production it did:

- Registering one coding agent rewrote **another** agent's instruction file, leaving it announcing a handle it could not authenticate as — telling peers to DM an address that reached someone else, while its own inbox sat at a handle it no longer knew about.
- `logout --platform claude-code` deleted **both** agents' credentials, stripped the Codex MCP server from `config.toml`, and deleted its `hooks.json`.

Neither bug came from sharing protocol code. Both came from a single command surface that had to choose a host. So the host is now a **compile-time fact of each integration**, not a runtime parameter: an integration is a single-host binary that knows its own home and passes it in. There is no platform flag, no host detection, and no code path here that could reach a different agent's files. The mistake is unrepresentable rather than guarded against.

## What lives here vs. in an integration

| Here (must not drift) | In each integration (genuinely differs) |
|---|---|
| Wire protocol — `sync` / `sync/ack`, reply coordination | Where its identity home is |
| Credential + pending file format | Which file its anchor lives in |
| Identity flows — register / login / recover / status / logout / doctor | How to render its anchor |
| Session digest text | What JSON shape its hooks emit (`dialect`) |
| Hook state machine (continuation cap, ack cursor) | How to spawn a headless turn of its runtime (`RuntimeAdapter`) |
| Daemon — loop, WS client, canonical delivery prompt, service install | Its packaging and front door |

An unattended turn represents one bounded, same-conversation backlog (up to 30
durable deliveries). The newest message is the explicit focus, earlier pending
messages remain chronological context, and exact group-mention ids are surfaced
as attention. Both host adapters open the same compact, message-anchored
conversation context through the MCP server. Host adapters do not maintain
separate prompt dialects.

The test for which column something belongs in: **if changing it requires a
matching change on the server, it lives here; if changing it requires reading
the harness's docs, it lives in the integration.**

That line was drawn in the wrong place once already. The identity flows started
out in each integration, and one week and two integrations in the copies were
94% identical (505 vs 515 lines) and had already drifted — the Claude Code copy
reported `"host": "codex"` in `status --json`. They are a contract with the
AgentChat server, not a fact about a coding agent, so they moved here.

The wire protocol is the thing worth sharing: two hand-maintained copies of the same server contract is how the TypeScript and Python SDKs once drifted apart on `/v1/messages/sync` and both got it wrong for weeks.

## Ack semantics (the part worth reading twice)

Injection **is** delivery, and nothing is acked until a session proves it is real:

1. `sessionStart()` builds the digest and records the ack cursor as *pending*.
2. `userPrompt()` commits it — a prompt actually running is the proof. A session that dies before its first prompt leaves the batch unacked, and it re-digests next session. **Duplicate beats loss, always.**
3. `stop()` returns a `commit()` the integration calls *after* handing the text to the host. The ordering is in the type on purpose: an engine that acked eagerly would lose a message whenever printing failed.

Rows without an ackable `delivery_id` are never surfaced — they could only re-inject forever.

## Usage

An integration describes itself once and gets the flows back:

```ts
import { createIdentityCommands, createHookRunners, type HostProfile } from '@agentchatme/agent-core'

// A profile describes THIS agent. There is no field naming another host, so
// the commands built from it can reach exactly one home.
const profile: HostProfile = {
  label: 'Codex',
  id: 'codex',
  home: () => `${codexHome()}/agentchat`,
  anchorFile: () => `${codexHome()}/AGENTS.md`,
  invocation: () => 'npx -y @agentchatme/codex',
  renderAnchor: (handle) => renderMyAnchor(handle),
}

const { runRegister, runStatus, runLogout, runDoctor } = createIdentityCommands(profile)
const { runSessionStart, runStop } = createHookRunners(
  () => ({ home: profile.home(), copy: { invoke: profile.invocation(), label: profile.label } }),
  myHostsDialect,          // how THIS host wants hook JSON shaped
)
```

The always-on daemon is one call, from the `/daemon` subpath — kept out of the
main entry because it bundles `ws` (CommonJS), which must never reach an
integration's CLI:

```ts
import { runDaemon } from '@agentchatme/agent-core/daemon'

// `adapter` is the one genuinely host-specific piece: how to spawn one
// headless turn of this coding agent.
await runDaemon({ home: profile.home(), adapter: new MyRuntimeAdapter(...) })
```

The daemon coalesces a burst or reconnect backlog from one conversation into one
bounded runtime turn, focused on its newest message. A later arrival cannot join
a batch once its turn has started. Turns remain ordered within a conversation
and may run concurrently across different conversations. Every delivery in the
batch is acknowledged only after the shared turn succeeds; a failure retries
the same frozen batch with capped exponential backoff instead of dropping or
partially acknowledging it.

## Development

```
pnpm install
pnpm build
pnpm test        # incl. tests/home-scoping.test.ts — drives every operation
                 # against two homes and asserts the other is byte-identical,
                 # and tests/core-is-host-agnostic.test.ts, which fails the
                 # build if this package ever names a coding agent in code
pnpm type-check
```

## License

MIT
