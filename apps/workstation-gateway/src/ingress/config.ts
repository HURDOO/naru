import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { VersionedIngressProfileSchema } from "@naru/contracts/workstation-gateway/v1";
import { analyzeIngressProfiles, isPrivateIpAddress } from "@naru/domain/workstation";
import { z } from "zod";
import { assertPrivateRegularFile } from "../security.js";

const FileIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(isAbsolute, "Path must be absolute.")
  .refine((value) => !/[\0\r\n]/.test(value), "Path contains a control character.");

const ProbePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(isExactProbePath, "Probe path must be an exact safe absolute URL path.");

export const NetworkHealthProbeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("uds-http"),
    socketPath: AbsolutePathSchema.refine(
      (path) => Buffer.byteLength(path) <= 103,
      "Unix socket path exceeds the macOS limit.",
    ),
    path: ProbePathSchema,
  }),
  z.strictObject({
    kind: z.literal("loopback-http"),
    origin: z
      .string()
      .refine(isExactLoopbackHttpOrigin, "Probe Origin must be exact loopback HTTP."),
    path: ProbePathSchema,
  }),
]);

const TrustedProxyPolicySchema = z.strictObject({
  id: FileIdentifierSchema,
  kind: z.literal("tailscale-loopback"),
});

const SourcePolicySchema = z.strictObject({
  id: FileIdentifierSchema,
  kind: z.literal("private-cidr-allowlist"),
  cidrs: z.array(z.string().refine(isPrivateCidr, "Source CIDR must be private.")).min(1).max(128),
});

const TargetProbeSchema = z.strictObject({
  appId: FileIdentifierSchema,
  app: NetworkHealthProbeSchema.optional(),
  host: NetworkHealthProbeSchema.optional(),
});

export const WorkstationNetworkConfigSchema = z
  .strictObject({
    version: z.literal(1),
    instanceId: FileIdentifierSchema,
    gatewayConfigPath: AbsolutePathSchema.optional(),
    ownershipDirectory: AbsolutePathSchema,
    tailscaleExecutable: AbsolutePathSchema,
    trustedProxyPolicies: z.array(TrustedProxyPolicySchema).max(64).default([]),
    sourcePolicies: z.array(SourcePolicySchema).max(64).default([]),
    targetProbes: z.array(TargetProbeSchema).max(1_000).default([]),
    profiles: z.array(VersionedIngressProfileSchema).max(64),
  })
  .superRefine((config, context) => {
    const profiles = config.profiles.map((entry) => entry.profile);
    for (const policyIssue of analyzeIngressProfiles(profiles).issues) {
      for (const profileId of policyIssue.profileIds) {
        const index = profiles.findIndex((profile) => profile.id === profileId);
        context.addIssue({
          code: "custom",
          path: ["profiles", Math.max(index, 0), "profile", policyIssue.field],
          message: `${policyIssue.code}: ${policyIssue.message}`,
        });
      }
    }

    const proxyPolicies = uniqueIds(config.trustedProxyPolicies, "trustedProxyPolicies", context);
    const sourcePolicies = uniqueIds(config.sourcePolicies, "sourcePolicies", context);
    uniqueIds(config.targetProbes, "targetProbes", context, "appId");
    for (const [index, profile] of profiles.entries()) {
      if (
        profile.trustedProxyPolicy !== undefined &&
        !proxyPolicies.has(profile.trustedProxyPolicy)
      ) {
        context.addIssue({
          code: "custom",
          path: ["profiles", index, "profile", "trustedProxyPolicy"],
          message: "trustedProxyPolicy does not resolve to a configured policy.",
        });
      }
      if (profile.sourcePolicy !== undefined && !sourcePolicies.has(profile.sourcePolicy)) {
        context.addIssue({
          code: "custom",
          path: ["profiles", index, "profile", "sourcePolicy"],
          message: "sourcePolicy does not resolve to a configured policy.",
        });
      }
    }
  });

export type WorkstationNetworkConfig = z.infer<typeof WorkstationNetworkConfigSchema>;
export type NetworkHealthProbe = z.infer<typeof NetworkHealthProbeSchema>;

export function readWorkstationNetworkConfig(path: string): WorkstationNetworkConfig {
  assertPrivateRegularFile(path);
  const source = readFileSync(path, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new Error("Workstation network config is not valid JSON.");
  }
  return WorkstationNetworkConfigSchema.parse(value);
}

function uniqueIds<T extends Readonly<Record<string, unknown>>>(
  entries: readonly T[],
  path: string,
  context: z.core.$RefinementCtx<unknown>,
  field = "id",
): Set<string> {
  const ids = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const id = entry[field];
    if (typeof id !== "string") continue;
    if (ids.has(id)) {
      context.addIssue({
        code: "custom",
        path: [path, index, field],
        message: `${field} values must be unique.`,
      });
    }
    ids.add(id);
  }
  return ids;
}

function isExactLoopbackHttpOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "http:" &&
      parsed.origin === value &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.port !== "" &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function isExactProbePath(value: string): boolean {
  if (!value.startsWith("/") || value.includes("//") || /[\0\r\n?#\\]/.test(value)) return false;
  try {
    const parsed = new URL(value, "https://probe.invalid");
    return (
      parsed.pathname === value &&
      !parsed.pathname.split("/").some((part) => part === "." || part === "..")
    );
  } catch {
    return false;
  }
}

function isPrivateCidr(value: string): boolean {
  const match = /^(.*)\/(\d{1,3})$/.exec(value);
  if (match === null) return false;
  const address = match[1];
  const prefix = Number(match[2]);
  if (address === undefined || !isPrivateIpAddress(address)) return false;
  if (!Number.isInteger(prefix)) return false;
  if (address.includes(":")) {
    if (prefix < 0 || prefix > 128) return false;
    const lower = address.toLowerCase();
    if (lower === "::1") return prefix === 128;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return prefix >= 7;
    return prefix >= 10;
  }
  if (prefix < 0 || prefix > 32) return false;
  const [first, second] = address.split(".").map(Number);
  if (first === 10 || first === 127) return prefix >= 8;
  if (first === 172 && second !== undefined && second >= 16 && second <= 31) return prefix >= 12;
  return first === 192 && second === 168 && prefix >= 16;
}
