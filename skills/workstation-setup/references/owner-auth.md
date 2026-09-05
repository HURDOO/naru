# Owner authentication bootstrap and recovery

Use this reference only after the live packaged workstation CLI proves that owner authentication
operations are available.

The current T14 command shapes are:

```text
workstation auth bootstrap --intent PRIVATE_INTENT --json
workstation auth recover --intent PRIVATE_INTENT --json
```

The target user invokes these commands personally. Do not run them merely to inspect availability:
each successful invocation creates credential state and reveals a short-lived secret exactly once.

## Trust boundary

- Bootstrap and recovery start from the same macOS user's private Gateway admin socket.
- The local operation creates a short-lived, single-use intent bound to the canonical HTTPS Origin.
- The raw code or QR is shown once to that user. Gateway stores only a keyed digest, expiry, attempt,
  and consumed state.
- Passkey enrollment happens at the doctor-verified canonical Origin and requires user verification.
- Recovery creates a new local intent; it is not a remote unauthenticated reset or password fallback.
- Cold top-level navigation ends at the Gateway's no-store passkey page. The managed app's page,
  assets, APIs, and WebSockets remain unavailable until the Gateway session is authenticated.

The user performs passkey enrollment and any authenticator judgment. Do not open a browser, enter or
copy a one-time code, approve an authenticator prompt, or treat permission for another setup phase as
authorization to do so.

## Plan and handle sensitive material

Before creating an intent, show the exact instance, local user, canonical Origin, expiry, and effects.
Never include the raw code, WebAuthn challenge, credential ID, cookie, signing material, or recovery
secret in argv, repository files, structured logs, plans, evaluation fixtures, or chat summaries.
Keep a code only in the current form field while the user completes registration; never put it in a
URL, persistent browser storage, or an upstream app request.

A code or challenge is consumed according to the live single-attempt policy. Do not retry it, extend
its TTL, change its Origin, or reuse it after failure. Generate a new intent only through the live
deterministic operation and under fresh user authorization.

## Proof and failure handling

After the user completes enrollment, require full doctor JSON to distinguish:

- canonical TLS Origin and relying-party identity;
- Gateway readiness and owner bootstrap state;
- browser authentication from app authorization;
- app route/assertion health from optional Host credentials and Session health.

If remote access is unavailable, use same-user local recovery only. Never enable a direct app
listener, persistent default password, relaxed Origin, or unauthenticated reset as a fallback.
