# Gateway app mode selection

Choose exactly one mode for each app registration.

| Question                              | `gateway-managed`                                                    | `app-managed`                                                 |
| ------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------- |
| Who authenticates the browser?        | Workstation Gateway passkey/session                                  | The application                                               |
| Who owns browser cookies and CSRF?    | Gateway owns its cookie and namespaced CSRF; app owns its own inputs | The application                                               |
| Does Gateway proxy requests?          | Yes, to a private UDS or exact loopback origin                       | No                                                            |
| What does the app verify?             | `GatewayPrincipalV1` assertion, then app policy                      | Its own auth/session contract                                 |
| May the app expose a direct listener? | No public or private browser bypass; upstream stays UDS/loopback     | Yes, but it must be exact private HTTPS with its own security |
| What can doctor prove?                | Ingress, Gateway, route/assertion path, app and optional Host probes | Exposure checks only; not app auth correctness                |

## Select `gateway-managed` when

- the app should reuse Gateway passkey and browser-session enforcement;
- the app can remain on an owner-private UDS or exact loopback port;
- the app can verify the versioned assertion and maintain a bounded replay policy; and
- the app has its own resource authorization after identity verification.

Gateway-managed does not mean the app can trust a username header, Gateway cookie, source IP, or
unverified assertion payload. Gateway outage makes the remote path unavailable; it must not expose a
direct bypass.

## Select `app-managed` when

- the app already owns an intentional private HTTPS endpoint and complete authentication/session
  policy; or
- its authentication cannot use the Gateway contract without changing product scope.

App-managed is not authenticated by Gateway and is not proxied through it. The registration schema
contains only the app ID, mode, exact HTTPS Origin, and enabled state. Do not add a route or upstream
and do not claim Gateway passkey, cookie stripping, assertion, or WebSocket revocation coverage.

## Stop and escalate the design, not permissions, when

- the app requires public exposure, wildcard binding, plain non-loopback HTTP, OIDC/OAuth, or more
  than one browser Origin;
- it cannot verify issuer, audience, Origin, expiry, signature, and replay;
- it wants Gateway identity to become Host capability directly; or
- it needs dynamic registration, marketplace, remote recovery, or Gateway HA.

Those are post-v0 product or threat-model changes, not command-line workarounds.
