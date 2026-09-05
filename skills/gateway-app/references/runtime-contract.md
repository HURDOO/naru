# Gateway runtime contract and source map

Use the installed schema and package exports as the source of truth. The authoring sources for this
repository version are:

- [Gateway configuration and app registration schemas](../../../apps/workstation-gateway/src/config.ts)
- [Gateway admin UDS endpoints](../../../apps/workstation-gateway/src/admin-server.ts)
- [Gateway app registry behavior](../../../apps/workstation-gateway/src/app-registry.ts)
- [Gateway browser authentication and namespaced CSRF](../../../apps/workstation-gateway/src/browser-server.ts)
- [Gateway cold pre-auth page](../../../apps/workstation-gateway/src/pre-auth-page.ts)
- [private proxy header sanitization](../../../apps/workstation-gateway/src/proxy.ts)
- [`GatewayPrincipalV1`, app-mode, browser-route/failure, and CSRF contracts](../../../packages/contracts/src/workstation-gateway/v1/index.ts)
- [public assertion verifier](../../../packages/gateway-verifier/src/verifier.ts)
- [private proxy negative tests](../../../apps/workstation-gateway/test/proxy.integration.test.ts)
- [public DurableSession client boundary](../../../packages/durable-session-client/README.md)

If these sources are unavailable in an installed distribution, use its packaged versioned schemas,
verifier API, and CLI/admin help. If no machine contract exists, report the missing integration
surface and stop.

## Current configuration contract

`WorkstationGatewayConfigSchema` is strict version 1. It binds one Gateway instance and owner to an
exact HTTPS browser Origin, ingress profile, `127.0.0.1` listener, host-only `__Host-` cookie,
owner-private data/admin socket paths, bounded TTL/body settings, and one or more app registrations.

A `gateway-managed` registration has:

- unique `appId`;
- a unique, non-overlapping `routePrefix` outside `/_gateway`;
- an owner-private UDS or exact loopback HTTP upstream;
- explicit `includeCredentialRef` and `enabled` defaults.

An `app-managed` registration has only `appId`, mode, exact HTTPS `origin`, and enabled state. The
Gateway registry does not proxy it.

The current T09/T10 artifact does not expose a deterministic `app register` command. Registration is
part of strict private configuration, while bootstrap/recovery and verifier public-key inventory are
private admin UDS operations. Do not synthesize shell editing or present a target-v0 command as live.

## Admin and verifier contract

The current-user `0600` admin UDS exposes redacted app and credential inventories, verifier public
keys, local one-time bootstrap/recovery intent creation, and credential revocation. It never returns
private signing material, raw WebAuthn credential IDs, session secrets, or terminal data.

The app consumes `@naru/gateway-verifier`. `verifyGatewayAssertion` requires exact issuer, audience,
Origin, a key resolver, and a bounded replay store. It rejects malformed data, unknown keys, invalid
signatures, identity mismatch, invalid time/TTL, replay, and a full replay cache with stable errors.

GatewayPrincipal is an internal identity-aware proxy contract, not OIDC and not a bearer credential
for another service. `credentialRef` is optional, app-scoped, and does not prove physical device
identity.

The browser contract exports `WORKSTATION_GATEWAY_CSRF_HEADER` as
`x-workstation-gateway-csrf`. Gateway accepts that namespaced header for its own mutation checks and
removes reserved `x-workstation-gateway-*` inputs before proxying. A generic `x-csrf-token` is not a
Gateway fallback and remains available to the upstream application's independent CSRF policy.

The same contract exports `WORKSTATION_GATEWAY_BROWSER_ROUTE_PREFIX`,
`WORKSTATION_GATEWAY_LOGIN_PATH`, `isWorkstationGatewayBrowserPath`, and
`GatewayBrowserFailureResponseV1Schema`. The exact reserved namespace and all descendants are
network-only browser surface: an application service worker or app-shell navigation fallback must
not intercept them. The failure schema is the only supported way to distinguish Gateway's nested
`401/AUTHENTICATION_REQUIRED` from application errors or network failure.

This reserved namespace does not make `/sw.js` or any other application asset public before
authentication. If a worker installed before the reserved-route contract cannot self-update while
unauthenticated, use the user-approved, Origin-specific migration in
[gateway-managed.md](gateway-managed.md); do not add a pre-auth asset route.
