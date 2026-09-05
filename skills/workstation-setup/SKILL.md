---
name: workstation-setup
description: Plan, inspect, and verify installation, reconfiguration, recovery, and private ingress for a per-user Private Agent Workstation on supported macOS. Use for workstation lifecycle work; do not use for live DurableSession control, application code integration, production Naru deployment, Linux, or Raspberry Pi.
---

# Workstation Setup

Treat the executable contract as authoritative:

> Skill proposes. Deterministic CLI applies. Doctor proves.

## Start with the live contract and one instance

1. Identify the installed artifact or repository checkout, current macOS user, and exact workstation
   instance. Do not infer another user's paths or reuse production identifiers.
2. Read packaged help and machine schemas before proposing commands. In this repository, use the
   source map in [references/runtime-contract.md](references/runtime-contract.md).
3. If installed help, schemas, or exported operations differ from the reference, stop and report
   contract drift. Never repair the gap with a guessed command or shell mutation.
4. Keep every instance's data, sockets, credentials, labels, listeners, cookie names, Origins, and
   project roots separate from other users and production.

The final artifact owns its pinned Node 24 runtime. Invoke the packaged CLI with the artifact's
`runtime/node/bin/node`; do not ask the target user to install Node, borrow another application's
embedded Node, or modify global/user PATH or shell startup files. The source artifact Node may run
the CLI and approved verified copy only. Before writing a launchd plist or request, the package must
atomically stage and reverify the artifact in its private immutable release; the first maintenance
handoff and every installed service run from that release. Treat an external `--node` as
legacy-artifact compatibility only.

The current T14 artifact exposes the distribution lifecycle and doctor through packaged
`workstation`, local `auth bootstrap|recover`, and ingress through `workstation-network`. It does not
expose the target-v0 `workstation init` or `app register` commands. Do not present absent names as
executable unless newer packaged help proves they exist. The baseline installer remains
characterization evidence, not the final package.

## Route the workstation lifecycle

- For install, upgrade, resume, reconfigure, service readiness, or rollback, read
  [references/installation-lifecycle.md](references/installation-lifecycle.md).
- For owner passkey bootstrap or recovery, read
  [references/owner-auth.md](references/owner-auth.md).
- For Tailscale Serve, WireGuard, or trusted-LAN selection, read
  [references/profile-selection.md](references/profile-selection.md).
- For an already installed Session's `run`, `watch`, `attach`, `control`, or `stop`, use the
  `durable-session` skill instead. For application code and verifier work, use `gateway-app`.

Begin with read-only preflight, plan, status, or doctor operations. Record expected and actual state
separately. A missing package operation is a contract gap, not permission to hand-create services,
credentials, configuration, or ownership manifests.

## Select an ingress profile

- Profiles are additive. Adding Tailscale must not replace an existing WireGuard or trusted-LAN
  profile.
- Tailscale Serve is the only v0 profile with package-owned network apply and rollback.
- WireGuard and trusted LAN are inspect/doctor-only. DNS, router, firewall, peer, and certificate
  changes remain user-owned external work.
- Reject Funnel, public or wildcard binds, non-loopback plain HTTP, ambiguous proxy trust, and
  conflicting route, port, Origin, certificate, or auth ownership.

## Plan before each mutation

Use the exact installed schema and read-only planning operation. Show the user the instance, selected
profile or lifecycle phase, exact targets, checks, risks, rollback, approval boundaries, state
fingerprint, and digest. Do not treat approval of a discussion, a different phase, or an old digest
as approval to apply.

For Tailscale HTTPS, the tailnet owner must personally enable MagicDNS and HTTPS Certificates and
acknowledge that machine and tailnet DNS names enter public Certificate Transparency logs. Never
open, accept, or automate that account-level consent. A capability change invalidates the old
digest; inspect state and create a fresh plan.

## Mutate only after fresh authorization

- Ask immediately before each install, service, listener, ingress, credential, `apply`, reconfigure,
  or rollback mutation, showing the exact reviewed digest and effects.
- Do not retry a blocked, unavailable, timed-out, or drifted operation by broadening the command.
- Never run Tailscale install/login/account/ACL/node-name changes, Funnel, `serve reset`, global
  Serve replacement, or WireGuard/LAN network mutation.
- Treat service installation, listener startup, passkey enrollment, and another macOS user's state
  as separate approval boundaries.

Read [references/examples.md](references/examples.md) when composing a plan or interpreting a
blocked result. Examples contain fake values and are not approval to execute them.

## Prove the result

After an authorized lifecycle mutation, require packaged `workstation doctor --json`; after ingress
mutation, also require `workstation-network doctor --json`. Report each profile and layer as `ok`,
`warning`, `blocked`, or `unavailable`; never collapse a healthy Host and unavailable remote ingress
into a green result. Do not claim setup success from a zero exit code, an apply response, a reachable
page, or a partial health check alone.

Redact credentials, one-time codes, cookies, assertions, terminal content, and private user data from
plans, logs, and reports. Never use production Naru operations as a setup shortcut.
