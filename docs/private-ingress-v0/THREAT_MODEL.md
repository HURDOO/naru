# Private Ingress v0 threat model

## 1. Scope and assets

Private Ingress v0 protects a single-user Naru instance that can execute shell and Codex processes
with the installed OS user's authority. Network admission is only the first gate: Gateway browser
authentication, Naru application authorization, and DurableSession Host capability checks remain
independent requirements.

Protected assets are browser sessions and Passkeys, Gateway signing keys, Naru project authority,
Host credentials and PTYs, terminal/Codex content, TLS private keys, private network topology, and
immutable installation receipts.

The v0 runtime has exactly one `canonicalBrowserOrigin` and one active browser listener. A profile
inventory may retain both `loopback-proxy` and `direct-private-tls` configurations, but selecting,
falling back to, or activating a second listener implicitly is forbidden. Multi-ingress is a
post-v0 contract tracked as PI-10.

## 2. Trust boundaries

```text
private browser source
  -> exact IP/CIDR source admission
  -> Gateway TLS + Host/Origin + Passkey/session/CSRF/WS authentication
  -> exact loopback Naru upstream + signed principal
  -> Naru resource authorization
  -> owner-only Host UDS + scoped capability
  -> PTY/runtime
```

`loopback-proxy` keeps TLS and external listener ownership at Tailscale Serve or an explicitly
trusted proxy and exposes only `127.0.0.1` HTTP to Gateway. `direct-private-tls` binds one exact
RFC1918 local IPv4 address and terminates TLS in Gateway. The two modes do not share configuration
fields or silently inherit each other's trust assumptions.

## 3. Threat and control matrix

| Threat                                                             | Required control                                                                                                                                                  | Owner                | Verification task   |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------- |
| Wildcard, public, hostname, or IPv6 bind exposes the shell surface | Schema accepts only canonical RFC1918 IPv4; runtime verifies the address is active locally before bind                                                            | Gateway              | PI-01, PI-02        |
| Broad or malformed source admission                                | Explicit canonical RFC1918 exact IPv4/CIDR entries only; reject empty, duplicate, overlapping, public, IPv6, and host-bit CIDRs                                   | Gateway              | PI-01, PI-03        |
| A permitted network peer is treated as a user                      | Passkey/session and CSRF or WebSocket authentication remain mandatory after source admission                                                                      | Gateway              | PI-03               |
| Forwarding headers spoof client or Gateway identity                | Match the actual socket remote address and reject or remove `Forwarded`, `X-Forwarded-*`, assertion, and reserved identity headers before authentication/upstream | Gateway              | PI-03               |
| Wrong Host or Origin reaches authentication or the app             | Require the one exact HTTPS Origin and matching Host for HTTP and WebSocket                                                                                       | Gateway              | PI-01, PI-03        |
| Mode confusion enables an unsafe fallback                          | Strict loopback/direct discriminated union, one active selection, no inferred defaults or fallback                                                                | Gateway/distribution | PI-01, PI-02, PI-05 |
| Gateway bypass reaches Naru directly                               | Gateway-managed Naru uses exact `127.0.0.1` HTTP upstream and verifies short-lived signed principals                                                              | Gateway/Naru         | PI-02, PI-03        |
| TLS path escapes or changes target                                 | Require canonical absolute references under a non-root approved root, then verify `realpath`, regular-file type, owner, mode, and final containment               | user/Gateway         | PI-01, PI-04        |
| Invalid, mismatched, or expired TLS material is activated          | Verify SAN, key pair, validity and expiry before bind/reload; retain last-known-good context on rejected reload                                                   | user/Gateway         | PI-04               |
| Reconfigure races or stale approval changes ownership              | Bind normalized private intent, verified actual state, operation and immutable artifact/config identity into a fresh plan digest and receipt                      | distribution         | PI-01, PI-05        |
| Logs or fixtures disclose secrets and topology                     | Never accept inline key/credential fields; redact profile, Origin, address and paths; report source counts and stable codes only                                  | all components       | PI-01 onward        |
| Gateway/Naru restart destroys an active terminal                   | Keep PTY/runtime ownership in DurableSession Host and reattach after Gateway/Naru restart                                                                         | Host                 | PI-06, PI-07        |
| Package mutates operator-owned network or certificate state        | Inspect DNS, WireGuard, routes and material; mutate only package-owned listener/config/release/service resources                                                  | user/distribution    | PI-05 onward        |

Request/body/message size limits, authentication rate limits, connection timeouts, and bounded
diagnostics are required in PI-03. The PI-01 schema does not claim that syntactically valid network
or path values exist or are safe on the current machine; those checks require runtime state and stay
fail-closed in their assigned tasks.

## 4. Source-policy boundary

`private-ipv4-allowlist` has separate `allowedAddresses` and `allowedCidrs` arrays so a CIDR is never
parsed as an exact address. Both may be used in one policy. Each CIDR must use its network address
with no host bits and its complete range must remain within RFC1918 space. Exact entries covered by
a configured CIDR and overlapping CIDRs are rejected to keep policy meaning and receipt digests
unambiguous.

CIDR admission deliberately permits multiple private peers and therefore has a larger blast radius
than exact-address admission. Operators should select the smallest stable range that matches their
WireGuard or trusted-LAN design. Even the narrowest exact address is not an identity and never
removes Passkey/session requirements.

## 5. Ownership matrix

| Resource or decision                                             | Authoritative owner                    | Package authority                                   |
| ---------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------- |
| Private DNS, WireGuard, LAN route, router, firewall              | user/operator                          | inspect and doctor only                             |
| Allowed exact source addresses and CIDRs                         | user intent                            | validate, enforce, report redacted counts           |
| Active ingress selection and exact listener                      | Gateway package under approved receipt | bind, stop, reconfigure, rollback one listener      |
| Certificate/key bytes and renewal                                | user or external job                   | validate and read; never issue or renew             |
| TLS termination and last-known-good context                      | Gateway                                | terminate, validate, hot reload, fail closed        |
| Passkey, browser session, Origin, CSRF, WebSocket authentication | Gateway                                | exclusive enforcement                               |
| Project, Pane and app authorization                              | Naru                                   | authorize a verified Gateway principal              |
| Session, PTY, runtime, sequence and control                      | DurableSession Host                    | owner-only UDS and scoped capability                |
| Immutable release, config and private receipts                   | distribution                           | mutate package-owned resources after fresh approval |
| Production values and acceptance evidence                        | operator-private state                 | never commit to public source/history               |

## 6. Redaction and digest boundary

The owner-only intent and receipt may contain exact private references. Structured logs, public
errors, fixtures, and general diagnostics use the contract's redacted projection: profile, Origin,
listener and paths are replaced by fixed markers, and source policy reports counts only. Raw TLS
material, cookies, authorization values, request bodies, terminal bytes and environment values are
never contract fields.

The intent digest is lowercase SHA-256 over UTF-8 canonical JSON for
`{ purpose: "naru.private-ingress.intent.v0", ingress }`. Object keys are lexically sorted; arrays
preserve order after exact addresses and CIDRs are normalized into numeric order. The digest binds
private references but its preimage is sensitive and must not be logged. PI-05 must additionally
bind operation, immutable artifact/config identity and verified actual-state fingerprint before a
mutation receipt can authorize apply, reconfigure, or rollback.

## 7. Acceptance boundary

PI-01 contract tests prove schema shape, mode separation, generic accepted/rejected fixtures,
redaction, and deterministic intent digest behavior. They do not prove interface ownership, DNS,
TLS validity, socket enforcement, browser authentication, PTY continuity, or production safety.
Those claims require PI-02 through PI-09 and their explicit production approval gates.
