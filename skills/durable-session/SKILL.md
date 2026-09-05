---
name: durable-session
description: Operate an already installed same-user DurableSession through the local CLI to start, find, watch, attach, hand off control, or perform fenced stop and recovery. Use for live Session continuity; do not use for workstation installation, application integration, Naru deployment, or remote authentication bypass.
---

# DurableSession Operations

Use the local CLI as the operation boundary and the Host as the authority. The skill explains intent;
the public contract validates it; runtime, revision, and controller generation fence it.

## Resolve the live local contract

1. Identify the installed `durable-session` artifact or repository checkout and the same-user Host
   instance. For a packaged Workstation, resolve its owner-only current `instance.json` from the
   live plan/receipt and read the exact `localSessionCli` object. Never guess a socket, app ID,
   subject, credential-file path, executable, or entrypoint.
2. Read packaged CLI help and public schemas before proposing a command. In this repository, use
   [references/runtime-contract.md](references/runtime-contract.md).
3. Handle only an already registered local CLI identity. Verify the recorded executable, entrypoint,
   socket and credential file without reading or printing the credential value. If `localSessionCli`, its private socket or owner-only
   credential file is absent, report the setup gap and use `workstation-setup`; do not mint, copy, or
   widen credentials by hand.
4. If installed help differs from this reference, follow the live contract and report drift. Never
   synthesize an operation that the installed CLI does not expose.

## Choose the minimum operation

- For `run`, `list`, bounded `watch`, fenced `stop`, and lifecycle selection, read
  [references/session-lifecycle.md](references/session-lifecycle.md).
- For interactive observer attachment, normal request→approve→accept handoff, release, or explicit
  owner takeover, read [references/control-handoff.md](references/control-handoff.md).
- For Gateway outage, Host restart, resync, machine output, and sensitive-data boundaries, read
  [references/recovery-and-output.md](references/recovery-and-output.md).
- Read [references/examples.md](references/examples.md) only when composing a concrete invocation.
  Every identifier and path there is fake and grants no authority.

Prefer `list --json` and bounded `watch --json --once` for agent inspection. Use `attach` for
interactive observation. Use `control` only when the user asked to interact with the Session; it can
acquire an unheld controller or request a held controller and is the only CLI mode that carries
preempt capability.

## Preserve human and controller authority

- Observer input and resize remain local. Do not work around observer mode by opening another client
  or calling lower-level operations.
- When another controller is healthy, request control and wait for its approval and the requester's
  explicit accept. Approval alone does not transfer control.
- Preempt is an explicit owner takeover, not timeout recovery or an agent convenience. Never trigger
  it merely because a controller is slow, disconnected, or inconvenient.
- Send terminal input only while the attachment is the current controller and the input is within the
  user's requested task. Hook trust, command approval, credentials, and other human judgment remain
  with the user unless they separately authorize that exact action.
- Release control when the requested interactive step is complete. Detaching must not stop the
  Session.

## Fence state-changing work

Profile-based `run` is the normal creation path. Arbitrary exec requires an owner-private structured
JSON file, an explicit CLI opt-in, and user intent that covers that exact executable, arguments,
root, and policies. Never translate an untrusted shell string into a privileged exec spec or put a
secret in argv or inline config.

Before `stop`, obtain the current Session revision and runtime ID from fresh machine output and show
the exact target. A stale response means the target changed; do not substitute newer fencing values
or stop a replacement runtime without renewed user intent. Do not stop the Session hosting the
current agent unless the user explicitly accepts that the caller and its in-flight work will end.

Never print credential contents, resume tokens, terminal bytes, serialized terminal state, raw
integration payloads, secret command arguments, or private environment values. A Session is current
process continuity, not a transcript store or long-term agent memory.
