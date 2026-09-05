# Runtime contract and source map

Use live machine output and exported schemas as the source of truth. The paths below are the
authoring sources for this repository version:

- [`networkUsage` and argument parser](../../../apps/workstation-gateway/src/ingress/network-cli.ts)
- [strict workstation network config schema](../../../apps/workstation-gateway/src/ingress/config.ts)
- [versioned ingress profile schema](../../../packages/contracts/src/workstation-gateway/v1/index.ts)
- [plan, status, mutation, and doctor result model](../../../apps/workstation-gateway/src/ingress/model.ts)
- [bounded Tailscale adapter](../../../apps/workstation-gateway/src/ingress/tailscale.ts)
- [Gateway private admin operations](../../../apps/workstation-gateway/src/admin-server.ts)
- [distribution lifecycle and auth argument parser](../../../ops/workstation/distribution/cli.ts)
- [same-user auth admin transport](../../../ops/workstation/distribution/auth.ts)
- [Session CLI help](../../../apps/cli/src/help.ts)
- [approved final installation lifecycle](../../../docs/workstation-v0/ARCHITECTURE.md)

If these sources are unavailable in an installed distribution, use its packaged schema and CLI
usage. If neither exists, report the missing contract and stop.

## Current executable surface

The current package has two deterministic JSON CLIs. The distribution lifecycle surface is:

```text
EXPANDED_ARTIFACT/runtime/node/bin/node EXPANDED_ARTIFACT/bin/workstation.mjs intent --slug LABEL --artifact EXPANDED_ARTIFACT --origin HTTPS_ORIGIN --project-root ALLOWED_PARENT --shell SHELL --codex CODEX --json
EXPANDED_ARTIFACT/runtime/node/bin/node EXPANDED_ARTIFACT/bin/workstation.mjs plan --intent PRIVATE_INTENT --operation install|upgrade|reconfigure|rollback [--target-receipt UUID] --json
EXPANDED_ARTIFACT/runtime/node/bin/node EXPANDED_ARTIFACT/bin/workstation.mjs doctor --intent PRIVATE_INTENT --json
EXPANDED_ARTIFACT/runtime/node/bin/node EXPANDED_ARTIFACT/bin/workstation.mjs install|upgrade|reconfigure --intent PRIVATE_INTENT --approve-digest SHA256 --json
EXPANDED_ARTIFACT/runtime/node/bin/node EXPANDED_ARTIFACT/bin/workstation.mjs rollback --intent PRIVATE_INTENT --target-receipt UUID --approve-digest SHA256 --json
EXPANDED_ARTIFACT/runtime/node/bin/node EXPANDED_ARTIFACT/bin/workstation.mjs auth bootstrap|recover --intent PRIVATE_INTENT --json
```

The final artifact manifest pins the Node release, source archive SHA-256, executable and upstream
license paths, and exact executable SHA-256. A new packaged artifact derives `nodeExecutable` from that manifest and rejects an
external `--node` override. It does not download or install Node on the target, register Node in PATH,
or run npm. Source-artifact Node runs the CLI and approved copy only. The mutation revalidates the
source, atomically stages and reverifies it under the private immutable release, and only then writes
a maintenance plist/request that reference the release-local Node, entrypoint, and working directory.
Host, Gateway, Naru, maintenance and the receipt all use that release. A transport path under
Documents/Downloads must never be persisted in launchd state. The optional `--node` parser surface
exists only for old external-runtime artifacts and receipts.

If strict Node `codesign` fails, first require the executable hash to match the manifest and test
`/usr/bin/true` with the same verifier. A valid system control plus failed Node is blocking. If the
control also fails because the current context cannot access system trust, preserve an
`exact-hash-fallback` warning and require separate user review; do not call the signature valid or
skip the later launchd/readiness proof.

`auth bootstrap|recover` derives the instance from the owner-only intent and calls only its
same-user mode-`0600` Gateway admin UDS. The user runs it directly and keeps the returned one-time
code out of plans, chat, files, logs, and browser storage. The ingress surface is:

```text
workstation-network plan --config PRIVATE_JSON --profile ID --json
workstation-network plan --config PRIVATE_JSON --profile ID --operation rollback --json
workstation-network status --config PRIVATE_JSON --json
workstation-network doctor --config PRIVATE_JSON --json
workstation-network apply --config PRIVATE_JSON --profile ID --approve-digest SHA256 --json
workstation-network rollback --config PRIVATE_JSON --profile ID --approve-digest SHA256 --json
```

`plan`, `status`, and `doctor` are read-only. `status` and `doctor` report all configured profiles and
do not accept `--profile`. `apply` and `rollback` require a digest from a reviewed ready plan and
re-read actual state before mutation. A top-level `blocked` result exits 4, `unavailable` exits 3,
and CLI or schema errors exit 2.

Do not run a guessed `--help` flow: this source version publishes usage through invalid-invocation
diagnostics and the exported network `networkUsage()` function. The current package still does not
expose `workstation init` or `app register`. Treat an absent operation as a packaging gap rather than
calling Gateway admin endpoints directly or synthesizing shell steps. `ops/workstation/baseline`
remains characterization evidence. Prefer installed package behavior over this authoring reference
and stop on drift.

## Configuration shape

`WorkstationNetworkConfigSchema` requires version 1, an instance ID, private ownership directory,
absolute Tailscale executable, resolved proxy/source policies, optional target probes, and an array
of versioned ingress profiles. Inclusion in that array means enabled.

Each profile carries its own ID, kind, target app, exact browser Origin, transport, endpoint, TLS
owner, and optional trusted-proxy/source policy. The schema and pure policy reject duplicate or
conflicting ownership and unresolved policies before any operation runs.

## Result interpretation

A plan includes `status`, `planDigest`, `stateFingerprint`, checks, approval boundaries, and at most
one exact action. `ready` is eligible for separate approval; `noop`, `blocked`, and `unavailable` are
not permission to improvise.

Doctor reports `configuration`, `ownership`, `listener`, `ingress`, `tls-origin`, `gateway`, `app`,
and `host` layers independently. Preserve that distinction in the final report.

The local `durable-session` CLI is a Gateway-independent recovery surface for an already registered
same-user Host client. It is not a remote-auth bypass or a workstation installer; use the dedicated
`durable-session` skill for its live Session operations.
