# DurableSession examples

All IDs and paths are fake. Confirm every value from live packaged configuration and CLI output.
These examples explain command shape and grant no permission to run, control, input, preempt, or stop.

## Bounded discovery

```text
durable-session \
  --socket /private/fixture/host.sock \
  --app-id local-session-cli \
  --credential-file /private/fixture/local-session-cli.credential \
  --subject fixture-owner \
  --json \
  list --limit 25
```

Observe one bounded batch without attaching a terminal:

```text
durable-session \
  --socket /private/fixture/host.sock \
  --app-id local-session-cli \
  --credential-file /private/fixture/local-session-cli.credential \
  --subject fixture-owner \
  --json \
  watch 11111111-1111-4111-8111-111111111111 --once --limit 25 --timeout-ms 5000
```

## Profile-based run

```text
durable-session \
  --socket /private/fixture/host.sock \
  --app-id local-session-cli \
  --credential-file /private/fixture/local-session-cli.credential \
  --subject fixture-owner \
  --json \
  run --profile dev-server --root project-main --cwd packages/web --cols 100 --rows 30
```

Use arbitrary exec only when the exact private JSON spec and distinct risk were requested and
reviewed. Never put the JSON or credential value directly in argv.

## Observe or request control

Use interactive `attach SESSION_ID` when observation is enough. If the user explicitly wants to
interact, `control SESSION_ID` acquires an unheld controller or requests the current controller. Wait
for approve→accept; do not use the repeated `p` takeover action without separate explicit owner
intent.

## Fenced stop

After fresh list output identifies revision `7` and runtime
`22222222-2222-4222-8222-222222222222` for the exact target:

```text
durable-session \
  --socket /private/fixture/host.sock \
  --app-id local-session-cli \
  --credential-file /private/fixture/local-session-cli.credential \
  --subject fixture-owner \
  --json \
  stop 11111111-1111-4111-8111-111111111111 \
    --revision 7 \
    --runtime 22222222-2222-4222-8222-222222222222
```

If the Host rejects either fencing value as stale, do not retry with refreshed values until the user
has reviewed the replacement runtime.
