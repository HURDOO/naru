# Workstation Gateway

`@naru/workstation-gateway` is the optional, same-user security boundary between a private HTTPS
ingress and registered workstation applications. It owns WebAuthn credentials and browser sessions,
then gives a gateway-managed upstream a short-lived signed principal assertion. It does not start,
stop, or bypass DurableSession Host or any registered application.

## Runtime boundary

- Config v1 retains the exact `127.0.0.1` HTTP listener used by Tailscale Serve. Config v2 selects
  exactly one strict `loopback-proxy | direct-private-tls` browser ingress adapter.
- Direct mode terminates HTTPS/WSS in Gateway, verifies that its exact RFC1918 IPv4 bind is active
  locally, and requires every enabled Gateway-managed app to use an exact `127.0.0.1` HTTP upstream.
- The local administration API is available only through a current-user Unix socket with mode
  `0600`.
- Gateway-managed upstreams must be either a current-user `0600` Unix socket or an exact loopback
  HTTP origin. App-managed registrations are listed but never proxied.
- The private config file, data directories, key files, database, and socket path must not cross a
  symbolic link or permit group/other access.
- There is no remote reset endpoint. Bootstrap and recovery intents are created only through the
  local administration socket and consumed once.

The executable accepts one positional argument:

```text
workstation-gateway <private-config.json>
```

The configuration is strict and versioned. `src/config.ts` is the canonical schema. Version 1 keeps
the frozen top-level `listenHost: "127.0.0.1"` and `listenPort` fields. Version 2 replaces those
fields with one `browserIngress` from `@naru/contracts/private-ingress/v0`; direct profile and Origin
must match the active Gateway values exactly. Invalid or incomplete v2 input never falls back to
version 1 or loopback mode. In every version, the cookie name starts with `__Host-`, and managed
route prefixes cannot overlap `/_gateway` or one another.

PI-02 accepts already validated TLS server options through the direct-listener bootstrap port and
fails before bind when that provider is absent. The default certificate path validation,
last-known-good reload, readiness projection, and distribution renderer remain disabled until
PI-04 and PI-05 complete; a source build must not be treated as production-ready direct ingress.

`/_gateway` and every descendant are Gateway-owned browser routes even when an app owns `/`.
Application routers and service workers must leave them network-only and must never cache or replace
them with an app shell. Browser consumers parse `GatewayBrowserFailureResponseV1Schema` from
`@naru/contracts/workstation-gateway/v1`; only its exact HTTP
`401/AUTHENTICATION_REQUIRED` response triggers Gateway reauthentication. PWA acceptance must test
this with a previously active current-contract worker followed by the normal user-approved worker
update, not only a fresh browser profile. A pre-contract worker that intercepts login and cannot
fetch authenticated `/sw.js` is a one-time browser migration: keep app assets private before auth,
use only a user-approved Origin-specific site reset, then re-test fixed-worker logout and Passkey
login. The package must not perform that cleanup or clear all browser/password-manager data.

## Authentication and proxy behavior

Registration requires a live local bootstrap or recovery intent, a discoverable credential, and
user verification. Authentication also requires user verification. The resulting cookie is
`Secure`, `HttpOnly`, `SameSite=Strict`, host-only, and backed by a digest-only SQLite record with
idle and absolute expiry. Unsafe browser requests additionally require the exact Origin and a
rotating CSRF token.

Before HTTP or WebSocket proxying, the Gateway removes cookies, authorization, forwarding metadata,
connection-token headers, and all reserved identity/capability headers. It then injects only
`x-workstation-gateway-assertion`. The assertion carries an app-scoped opaque credential reference,
not the WebAuthn credential ID. WebSocket identity is fixed at upgrade time and the socket closes on
logout, credential revocation, session expiry, route disable, or Gateway shutdown.

Consumers verify assertions with `@naru/gateway-verifier`. They must bind issuer, audience, exact
origin, time, signature key, and a bounded replay store. Public verifier keys are available from the
local administration API; publishing or distributing those keys is an integration concern.

## Administrative API

The Unix-socket API exposes health/readiness, redacted app and credential inventories, verifier
public keys, local bootstrap/recovery intent creation, and credential revocation. Requests and
responses are JSON with `Cache-Control: no-store`; no endpoint returns private signing material,
session secrets, raw WebAuthn credential IDs, or stored terminal data.

Starting a real private listener or enrolling a real passkey is an explicit acceptance action. It
must use an isolated runtime and requires fresh user approval under the repository operating rules.

## Additive network control

The package also builds `workstation-network`, a JSON-only control-plane CLI for versioned additive
ingress profiles:

```text
workstation-network plan --config <private-network.json> --profile <id> --json
workstation-network apply --config <private-network.json> --profile <id> --approve-digest <sha256> --json
workstation-network status --config <private-network.json> --json
workstation-network doctor --config <private-network.json> --json
workstation-network plan --config <private-network.json> --profile <id> --operation rollback --json
workstation-network rollback --config <private-network.json> --profile <id> --approve-digest <sha256> --json
```

`src/ingress/config.ts` is the strict local deployment schema. Inclusion in its profile array means
enabled. A Tailscale profile must target the exact ready loopback Gateway listener, use a canonical
`.ts.net` HTTPS Origin, name a `tailscale-loopback` trusted-proxy policy, and match the Gateway's
single configured Origin/profile/app. WireGuard and trusted-LAN profiles use exact private listeners
and resolved private-CIDR source policies; they are inspect/doctor-only and never cause network
mutation.

Tailscale installation and login are not sufficient for HTTPS Serve. Before requesting an apply
plan, the tailnet owner must enable MagicDNS and **HTTPS Certificates** on the Tailscale admin
console DNS page and acknowledge the Certificate Transparency disclosure for machine and tailnet
DNS names. The CLI reads the node's exact HTTPS capability and blocks apply when it is absent; it
never completes this account-level consent flow. After the user enables it, create and review a new
plan because the capability is part of the state-bound digest.

Every state-changing operation recomputes actual Tailscale state, requires a reviewed digest, and
uses a private `pending -> active -> rolled-back` ownership receipt. The only external mutations that
the adapter can represent are one exact background HTTPS Serve root route and the matching route-level
`off`. Global Serve reset/config replacement, Funnel, Tailscale install/login/account/ACL/node-name,
and WireGuard/router/firewall/DNS changes have no mutation path.

Doctor reports `configuration -> ownership -> listener -> ingress -> TLS/Origin -> Gateway -> app ->
Host` checks independently as `ok`, `warning`, `blocked`, or `unavailable`. Missing app or Host proof
does not collapse into a green ingress result. Running real Tailscale detection, Serve apply, or
rollback remains a separate explicit acceptance action.
