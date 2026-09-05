# Local Session CLI

`durable-session` consumes only the public DurableSession v0 contract and talks directly to the
per-user Host private UDS. It does not use Naru server/web modules or the Workstation Gateway.

Connection metadata can be passed through flags or the matching non-secret environment settings.
The Host credential value itself is accepted only through an owner-only credential file and is
never placed in argv, JSON, diagnostics, or persistent state.

```text
durable-session \
  --socket /absolute/private/runtime/host.sock \
  --app-id local-session-cli \
  --credential-file /absolute/private/credentials/local-session-cli \
  --subject local-owner \
  --json \
  list
```

Machine mode writes versioned JSON or NDJSON to stdout. Human diagnostics use stderr. Attachment
resume tokens, serialized terminal state, raw terminal output, and integration payloads are not
included in machine output.

Profile `run` is the normal path. Arbitrary exec requires both an owner-only structured JSON file
matching `ExecCommandSpecV0` and the explicit `--allow-arbitrary-exec` flag; shell command strings,
inline environment maps, and credential arguments are not accepted.

Interactive attachment uses `Ctrl+]` as a local control prefix. Observer input/resize stays local;
request approval, offer acceptance, release, and repeated-confirmation preempt are performed on the
same in-memory attachment. `attach` starts as an observer and delegates no preempt capability.
`control` explicitly acquires control when it is free or submits a normal request when another
controller holds it; only this command enables the repeated-confirmation preempt action. Both
commands require an interactive terminal; machine consumers use `watch --json` so terminal bytes
never enter JSON.

The Node stream adapter validates the owner-only socket before sending credentials, authenticates a
single caller context, correlates operation responses, bounds its event queue, and sends Host
heartbeats for every attachment. `--caller-ttl-ms` (or `DURABLE_SESSION_CALLER_TTL_MS`) must not
exceed the registered app policy; when that delegation expires the command exits while the Host
Session process continues.
