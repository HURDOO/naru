import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  AppIdSchema,
  BoundedIdentifierSchema,
  DURABLE_SESSION_LIMITS,
  DurableSessionCapabilitySchema,
  ProfileScopeSchema,
  RootScopeSchema,
  SessionScopeSchema,
} from "@naru/contracts/durable-session/v0";
import { DURABLE_SESSION_INTEGRATION_BOOTSTRAP_ENV } from "@naru/durable-session-integration";
import { z } from "zod";
import { assertPrivateRegularFile } from "./security.js";

const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(isAbsolute, "Path must be absolute.")
  .refine((value) => !/[\0\r\n]/.test(value), "Path contains a control character.");

const EnvironmentNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .max(128);

const IntegrationConfigKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9._-]*$/);

const SubjectScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("all") }),
  z.strictObject({
    kind: z.literal("ids"),
    ids: z.array(BoundedIdentifierSchema).min(1).max(1_000),
  }),
]);

export const HostRootConfigSchema = z.strictObject({
  rootId: BoundedIdentifierSchema,
  path: AbsolutePathSchema,
});

export const HostEnvironmentPolicySchema = z
  .strictObject({
    envPolicyId: BoundedIdentifierSchema,
    inherit: z.array(EnvironmentNameSchema).max(128).default([]),
    values: z.record(EnvironmentNameSchema, z.string().max(16_384)).default({}),
  })
  .superRefine((policy, context) => {
    if (new Set(policy.inherit).size !== policy.inherit.length) {
      context.addIssue({
        code: "custom",
        path: ["inherit"],
        message: "Inherited environment names must be unique.",
      });
    }
    for (const [key, value] of Object.entries(policy.values)) {
      if (value.includes("\0")) {
        context.addIssue({
          code: "custom",
          path: ["values", key],
          message: "Environment value contains a null byte.",
        });
      }
    }
    if (Object.keys(policy.values).length > 128) {
      context.addIssue({
        code: "custom",
        path: ["values"],
        message: "Environment policy has too many fixed values.",
      });
    }
    const totalCharacters = Object.values(policy.values).reduce(
      (total, value) => total + value.length,
      0,
    );
    if (totalCharacters > 256 * 1_024) {
      context.addIssue({
        code: "custom",
        path: ["values"],
        message: "Environment policy values are too large.",
      });
    }
  });

export const HostResourcePolicySchema = z.strictObject({
  resourcePolicyId: BoundedIdentifierSchema,
  allowedExecutables: z.array(AbsolutePathSchema).min(1).max(256),
  maxCols: z.number().int().min(2).max(1_000).default(500),
  maxRows: z.number().int().min(1).max(1_000).default(200),
  scrollbackRows: z.number().int().min(0).max(100_000).default(5_000),
  outputRingCharacters: z
    .number()
    .int()
    .min(DURABLE_SESSION_LIMITS.terminalDataCharacters)
    .max(16 * 1_024 * 1_024)
    .default(1024 * 1024),
  stopTimeoutMs: z.number().int().min(100).max(30_000).default(5_000),
});

export const HostProfileConfigSchema = z.strictObject({
  profileId: BoundedIdentifierSchema,
  executable: AbsolutePathSchema,
  args: z
    .array(z.string().max(DURABLE_SESSION_LIMITS.argumentCharacters))
    .max(DURABLE_SESSION_LIMITS.argumentCount),
  envPolicyId: BoundedIdentifierSchema,
  resourcePolicyId: BoundedIdentifierSchema,
});

export const HostAppRegistrationSchema = z.strictObject({
  appId: AppIdSchema,
  credentialFile: AbsolutePathSchema,
  capabilities: z.array(DurableSessionCapabilitySchema).min(1).max(32),
  subjectScope: SubjectScopeSchema,
  sessionScope: SessionScopeSchema,
  profileScope: ProfileScopeSchema,
  rootScope: RootScopeSchema,
  maxCallerTtlMs: z
    .number()
    .int()
    .min(1_000)
    .max(24 * 60 * 60_000),
});

export const HostIntegrationPolicySchema = z
  .strictObject({
    policyRef: BoundedIdentifierSchema,
    appId: AppIdSchema,
    integrationKind: BoundedIdentifierSchema,
    profileIds: z.array(BoundedIdentifierSchema).min(1).max(64),
    configKeys: z.array(IntegrationConfigKeySchema).min(1).max(64),
  })
  .superRefine((policy, context) => {
    for (const [field, values] of [
      ["profileIds", policy.profileIds],
      ["configKeys", policy.configKeys],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} must be unique.`,
        });
      }
    }
    if (!policy.configKeys.includes("policyRef")) {
      context.addIssue({
        code: "custom",
        path: ["configKeys"],
        message: "Integration policy must allow the policyRef config key.",
      });
    }
  });

export const DurableSessionHostConfigSchema = z
  .strictObject({
    version: z.literal(1),
    dataDirectory: AbsolutePathSchema,
    socketPath: AbsolutePathSchema.refine(
      (path) => Buffer.byteLength(path) <= 103,
      "Unix socket path exceeds the macOS limit.",
    ),
    roots: z.array(HostRootConfigSchema).min(1).max(1_000),
    profiles: z.array(HostProfileConfigSchema).max(1_000),
    environmentPolicies: z.array(HostEnvironmentPolicySchema).min(1).max(1_000),
    resourcePolicies: z.array(HostResourcePolicySchema).min(1).max(1_000),
    appRegistrations: z.array(HostAppRegistrationSchema).min(1).max(1_000),
    integrationPolicies: z.array(HostIntegrationPolicySchema).max(1_000).default([]),
    sessionLimit: z.number().int().min(1).max(10_000).default(1_000),
    requestBodyBytes: z
      .number()
      .int()
      .min(1_024)
      .max(4 * 1_024 * 1_024)
      .default(512 * 1_024),
    maxConcurrentRequests: z.number().int().min(1).max(1_000).default(64),
    maxConcurrentStreams: z.number().int().min(1).max(1_000).default(64),
    maxAttachmentsPerSession: z.number().int().min(1).max(1_000).default(32),
    attachmentQueueBytes: z
      .number()
      .int()
      .min(DURABLE_SESSION_LIMITS.terminalStateCharacters + 64 * 1_024)
      .max(64 * 1_024 * 1_024)
      .default(4 * 1_024 * 1_024),
    eventJournalLimit: z.number().int().min(1).max(100_000).default(10_000),
    inputDedupeTtlMs: z
      .number()
      .int()
      .min(1_000)
      .max(24 * 60 * 60_000)
      .default(60_000),
    inputDedupeLimit: z.number().int().min(1).max(100_000).default(10_000),
    expirySweepIntervalMs: z.number().int().min(100).max(10_000).default(1_000),
    idempotencyTtlMs: z
      .number()
      .int()
      .min(1_000)
      .max(24 * 60 * 60_000)
      .default(10 * 60_000),
    idempotencyLimit: z.number().int().min(1).max(100_000).default(10_000),
  })
  .superRefine((config, context) => {
    checkUnique(config.roots, "rootId", ["roots"], context);
    checkUnique(config.profiles, "profileId", ["profiles"], context);
    checkUnique(config.environmentPolicies, "envPolicyId", ["environmentPolicies"], context);
    checkUnique(config.resourcePolicies, "resourcePolicyId", ["resourcePolicies"], context);
    checkUnique(config.appRegistrations, "appId", ["appRegistrations"], context);
    checkUnique(config.integrationPolicies, "policyRef", ["integrationPolicies"], context);

    const environmentPolicies = new Set(
      config.environmentPolicies.map((policy) => policy.envPolicyId),
    );
    const resourcePolicies = new Set(
      config.resourcePolicies.map((policy) => policy.resourcePolicyId),
    );
    const profileIds = new Set(config.profiles.map((profile) => profile.profileId));
    const appIds = new Set(config.appRegistrations.map((registration) => registration.appId));
    for (const [index, profile] of config.profiles.entries()) {
      if (!environmentPolicies.has(profile.envPolicyId)) {
        context.addIssue({
          code: "custom",
          path: ["profiles", index, "envPolicyId"],
          message: "Profile references an unknown environment policy.",
        });
      }
      if (!resourcePolicies.has(profile.resourcePolicyId)) {
        context.addIssue({
          code: "custom",
          path: ["profiles", index, "resourcePolicyId"],
          message: "Profile references an unknown resource policy.",
        });
      }
    }
    for (const [index, policy] of config.integrationPolicies.entries()) {
      if (!appIds.has(policy.appId)) {
        context.addIssue({
          code: "custom",
          path: ["integrationPolicies", index, "appId"],
          message: "Integration policy references an unknown app registration.",
        });
      }
      for (const [profileIndex, profileId] of policy.profileIds.entries()) {
        if (!profileIds.has(profileId)) {
          context.addIssue({
            code: "custom",
            path: ["integrationPolicies", index, "profileIds", profileIndex],
            message: "Integration policy references an unknown profile.",
          });
        }
      }
    }
    for (const [index, policy] of config.environmentPolicies.entries()) {
      if (
        policy.inherit.includes(DURABLE_SESSION_INTEGRATION_BOOTSTRAP_ENV) ||
        Object.hasOwn(policy.values, DURABLE_SESSION_INTEGRATION_BOOTSTRAP_ENV)
      ) {
        context.addIssue({
          code: "custom",
          path: ["environmentPolicies", index],
          message: "Environment policy cannot supply the reserved integration bootstrap key.",
        });
      }
    }
  });

export type DurableSessionHostConfig = z.infer<typeof DurableSessionHostConfigSchema>;
export type HostRootConfig = z.infer<typeof HostRootConfigSchema>;
export type HostEnvironmentPolicy = z.infer<typeof HostEnvironmentPolicySchema>;
export type HostResourcePolicy = z.infer<typeof HostResourcePolicySchema>;
export type HostProfileConfig = z.infer<typeof HostProfileConfigSchema>;
export type HostAppRegistration = z.infer<typeof HostAppRegistrationSchema>;
export type HostIntegrationPolicy = z.infer<typeof HostIntegrationPolicySchema>;

export function readDurableSessionHostConfig(path: string): DurableSessionHostConfig {
  assertPrivateRegularFile(path);
  const source = readFileSync(path, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new Error("DurableSession Host config is not valid JSON.");
  }
  return DurableSessionHostConfigSchema.parse(value);
}

function checkUnique<T extends Record<K, string>, K extends keyof T>(
  values: readonly T[],
  key: K,
  path: readonly (string | number)[],
  context: z.core.$RefinementCtx<unknown>,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    const identifier = value[key];
    if (seen.has(identifier)) {
      context.addIssue({
        code: "custom",
        path: [...path, index, String(key)],
        message: `Duplicate identifier: ${identifier}`,
      });
    }
    seen.add(identifier);
  }
}
