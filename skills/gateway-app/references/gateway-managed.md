# Gateway-managed integration

## Registration

Prefer an owner-private Unix socket. Use an exact loopback HTTP origin only when the application
cannot serve UDS. Never use `0.0.0.0`, a LAN/public address, a credential-bearing URL, a path-bearing
origin, or a TLS endpoint as the managed upstream.

Route prefixes must start with `/`, be canonical, avoid `/_gateway`, and not overlap any other
managed route. The Gateway strips the matched prefix before forwarding to the upstream.

## Browser-owned route and failure contract

`/_gateway` and every descendant are owned by Gateway even when an application is registered at
root `/`. An application router, reverse rewrite, offline fallback, or service worker must not
answer, cache, precache, or substitute an app shell for that namespace. A service worker fetch
handler must return without calling `respondWith`, which leaves the request network-only. This is
required for `/_gateway/login` to remain reachable after a Gateway cookie expires or is absent.

Browser clients must parse `GatewayBrowserFailureResponseV1Schema` from
`@naru/contracts/workstation-gateway/v1`. Only an HTTP 401 with the exact version 1 envelope and
`error.code === "AUTHENTICATION_REQUIRED"` means that the Gateway session must be re-established:

```json
{
  "version": 1,
  "ok": false,
  "error": {
    "code": "AUTHENTICATION_REQUIRED",
    "message": "Gateway authentication is required."
  },
  "requestId": "opaque-request-id"
}
```

Do not flatten this response into the application's error schema, treat every upstream 401 as a
Gateway failure, or report this exact response as a network outage. Preserve application-owned
authentication codes and unknown/malformed responses with their original failure semantics.

For an installable PWA, steady-state acceptance must cover both a fresh browser and a previously
installed, already controlling worker that follows this reserved-route contract. Publish the new
worker, let the user apply the normal update, remove or expire the Gateway cookie, and verify that a
`/_gateway/login?return=...` navigation loads the Gateway's no-store passkey page rather than the
cached app shell. Do not auto-clear passkeys, PWA state, Push subscriptions, or site data to hide a
defect in a current-contract worker.

### Android WebAPK acceptance and external fallback triage

On Android Chrome, a home-screen entry that merely opens full-screen is not sufficient installation
evidence. Count the install only when the user confirms an OS-installed WebAPK, such as presence in
the app launcher or Android's application settings, and a standalone launch from that installation.
Push acceptance is separate: the user grants notification permission and confirms delivery, while
server evidence is limited to safe aggregate status that does not expose subscription endpoints.

If Chrome offers or creates only a shortcut, first preserve the current Origin, authenticated asset
policy, and intended private ingress. Verify the manifest, worker, icons, scope, and authenticated
response contract, then ask the user to try a known public installable PWA on the same device and
network state. If the control also fails, or both recover after a VPN or connectivity-state change,
classify the result as an external device/browser/WebAPK-minting observation unless stronger evidence
identifies the app. Retry the private Origin with its intended private ingress, including Tailscale
when that is the selected profile. Do not infer that Tailscale, a non-default port, or private assets
caused the fallback merely because they are present.

One shortcut fallback is not authority to expose the manifest, service worker, or icons before
Gateway authentication; add Origins or ports; clear site data; change the manifest contract; or
weaken any security boundary. Make such a change only for an independently demonstrated product
defect under its own review and approval.

### Pre-contract worker migration

A worker installed before this contract may already intercept `/_gateway/login`. If the Gateway
cookie is absent and `/sw.js` is an authenticated app asset, that worker cannot reach login or fetch
its replacement. Do not solve this migration deadlock by exposing `/sw.js`, a digest-bound worker,
or another upstream app asset before Gateway authentication; that changes the pre-auth security
boundary for every client.

Explain the impact and obtain the user's approval for a one-time, Origin-specific site-data reset
through browser UI. It can remove that Origin's worker, caches, cookie, notification permission, and
Push subscription. Do not clear all browser data, delete Password Manager entries or passkeys, or
perform the reset from application/package code. Close every normal tab for the Origin, open the
exact Gateway login URL, authenticate with the retained passkey, allow the fixed worker to register,
then test application logout, the Gateway no-store login surface, and Passkey login again. Record
this as a pre-contract migration, not as the application's normal worker-update acceptance.

## Cold browser and CSRF handoff

Before authentication, a top-level managed-app navigation terminates at the Gateway's minimal,
no-store passkey surface. The upstream app page, assets, APIs, and WebSockets stay unavailable until
the Gateway session is authenticated; never add an app-owned login fallback or direct route around
that boundary.

Gateway mutations use `x-workstation-gateway-csrf`. The proxy consumes and removes only that
namespaced header before forwarding. A generic `x-csrf-token` belongs to the application, passes
through unchanged, and is never accepted as a Gateway CSRF fallback. An application may therefore
keep and independently validate its existing CSRF contract after Gateway authentication.

## Request verification sequence

1. Accept requests only on the registered private upstream.
2. Read exactly one `x-workstation-gateway-assertion` header. Missing or repeated values fail closed.
3. Resolve the public verification key by the assertion key ID from trusted local configuration.
4. Call `verifyGatewayAssertion` with the configured Gateway instance ID, this app ID, exact browser
   Origin, bounded replay store, and bounded TTL policy.
5. On any verifier error, deny the request or WebSocket upgrade. Do not fall back to cookies, source
   IP, forwarding headers, or unverified fields.
6. Apply application-owned authorization to the verified `sub` and requested resource/action.
7. Create any downstream caller context only after authorization and with least privilege.

```ts
import { InMemoryGatewayReplayStore, verifyGatewayAssertion } from "@naru/gateway-verifier";

const replayStore = new InMemoryGatewayReplayStore();

const verified = verifyGatewayAssertion(assertion, {
  expectedIssuer: configuredGatewayInstanceId,
  expectedAudience: configuredAppId,
  expectedOrigin: configuredBrowserOrigin,
  resolveKey: trustedVerifierKeyFor,
  replayStore,
});

const decision = authorizeAppResource(verified.principal.sub, requestedAction, requestedResource);
```

The in-memory store is suitable for a single-process fixture or app instance. A multi-process app
must preserve the same bounded single-consumption property across every process that accepts the
same assertion; do not silently accept per-process replay gaps.

Do not log the assertion or decoded principal wholesale. Emit only allowlisted diagnostic IDs and
non-sensitive decision metadata required by the app's policy.

## WebSocket

Verify the upgrade exactly like HTTP and bind identity for the connection lifetime. Do not exchange
the assertion for a long-lived app credential. Gateway closes proxied sockets on logout, expiry,
revocation, route disable, and shutdown; the app still denies a new upgrade unless a fresh assertion
passes.
