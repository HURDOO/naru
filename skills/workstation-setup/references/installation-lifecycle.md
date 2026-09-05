# Installation lifecycle

Use this reference for install, upgrade, resume, reconfigure, readiness, and rollback. The installed
package's help, schema, plan, receipt, and doctor output remain authoritative.

## Transaction boundary

A final v0 lifecycle transaction separates these phases:

1. Read-only preflight for the supported macOS user, artifact-owned Node 24 version/signature,
   native modules, paths and modes, existing instances, labels, ports, Origins, project roots, and
   Tailscale state.
2. An immutable plan listing exact files, directories, credentials, services, routes, bootstrap
   boundaries, rollback effects, actual-state fingerprint, and approval digest.
3. After exact approval, a fresh source verification and atomic private immutable-release stage.
4. A release-local one-shot maintenance handoff, package-owned private state, and credentials.
5. Per-user DurableSession Host, Workstation Gateway, and Naru service installation and readiness.
6. Optional ingress apply and owner passkey enrollment, each under its own authority boundary.
7. End-to-end doctor and ownership-manifest finalization.

Do not collapse these phases into one broad approval. A plan may be reviewed without authorizing any
mutation. A partial transaction must offer deterministic resume or exact rollback; never repair it
with hand-written launchd, file, credential, or network commands.

## Per-user and per-instance isolation

Before proposing a mutation, check that the target instance has distinct:

- owner user and private directory ancestors;
- Host, Gateway, and Naru data, database, socket, credential, and log paths;
- launchd labels, process environment, listener ports, cookie names, and exact Origins;
- shell, Codex home/config/auth, allowed parent roots, and registered Project paths.

Private directories must be owner-only, secret files owner-only regular files, and all managed path
ancestors free of symlink escapes. Do not inspect, stop, overwrite, or reuse another user's instance.
A second-user plan must derive that user's values rather than copy absolute paths from the first
user.

## Install, upgrade, and reconfigure

- Install only immutable versioned artifacts accepted by the live package contract.
- Use the source artifact's Node only for its CLI and the approved verified copy. Before any launchd
  handoff, atomically stage and reverify it under the instance's private immutable release. Require
  the initial maintenance request/plist, all four jobs, and the final receipt to reference that
  release-local Node; never persist a Documents/Downloads source path.
- Treat the source directory as a transport location. Bind approval to artifact identity,
  destination, settings, and actual state, and do not call an unreferenced staged release installed
  until the ownership receipt exists.
- Do not install Node separately, reuse another application's embedded runtime, run npm on the
  target, or mutate PATH/shell startup files. An external `--node` is legacy migration only.
- Resume only when the plan and actual state still match the transaction receipt.
- Upgrade must preserve the previous immutable rollback receipt until the new installation passes
  readiness and doctor.
- Reconfigure or supersede requires a new plan and digest. Do not edit an old receipt or mutate
  active configuration behind the transaction model.
- Distinguish an allowed parent directory from a Project that has actually been registered and
  passed root policy.

If the package reports a conflict with an existing Naru service, route, port, Origin, or another
instance, stop. Never adopt, rename, terminate, or overwrite it by inference.

## Readiness and rollback

Readiness proves that each installed process can accept its intended private operation; it does not
prove ingress, authentication, application authorization, or Session continuity. Final doctor must
report those layers separately.

### Mobile PWA and Push acceptance

Treat mobile browser acceptance as a user-observed layer after service, exact-Origin, and ingress
doctor checks. On Android Chrome, full-screen launch from a home-screen shortcut is not proof of an
installed WebAPK; require the user to confirm OS-level installation and standalone launch. Record
Push separately only after the user grants notification permission and confirms a test delivery.
Use only safe aggregate server evidence and never inspect subscription endpoints or private browser
state.

If Android Chrome falls back to a shortcut, keep the approved Origin, port, Tailscale route, and
Gateway pre-auth policy unchanged while checking the rendered manifest/worker/icon contract. A
known public installable PWA on the same device is a useful external control: if it also fails or
recovers after a VPN/connectivity-state change, retry the private Origin with the intended ingress
active and classify the earlier result as external or transient unless stronger evidence proves an
instance defect. A single fallback does not authorize site-data deletion, public app assets, Origin
or port changes, or another security relaxation.

Rollback removes only artifacts named in the package-owned receipt and only while its preconditions
still match. It must preserve other instances, user-owned Tailscale settings and routes, registered
Projects, and unrelated services. A stale or missing receipt is a blocked manual-review state, not a
reason to delete broadly.

## Current repository boundary

The current T14 artifact exposes `intent`, lifecycle `plan`, `install|upgrade|reconfigure|rollback`,
full-workstation `doctor`, and local `auth bootstrap|recover` through packaged `workstation`. It does
not expose `workstation init` or `app register`. Use only the commands proven by installed help and
schemas, and report any newer or missing surface as contract drift.
