import { z } from "zod";

export const PRIVATE_INGRESS_V0_CONTRACT_VERSION = "private-ingress.v0" as const;
export const PRIVATE_INGRESS_V0_DIGEST_ALGORITHM = "sha256" as const;
export const PRIVATE_INGRESS_V0_DIGEST_PURPOSE = "naru.private-ingress.intent.v0" as const;

export const PRIVATE_INGRESS_V0_LIMITS = {
  identifierCharacters: 128,
  originCharacters: 2_048,
  pathCharacters: 4_096,
  sourceEntries: 128,
} as const;

const IPV4_OCTET_PATTERN = "(?:25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)";
const PRIVATE_IPV4_SOURCE = `(?:10\\.${IPV4_OCTET_PATTERN}\\.${IPV4_OCTET_PATTERN}\\.${IPV4_OCTET_PATTERN}|172\\.(?:1[6-9]|2\\d|3[01])\\.${IPV4_OCTET_PATTERN}\\.${IPV4_OCTET_PATTERN}|192\\.168\\.${IPV4_OCTET_PATTERN}\\.${IPV4_OCTET_PATTERN})`;
const PRIVATE_IPV4_PATTERN = new RegExp(`^${PRIVATE_IPV4_SOURCE}$`);
const PRIVATE_IPV4_CIDR_PATTERN = new RegExp(`^${PRIVATE_IPV4_SOURCE}/(?:0|[1-9]\\d?)$`);

const PrivateIngressIdentifierSchema = z
  .string()
  .min(1)
  .max(PRIVATE_INGRESS_V0_LIMITS.identifierCharacters)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const PrivateIngressExactHttpsOriginSchema = z
  .string()
  .min(1)
  .max(PRIVATE_INGRESS_V0_LIMITS.originCharacters)
  .regex(
    /^https:\/\/(?!localhost(?::|$))(?![0-9.]+(?::|$))[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[1-9]\d{0,4})?$/,
  )
  .refine(
    isExactHostnameHttpsOrigin,
    "Origin must be one canonical credential-free hostname HTTPS origin.",
  );

export const PrivateIpv4AddressSchema = z
  .string()
  .regex(PRIVATE_IPV4_PATTERN)
  .refine(isPrivateIpv4Address, "Address must be one canonical RFC1918 IPv4 address.");

export const PrivateIpv4CidrSchema = z
  .string()
  .regex(PRIVATE_IPV4_CIDR_PATTERN)
  .refine(isPrivateIpv4Cidr, "CIDR must be one canonical RFC1918 IPv4 network.");

const CanonicalAbsolutePathSchema = z
  .string()
  .min(1)
  .max(PRIVATE_INGRESS_V0_LIMITS.pathCharacters)
  .refine(isCanonicalAbsolutePath, "Path must be a canonical absolute path.");

export const PrivateIngressSourcePolicyV0Schema = z
  .strictObject({
    mode: z.literal("private-ipv4-allowlist"),
    allowedAddresses: z
      .array(PrivateIpv4AddressSchema)
      .max(PRIVATE_INGRESS_V0_LIMITS.sourceEntries),
    allowedCidrs: z.array(PrivateIpv4CidrSchema).max(PRIVATE_INGRESS_V0_LIMITS.sourceEntries),
  })
  .superRefine((policy, context) => {
    const entryCount = policy.allowedAddresses.length + policy.allowedCidrs.length;
    if (entryCount < 1 || entryCount > PRIVATE_INGRESS_V0_LIMITS.sourceEntries) {
      context.addIssue({
        code: "custom",
        path: [],
        message: `Source policy must contain 1-${PRIVATE_INGRESS_V0_LIMITS.sourceEntries} entries.`,
      });
    }

    addDuplicateIssues(policy.allowedAddresses, "allowedAddresses", context);
    addDuplicateIssues(policy.allowedCidrs, "allowedCidrs", context);

    const ranges = policy.allowedCidrs.flatMap((cidr, index) =>
      isPrivateIpv4Cidr(cidr) ? [{ index, ...privateIpv4CidrRange(cidr) }] : [],
    );
    for (let left = 0; left < ranges.length; left += 1) {
      for (let right = left + 1; right < ranges.length; right += 1) {
        const first = ranges[left];
        const second = ranges[right];
        if (
          first !== undefined &&
          second !== undefined &&
          first.start <= second.end &&
          second.start <= first.end
        ) {
          context.addIssue({
            code: "custom",
            path: ["allowedCidrs", second.index],
            message: "Source CIDR entries must not overlap.",
          });
        }
      }
    }

    for (const [index, address] of policy.allowedAddresses.entries()) {
      const numeric = parseCanonicalIpv4(address);
      if (
        numeric !== undefined &&
        ranges.some((range) => numeric >= range.start && numeric <= range.end)
      ) {
        context.addIssue({
          code: "custom",
          path: ["allowedAddresses", index],
          message: "An exact source address must not duplicate an allowed CIDR.",
        });
      }
    }
  });

export type PrivateIngressSourcePolicyV0 = z.infer<typeof PrivateIngressSourcePolicyV0Schema>;

export const PrivateIngressTlsV0Schema = z
  .strictObject({
    approvedRoot: CanonicalAbsolutePathSchema,
    certificateFile: CanonicalAbsolutePathSchema,
    privateKeyFile: CanonicalAbsolutePathSchema,
    reload: z.literal("watch-last-known-good"),
    materialOwner: z.literal("user"),
    renewalOwner: z.enum(["user", "external"]),
    terminationOwner: z.literal("gateway"),
  })
  .superRefine((tls, context) => {
    if (tls.approvedRoot === "/") {
      context.addIssue({
        code: "custom",
        path: ["approvedRoot"],
        message: "TLS approved root must not be the filesystem root.",
      });
    }
    for (const field of ["certificateFile", "privateKeyFile"] as const) {
      if (!isStrictPathChild(tls.approvedRoot, tls[field])) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "TLS material path must be a strict child of approvedRoot.",
        });
      }
    }
    if (tls.certificateFile === tls.privateKeyFile) {
      context.addIssue({
        code: "custom",
        path: ["privateKeyFile"],
        message: "Certificate and private key must use different files.",
      });
    }
  });

export type PrivateIngressTlsV0 = z.infer<typeof PrivateIngressTlsV0Schema>;

export const LoopbackProxyIngressV0Schema = z.strictObject({
  kind: z.literal("loopback-proxy"),
  network: z.enum(["tailscale-serve", "trusted-proxy"]),
  listenHost: z.literal("127.0.0.1"),
  listenPort: z.number().int().min(1).max(65_535),
});

export type LoopbackProxyIngressV0 = z.infer<typeof LoopbackProxyIngressV0Schema>;

export const PrivateIngressV0Schema = z
  .strictObject({
    contractVersion: z.literal(PRIVATE_INGRESS_V0_CONTRACT_VERSION),
    profileId: PrivateIngressIdentifierSchema,
    kind: z.literal("direct-private-tls"),
    network: z.enum(["wireguard-direct", "trusted-lan"]),
    browserOrigin: PrivateIngressExactHttpsOriginSchema,
    listener: z.strictObject({
      host: PrivateIpv4AddressSchema,
      port: z.number().int().min(1).max(65_535),
    }),
    tls: PrivateIngressTlsV0Schema,
    sourcePolicy: PrivateIngressSourcePolicyV0Schema,
  })
  .superRefine((ingress, context) => {
    if (effectiveHttpsPort(ingress.browserOrigin) !== ingress.listener.port) {
      context.addIssue({
        code: "custom",
        path: ["listener", "port"],
        message: "Listener port must match the canonical browser Origin port.",
      });
    }
  });

export type PrivateIngressV0 = z.infer<typeof PrivateIngressV0Schema>;

export const GatewayIngressV0Schema = z.discriminatedUnion("kind", [
  LoopbackProxyIngressV0Schema,
  PrivateIngressV0Schema,
]);

export type GatewayIngressV0 = z.infer<typeof GatewayIngressV0Schema>;

export const PRIVATE_INGRESS_V0_JSON_SCHEMA = z.toJSONSchema(PrivateIngressV0Schema, {
  target: "draft-2020-12",
});

export const GATEWAY_INGRESS_V0_JSON_SCHEMA = z.toJSONSchema(GatewayIngressV0Schema, {
  target: "draft-2020-12",
});

export interface RedactedPrivateIngressV0 {
  readonly contractVersion: typeof PRIVATE_INGRESS_V0_CONTRACT_VERSION;
  readonly profileId: "[redacted-profile]";
  readonly kind: "direct-private-tls";
  readonly network: PrivateIngressV0["network"];
  readonly browserOrigin: "[redacted-origin]";
  readonly listener: {
    readonly host: "[redacted-address]";
    readonly port: "[redacted-port]";
  };
  readonly tls: {
    readonly approvedRoot: "[redacted-path]";
    readonly certificateFile: "[redacted-path]";
    readonly privateKeyFile: "[redacted-path]";
    readonly reload: "watch-last-known-good";
    readonly materialOwner: "user";
    readonly renewalOwner: "user" | "external";
    readonly terminationOwner: "gateway";
  };
  readonly sourcePolicy: {
    readonly mode: "private-ipv4-allowlist";
    readonly allowedAddressCount: number;
    readonly allowedCidrCount: number;
  };
}

export function redactPrivateIngressV0(value: unknown): RedactedPrivateIngressV0 {
  const ingress = PrivateIngressV0Schema.parse(value);
  return {
    contractVersion: ingress.contractVersion,
    profileId: "[redacted-profile]",
    kind: ingress.kind,
    network: ingress.network,
    browserOrigin: "[redacted-origin]",
    listener: { host: "[redacted-address]", port: "[redacted-port]" },
    tls: {
      approvedRoot: "[redacted-path]",
      certificateFile: "[redacted-path]",
      privateKeyFile: "[redacted-path]",
      reload: ingress.tls.reload,
      materialOwner: ingress.tls.materialOwner,
      renewalOwner: ingress.tls.renewalOwner,
      terminationOwner: ingress.tls.terminationOwner,
    },
    sourcePolicy: {
      mode: ingress.sourcePolicy.mode,
      allowedAddressCount: ingress.sourcePolicy.allowedAddresses.length,
      allowedCidrCount: ingress.sourcePolicy.allowedCidrs.length,
    },
  };
}

export function canonicalizePrivateIngressV0(value: unknown): PrivateIngressV0 {
  const ingress = PrivateIngressV0Schema.parse(value);
  return {
    ...ingress,
    sourcePolicy: {
      ...ingress.sourcePolicy,
      allowedAddresses: [...ingress.sourcePolicy.allowedAddresses].sort(compareIpv4Addresses),
      allowedCidrs: [...ingress.sourcePolicy.allowedCidrs].sort(compareIpv4Cidrs),
    },
  };
}

/**
 * Produces the non-secret receipt binding for a validated private ingress intent. The digest binds
 * exact private path and topology references, so callers must not log the canonical preimage.
 */
export async function digestPrivateIngressIntentV0(value: unknown): Promise<string> {
  const payload = canonicalJson({
    purpose: PRIVATE_INGRESS_V0_DIGEST_PURPOSE,
    ingress: canonicalizePrivateIngressV0(value),
  });
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isExactHostnameHttpsOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.origin === value &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.hostname !== "localhost" &&
      !parsed.hostname.endsWith(".") &&
      parseCanonicalIpv4(parsed.hostname) === undefined &&
      !parsed.hostname.includes(":") &&
      isCanonicalHostname(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function effectiveHttpsPort(origin: string): number {
  const parsed = new URL(origin);
  return parsed.port === "" ? 443 : Number(parsed.port);
}

function isPrivateIpv4Address(value: string): boolean {
  const numeric = parseCanonicalIpv4(value);
  return numeric !== undefined && isRfc1918Number(numeric);
}

function isPrivateIpv4Cidr(value: string): boolean {
  const match = /^(.*)\/(\d{1,2})$/.exec(value);
  if (match === null) return false;
  const address = match[1];
  const prefixSource = match[2];
  const prefix = Number(prefixSource);
  if (
    address === undefined ||
    prefixSource === undefined ||
    !Number.isInteger(prefix) ||
    String(prefix) !== prefixSource ||
    prefix < 0 ||
    prefix > 32
  ) {
    return false;
  }
  const numeric = parseCanonicalIpv4(address);
  if (numeric === undefined) return false;
  const size = 2 ** (32 - prefix);
  const end = numeric + size - 1;
  return numeric % size === 0 && isRfc1918Number(numeric) && isRfc1918Number(end);
}

function isCanonicalHostname(value: string): boolean {
  return (
    value.length <= 253 &&
    value.split(".").every((label) => /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/.test(label))
  );
}

function privateIpv4CidrRange(value: string): { start: number; end: number; prefix: number } {
  const [address, prefixSource] = value.split("/");
  const start = address === undefined ? undefined : parseCanonicalIpv4(address);
  const prefix = Number(prefixSource);
  if (start === undefined || !Number.isInteger(prefix)) {
    throw new Error("Private IPv4 CIDR must be validated before normalization.");
  }
  return { start, end: start + 2 ** (32 - prefix) - 1, prefix };
}

function parseCanonicalIpv4(value: string): number | undefined {
  const parts = value.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)
  ) {
    return undefined;
  }
  const octets = parts.map(Number);
  const first = octets[0];
  const second = octets[1];
  const third = octets[2];
  const fourth = octets[3];
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) {
    return undefined;
  }
  return ((first * 256 + second) * 256 + third) * 256 + fourth;
}

function isRfc1918Number(value: number): boolean {
  return (
    (value >= 167_772_160 && value <= 184_549_375) ||
    (value >= 2_886_729_728 && value <= 2_887_778_303) ||
    (value >= 3_232_235_520 && value <= 3_232_301_055)
  );
}

function isCanonicalAbsolutePath(value: string): boolean {
  if (!value.startsWith("/") || /[\0\r\n]/.test(value)) return false;
  const parts = value.split("/");
  return parts.slice(1).every((part) => part !== "" && part !== "." && part !== "..");
}

function isStrictPathChild(root: string, candidate: string): boolean {
  return root !== "/" && candidate.startsWith(`${root}/`);
}

function addDuplicateIssues(
  entries: readonly string[],
  field: "allowedAddresses" | "allowedCidrs",
  context: z.core.$RefinementCtx<unknown>,
): void {
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (seen.has(entry)) {
      context.addIssue({
        code: "custom",
        path: [field, index],
        message: "Source policy entries must be unique.",
      });
    }
    seen.add(entry);
  }
}

function compareIpv4Addresses(left: string, right: string): number {
  return (parseCanonicalIpv4(left) ?? 0) - (parseCanonicalIpv4(right) ?? 0);
}

function compareIpv4Cidrs(left: string, right: string): number {
  const first = privateIpv4CidrRange(left);
  const second = privateIpv4CidrRange(right);
  return first.start - second.start || first.prefix - second.prefix;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortJson(record[key])]),
  );
}
