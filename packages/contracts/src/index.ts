import { z } from "zod";

export const ErrorCodeSchema = z.enum([
  "AUTH_INVALID",
  "AUTH_REQUIRED",
  "AUTH_RATE_LIMITED",
  "PASSKEY_DUPLICATE",
  "PASSKEY_MISSING",
  "PUSH_NOT_CONFIGURED",
  "PUSH_SUBSCRIPTION_LIMIT",
  "PUSH_SUBSCRIPTION_MISSING",
  "CSRF_INVALID",
  "ORIGIN_INVALID",
  "PROJECT_DUPLICATE",
  "PROJECT_GIT_INVALID",
  "PROJECT_GIT_UNAVAILABLE",
  "PROJECT_GROUP_MISSING",
  "PROJECT_TARGET_NOT_DISCOVERED",
  "PROJECT_INVALID_PATH",
  "PROJECT_MISSING",
  "PROJECT_OUTSIDE_ROOT",
  "PROJECT_PERMISSION_DENIED",
  "DOCS_OUTSIDE_ROOT",
  "DOCS_PERMISSION_DENIED",
  "DOCS_FILE_MISSING",
  "DOCS_FILE_TOO_LARGE",
  "DOCS_LIMIT_EXCEEDED",
  "DOCS_UNSUPPORTED_TYPE",
  "FILE_OUTSIDE_ROOT",
  "FILE_PERMISSION_DENIED",
  "FILE_MISSING",
  "FILE_TOO_LARGE",
  "FILE_BINARY",
  "FILE_LIMIT_EXCEEDED",
  "FILE_SENSITIVE_CONFIRMATION_REQUIRED",
  "FILE_CONFLICT",
  "FILE_PROTECTED",
  "LAYOUT_CONFLICT",
  "PANE_MISSING",
  "PTY_NOT_RUNNING",
  "PTY_SPAWN_FAILED",
  "CODEX_EXECUTABLE_MISSING",
  "CODEX_AUTH_REQUIRED",
  "CODEX_CONFIG_INVALID",
  "CLAUDE_EXECUTABLE_MISSING",
  "CLAUDE_AUTH_REQUIRED",
  "LEASE_REQUIRED",
  "LEASE_REPLACED",
  "WS_BACKPRESSURE",
  "REQUEST_INVALID",
  "INTERNAL_ERROR",
  // Agent Platform (naru-agent/v1); older web builds fall back to their default message.
  "AGENT_NOT_FOUND",
  "AGENT_SCOPE_DENIED",
  "AGENT_ROLE_DENIED",
  "AGENT_HELD_BY_HUMAN",
  "AGENT_REVISION_STALE",
  "AGENT_IDEMPOTENCY_CONFLICT",
  "AGENT_INVALID_REFERENCE",
  "AGENT_INVALID_STATE",
  "AGENT_DEPENDENCY_CYCLE",
  "AGENT_RUNTIME_UNAVAILABLE",
  "AGENT_WRITER_REQUIRED",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  requestId: z.string(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const LoginRequestSchema = z.object({
  password: z.string().min(1).max(1024),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

const WebAuthnBase64UrlSchema = z
  .string()
  .min(1)
  .max(512 * 1024);
const WebAuthnClientExtensionResultsSchema = z.record(z.string(), z.unknown());

export const PasskeyRegistrationResponseSchema = z.object({
  id: WebAuthnBase64UrlSchema,
  rawId: WebAuthnBase64UrlSchema,
  response: z.object({
    clientDataJSON: WebAuthnBase64UrlSchema,
    attestationObject: WebAuthnBase64UrlSchema,
    transports: z.array(z.string().min(1).max(32)).max(16).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: WebAuthnBase64UrlSchema.optional(),
    authenticatorData: WebAuthnBase64UrlSchema.optional(),
  }),
  type: z.literal("public-key"),
  clientExtensionResults: WebAuthnClientExtensionResultsSchema,
  authenticatorAttachment: z.string().max(64).optional(),
});
export type PasskeyRegistrationResponse = z.infer<typeof PasskeyRegistrationResponseSchema>;

export const PasskeyAuthenticationResponseSchema = z.object({
  id: WebAuthnBase64UrlSchema,
  rawId: WebAuthnBase64UrlSchema,
  response: z.object({
    clientDataJSON: WebAuthnBase64UrlSchema,
    authenticatorData: WebAuthnBase64UrlSchema,
    signature: WebAuthnBase64UrlSchema,
    userHandle: WebAuthnBase64UrlSchema.nullable().optional(),
  }),
  type: z.literal("public-key"),
  clientExtensionResults: WebAuthnClientExtensionResultsSchema,
  authenticatorAttachment: z.string().max(64).optional(),
});
export type PasskeyAuthenticationResponse = z.infer<typeof PasskeyAuthenticationResponseSchema>;

export const FinishPasskeyRegistrationRequestSchema = z.object({
  ceremonyId: z.string().uuid(),
  name: z.string().trim().min(1).max(64),
  response: PasskeyRegistrationResponseSchema,
});
export type FinishPasskeyRegistrationRequest = z.infer<
  typeof FinishPasskeyRegistrationRequestSchema
>;

export const FinishPasskeyAuthenticationRequestSchema = z.object({
  ceremonyId: z.string().uuid(),
  response: PasskeyAuthenticationResponseSchema,
});
export type FinishPasskeyAuthenticationRequest = z.infer<
  typeof FinishPasskeyAuthenticationRequestSchema
>;

export const PasskeySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(64),
  deviceType: z.enum(["singleDevice", "multiDevice"]),
  backedUp: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().nullable(),
});
export type Passkey = z.infer<typeof PasskeySchema>;

export const UpdatePasskeyRequestSchema = z.object({
  name: z.string().trim().min(1).max(64),
});
export type UpdatePasskeyRequest = z.infer<typeof UpdatePasskeyRequestSchema>;

const PushEndpointSchema = z
  .url()
  .max(2048)
  .refine((value) => {
    const endpoint = new URL(value);
    return (
      endpoint.protocol === "https:" &&
      endpoint.username === "" &&
      endpoint.password === "" &&
      endpoint.hash === ""
    );
  }, "Push endpoint must be a credential-free HTTPS URL without a fragment.");
const PushKeySchema = z
  .string()
  .min(16)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);
const PushP256dhKeySchema = PushKeySchema.length(87);
const PushAuthKeySchema = PushKeySchema.length(22);

export const PushEventKindSchema = z.enum(["completed", "interaction-required", "failed"]);
export type PushEventKind = z.infer<typeof PushEventKindSchema>;

export const PUSH_INACTIVITY_DELAY_MINUTES = {
  default: 2,
  min: 1,
  max: 60,
} as const;
export const PushInactivityDelayMinutesSchema = z
  .number()
  .int()
  .min(PUSH_INACTIVITY_DELAY_MINUTES.min)
  .max(PUSH_INACTIVITY_DELAY_MINUTES.max);

export const PushConfigurationSchema = z.object({
  configured: z.boolean(),
  publicKey: z.string().nullable(),
  inactivityDelayMinutes: PushInactivityDelayMinutesSchema,
});
export type PushConfiguration = z.infer<typeof PushConfigurationSchema>;

export const UpdatePushConfigurationRequestSchema = z
  .object({ inactivityDelayMinutes: PushInactivityDelayMinutesSchema })
  .strict();
export type UpdatePushConfigurationRequest = z.infer<typeof UpdatePushConfigurationRequestSchema>;

export const PushSubscriptionSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(64),
  endpointFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  expirationTime: z.number().int().nonnegative().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type NaruPushSubscription = z.infer<typeof PushSubscriptionSchema>;

export const CreatePushSubscriptionRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    endpoint: PushEndpointSchema,
    expirationTime: z.number().int().nonnegative().nullable(),
    keys: z
      .object({
        p256dh: PushP256dhKeySchema,
        auth: PushAuthKeySchema,
      })
      .strict(),
  })
  .strict();
export type CreatePushSubscriptionRequest = z.infer<typeof CreatePushSubscriptionRequestSchema>;

export const UpdatePushSubscriptionRequestSchema = z
  .object({ name: z.string().trim().min(1).max(64) })
  .strict();
export type UpdatePushSubscriptionRequest = z.infer<typeof UpdatePushSubscriptionRequestSchema>;

export const PushNotificationPayloadSchema = z
  .object({
    version: z.literal(1),
    eventId: z.string().uuid(),
    projectId: z.string().uuid(),
    paneId: z.string().uuid(),
    runtimeId: z.string().uuid(),
    eventKind: PushEventKindSchema,
  })
  .strict();
export type PushNotificationPayload = z.infer<typeof PushNotificationPayloadSchema>;

/**
 * An agent asked the person for a decision, manual test or terminal control (Agent Platform Inbox,
 * AP-D004 L4). Opening it shows that handoff.
 */
export const PushHandoffPayloadSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("handoff"),
    eventId: z.string().uuid(),
    projectId: z.string().uuid(),
    handoffId: z.string().uuid(),
    handoffKind: z.enum([
      "design-deviation",
      "product-decision",
      "manual-test",
      "terminal-control",
      "security-or-external",
    ]),
  })
  .strict();
export type PushHandoffPayload = z.infer<typeof PushHandoffPayloadSchema>;

export const PUSH_CLEAR_MAX_ALERT_EVENT_IDS = 32;

/** Tells a device to close the listed alerts of a project whose attention states were resolved. */
export const PushClearPayloadSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("clear"),
    eventId: z.string().uuid(),
    projectId: z.string().uuid(),
    alertEventIds: z.array(z.string().uuid()).min(1).max(PUSH_CLEAR_MAX_ALERT_EVENT_IDS),
  })
  .strict();
export type PushClearPayload = z.infer<typeof PushClearPayloadSchema>;

export const TERMINAL_RESTORE_PROTOCOL = "staged-v1" as const;
export const TerminalRestoreProtocolSchema = z.literal(TERMINAL_RESTORE_PROTOCOL);
export type TerminalRestoreProtocol = z.infer<typeof TerminalRestoreProtocolSchema>;
export const MAX_TERMINAL_SCROLLBACK_ROWS = 2_000;

const SessionCapabilitiesSchema = z
  .object({
    terminalRestore: TerminalRestoreProtocolSchema,
  })
  .optional();
const SessionProjectRootsSchema = z
  .array(z.string().min(2).max(4_096).startsWith("/"))
  .min(1)
  .max(128);
export const SessionResponseSchema = z.discriminatedUnion("authMode", [
  z.strictObject({
    authenticated: z.literal(true),
    authMode: z.literal("app-managed"),
    csrfToken: z.string(),
    expiresAt: z.string().datetime(),
    projectRoots: SessionProjectRootsSchema,
    capabilities: SessionCapabilitiesSchema,
  }),
  z.strictObject({
    authenticated: z.literal(true),
    authMode: z.literal("gateway-managed"),
    projectRoots: SessionProjectRootsSchema,
    capabilities: SessionCapabilitiesSchema,
  }),
]);
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

export const ProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  path: z.string(),
  activity: z.object({
    state: z.enum([
      "idle",
      "running",
      "interaction-required",
      "completed",
      "canceled",
      "server-stopped",
      "failed",
    ]),
    interactionRequiredCount: z.number().int().nonnegative(),
    updatedAt: z.string().datetime().nullable(),
  }),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const CreateProjectRequestSchema = z.object({
  path: z.string().min(1).max(4096),
  name: z.string().trim().min(1).max(120).optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const UpdateProjectRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
});
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequestSchema>;

export const PaneKindSchema = z.enum(["terminal", "codex", "claude", "files", "docs", "tasks"]);
export type PaneKind = z.infer<typeof PaneKindSchema>;

export const PaneStatusSchema = z.enum(["stopped", "running", "exited", "error", "ready"]);
export type PaneStatus = z.infer<typeof PaneStatusSchema>;

export const PaneActivityStateSchema = z.enum([
  "idle",
  "running",
  "interaction-required",
  "completed",
  "canceled",
  "server-stopped",
  "failed",
]);
export type PaneActivityState = z.infer<typeof PaneActivityStateSchema>;

export const PaneActivitySchema = z.object({
  state: PaneActivityStateSchema,
  eventId: z.string().uuid().nullable(),
  runtimeId: z.string().uuid().nullable(),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
});
export type PaneActivity = z.infer<typeof PaneActivitySchema>;

export const ProjectActivitySchema = ProjectSchema.shape.activity;
export type ProjectActivity = z.infer<typeof ProjectActivitySchema>;

export const ProjectGroupKindSchema = z.enum(["standalone", "git"]);
export type ProjectGroupKind = z.infer<typeof ProjectGroupKindSchema>;

export const ProjectTargetAvailabilitySchema = z.enum([
  "ready",
  "missing",
  "permission-denied",
  "outside-root",
  "invalid",
]);
export type ProjectTargetAvailability = z.infer<typeof ProjectTargetAvailabilitySchema>;

export const GitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export type GitObjectId = z.infer<typeof GitObjectIdSchema>;

export const GitHeadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("branch"),
      name: z.string().min(1).max(1024),
      oid: GitObjectIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("detached"),
      oid: GitObjectIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("unborn"),
      name: z.string().min(1).max(1024).nullable(),
    })
    .strict(),
]);
export type GitHead = z.infer<typeof GitHeadSchema>;

export const GitWorktreeMetadataSchema = z
  .object({
    kind: z.literal("worktree"),
    role: z.enum(["primary", "linked"]),
    head: GitHeadSchema,
    locked: z.boolean(),
    prunable: z.boolean(),
  })
  .strict();
export type GitWorktreeMetadata = z.infer<typeof GitWorktreeMetadataSchema>;

export const ProjectTargetGitMetadataSchema = z.discriminatedUnion("kind", [
  GitWorktreeMetadataSchema,
  z.object({ kind: z.literal("bare") }).strict(),
]);
export type ProjectTargetGitMetadata = z.infer<typeof ProjectTargetGitMetadataSchema>;

const ProjectTargetBaseSchema = z.object({
  label: z.string().min(1).max(120),
  path: z.string().min(1).max(4096),
  availability: ProjectTargetAvailabilitySchema,
  git: ProjectTargetGitMetadataSchema.nullable(),
});

export const ConnectedProjectTargetSchema = ProjectTargetBaseSchema.extend({
  registration: z.literal("connected"),
  projectId: z.string().uuid(),
  activity: ProjectActivitySchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type ConnectedProjectTarget = z.infer<typeof ConnectedProjectTargetSchema>;

export const DiscoveredProjectTargetSchema = ProjectTargetBaseSchema.extend({
  registration: z.literal("discovered"),
  availability: z.literal("ready"),
  git: GitWorktreeMetadataSchema,
}).strict();
export type DiscoveredProjectTarget = z.infer<typeof DiscoveredProjectTargetSchema>;

export const ProjectTargetSchema = z.discriminatedUnion("registration", [
  ConnectedProjectTargetSchema,
  DiscoveredProjectTargetSchema,
]);
export type ProjectTarget = z.infer<typeof ProjectTargetSchema>;

export const ProjectGroupSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(120),
    kind: ProjectGroupKindSchema,
    activity: ProjectActivitySchema,
    targets: z.array(ProjectTargetSchema).min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((group, context) => {
    if (!group.targets.some((target) => target.registration === "connected")) {
      context.addIssue({
        code: "custom",
        message: "A project group must retain at least one connected target.",
        path: ["targets"],
      });
    }
    if (
      group.kind === "standalone" &&
      (group.targets.length !== 1 ||
        group.targets[0]?.registration !== "connected" ||
        group.targets[0].git !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "A standalone group must contain one connected non-Git target.",
        path: ["targets"],
      });
    }
    if (
      group.kind === "git" &&
      group.targets.some((target) => target.availability === "ready" && target.git === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Every target in a Git project group must include Git metadata.",
        path: ["targets"],
      });
    }
  });
export type ProjectGroup = z.infer<typeof ProjectGroupSchema>;

export const ConnectDiscoveredProjectTargetRequestSchema = z
  .object({ path: z.string().min(1).max(4096) })
  .strict();
export type ConnectDiscoveredProjectTargetRequest = z.infer<
  typeof ConnectDiscoveredProjectTargetRequestSchema
>;

export const PushProjectSummarySchema = z
  .object({
    projectId: z.string().uuid(),
    projectName: z.string().min(1).max(120),
    state: PaneActivityStateSchema,
    counts: z
      .object({
        interactionRequired: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        completed: z.number().int().nonnegative(),
      })
      .strict(),
    suppressNotification: z.boolean(),
  })
  .strict();
export type PushProjectSummary = z.infer<typeof PushProjectSummarySchema>;

export const CodexLaunchProfileSchema = z.enum(["codex-main", "codex-quick"]);
export type CodexLaunchProfile = z.infer<typeof CodexLaunchProfileSchema>;
export const ClaudeLaunchProfileSchema = z.literal("claude-code");
export const CodexSessionIdSchema = z.string().uuid();
export const ClaudeSessionIdSchema = z.string().uuid();

export const DocumentRelativePathSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => !value.includes("\0"), "Document path cannot contain null bytes.");
export type DocumentRelativePath = z.infer<typeof DocumentRelativePathSchema>;

export const PaneViewStateSchema = z.object({
  selectedDocumentPath: DocumentRelativePathSchema.nullable(),
  navigationOpen: z.boolean(),
  expandedDirectories: z.array(DocumentRelativePathSchema).max(256).default([]),
});
export type PaneViewState = z.infer<typeof PaneViewStateSchema>;

export const PaneSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  kind: PaneKindSchema,
  title: z.string().min(1).max(120),
  launchProfile: z.string().min(1).max(120),
  status: PaneStatusSchema,
  exitCode: z.number().int().nullable(),
  codexSessionId: CodexSessionIdSchema.nullable(),
  codexSessionResumable: z.boolean(),
  /** Latest Claude Code conversation for `claude --resume`; absent from older servers. */
  claudeSessionId: ClaudeSessionIdSchema.nullable().optional(),
  lastErrorCode: ErrorCodeSchema.nullable(),
  lastExitedAt: z.string().datetime().nullable(),
  activity: PaneActivitySchema,
  viewState: PaneViewStateSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Pane = z.infer<typeof PaneSchema>;

export interface PaneNode {
  type: "pane";
  paneId: string;
  collapsed: boolean;
}

export interface SplitNode {
  type: "split";
  id: string;
  direction: SplitDirection;
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
}

export type LayoutNode = PaneNode | SplitNode;

export const SplitDirectionSchema = z.enum(["horizontal", "vertical"]);
export type SplitDirection = z.infer<typeof SplitDirectionSchema>;

export const LAYOUT_SCHEMA_VERSION = 2;

export const LayoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("pane"),
      paneId: z.string().uuid(),
      collapsed: z.boolean(),
    }),
    z.object({
      type: z.literal("split"),
      id: z.string().uuid(),
      direction: SplitDirectionSchema,
      ratio: z.number().min(0.1).max(0.9),
      first: LayoutNodeSchema,
      second: LayoutNodeSchema,
    }),
  ]),
);

export const WorkspaceSchema = z.object({
  projectId: z.string().uuid(),
  schemaVersion: z.number().int().positive(),
  version: z.number().int().nonnegative(),
  layout: LayoutNodeSchema.nullable(),
  activePaneId: z.string().uuid().nullable(),
  panes: z.array(PaneSchema),
  updatedAt: z.string().datetime(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

const CreatePaneRequestBase = {
  title: z.string().trim().min(1).max(120).optional(),
  workspaceVersion: z.number().int().nonnegative(),
  targetPaneId: z.string().uuid().nullable(),
  direction: SplitDirectionSchema,
};

export const CreatePaneRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("terminal"),
    launchProfile: z.literal("shell").optional(),
    ...CreatePaneRequestBase,
  }),
  z.strictObject({
    kind: z.literal("codex"),
    launchProfile: CodexLaunchProfileSchema.optional(),
    ...CreatePaneRequestBase,
  }),
  z.strictObject({
    kind: z.literal("claude"),
    launchProfile: ClaudeLaunchProfileSchema.optional(),
    ...CreatePaneRequestBase,
  }),
  z.strictObject({
    kind: z.literal("files"),
    selectedDocumentPath: DocumentRelativePathSchema.optional(),
    ...CreatePaneRequestBase,
  }),
  z.strictObject({
    kind: z.literal("docs"),
    selectedDocumentPath: DocumentRelativePathSchema.optional(),
    ...CreatePaneRequestBase,
  }),
  z.strictObject({
    kind: z.literal("tasks"),
    selectedDocumentPath: DocumentRelativePathSchema.optional(),
    ...CreatePaneRequestBase,
  }),
]);
export type CreatePaneRequest = z.infer<typeof CreatePaneRequestSchema>;

export const UpdatePaneViewStateRequestSchema = PaneViewStateSchema.partial().strict();
export type UpdatePaneViewStateRequest = z.infer<typeof UpdatePaneViewStateRequestSchema>;

export const AcknowledgePaneActivityRequestSchema = z
  .object({ eventId: z.string().uuid() })
  .strict();
export type AcknowledgePaneActivityRequest = z.infer<typeof AcknowledgePaneActivityRequestSchema>;

export const DocumentKindSchema = z.enum(["markdown", "tasks"]);
export type DocumentKind = z.infer<typeof DocumentKindSchema>;

export const DocumentHeadingSchema = z.object({
  depth: z.number().int().min(1).max(6),
  text: z.string().max(500),
  line: z.number().int().positive(),
});
export type DocumentHeading = z.infer<typeof DocumentHeadingSchema>;

export const DocumentEntrySchema = z.object({
  path: DocumentRelativePathSchema,
  title: z.string().min(1).max(500),
  kind: DocumentKindSchema,
  modifiedAt: z.string().datetime(),
  sizeBytes: z.number().int().nonnegative(),
  tooLarge: z.boolean(),
  summary: z.string().max(500),
  headings: z.array(DocumentHeadingSchema).max(256),
});
export type DocumentEntry = z.infer<typeof DocumentEntrySchema>;

export const DocumentCatalogSchema = z.object({
  status: z.enum(["ready", "empty", "missing"]),
  documents: z.array(DocumentEntrySchema).max(256),
});
export type DocumentCatalog = z.infer<typeof DocumentCatalogSchema>;

export const TaskStatusSchema = z.enum(["pending", "in_progress", "deferred", "completed"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskItemSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(500),
  status: TaskStatusSchema,
  next: z.boolean(),
  scope: z.string().max(4000),
  prerequisites: z.string().max(4000),
  deliverables: z.string().max(4000),
  completionCriteria: z.array(z.string().max(2000)).max(100),
  records: z.array(z.string().max(4000)).max(100),
  postMvp: z.boolean(),
  line: z.number().int().positive(),
});
export type TaskItem = z.infer<typeof TaskItemSchema>;

export const TasksOverviewSchema = z.object({
  inProgress: z.array(TaskItemSchema),
  nextTask: TaskItemSchema.nullable(),
  pending: z.array(TaskItemSchema),
  deferred: z.array(TaskItemSchema),
  completed: z.array(TaskItemSchema),
  postMvp: z.array(TaskItemSchema),
});
export type TasksOverview = z.infer<typeof TasksOverviewSchema>;

export const DocumentContentSchema = DocumentEntrySchema.extend({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.string(),
  warnings: z.array(z.enum(["MARKDOWN_UNCLOSED_FENCE", "TASKS_NOT_RECOGNIZED"])),
  tasks: TasksOverviewSchema.nullable(),
});
export type DocumentContent = z.infer<typeof DocumentContentSchema>;

export const ProjectRelativePathSchema = z
  .string()
  .max(2048)
  .refine((value) => !value.includes("\0"), "Project path cannot contain null bytes.");
export type ProjectRelativePath = z.infer<typeof ProjectRelativePathSchema>;

export const ProjectFileEntrySchema = z
  .object({
    path: DocumentRelativePathSchema,
    name: z.string().min(1).max(512),
    kind: z.enum(["file", "directory", "symlink"]),
    sizeBytes: z.number().int().nonnegative().nullable(),
    modifiedAt: z.string().datetime().nullable(),
    sensitive: z.boolean(),
    protected: z.boolean(),
    excluded: z.boolean(),
    symlinkStatus: z.enum(["inside", "outside", "broken"]).nullable(),
  })
  .strict();
export type ProjectFileEntry = z.infer<typeof ProjectFileEntrySchema>;

export const ProjectDirectoryListingSchema = z
  .object({
    path: ProjectRelativePathSchema,
    entries: z.array(ProjectFileEntrySchema).max(512),
  })
  .strict();
export type ProjectDirectoryListing = z.infer<typeof ProjectDirectoryListingSchema>;

export const ProjectFileContentSchema = z
  .object({
    path: DocumentRelativePathSchema,
    source: z.string(),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z.number().int().nonnegative(),
    modifiedAt: z.string().datetime(),
    sensitive: z.boolean(),
  })
  .strict();
export type ProjectFileContent = z.infer<typeof ProjectFileContentSchema>;

export const SaveProjectFileRequestSchema = z
  .object({
    path: DocumentRelativePathSchema,
    source: z.string(),
    expectedRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    allowSensitive: z.boolean().default(false),
  })
  .strict();
export type SaveProjectFileRequest = z.infer<typeof SaveProjectFileRequestSchema>;

export const FileAssistantMergeRequestSchema = z
  .object({
    paneId: z.string().uuid(),
    initialActivityEventId: z.string().uuid().nullable(),
    currentRevision: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type FileAssistantMergeRequest = z.infer<typeof FileAssistantMergeRequestSchema>;

export const FileAssistantMergeSchema = z
  .object({
    paneId: z.string().uuid(),
    initialActivityEventId: z.string().uuid().nullable(),
    current: ProjectFileContentSchema,
    requestedAt: z.string().datetime(),
  })
  .strict();
export type FileAssistantMerge = z.infer<typeof FileAssistantMergeSchema>;

export const SaveFileDraftRequestSchema = z
  .object({
    path: DocumentRelativePathSchema,
    baseRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    draftSource: z.string(),
    allowSensitive: z.boolean().default(false),
    assistantMerge: FileAssistantMergeRequestSchema.nullable().default(null),
  })
  .strict();
export type SaveFileDraftRequest = z.infer<typeof SaveFileDraftRequestSchema>;

export const FileDraftSchema = z
  .object({
    paneId: z.string().uuid(),
    projectId: z.string().uuid(),
    path: DocumentRelativePathSchema,
    baseRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    baseSource: z.string(),
    draftSource: z.string(),
    sensitive: z.boolean(),
    assistantMerge: FileAssistantMergeSchema.nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type FileDraft = z.infer<typeof FileDraftSchema>;

export const SaveWorkspaceRequestSchema = z.object({
  version: z.number().int().nonnegative(),
  layout: LayoutNodeSchema.nullable(),
  activePaneId: z.string().uuid().nullable(),
});
export type SaveWorkspaceRequest = z.infer<typeof SaveWorkspaceRequestSchema>;

export const DeletePaneRequestSchema = z.object({
  workspaceVersion: z.number().int().nonnegative(),
});
export type DeletePaneRequest = z.infer<typeof DeletePaneRequestSchema>;

const LeaseGenerationSchema = z.number().int().positive();
export const LeaseAcquisitionSchema = z.enum(["initial", "reconnect", "takeover"]);
export type LeaseAcquisition = z.infer<typeof LeaseAcquisitionSchema>;
export const NARU_SURFACE_CONNECTION_HEADER = "x-naru-surface-connection";
export const NARU_SURFACE_GENERATION_HEADER = "x-naru-surface-generation";
export const SurfaceRoleSchema = z.enum(["controller", "observer"]);
export type SurfaceRole = z.infer<typeof SurfaceRoleSchema>;
export const SurfaceStateReasonSchema = z.enum([
  "initial",
  "reconnect",
  "conflict",
  "available",
  "acquired",
  "preempted",
  "released",
  "expired",
]);
export type SurfaceStateReason = z.infer<typeof SurfaceStateReasonSchema>;
export const MAX_CLIPBOARD_IMAGE_BYTES = 16 * 1024 * 1024;
export const CLIPBOARD_IMAGE_CHUNK_BYTES = 48 * 1024;
const ClipboardImageRequestIdSchema = z.string().uuid();
const ClipboardImageChunkSchema = z
  .string()
  .min(1)
  .max(Math.ceil(CLIPBOARD_IMAGE_CHUNK_BYTES / 3) * 4);
const PaneDimensions = {
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(200),
};

export const ClientPresenceSchema = z.strictObject({
  visible: z.boolean(),
  focused: z.boolean(),
  interactionRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type ClientPresence = z.infer<typeof ClientPresenceSchema>;

export const ClientWsFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("lease.acquire"),
    clientId: z.string().uuid(),
  }),
  z.strictObject({
    type: z.literal("surface.acquire"),
    leaseGeneration: LeaseGenerationSchema,
  }),
  z.strictObject({
    type: z.literal("surface.takeover"),
    leaseGeneration: LeaseGenerationSchema,
    target: z
      .strictObject({
        paneId: z.string().uuid(),
        ...PaneDimensions,
      })
      .nullable(),
  }),
  z.strictObject({
    type: z.literal("pane.control.preempt"),
    paneId: z.string().uuid(),
    leaseGeneration: LeaseGenerationSchema,
    ...PaneDimensions,
  }),
  z.strictObject({
    type: z.literal("pane.control.approve"),
    paneId: z.string().uuid(),
    controlRequestId: z.string().uuid(),
    leaseGeneration: LeaseGenerationSchema,
  }),
  z.strictObject({
    type: z.literal("pane.control.reject"),
    paneId: z.string().uuid(),
    controlRequestId: z.string().uuid(),
    leaseGeneration: LeaseGenerationSchema,
  }),
  z.strictObject({
    type: z.literal("pane.control.release"),
    paneId: z.string().uuid(),
    leaseGeneration: LeaseGenerationSchema,
  }),
  z.strictObject({
    type: z.literal("pane.attach"),
    paneId: z.string().uuid(),
    leaseGeneration: LeaseGenerationSchema,
    restoreProtocol: TerminalRestoreProtocolSchema.optional(),
    restoreId: z.string().uuid().optional(),
    ...PaneDimensions,
  }),
  z.strictObject({
    type: z.literal("pane.detach"),
    paneId: z.string().uuid(),
    leaseGeneration: LeaseGenerationSchema,
  }),
  z.strictObject({
    type: z.literal("terminal.input"),
    paneId: z.string().uuid(),
    leaseGeneration: LeaseGenerationSchema,
    data: z.string().max(65536),
    /**
     * Secret typed by a person (AP-D003): delivered to the PTY only, never to observers' relays,
     * records, logs or drafts. Absent for ordinary keys.
     */
    secure: z.literal(true).optional(),
  }),
  z.strictObject({
    type: z.literal("terminal.resize"),
    paneId: z.string().uuid(),
    leaseGeneration: LeaseGenerationSchema,
    ...PaneDimensions,
  }),
  z.strictObject({
    type: z.literal("terminal.viewport"),
    paneId: z.string().uuid(),
    runtimeId: z.string().uuid(),
    leaseGeneration: LeaseGenerationSchema,
    bottomOffset: z.number().int().min(0).max(MAX_TERMINAL_SCROLLBACK_ROWS),
  }),
  z.strictObject({
    type: z.literal("clipboard.image.begin"),
    requestId: ClipboardImageRequestIdSchema,
    paneId: z.string().uuid(),
    leaseGeneration: LeaseGenerationSchema,
    byteLength: z.number().int().min(1).max(MAX_CLIPBOARD_IMAGE_BYTES),
  }),
  z.strictObject({
    type: z.literal("clipboard.image.chunk"),
    requestId: ClipboardImageRequestIdSchema,
    paneId: z.string().uuid(),
    leaseGeneration: LeaseGenerationSchema,
    offset: z
      .number()
      .int()
      .min(0)
      .max(MAX_CLIPBOARD_IMAGE_BYTES - 1),
    data: ClipboardImageChunkSchema,
  }),
  z.strictObject({
    type: z.literal("clipboard.image.commit"),
    requestId: ClipboardImageRequestIdSchema,
    paneId: z.string().uuid(),
    leaseGeneration: LeaseGenerationSchema,
  }),
  z.strictObject({
    type: z.literal("heartbeat"),
    leaseGeneration: LeaseGenerationSchema,
    sentAt: z.number().int().nonnegative(),
    presence: ClientPresenceSchema.optional(),
  }),
]);
export type ClientWsFrame = z.infer<typeof ClientWsFrameSchema>;

export const ServerWsFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("lease.granted"),
    generation: LeaseGenerationSchema,
    replacedClient: z.boolean(),
    acquisition: LeaseAcquisitionSchema,
  }),
  z.strictObject({
    type: z.literal("lease.revoked"),
    reason: z.enum(["replaced", "expired", "logout", "server_shutdown"]),
  }),
  z.strictObject({
    type: z.literal("surface.state"),
    connectionId: z.string().uuid(),
    generation: LeaseGenerationSchema,
    role: SurfaceRoleSchema,
    controllerPresent: z.boolean(),
    reason: SurfaceStateReasonSchema,
  }),
  z.strictObject({
    type: z.literal("pane.control.state"),
    paneId: z.string().uuid(),
    role: SurfaceRoleSchema,
    controllerGeneration: z.number().int().nonnegative(),
    terminal: z.strictObject(PaneDimensions),
    reason: z.enum([
      "attached",
      "acquired",
      "transferred",
      "preempted",
      "released",
      "expired",
      "closed",
    ]),
  }),
  z.strictObject({
    type: z.literal("pane.control.requested"),
    paneId: z.string().uuid(),
    controlRequestId: z.string().uuid(),
    controllerGeneration: z.number().int().nonnegative(),
    expiresAtMs: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal("pane.control.request-resolved"),
    paneId: z.string().uuid(),
    controlRequestId: z.string().uuid(),
    controllerGeneration: z.number().int().nonnegative(),
    resolution: z.enum([
      "approved",
      "rejected",
      "expired",
      "controller-changed",
      "requester-closed",
    ]),
  }),
  z.strictObject({
    type: z.literal("pane.snapshot"),
    paneId: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    serializedState: z.string(),
    runtimeId: z.string().uuid(),
    ...PaneDimensions,
  }),
  z.strictObject({
    type: z.literal("pane.restore.preview"),
    paneId: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    serializedState: z.string(),
    runtimeId: z.string().uuid(),
    restoreId: z.string().uuid(),
    bottomOffset: z.number().int().min(0).max(MAX_TERMINAL_SCROLLBACK_ROWS),
    previewBottomOffset: z.number().int().min(0).max(MAX_TERMINAL_SCROLLBACK_ROWS),
    ...PaneDimensions,
  }),
  z.strictObject({
    type: z.literal("pane.restore.full"),
    paneId: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    serializedState: z.string(),
    runtimeId: z.string().uuid(),
    restoreId: z.string().uuid(),
    bottomOffset: z.number().int().min(0).max(MAX_TERMINAL_SCROLLBACK_ROWS),
    ...PaneDimensions,
  }),
  z.strictObject({
    type: z.literal("terminal.output"),
    paneId: z.string().uuid(),
    sequence: z.number().int().positive(),
    data: z.string(),
  }),
  z.strictObject({
    type: z.literal("terminal.exit"),
    paneId: z.string().uuid(),
    exitCode: z.number().int(),
    signal: z.number().int().nonnegative().optional(),
    codexSessionId: CodexSessionIdSchema.nullable().optional(),
    codexSessionResumable: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal("codex.session.changed"),
    paneId: z.string().uuid(),
    runtimeId: z.string().uuid(),
    updatedAt: z.string().datetime(),
    session: z.union([
      z.strictObject({ id: z.null(), resumable: z.literal(false) }),
      z.strictObject({ id: CodexSessionIdSchema, resumable: z.boolean() }),
    ]),
  }),
  z.strictObject({
    type: z.literal("activity.changed"),
    eventId: z.string().uuid(),
    projectId: z.string().uuid(),
    paneId: z.string().uuid(),
    activity: PaneActivitySchema,
    projectActivity: ProjectActivitySchema,
  }),
  z.strictObject({
    type: z.literal("heartbeat.ack"),
    sentAt: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal("clipboard.image.result"),
    requestId: ClipboardImageRequestIdSchema,
    paneId: z.string().uuid(),
    status: z.enum(["attached", "error"]),
    code: ErrorCodeSchema.optional(),
    message: z.string().min(1).max(500).optional(),
  }),
  z.strictObject({
    type: z.literal("protocol.error"),
    code: ErrorCodeSchema,
    message: z.string(),
    requestId: z.string().optional(),
  }),
]);
export type ServerWsFrame = z.infer<typeof ServerWsFrameSchema>;

export * as DurableSessionV0 from "./durable-session/v0/index.js";
export * as PrivateIngressV0 from "./private-ingress/v0/index.js";
export * as WorkstationGatewayV1 from "./workstation-gateway/v1/index.js";
