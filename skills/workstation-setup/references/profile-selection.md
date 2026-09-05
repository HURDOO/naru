# Ingress profile selection

Choose profiles independently; a workstation may have zero, one, or several enabled profiles.

| Profile            | v0 transport                                      | Package mutation                                                       | Required ownership                                                              |
| ------------------ | ------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `tailscale-serve`  | Exact HTTPS Origin through a loopback Gateway     | Exact package-owned Serve root route and matching route-level rollback | Tailnet owner enables MagicDNS and HTTPS Certificates and accepts CT disclosure |
| `wireguard-direct` | Exact private listener with TLS and source policy | None; inspect and doctor only                                          | User owns peer, route, firewall, DNS, certificate, and source allowlist         |
| `trusted-lan`      | Exact private listener with TLS and source policy | None; inspect and doctor only                                          | User owns LAN routing, firewall, DNS, certificate, and source allowlist         |

## Tailscale Serve

Use only when Tailscale is already installed and logged into the intended tailnet. The profile must
use a canonical `.ts.net` HTTPS Origin, `loopback-proxy`, `tlsOwner: "tailscale"`, an exact loopback
Gateway upstream, and a resolved `tailscale-loopback` trusted-proxy policy.

Installation and login do not prove HTTPS capability. If doctor or plan reports the HTTPS capability
missing, stop before mutation and return the owner action: enable MagicDNS and HTTPS Certificates in
the Tailscale admin console and review the public Certificate Transparency disclosure. After the
owner completes it, discard the old digest and create a fresh plan.

The workstation package must not change account enrollment, ACLs or grants, node names, global
Serve state, Funnel, or the HTTPS setting itself. Rollback removes only the exact route recorded by
the package ownership manifest and preserves the user-owned HTTPS setting and unrelated routes.

## WireGuard and trusted LAN

Both profiles require an exact private address or verified proxy, exact HTTPS Origin, clear TLS
ownership, and a resolved private-CIDR source policy. They never authorize wildcard/public binds,
plain non-loopback HTTP, router port forwarding, or guessed client identity from an IP address.

The skill may help the user review desired DNS, listener, certificate, route, and allowlist values.
It must not change external network state or call that work complete. Only deterministic doctor
evidence can characterize the configured path, and app-owned authentication remains outside the
network doctor's guarantee for `app-managed` targets.

## Selection questions

- Which exact browser Origin will users type?
- Which application ID owns the route?
- Is the upstream a private Gateway loopback endpoint or a direct private application listener?
- Who owns TLS, the trusted proxy boundary, and the source allowlist?
- Which existing profiles and routes must remain untouched?
- Which user-owned prerequisite or approval is still outstanding?
