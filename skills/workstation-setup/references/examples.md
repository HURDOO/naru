# Setup examples

All values below are fake. Use them to shape a plan, never as authority to mutate a machine.

## Final lifecycle plan review

When a packaged T14 installer becomes available, first obtain its read-only plan. The review should
identify the current macOS user and instance, exact artifact version, Node 24 source, private paths,
service labels, ports, Origins, registered roots, file and credential effects, partial-state handling,
rollback receipt, and each separate approval boundary. If the installed tool cannot emit those
facts, report a packaging gap; do not replace the transaction with shell commands.

For a final artifact, “Node 24 source” means its pinned manifest entry and packaged executable, not a
user-installed or another application's Node. The review should show the source as transport/CLI and
the installed release as the only launchd path. If a new packaged artifact points initial maintenance
at Documents/Downloads, asks for Full Disk Access, `--node`, npm, Homebrew, PATH, or shell-rc changes,
stop and report contract drift.

For an upgrade or reconfigure request, retain the existing immutable receipt, compare actual state,
and require a new plan digest. A request to change one instance never authorizes stopping or adopting
another user's or production service.

## Plan-only Tailscale review

1. Confirm that the intended profile is `tailscale-serve` and preserves every existing profile.
2. Validate the private JSON configuration against the live schema.
3. Run only:

   ```text
   workstation-network plan --config /absolute/private/workstation-network.json --profile tailscale-main --json
   ```

4. Present `status`, checks, `approvalBoundaries`, and `planDigest` without applying it.
5. If `tailscale.https-capability` is blocked, ask the tailnet owner to complete the MagicDNS,
   HTTPS Certificates, and CT disclosure decision personally. Do not open the consent page or retry
   apply. Afterward, generate a new plan.

## WireGuard review

For an existing WireGuard path, document the exact HTTPS Origin, private listener, TLS owner, and
private-CIDR source policy. Run `status` and `doctor` only. Report DNS, router, firewall, peer, or
certificate work as user-owned prerequisites; there is no v0 WireGuard apply operation.

## Post-change proof

An authorized apply result is provisional. Run:

```text
workstation-network doctor --config /absolute/private/workstation-network.json --json
```

Report all profile and layer statuses. If Gateway is unavailable while Host is healthy, state both
facts and do not call the remote workstation ready.

This current command proves only the network doctor's implemented layers. Final installation,
service, passkey, application authorization, and second-user proof remain unavailable until the
packaged full-workstation doctor exposes them.

## Owner recovery review

After live packaged help proves an auth-recovery operation exists, present the exact local user,
instance, canonical HTTPS Origin, expiry, and single-use behavior before requesting authorization to
create an intent. The user handles the raw code and authenticator interaction. The agent records only
redacted status and waits for full doctor evidence; it does not paste the code into a command, URL,
fixture, log, or chat response.
