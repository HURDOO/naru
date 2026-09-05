export const SESSION_CLI_HELP = `Usage:
  durable-session [connection options] run --profile ID --root ID [options]
  durable-session [connection options] run --exec-spec PRIVATE_JSON --allow-arbitrary-exec
  durable-session [connection options] list [--limit N] [--cursor CURSOR]
  durable-session [connection options] watch [SESSION_ID] [--once] [options]
  durable-session [connection options] attach SESSION_ID
  durable-session [connection options] control SESSION_ID
  durable-session [connection options] stop SESSION_ID --revision N --runtime UUID

Connection options:
  --socket PATH             Private DurableSession Host Unix socket
  --app-id ID               Registered local CLI app ID
  --credential-file PATH    Owner-only credential file; credential values are never argv
  --subject ID              Local caller subject
  --caller-ttl-ms N         Delegated caller lifetime; must fit the Host app policy
  --json                    Versioned JSON or NDJSON on stdout

Equivalent non-secret environment settings:
  DURABLE_SESSION_SOCKET_PATH
  DURABLE_SESSION_APP_ID
  DURABLE_SESSION_CREDENTIAL_FILE
  DURABLE_SESSION_SUBJECT
  DURABLE_SESSION_CALLER_TTL_MS

attach/control require an interactive terminal and use the workstation-v0/T07 private UDS stream.
Use watch --json for machine-readable events. Resume tokens and terminal transcript are never
written to JSON, persistent storage, argv, or diagnostics.
`;
