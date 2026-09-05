import { z } from "zod";

export const DURABLE_SESSION_PROTOCOL_VERSION = 0 as const;
export const DurableSessionProtocolVersionSchema = z.literal(DURABLE_SESSION_PROTOCOL_VERSION);

export const DURABLE_SESSION_LIMITS = {
  identifierCharacters: 128,
  relativePathCharacters: 4_096,
  executableCharacters: 4_096,
  argumentCharacters: 16_384,
  argumentCount: 256,
  argumentTotalCharacters: 256 * 1_024,
  integrationConfigBytes: 64 * 1_024,
  terminalDataCharacters: 64 * 1_024,
  terminalStateCharacters: 2 * 1_024 * 1_024,
  eventReadLimit: 1_000,
  requestTimeoutMs: 30_000,
  controlRequestTtlMs: 5 * 60_000,
  controlOfferTtlMs: 60_000,
  reconnectGraceMs: 10_000,
  heartbeatIntervalMs: 15_000,
  staleAfterMs: 35_000,
} as const;

const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const SAFE_CODE_PATTERN = /^[a-z][a-z0-9-]*$/;
const SENSITIVE_CONFIG_KEY_PATTERN =
  /(?:password|secret|token|credential|private[-_]?key|api[-_]?key)/i;

export const SessionIdSchema = z.string().uuid();
export const RuntimeIdSchema = z.string().uuid();
export const AttachmentIdSchema = z.string().uuid();
export const ControlRequestIdSchema = z.string().uuid();
export const ControlOfferIdSchema = z.string().uuid();
export const EventIdSchema = z.string().uuid();
export const ProtocolRequestIdSchema = z.string().uuid();
export const InputIdSchema = z.string().uuid();
export const IdempotencyKeySchema = z.string().uuid();

export type SessionId = z.infer<typeof SessionIdSchema>;
export type RuntimeId = z.infer<typeof RuntimeIdSchema>;
export type AttachmentId = z.infer<typeof AttachmentIdSchema>;
export type ControlRequestId = z.infer<typeof ControlRequestIdSchema>;
export type ControlOfferId = z.infer<typeof ControlOfferIdSchema>;
export type EventId = z.infer<typeof EventIdSchema>;
export type ProtocolRequestId = z.infer<typeof ProtocolRequestIdSchema>;
export type InputId = z.infer<typeof InputIdSchema>;
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;

export const MonotonicOrdinalSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const SessionRevisionSchema = MonotonicOrdinalSchema;
export const ControllerGenerationSchema = MonotonicOrdinalSchema;
export const TerminalSequenceSchema = MonotonicOrdinalSchema;
export const UnixTimeMillisecondsSchema = MonotonicOrdinalSchema;

export const BoundedIdentifierSchema = z
  .string()
  .min(1)
  .max(DURABLE_SESSION_LIMITS.identifierCharacters)
  .regex(SAFE_IDENTIFIER_PATTERN);
export const AppIdSchema = BoundedIdentifierSchema;
export const SubjectIdSchema = BoundedIdentifierSchema;
export const ProfileIdSchema = BoundedIdentifierSchema;
export const RootIdSchema = BoundedIdentifierSchema;
export const EnvPolicyIdSchema = BoundedIdentifierSchema;
export const ResourcePolicyIdSchema = BoundedIdentifierSchema;

export const TerminalSizeSchema = z.strictObject({
  cols: z.number().int().min(2).max(1_000),
  rows: z.number().int().min(1).max(1_000),
});
export type TerminalSize = z.infer<typeof TerminalSizeSchema>;

export const TerminalDescriptorSchema = z.strictObject({
  ...TerminalSizeSchema.shape,
  term: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._+-]+$/)
    .optional(),
});
export type TerminalDescriptor = z.infer<typeof TerminalDescriptorSchema>;

export const RelativePathSchema = z
  .string()
  .max(DURABLE_SESSION_LIMITS.relativePathCharacters)
  .superRefine((value, context) => {
    if (value.startsWith("/") || value.includes("\\") || /[\0\r\n]/.test(value)) {
      context.addIssue({ code: "custom", message: "Path must be a safe POSIX relative path." });
      return;
    }
    if (value === "") return;
    const components = value.split("/");
    if (
      components.some((component) => component === "" || component === "." || component === "..")
    ) {
      context.addIssue({ code: "custom", message: "Path contains an unsafe component." });
    }
  });

export const RootedWorkingDirectorySchema = z.strictObject({
  rootId: RootIdSchema,
  relativePath: RelativePathSchema,
});
export type RootedWorkingDirectory = z.infer<typeof RootedWorkingDirectorySchema>;

type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export const JsonValueSchema = z.custom<JsonValue>((value) => isJsonValue(value), {
  message: "Integration config must be JSON-compatible.",
});

export const IntegrationDescriptorSchema = z
  .strictObject({
    kind: BoundedIdentifierSchema,
    config: z.record(z.string().min(1).max(128), JsonValueSchema).optional(),
  })
  .superRefine((value, context) => {
    if (value.config === undefined) return;
    const sensitivePath = findSensitiveConfigPath(value.config);
    if (sensitivePath !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["config", ...sensitivePath],
        message: "Inline integration secrets are not allowed; use a Host-owned policy reference.",
      });
    }
    const encoded = JSON.stringify(value.config);
    if (
      new TextEncoder().encode(encoded).byteLength > DURABLE_SESSION_LIMITS.integrationConfigBytes
    ) {
      context.addIssue({
        code: "custom",
        path: ["config"],
        message: "Integration config is too large.",
      });
    }
  });
export type IntegrationDescriptor = z.infer<typeof IntegrationDescriptorSchema>;

const CommandBaseShape = {
  cwd: RootedWorkingDirectorySchema,
  terminal: TerminalDescriptorSchema,
  integration: IntegrationDescriptorSchema.optional(),
} as const;

export const ProfileCommandSpecV0Schema = z.strictObject({
  kind: z.literal("profile"),
  profileId: ProfileIdSchema,
  ...CommandBaseShape,
});

export const ExecCommandSpecV0Schema = z
  .strictObject({
    kind: z.literal("exec"),
    executable: z
      .string()
      .min(1)
      .max(DURABLE_SESSION_LIMITS.executableCharacters)
      .refine((value) => !/[\0\r\n]/.test(value), "Executable contains a control character."),
    args: z
      .array(z.string().max(DURABLE_SESSION_LIMITS.argumentCharacters))
      .max(DURABLE_SESSION_LIMITS.argumentCount),
    envPolicyId: EnvPolicyIdSchema,
    resourcePolicyId: ResourcePolicyIdSchema,
    ...CommandBaseShape,
  })
  .superRefine((value, context) => {
    const total = value.args.reduce((sum, argument) => sum + argument.length, 0);
    if (total > DURABLE_SESSION_LIMITS.argumentTotalCharacters) {
      context.addIssue({
        code: "custom",
        path: ["args"],
        message: "Command arguments are too large.",
      });
    }
  });

export const CommandSpecV0Schema = z.discriminatedUnion("kind", [
  ProfileCommandSpecV0Schema,
  ExecCommandSpecV0Schema,
]);
export type CommandSpecV0 = z.infer<typeof CommandSpecV0Schema>;

export const DurableSessionCapabilitySchema = z.enum([
  "session:observe",
  "control:request",
  "control:preempt",
  "session:create:profile",
  "session:create:arbitrary",
  "session:start",
  "session:stop",
  "session:forget",
  "profile:use",
  "session:read-sensitive-metadata",
]);
export type DurableSessionCapability = z.infer<typeof DurableSessionCapabilitySchema>;

function scopedIdsSchema<T extends z.ZodType>(item: T) {
  return z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("all") }),
    z.strictObject({ kind: z.literal("ids"), ids: z.array(item).min(1).max(1_000) }),
  ]);
}

export const SessionScopeSchema = scopedIdsSchema(SessionIdSchema);
export const ProfileScopeSchema = scopedIdsSchema(ProfileIdSchema);
export const RootScopeSchema = scopedIdsSchema(RootIdSchema);

export const DurableSessionCallerContextSchema = z
  .strictObject({
    appId: AppIdSchema,
    subject: SubjectIdSchema,
    capabilities: z.array(DurableSessionCapabilitySchema).min(1).max(32),
    sessionScope: SessionScopeSchema,
    profileScope: ProfileScopeSchema,
    rootScope: RootScopeSchema,
    expiresAtMs: UnixTimeMillisecondsSchema,
  })
  .superRefine((value, context) => {
    if (new Set(value.capabilities).size !== value.capabilities.length) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "Capabilities must be unique.",
      });
    }
    for (const scopeName of ["sessionScope", "profileScope", "rootScope"] as const) {
      const scope = value[scopeName];
      if (scope.kind === "ids" && new Set(scope.ids).size !== scope.ids.length) {
        context.addIssue({
          code: "custom",
          path: [scopeName, "ids"],
          message: "Scope IDs must be unique.",
        });
      }
    }
  });
export type DurableSessionCallerContext = z.infer<typeof DurableSessionCallerContextSchema>;

export const SessionLifecycleSchema = z.enum([
  "creating",
  "running",
  "stopping",
  "stopped",
  "exited",
  "failed",
]);
export type SessionLifecycle = z.infer<typeof SessionLifecycleSchema>;

export const AttachmentRoleSchema = z.enum(["observer", "controller"]);
export type AttachmentRole = z.infer<typeof AttachmentRoleSchema>;

export const AttachmentViewSchema = z.strictObject({
  attachmentId: AttachmentIdSchema,
  role: AttachmentRoleSchema,
  connected: z.boolean(),
});
export type AttachmentView = z.infer<typeof AttachmentViewSchema>;

export const RedactedCommandReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("profile"), profileId: ProfileIdSchema, rootId: RootIdSchema }),
  z.strictObject({
    kind: z.literal("exec"),
    executableLabel: z.string().min(1).max(256),
    rootId: RootIdSchema,
  }),
]);
export type RedactedCommandReference = z.infer<typeof RedactedCommandReferenceSchema>;

export const SessionViewSchema = z.strictObject({
  sessionId: SessionIdSchema,
  lifecycle: SessionLifecycleSchema,
  sessionRevision: SessionRevisionSchema,
  runtimeId: RuntimeIdSchema.nullable(),
  terminal: TerminalSizeSchema,
  controllerAttachmentId: AttachmentIdSchema.nullable(),
  controllerGeneration: ControllerGenerationSchema,
  nextSequence: TerminalSequenceSchema,
  command: RedactedCommandReferenceSchema,
  createdAtMs: UnixTimeMillisecondsSchema,
  updatedAtMs: UnixTimeMillisecondsSchema,
});
export type SessionView = z.infer<typeof SessionViewSchema>;

export const DurableSessionErrorCodeSchema = z.enum([
  "SESSION_NOT_FOUND",
  "SESSION_NOT_RUNNING",
  "SESSION_STATE_INVALID",
  "RUNTIME_STALE",
  "SESSION_REVISION_STALE",
  "CAPABILITY_REQUIRED",
  "CONTROL_HELD",
  "CONTROL_GENERATION_STALE",
  "CONTROL_REQUEST_NOT_FOUND",
  "CONTROL_REQUEST_EXPIRED",
  "CONTROL_OFFER_NOT_FOUND",
  "ATTACHMENT_NOT_FOUND",
  "ATTACHMENT_NOT_CONTROLLER",
  "ATTACHMENT_RESUME_REJECTED",
  "RESYNC_REQUIRED",
  "COMMAND_POLICY_DENIED",
  "ROOT_BOUNDARY_VIOLATION",
  "SESSION_LIMIT_REACHED",
  "REQUEST_INVALID",
  "PROTOCOL_VERSION_UNSUPPORTED",
  "INTERNAL_ERROR",
]);
export type DurableSessionErrorCode = z.infer<typeof DurableSessionErrorCodeSchema>;

export const DurableSessionErrorSchema = z.strictObject({
  code: DurableSessionErrorCodeSchema,
  message: z.string().min(1).max(500),
  diagnosticId: z.string().uuid().optional(),
});
export type DurableSessionError = z.infer<typeof DurableSessionErrorSchema>;

export const SensitiveOpaqueTokenSchema = z
  .string()
  .min(32)
  .max(1_024)
  .refine((value) => !/[\0\r\n]/.test(value), "Opaque token contains a control character.");

export const BoundedTerminalDataSchema = z
  .string()
  .max(DURABLE_SESSION_LIMITS.terminalDataCharacters);

export const RedactedReasonCodeSchema = z.string().min(1).max(64).regex(SAFE_CODE_PATTERN);

function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, seen));
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, seen));
}

function findSensitiveConfigPath(
  value: JsonValue,
  path: readonly (string | number)[] = [],
): readonly (string | number)[] | undefined {
  if (Array.isArray(value)) {
    for (const [index, item] of (value as readonly JsonValue[]).entries()) {
      const found = findSensitiveConfigPath(item, [...path, index]);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_CONFIG_KEY_PATTERN.test(key)) return [...path, key];
    const found = findSensitiveConfigPath(item, [...path, key]);
    if (found !== undefined) return found;
  }
  return undefined;
}
