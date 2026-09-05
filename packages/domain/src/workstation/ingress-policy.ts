import type { IngressProfileV0 } from "@naru/contracts/workstation-gateway/v1";

export type IngressPolicyIssueCode =
  | "PROFILE_ID_CONFLICT"
  | "ORIGIN_CONFLICT"
  | "CERTIFICATE_CONFLICT"
  | "LISTENER_CONFLICT"
  | "TAILSCALE_ORIGIN_INVALID"
  | "TAILSCALE_TRANSPORT_INVALID"
  | "TAILSCALE_TLS_OWNER_INVALID"
  | "TAILSCALE_UPSTREAM_INVALID"
  | "TAILSCALE_PROXY_POLICY_REQUIRED"
  | "DIRECT_TRANSPORT_INVALID"
  | "DIRECT_TLS_OWNER_INVALID"
  | "DIRECT_LISTENER_INVALID"
  | "DIRECT_SOURCE_POLICY_REQUIRED"
  | "TRUSTED_PROXY_POLICY_UNEXPECTED";

export interface IngressPolicyIssue {
  readonly code: IngressPolicyIssueCode;
  readonly profileIds: readonly string[];
  readonly field: string;
  readonly message: string;
}

export interface IngressConflictKey {
  readonly origin: string;
  readonly certificate: string;
  readonly listener: string;
}

export interface NormalizedIngressProfile {
  readonly profile: IngressProfileV0;
  readonly originHostname: string;
  readonly originPort: number;
  readonly upstream?: { readonly hostname: string; readonly port: number };
  readonly directListener?: { readonly address: string; readonly port: number };
  readonly conflictKey: IngressConflictKey;
}

export interface IngressPolicyAnalysis {
  readonly profiles: readonly NormalizedIngressProfile[];
  readonly issues: readonly IngressPolicyIssue[];
}

export function analyzeIngressProfiles(
  profiles: readonly IngressProfileV0[],
): IngressPolicyAnalysis {
  const issues: IngressPolicyIssue[] = [];
  const normalized: NormalizedIngressProfile[] = [];

  for (const profile of profiles) {
    const browserOrigin = new URL(profile.browserOrigin);
    const originPort = effectiveOriginPort(browserOrigin);
    let upstream: NormalizedIngressProfile["upstream"];
    let directListener: NormalizedIngressProfile["directListener"];

    if (profile.kind === "tailscale-serve") {
      if (!browserOrigin.hostname.toLowerCase().endsWith(".ts.net")) {
        issues.push(
          issue(
            "TAILSCALE_ORIGIN_INVALID",
            profile,
            "browserOrigin",
            "A tailscale-serve profile requires a canonical .ts.net HTTPS Origin.",
          ),
        );
      }
      if (profile.transport !== "loopback-proxy") {
        issues.push(
          issue(
            "TAILSCALE_TRANSPORT_INVALID",
            profile,
            "transport",
            "A tailscale-serve profile must use loopback-proxy transport.",
          ),
        );
      }
      if (profile.tlsOwner !== "tailscale") {
        issues.push(
          issue(
            "TAILSCALE_TLS_OWNER_INVALID",
            profile,
            "tlsOwner",
            "Tailscale must own TLS for a tailscale-serve profile.",
          ),
        );
      }
      upstream = parseLoopbackHttpOrigin(profile.bindOrUpstream);
      if (upstream === undefined) {
        issues.push(
          issue(
            "TAILSCALE_UPSTREAM_INVALID",
            profile,
            "bindOrUpstream",
            "Tailscale Serve must proxy to an exact credential-free loopback HTTP origin.",
          ),
        );
      }
      if (profile.trustedProxyPolicy === undefined) {
        issues.push(
          issue(
            "TAILSCALE_PROXY_POLICY_REQUIRED",
            profile,
            "trustedProxyPolicy",
            "A tailscale-serve profile requires an explicit trusted proxy policy reference.",
          ),
        );
      }
    } else {
      if (profile.transport !== "direct-private-listener") {
        issues.push(
          issue(
            "DIRECT_TRANSPORT_INVALID",
            profile,
            "transport",
            "WireGuard and trusted-LAN profiles must use a direct private listener.",
          ),
        );
      }
      if (profile.tlsOwner === "tailscale") {
        issues.push(
          issue(
            "DIRECT_TLS_OWNER_INVALID",
            profile,
            "tlsOwner",
            "Tailscale cannot own TLS for a direct WireGuard or trusted-LAN listener.",
          ),
        );
      }
      directListener = parseDirectPrivateListener(profile.bindOrUpstream);
      if (directListener === undefined) {
        issues.push(
          issue(
            "DIRECT_LISTENER_INVALID",
            profile,
            "bindOrUpstream",
            "A direct listener must be an exact private IP address and TCP port, never a wildcard or public address.",
          ),
        );
      }
      if (profile.sourcePolicy === undefined) {
        issues.push(
          issue(
            "DIRECT_SOURCE_POLICY_REQUIRED",
            profile,
            "sourcePolicy",
            "A direct WireGuard or trusted-LAN listener requires an explicit source policy reference.",
          ),
        );
      }
      if (profile.trustedProxyPolicy !== undefined) {
        issues.push(
          issue(
            "TRUSTED_PROXY_POLICY_UNEXPECTED",
            profile,
            "trustedProxyPolicy",
            "A direct-private-listener profile must not claim a trusted proxy boundary.",
          ),
        );
      }
    }

    const listener =
      directListener === undefined
        ? upstream === undefined
          ? `invalid:${profile.bindOrUpstream}`
          : `tcp:${formatHostPort(upstream.hostname, upstream.port)}`
        : `tcp:${formatHostPort(directListener.address, directListener.port)}`;
    normalized.push({
      profile,
      originHostname: browserOrigin.hostname.toLowerCase(),
      originPort,
      ...(upstream === undefined ? {} : { upstream }),
      ...(directListener === undefined ? {} : { directListener }),
      conflictKey: {
        origin: browserOrigin.origin.toLowerCase(),
        certificate: `${browserOrigin.hostname.toLowerCase()}:${originPort}`,
        listener,
      },
    });
  }

  addPairwiseConflicts(normalized, issues);
  return { profiles: normalized, issues };
}

export function assertIngressProfilesSafe(
  profiles: readonly IngressProfileV0[],
): readonly NormalizedIngressProfile[] {
  const analysis = analyzeIngressProfiles(profiles);
  if (analysis.issues.length > 0) {
    const summary = analysis.issues.map((entry) => `${entry.code}:${entry.profileIds.join(",")}`);
    throw new Error(`Ingress profiles are unsafe: ${summary.join("; ")}`);
  }
  return analysis.profiles;
}

export function effectiveOriginPort(origin: URL): number {
  if (origin.protocol !== "https:") {
    throw new Error("Ingress browser Origin must use HTTPS.");
  }
  if (origin.port === "") return 443;
  const port = Number(origin.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Ingress browser Origin has an invalid port.");
  }
  return port;
}

export function isPrivateIpAddress(value: string): boolean {
  if (isIpv4Address(value)) {
    const octets = value.split(".").map(Number);
    const first = octets[0];
    const second = octets[1];
    if (first === undefined || second === undefined) return false;
    return (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      first === 127
    );
  }
  if (isIpv6Address(value)) {
    const lower = value.toLowerCase();
    return (
      lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || isLinkLocalV6(lower)
    );
  }
  return false;
}

function isIpv4Address(value: string): boolean {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)
  );
}

function isIpv6Address(value: string): boolean {
  if (!value.includes(":") || !/^[0-9A-Fa-f:.]+$/.test(value)) return false;
  try {
    return new URL(`http://[${value}]/`).hostname !== "";
  } catch {
    return false;
  }
}

function addPairwiseConflicts(
  profiles: readonly NormalizedIngressProfile[],
  issues: IngressPolicyIssue[],
): void {
  for (let leftIndex = 0; leftIndex < profiles.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < profiles.length; rightIndex += 1) {
      const left = profiles[leftIndex];
      const right = profiles[rightIndex];
      if (left === undefined || right === undefined) continue;
      if (left.profile.id === right.profile.id) {
        issues.push(
          conflict("PROFILE_ID_CONFLICT", left, right, "id", "Profile IDs must be unique."),
        );
      }
      if (left.conflictKey.origin === right.conflictKey.origin) {
        issues.push(
          conflict(
            "ORIGIN_CONFLICT",
            left,
            right,
            "browserOrigin",
            "Two ingress profiles cannot own the same exact browser Origin.",
          ),
        );
      }
      if (
        left.conflictKey.certificate === right.conflictKey.certificate &&
        left.profile.tlsOwner !== right.profile.tlsOwner
      ) {
        issues.push(
          conflict(
            "CERTIFICATE_CONFLICT",
            left,
            right,
            "tlsOwner",
            "Profiles disagree about the TLS owner for the same certificate endpoint.",
          ),
        );
      }
      if (
        left.conflictKey.listener === right.conflictKey.listener &&
        (left.profile.transport === "direct-private-listener" ||
          right.profile.transport === "direct-private-listener")
      ) {
        issues.push(
          conflict(
            "LISTENER_CONFLICT",
            left,
            right,
            "bindOrUpstream",
            "Profiles disagree about ownership of the same listener.",
          ),
        );
      }
    }
  }
}

function parseLoopbackHttpOrigin(
  value: string,
): { readonly hostname: string; readonly port: number } | undefined {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "http:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.port === "" ||
      (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]")
    ) {
      return undefined;
    }
    return {
      hostname: parsed.hostname === "[::1]" ? "::1" : parsed.hostname,
      port: Number(parsed.port),
    };
  } catch {
    return undefined;
  }
}

function parseDirectPrivateListener(
  value: string,
): { readonly address: string; readonly port: number } | undefined {
  if (value.includes("://") || /[\0\r\n]/.test(value)) return undefined;
  try {
    const parsed = new URL(`tcp://${value}`);
    if (
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.port === ""
    ) {
      return undefined;
    }
    const address = parsed.hostname.startsWith("[")
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535 || !isPrivateIpAddress(address)) {
      return undefined;
    }
    return { address, port };
  } catch {
    return undefined;
  }
}

function issue(
  code: IngressPolicyIssueCode,
  profile: IngressProfileV0,
  field: string,
  message: string,
): IngressPolicyIssue {
  return { code, profileIds: [profile.id], field, message };
}

function conflict(
  code: IngressPolicyIssueCode,
  left: NormalizedIngressProfile,
  right: NormalizedIngressProfile,
  field: string,
  message: string,
): IngressPolicyIssue {
  return { code, profileIds: [left.profile.id, right.profile.id], field, message };
}

function formatHostPort(hostname: string, port: number): string {
  return hostname.includes(":") ? `[${hostname}]:${port}` : `${hostname}:${port}`;
}

function isLinkLocalV6(value: string): boolean {
  const first = Number.parseInt(value.slice(0, 4), 16);
  return Number.isInteger(first) && first >= 0xfe80 && first <= 0xfebf;
}
