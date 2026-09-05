# Runtime contract and source map

Use installed CLI help and public versioned schemas as the source of truth. The authoring sources for
this repository version are:

- [CLI usage](../../../apps/cli/src/help.ts)
- [CLI argument contract](../../../apps/cli/src/arguments.ts)
- [least-capability caller construction](../../../apps/cli/src/caller-context.ts)
- [interactive control behavior](../../../apps/cli/src/interactive-terminal.ts)
- [machine-output redaction](../../../apps/cli/src/output.ts)
- [public TypeScript client boundary](../../../packages/durable-session-client/README.md)
- [public protocol schemas](../../../packages/contracts/src/durable-session/v0/index.ts)

If these sources are unavailable in an installed distribution, use its packaged help and schemas. If
neither exists, report the missing contract and stop.

## Current CLI surface

Global connection options must precede the command:

```text
durable-session [connection options] run --profile ID --root ID [options]
durable-session [connection options] run --exec-spec PRIVATE_JSON --allow-arbitrary-exec
durable-session [connection options] list [--limit N] [--cursor CURSOR]
durable-session [connection options] watch [SESSION_ID] [--once] [options]
durable-session [connection options] attach SESSION_ID
durable-session [connection options] control SESSION_ID
durable-session [connection options] stop SESSION_ID --revision N --runtime UUID
```

Connection metadata is `--socket`, `--app-id`, `--credential-file`, `--subject`, and
`--caller-ttl-ms`. Matching `DURABLE_SESSION_*` environment settings may provide those values. The
credential value itself is read only from the owner-only credential file; it is never an argument or
environment value. `--json` is also a global option and cannot be combined with interactive
`attach` or `control`; machine consumers use `watch --json`.

A current packaged Workstation records these non-secret invocation fields under the owner-only
`instance.json.localSessionCli` object:

```text
executable, entrypoint, socketPath, appId, credentialFile, subject, callerTtlMs
```

Pass `executable entrypoint` first, then translate the remaining fields to the corresponding global
options before the command. Do not source the JSON as shell, expose the credential value, substitute
the Naru app credential, or derive missing fields from naming conventions. The Host registration for
this identity covers configured profiles/roots and omits arbitrary create and forget; `control`
requests preempt only for its explicit repeated-confirmation action.

The current CLI does not expose separate `start`, `forget`, direct control-operation, or resume-token
commands. Interactive attachment manages attachment resume and control protocol in memory. Do not
invent lower-level CLI syntax from the broader public TypeScript service API.

## Machine behavior

- JSON/NDJSON is version 1 on stdout; diagnostics are separate.
- `list` and `watch` delegate observe capability. `watch` is bounded by event limit and timeout.
- `attach` delegates observe and normal control-request capability but no preempt capability.
- `control` delegates observe, normal control-request, and preempt capability for its explicit,
  repeated-confirmation takeover action.
- Profile `run` delegates profile creation and the named profile/root only. Arbitrary `run` delegates
  the distinct arbitrary-create capability.
- `stop` requires both current Session revision and runtime ID.

Usage or schema failure exits 2; private endpoint, credential, or transport unavailability exits 3;
policy denial exits 4; stale/control conflict exits 5; missing or invalid lifecycle state exits 6;
resync-required exits 7; an aborted request exits 130. Read the stable machine error code instead of
matching diagnostic prose.
