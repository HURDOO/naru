# Recovery and output boundaries

## Outage model

- Naru or Gateway restart does not terminate a Host-owned PTY. The same-user local CLI remains the
  recovery path through the Host private socket.
- Gateway outage makes a gateway-managed remote app unavailable. Do not expose a direct listener,
  bypass browser authentication, or send Host credentials remotely as a fallback.
- Host restart does not preserve child processes in v0. Persisted running metadata becomes honestly
  stopped; do not claim that its runtime or screen was restored.
- The current CLI can inspect that state but has no separate restart command. Do not silently create a
  new Session and represent it as the old runtime.

If the private Host socket or registered CLI credential is unavailable, stop at the local setup
boundary. Workstation setup or service repair is a different workflow and may require fresh user
authorization.

## Resync and reconnect

Interactive clients maintain a bounded current terminal state and attachment queue. A sequence gap or
queue overflow requires full resync; never splice guessed output into the screen. Resume tokens are
short-lived, single-use, app/subject/runtime-bound, and kept only inside the client. Do not request,
extract, persist, print, or transfer them.

Disconnect does not elect a new controller. Reconnection cannot resurrect control after preempt,
release, generation change, expiry, or wrong app/subject binding.

## Machine-readable observation

Use `list --json` for current redacted Session views and `watch --json --once` for bounded journal
events. The CLI intentionally excludes terminal bytes, serialized screen state, resume tokens, and raw
integration payloads from machine output. Do not bypass that boundary with debug logs, database
inspection, terminal capture, or lower-level socket frames.

Report lifecycle, revision, runtime, generation, event IDs/types, stable errors, and explicitly
redacted summaries only. A bounded current state is not a complete transcript and must not be
described or stored as long-term agent memory.
