# Claude messaging spikes (V06, V08 Claude side)

Reproducible experiments for `docs/agent-platform-v0/validation/claude-messaging.md`. They start real
`claude` processes with the user's normal Claude Code login, so they spend model usage. They are not
part of `pnpm test`.

## Prerequisites

- Node 24, repository deps installed (`pnpm install --frozen-lockfile`).
- `NARU_SPIKE_CLAUDE`: absolute path to the canonical Claude Code executable (tested: 2.1.296).
- Optional `NARU_SPIKE_LOG_DIR`: where raw transcripts go. The default is the `experiments/` directory
  next to the worktrees directory, outside the repository. Raw logs never go in the repository.
- `v06-tui-receiver.ts` needs `node-pty`'s `spawn-helper` to be executable. An offline pnpm install can
  drop the bit (`posix_spawnp failed`).

## Run

```sh
node --import tsx tests/spikes/claude-messaging/v06-cross-session.ts a   # inbound accept/refuse/default/bypass
node --import tsx tests/spikes/claude-messaging/v06-cross-session.ts b   # subagent messaging under cross-session block
node --import tsx tests/spikes/claude-messaging/v06-cross-session.ts c   # receiver UserPromptSubmit block
node --import tsx tests/spikes/claude-messaging/v06-tui-receiver.ts      # interactive TUI receiver in a PTY
node --import tsx tests/spikes/claude-messaging/v08-managed-stub.ts      # Naru-managed MCP stub, token-bound sender
```

Each run writes `summary.json`, per-session stream-json, and `hooks.jsonl` under `<log dir>/runs/<run>/`.

## Safety guards

- Child processes get an environment built from scratch. Inherited `CLAUDE_*` values (for example the
  parent session's messaging socket and token) are not passed through.
- Every spike session runs `audit-hook.mjs` on all lifecycle events. The hook denies `SendMessage` to any
  target outside the spike session names (`NARU_SPIKE_SEND_ALLOW`). Receivers deny all sends. The user's
  real sessions that appear in `ListAgents` are therefore never messaged.
- Spike sessions use `--settings` and `--mcp-config --strict-mcp-config`. They never modify user or
  global Claude settings.

## Managed messaging stub interface (`naru-stub-mcp.mjs`)

This is a stdio MCP server using newline-delimited JSON-RPC 2.0. It replies with protocol `2025-06-18`.
The same interface is shared with the Codex worker's stub so the integration step can do the
Codex↔Claude round trip.

| Env                       | Meaning                                                                    |
| ------------------------- | -------------------------------------------------------------------------- |
| `NARU_STUB_STORE`         | Owner-only JSON store: `{ messages: [...], calls: [...] }`                 |
| `NARU_STUB_REGISTRY`      | `{ "tokens": { "<session token>": "<agent id>" } }`, written by the host   |
| `NARU_STUB_SESSION_TOKEN` | Per-session token. Identity is resolved from it, never from tool arguments |

| Tool           | Input (no extra fields allowed)                                   | Result (text content, JSON)                                                 |
| -------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `send_message` | `{ to: string, verbatim: string, origin_instruction_id: string }` | `{ ok, message_id, from }` or `{ error }` (`isError: true`)                 |
| `inbox`        | `{}`                                                              | `{ messages: [{ id, from, verbatim, origin_instruction_id, created_at }] }` |

Errors: `NARU_STUB_UNBOUND_SESSION`, `NARU_STUB_UNEXPECTED_FIELD`, `NARU_STUB_INVALID_FIELD`,
`NARU_STUB_UNKNOWN_TOOL`. `inbox` marks the returned messages as delivered. Each message is delivered
at most once.

Claude attaches it per session:

```sh
claude --mcp-config '{"mcpServers":{"naru":{"command":"<node>","args":["<repo>/tests/spikes/claude-messaging/naru-stub-mcp.mjs"],"env":{"NARU_STUB_STORE":"…","NARU_STUB_REGISTRY":"…","NARU_STUB_SESSION_TOKEN":"…"}}}}' \
  --strict-mcp-config --allowedTools mcp__naru__send_message mcp__naru__inbox
```
