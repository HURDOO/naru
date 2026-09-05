---
name: gateway-app
description: Integrate or review a private application with Workstation Gateway and, when needed, DurableSession Host using live registration schemas and public verifier/client contracts. Use for gateway-managed or app-managed application work; do not use for workstation installation, live Session operation, generic reverse proxy, OIDC, or deployment.
---

# Gateway App

Keep browser authentication, application authorization, and Host capability as three separate
boundaries. A Gateway assertion authenticates a browser principal; it is not application permission
and is never a DurableSession credential.

## Start from the live contract

1. Inspect the application's current authentication, exact browser Origin, private endpoint, route,
   resource model, and any DurableSession operations it needs.
2. Read the live Gateway registration schema and verifier exports before proposing changes. Use
   [references/runtime-contract.md](references/runtime-contract.md) for this repository's source map.
3. If runtime help, schemas, or verifier exports drift from the reference, stop and return the gap to
   the owning runtime task. Never invent an `app register` command or hand-edit active state through
   guessed shell steps.

Use `workstation-setup` for machine installation, authentication bootstrap, services, ingress, and
doctor operations. Use `durable-session` when the request is to operate an already registered live
Session rather than implement an application consumer.

## Choose one app mode

Read [references/mode-selection.md](references/mode-selection.md) before designing a registration.

- `gateway-managed`: Gateway owns the cold pre-auth page plus
  passkey/session/Origin/namespaced-CSRF/WebSocket authentication and proxies to an owner-private
  Unix socket or exact loopback origin. The app verifies a fresh signed assertion and applies its
  own authorization. It must not expose a direct or public listener.
- `app-managed`: the app owns its endpoint, TLS, Origin, authentication, session, and authorization.
  Gateway records but does not proxy the app. Doctor can inspect exposure but cannot certify the
  app's auth correctness.

Do not turn `app-managed` into a fallback for a broken managed route, and do not require Gateway
cookies or passkeys from an app-managed consumer.

## Implement only the selected boundary

For `gateway-managed`, read [references/gateway-managed.md](references/gateway-managed.md) for the
strict registration and verifier sequence.

- Propose a schema-valid registration diff with a unique app ID and non-overlapping, non-reserved
  route.
- Accept identity only from `x-workstation-gateway-assertion` received through the registered private
  upstream. Ignore and reject fallback identity, cookie, authorization, forwarding, or capability
  headers.
- Send Gateway mutations with `x-workstation-gateway-csrf`. Gateway consumes and removes only that
  namespaced header; an application's own `x-csrf-token` remains application input and is never a
  fallback Gateway token.
- Keep the exact `/_gateway` path and every descendant outside application routing, navigation
  fallback, service-worker interception, and every cache. Parse the shared version 1 Gateway
  failure envelope so only `401/AUTHENTICATION_REQUIRED` becomes Gateway reauthentication.
- Verify signature, key ID, issuer, exact app audience, exact Origin, time window, maximum TTL, and
  bounded replay before reading the principal as authenticated.
- Map the verified principal to application-owned resources and actions. Deny by default on any
  verifier, key, replay-store, or policy failure.

For `app-managed`, keep its endpoint, TLS, Origin, browser authentication, session, CSRF, WebSocket,
and authorization implementation application-owned. A registry record does not proxy or certify
those controls.

If either mode uses DurableSession, read
[references/host-authorization.md](references/host-authorization.md). Delegate only the capabilities,
Session/profile/root scopes, subject, and expiry required for that request. Load the separately
registered Host app credential from an owner-only file; never derive it from a Gateway assertion.

Read [references/examples.md](references/examples.md) when composing a configuration or verifier
walkthrough. All examples use fake data and do not authorize a config, service, listener, passkey,
network, or Host change.

## Verify before handoff

Require schema parsing and negative tests for malformed or tampered assertion, unknown key, wrong
issuer/audience/Origin, expiry, excessive TTL, replay, header/cookie spoofing, route overlap, unsafe
upstream, direct-listener exposure, Gateway route interception, and false authentication-envelope
matches. A PWA whose controlling worker already follows the reserved-route contract must also prove
normal user-approved update followed by logout or cookie loss and Gateway reauthentication; a
fresh-profile test alone is insufficient. If a pre-contract worker intercepts login and cannot fetch
the authenticated `/sw.js`, preserve the Gateway pre-auth boundary and read the one-time migration
procedure in [references/gateway-managed.md](references/gateway-managed.md). Android installation
acceptance must distinguish an OS-installed WebAPK from a full-screen home-screen shortcut and use
the same reference's external-fallback triage before proposing application or Gateway changes. For
Host consumers, also test wrong app credential and over-broad capability/scope rejection. An
app-managed consumer must independently test its own authentication and authorization; Gateway
doctor cannot supply that evidence.

Use doctor JSON for the deployed chain, but do not claim it proves application authorization. Do not
log raw assertions, cookies, WebAuthn credential IDs, signing material, Host credentials, terminal
content, or authorization headers. Active config, service, listener, passkey, or network mutations
need fresh user authorization immediately before execution.
