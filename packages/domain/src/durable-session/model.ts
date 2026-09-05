import type {
  AttachmentId,
  AttachmentRole,
  CommandSpecV0,
  ControlOfferId,
  ControlRequestId,
  RedactedCommandReference,
  RuntimeId,
  SessionId,
  SessionLifecycle,
  SessionView,
  TerminalSize,
} from "@naru/contracts/durable-session/v0";

export interface AttachmentState {
  readonly attachmentId: AttachmentId;
  readonly role: AttachmentRole;
  readonly connected: boolean;
  readonly lastSeenAtMs: number;
  readonly graceExpiresAtMs: number | null;
}

export interface PendingControlRequestState {
  readonly controlRequestId: ControlRequestId;
  readonly requesterAttachmentId: AttachmentId;
  readonly controllerGeneration: number;
  readonly expiresAtMs: number;
}

export interface ActiveControlOfferState {
  readonly controlOfferId: ControlOfferId;
  readonly controlRequestId: ControlRequestId;
  readonly requesterAttachmentId: AttachmentId;
  readonly controllerAttachmentId: AttachmentId;
  readonly controllerGeneration: number;
  readonly expiresAtMs: number;
}

export interface RuntimeSummary {
  readonly runtimeId: RuntimeId;
  readonly reason:
    "natural-exit" | "explicit-stop" | "spawn-failed" | "runtime-failed" | "runtime-lost";
  readonly exitCode: number | null;
  readonly signal: number | null;
}

export interface DurableSessionState {
  readonly sessionId: SessionId;
  readonly command: CommandSpecV0;
  readonly lifecycle: SessionLifecycle;
  readonly sessionRevision: number;
  readonly runtimeId: RuntimeId | null;
  readonly terminal: TerminalSize;
  readonly controllerAttachmentId: AttachmentId | null;
  readonly controllerGeneration: number;
  readonly nextSequence: number;
  readonly attachments: Readonly<Record<AttachmentId, AttachmentState>>;
  readonly pendingControlRequests: Readonly<Record<ControlRequestId, PendingControlRequestState>>;
  readonly activeControlOffer: ActiveControlOfferState | null;
  readonly lastRuntime: RuntimeSummary | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export type ControlChangeReason =
  "acquired" | "transferred" | "preempted" | "released" | "expired" | "closed";

export type DurableSessionDomainEvent =
  | {
      readonly type: "session.changed";
      readonly lifecycle: SessionLifecycle;
      readonly sessionRevision: number;
      readonly runtimeId: RuntimeId | null;
    }
  | {
      readonly type: "control.requested";
      readonly controllerGeneration: number;
      readonly request: PendingControlRequestState;
    }
  | {
      readonly type: "control.offered";
      readonly controllerGeneration: number;
      readonly offer: ActiveControlOfferState;
    }
  | {
      readonly type: "control.request-resolved";
      readonly controllerGeneration: number;
      readonly controlRequestId: ControlRequestId;
      readonly resolution:
        "approved" | "rejected" | "expired" | "controller-changed" | "requester-closed";
    }
  | { readonly type: "control.available"; readonly controllerGeneration: number }
  | {
      readonly type: "control.changed";
      readonly previousControllerAttachmentId: AttachmentId | null;
      readonly controllerAttachmentId: AttachmentId | null;
      readonly controllerGeneration: number;
      readonly terminal: TerminalSize;
      readonly reason: ControlChangeReason;
    };

export type DurableSessionEffect =
  | {
      readonly type: "spawn";
      readonly sessionId: SessionId;
      readonly runtimeId: RuntimeId;
      readonly command: CommandSpecV0;
    }
  | { readonly type: "kill"; readonly sessionId: SessionId; readonly runtimeId: RuntimeId }
  | {
      readonly type: "resizePty";
      readonly sessionId: SessionId;
      readonly runtimeId: RuntimeId;
      readonly terminal: TerminalSize;
    }
  | {
      readonly type: "writePty";
      readonly sessionId: SessionId;
      readonly runtimeId: RuntimeId;
      readonly inputId: string;
      readonly data: string;
    }
  | {
      readonly type: "persistMetadata";
      readonly sessionId: SessionId;
      readonly sessionRevision: number;
    }
  | { readonly type: "deleteMetadata"; readonly sessionId: SessionId }
  | {
      readonly type: "emitEvent";
      readonly sessionId: SessionId;
      readonly event: DurableSessionDomainEvent;
    }
  | {
      readonly type: "closeAttachment";
      readonly sessionId: SessionId;
      readonly attachmentId: AttachmentId;
      readonly reason: "closed" | "grace-expired" | "session-forgotten";
    };

export interface CreateSessionStateInput {
  readonly sessionId: SessionId;
  readonly runtimeId: RuntimeId;
  readonly command: CommandSpecV0;
  readonly nowMs: number;
}

export function createSessionState(input: CreateSessionStateInput): DurableSessionState {
  return {
    sessionId: input.sessionId,
    command: input.command,
    lifecycle: "creating",
    sessionRevision: 0,
    runtimeId: input.runtimeId,
    terminal: { cols: input.command.terminal.cols, rows: input.command.terminal.rows },
    controllerAttachmentId: null,
    controllerGeneration: 0,
    nextSequence: 0,
    attachments: {},
    pendingControlRequests: {},
    activeControlOffer: null,
    lastRuntime: null,
    createdAtMs: input.nowMs,
    updatedAtMs: input.nowMs,
  };
}

export function effectsForCreatedSession(
  state: DurableSessionState,
): readonly DurableSessionEffect[] {
  if (state.lifecycle !== "creating" || state.runtimeId === null) {
    throw new Error("Only a creating Session can produce initial effects.");
  }
  return [
    {
      type: "persistMetadata",
      sessionId: state.sessionId,
      sessionRevision: state.sessionRevision,
    },
    {
      type: "emitEvent",
      sessionId: state.sessionId,
      event: {
        type: "session.changed",
        lifecycle: state.lifecycle,
        sessionRevision: state.sessionRevision,
        runtimeId: state.runtimeId,
      },
    },
    {
      type: "spawn",
      sessionId: state.sessionId,
      runtimeId: state.runtimeId,
      command: state.command,
    },
  ];
}

export function toSessionView(state: DurableSessionState): SessionView {
  return {
    sessionId: state.sessionId,
    lifecycle: state.lifecycle,
    sessionRevision: state.sessionRevision,
    runtimeId: state.runtimeId,
    terminal: { cols: state.terminal.cols, rows: state.terminal.rows },
    controllerAttachmentId: state.controllerAttachmentId,
    controllerGeneration: state.controllerGeneration,
    nextSequence: state.nextSequence,
    command: redactCommand(state.command),
    createdAtMs: state.createdAtMs,
    updatedAtMs: state.updatedAtMs,
  };
}

export function assertSessionInvariants(state: DurableSessionState): void {
  const liveLifecycle =
    state.lifecycle === "creating" ||
    state.lifecycle === "running" ||
    state.lifecycle === "stopping";
  if (liveLifecycle !== (state.runtimeId !== null)) {
    throw new Error("Runtime identity does not match Session lifecycle.");
  }
  if (!Number.isSafeInteger(state.sessionRevision) || state.sessionRevision < 0) {
    throw new Error("Session revision is not a monotonic ordinal.");
  }
  if (!Number.isSafeInteger(state.controllerGeneration) || state.controllerGeneration < 0) {
    throw new Error("Controller generation is not a monotonic ordinal.");
  }
  if (!Number.isSafeInteger(state.nextSequence) || state.nextSequence < 0) {
    throw new Error("Terminal sequence is not a monotonic ordinal.");
  }

  const controllers = Object.values(state.attachments).filter(
    (attachment) => attachment.role === "controller",
  );
  if (controllers.length > 1) throw new Error("A Session has more than one controller.");
  if (state.controllerAttachmentId === null) {
    if (controllers.length !== 0)
      throw new Error("Controller role exists without controller identity.");
  } else if (
    controllers.length !== 1 ||
    controllers[0]?.attachmentId !== state.controllerAttachmentId
  ) {
    throw new Error("Controller identity and attachment role disagree.");
  }

  for (const request of Object.values(state.pendingControlRequests)) {
    if (request.controllerGeneration !== state.controllerGeneration) {
      throw new Error("A pending control request belongs to a stale generation.");
    }
    if (state.attachments[request.requesterAttachmentId] === undefined) {
      throw new Error("A pending control request references a missing attachment.");
    }
  }
  const offer = state.activeControlOffer;
  if (offer !== null) {
    if (offer.controllerGeneration !== state.controllerGeneration) {
      throw new Error("The active control offer belongs to a stale generation.");
    }
    if (state.pendingControlRequests[offer.controlRequestId] === undefined) {
      throw new Error("The active control offer has no pending request.");
    }
    if (offer.controllerAttachmentId !== state.controllerAttachmentId) {
      throw new Error("The active control offer was not issued by the current controller.");
    }
  }
}

function redactCommand(command: CommandSpecV0): RedactedCommandReference {
  if (command.kind === "profile") {
    return { kind: "profile", profileId: command.profileId, rootId: command.cwd.rootId };
  }
  const components = command.executable.split("/");
  return {
    kind: "exec",
    executableLabel: components.at(-1) || "executable",
    rootId: command.cwd.rootId,
  };
}
