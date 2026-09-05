# Gateway app examples

All identifiers, paths, Origins, and keys below are fixtures.

## Gateway-managed registration

```json
{
  "appId": "fixture-app",
  "mode": "gateway-managed",
  "routePrefix": "/fixture",
  "upstream": {
    "kind": "uds",
    "socketPath": "/private/fixture/app.sock"
  },
  "includeCredentialRef": false,
  "enabled": true
}
```

The app accepts only the registered private socket, verifies the injected assertion against
`fixture-app` and the configured exact Origin, then authorizes its own resource. It does not ask for
the Gateway cookie and has no direct browser listener.

## PWA browser handoff

Bundle the public pathname predicate into the service worker and return before any cache or
navigation fallback handles the Gateway namespace:

```ts
import { isWorkstationGatewayBrowserPath } from "@naru/contracts/workstation-gateway/v1";

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin && isWorkstationGatewayBrowserPath(url.pathname)) return;
  // Application-owned cache and navigation policy follows.
});
```

Parse the browser failure before translating it into an application-facing error:

```ts
import { GatewayBrowserFailureResponseV1Schema } from "@naru/contracts/workstation-gateway/v1";

const failure = GatewayBrowserFailureResponseV1Schema.safeParse(await response.json());
if (
  response.status === 401 &&
  failure.success &&
  failure.data.error.code === "AUTHENTICATION_REQUIRED"
) {
  showGatewayLogin();
}
```

Do not use a broad `401` match or reuse the application's flat error parser. With an existing
current-contract worker, apply the new worker through the normal update UX, then verify the Gateway
login page with its cookie absent. If a pre-contract worker already blocks both login and its
authenticated replacement, keep `/sw.js` private and use the user-approved, Origin-specific reset
procedure in [gateway-managed.md](gateway-managed.md); do not present that migration as normal
update behavior.

## App-managed registration

```json
{
  "appId": "fixture-independent-app",
  "mode": "app-managed",
  "origin": "https://fixture-independent.invalid",
  "enabled": true
}
```

This app owns HTTPS, Origin, authentication, cookies, CSRF, WebSocket security, and authorization.
Gateway does not proxy it and doctor does not certify those controls.

## Review handoff

A plan should include the chosen mode and why, schema-valid proposed registration, exact private
endpoint, cold pre-auth ownership, the namespaced Gateway CSRF versus application-CSRF boundary,
expected issuer/audience/Origin, key and replay policy, application authorization mapping, optional
least-privilege Host delegation, negative tests, and every remaining approval boundary. It must not
edit active config or start listeners merely because the proposal is complete.
