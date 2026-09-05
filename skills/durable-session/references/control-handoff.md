# Control handoff

## Choose observer or controller intent

`attach SESSION_ID` opens an interactive observer. It can request normal control but cannot preempt.
Use it for inspection, waiting, or a handoff initiated only if later needed. Observer keystrokes and
terminal resize stay local and do not change Host geometry.

`control SESSION_ID` expresses controller intent. It acquires control if no controller exists or
creates a normal request if another attachment holds it. It also delegates preempt capability, so do
not use it as a more convenient spelling of `attach`.

Both commands require a real interactive terminal. Do not combine them with JSON mode, pipe their
terminal bytes into structured output, or emulate their palette through unrelated protocol calls.

## Normal transfer

The safe held-controller flow is:

```text
requester requests -> current controller approves -> requester accepts -> generation increments
```

Request, approval, and offer are time-bounded. Approval does not move control by itself. If the
requester disappears or the offer expires, keep the current controller. After transfer, every old
generation input, resize, heartbeat, and accept is stale and must be rejected rather than retried.

In the interactive CLI, `Ctrl+]` opens the local control palette:

- `r` requests control;
- `a` approves a visible request or accepts a visible offer;
- `x` rejects a visible request;
- `l` releases control; and
- `q` closes only the attachment.

Use `c` only to acquire currently unheld control. Do not approve, reject, or accept a request whose
identity is not the one shown by the current attachment.

## Explicit owner takeover

Only `control` enables `p` preempt, and the CLI requires the palette action twice. Preempt is for an
explicit owner takeover that intentionally invalidates the previous controller generation. It is not
authorized by silence, timeout, a disconnected browser, a blocked agent, or a general request to
observe or continue work.

After the requested interaction, release control unless continued ownership is part of the user's
task. Never stop the Session merely to resolve a control conflict.
