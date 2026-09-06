# Private Ingress v0 release acceptance

## Purpose and evidence boundary

PI-06 fixes a reproducible public-source gate for a production staging candidate. It does not
install that candidate, change an operator network, or perform external-device acceptance. Exact
instance configuration, command output, private topology, and acceptance evidence stay in an
owner-private release record outside the repository. Public source records only the generic matrix,
commands, and redacted pass/fail summary.

The isolated continuity scenario uses temporary private data and configuration, dynamically
allocated loopback ports, a generic fixture identity, and an actual Node 24 `node-pty` runtime. It
opens no private-interface or public listener and creates no launchd label. Distribution tests render
separate fixture labels and receipts through the fake package runtime without mutating launchd,
Tailscale, DNS, routes, firewall, router, or certificate state.

## Required matrix

| Boundary                           | Release evidence                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Contract and mode separation       | PrivateIngress accepted/rejected vectors; strict Gateway v1/v2 and loopback/direct union tests                                            |
| Listener and source admission      | exact private bind lifecycle; wildcard/public/IPv6 rejection; denied actual TLS sockets never dispatch HTTP or WSS                        |
| Host, Origin, and identity headers | exact authority and unsafe-Origin tests; forwarding/assertion/capability spoof rejection and upstream sanitization                        |
| Authentication and bounded work    | Passkey/session/CSRF/WS tests; source/global authentication rate limits; header/body/message/queue/timeout limits                         |
| TLS material lifecycle             | canonical path/owner/mode/SAN/key-pair/expiry validation; valid rotation, rejected rotation, last-known-good expiry and recovery          |
| HTTP and WSS chain                 | authenticated direct TLS HTTP/WSS integration and Gateway-to-Naru signed-principal proxy integration                                      |
| Actual PTY continuity              | isolated Gateway and Naru restart acceptance retains one Host `sessionId`, `runtimeId`, increasing terminal sequence, and live WSS output |
| Distribution transaction           | private intent/config/artifact/state digest, stale approval rejection, owner-only receipt, redacted status/doctor, v1/v2 rollback         |
| Public exposure and ownership      | public DNS answer rejection, direct candidate with no Funnel route, no public/wildcard bind, and no package authority for port forwarding |
| Public artifact                    | clean committed source, pinned source commit and Node runtime, verified manifest/payload/archive SHA-256, deterministic rebuild           |

An abnormal WebSocket close code from either side must be normalized to a valid proxy failure code.
Service restart must not raise an uncaught close-frame error or terminate the Host runtime.

## Node 24 verification gate

All commands run with Node.js 24 LTS and pnpm 11.12.0.

```text
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm test:operations
pnpm workstation:distribution:test
pnpm test:production-smoke
pnpm test:private-ingress-acceptance
pnpm audit:security
pnpm public:scan
```

The release record also captures a successful native Node 24 preflight, Git integrity check, clean
status, and a manual review of the complete candidate diff. The optional public-scan denylist is used
when an operator supplies it; its contents and matches are never printed.

## Artifact identity and reproducibility

Build the final clean commit twice with the same public build ID and the pinned official
darwin-arm64 Node archive, using two new private output parents outside the repository. Both builds
must return the exact source commit, lockfile SHA-256, manifest digest, payload digest, and archive
SHA-256. The archive bytes must compare equal. A mismatch rejects the candidate rather than choosing
one output.

The accepted five-value identity is copied to the owner-private release record. A later PI-07 plan
must bind its rendered Gateway configuration digest to that same source and artifact identity.

## Public-exposure confirmation boundary

PI-06 confirms that the candidate source and artifact cannot select a wildcard/public listener,
reject public or IPv6 DNS answers, contain no direct-profile Funnel activation, and expose no command
that configures DNS, VPN, routes, firewall, router, or port forwarding. Its live restart scenario is
loopback-only.

Router port-forwarding state cannot be authoritatively observed from this package. Its absence is an
operator-owned external-state assertion and remains a mandatory PI-07 preflight and actual-device
acceptance item. PI-06 must not broaden its authority or probe a router to manufacture that evidence.

## Candidate rejection and rollback

- Before PI-07, a failed gate rejects the artifact and performs no runtime rollback because PI-06
  installs nothing.
- PI-07 stages only the accepted pinned candidate in a separate namespace, data/config paths,
  labels, and non-canonical port. Failure stops that package-owned candidate and leaves the existing
  deployment unchanged.
- PI-08 rollback uses the previous immutable receipt and listener. Existing service, data, source
  admission, and rollback material remain through the approved soak period.
- Remote push, release publication, production admission, staging, and cutover each require their
  separately documented approval.
