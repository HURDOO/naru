import { DURABLE_SESSION_LIMITS } from "@naru/contracts/durable-session/v0";
import type {
  AttachmentId,
  ControlOfferId,
  ControlRequestId,
  DurableSessionError,
  InputId,
  RuntimeId,
  TerminalSize,
} from "@naru/contracts/durable-session/v0";
import {
  assertSessionInvariants,
  type ActiveControlOfferState,
  type AttachmentState,
  type ControlChangeReason,
  type DurableSessionDomainEvent,
  type DurableSessionEffect,
  type DurableSessionState,
  type PendingControlRequestState,
} from "./model.js";

export type DurableSessionCommand =
  | {
      readonly type: "spawnSucceeded";
      readonly expectedSessionRevision: number;
      readonly expectedRuntimeId: RuntimeId;
      readonly nowMs: number;
    }
  | {
      readonly type: "spawnFailed";
      readonly expectedSessionRevision: number;
      readonly expectedRuntimeId: RuntimeId;
      readonly nowMs: number;
    }
  | {
      readonly type: "start";
      readonly expectedSessionRevision: number;
      readonly newRuntimeId: RuntimeId;
      readonly nowMs: number;
    }
  | {
      readonly type: "stop";
      readonly expectedSessionRevision: number;
      readonly expectedRuntimeId: RuntimeId;
      readonly nowMs: number;
    }
  | {
      readonly type: "runtimeExited";
      readonly expectedRuntimeId: RuntimeId;
      readonly exitCode: number | null;
      readonly signal: number | null;
      readonly nowMs: number;
    }
  | {
      readonly type: "runtimeFailed";
      readonly expectedRuntimeId: RuntimeId;
      readonly nowMs: number;
    }
  | {
      readonly type: "recoverRuntimeLost";
      readonly expectedRuntimeId: RuntimeId;
      readonly nowMs: number;
    }
  | { readonly type: "forget"; readonly expectedSessionRevision: number; readonly nowMs: number }
  | {
      readonly type: "openAttachment";
      readonly attachmentId: AttachmentId;
      readonly nowMs: number;
    }
  | {
      readonly type: "disconnectAttachment";
      readonly attachmentId: AttachmentId;
      readonly nowMs: number;
    }
  | {
      readonly type: "resumeAttachment";
      readonly attachmentId: AttachmentId;
      readonly expectedRuntimeId: RuntimeId;
      readonly expectedControllerGeneration: number;
      readonly nowMs: number;
    }
  | {
      readonly type: "heartbeat";
      readonly attachmentId: AttachmentId;
      readonly expectedRuntimeId: RuntimeId;
      readonly expectedControllerGeneration: number;
      readonly nowMs: number;
    }
  | {
      readonly type: "closeAttachment";
      readonly attachmentId: AttachmentId;
      readonly nowMs: number;
    }
  | {
      readonly type: "acquireControl";
      readonly attachmentId: AttachmentId;
      readonly expectedRuntimeId: RuntimeId;
      readonly expectedControllerGeneration: number;
      readonly terminal: TerminalSize;
      readonly nowMs: number;
    }
  | {
      readonly type: "requestControl";
      readonly attachmentId: AttachmentId;
      readonly controlRequestId: ControlRequestId;
      readonly expectedControllerGeneration: number;
      readonly nowMs: number;
    }
  | {
      readonly type: "approveControl";
      readonly attachmentId: AttachmentId;
      readonly controlRequestId: ControlRequestId;
      readonly controlOfferId: ControlOfferId;
      readonly expectedControllerGeneration: number;
      readonly nowMs: number;
    }
  | {
      readonly type: "rejectControl";
      readonly attachmentId: AttachmentId;
      readonly controlRequestId: ControlRequestId;
      readonly expectedControllerGeneration: number;
      readonly nowMs: number;
    }
  | {
      readonly type: "acceptControl";
      readonly attachmentId: AttachmentId;
      readonly controlOfferId: ControlOfferId;
      readonly expectedRuntimeId: RuntimeId;
      readonly expectedControllerGeneration: number;
      readonly terminal: TerminalSize;
      readonly nowMs: number;
    }
  | {
      readonly type: "preemptControl";
      readonly attachmentId: AttachmentId;
      readonly expectedRuntimeId: RuntimeId;
      readonly expectedControllerGeneration: number;
      readonly terminal: TerminalSize;
      readonly nowMs: number;
    }
  | {
      readonly type: "releaseControl";
      readonly attachmentId: AttachmentId;
      readonly expectedControllerGeneration: number;
      readonly nowMs: number;
    }
  | { readonly type: "expire"; readonly nowMs: number }
  | {
      readonly type: "sendInput";
      readonly attachmentId: AttachmentId;
      readonly expectedRuntimeId: RuntimeId;
      readonly expectedControllerGeneration: number;
      readonly inputId: InputId;
      readonly data: string;
      readonly nowMs: number;
    }
  | {
      readonly type: "resizeTerminal";
      readonly attachmentId: AttachmentId;
      readonly expectedRuntimeId: RuntimeId;
      readonly expectedControllerGeneration: number;
      readonly terminal: TerminalSize;
      readonly nowMs: number;
    }
  | {
      readonly type: "recordOutput";
      readonly expectedRuntimeId: RuntimeId;
      readonly nowMs: number;
    };

export type DurableSessionTransition =
  | {
      readonly ok: true;
      readonly state: DurableSessionState;
      readonly effects: readonly DurableSessionEffect[];
    }
  | {
      readonly ok: false;
      readonly state: DurableSessionState;
      readonly effects: readonly [];
      readonly error: DurableSessionError;
    };

export function reduceDurableSession(
  state: DurableSessionState,
  command: DurableSessionCommand,
): DurableSessionTransition {
  if (!Number.isSafeInteger(command.nowMs) || command.nowMs < state.updatedAtMs) {
    return failure(state, error("REQUEST_INVALID", "Monotonic clock moved backwards."));
  }
  switch (command.type) {
    case "spawnSucceeded":
      return spawnSucceeded(state, command);
    case "spawnFailed":
      return spawnFailed(state, command);
    case "start":
      return start(state, command);
    case "stop":
      return stop(state, command);
    case "runtimeExited":
      return runtimeExited(state, command);
    case "runtimeFailed":
      return runtimeFailed(state, command);
    case "recoverRuntimeLost":
      return recoverRuntimeLost(state, command);
    case "forget":
      return forget(state, command);
    case "openAttachment":
      return openAttachment(state, command);
    case "disconnectAttachment":
      return disconnectAttachment(state, command);
    case "resumeAttachment":
      return resumeAttachment(state, command);
    case "heartbeat":
      return heartbeat(state, command);
    case "closeAttachment":
      return closeAttachment(state, command);
    case "acquireControl":
      return acquireControl(state, command);
    case "requestControl":
      return requestControl(state, command);
    case "approveControl":
      return approveControl(state, command);
    case "rejectControl":
      return rejectControl(state, command);
    case "acceptControl":
      return acceptControl(state, command);
    case "preemptControl":
      return preemptControl(state, command);
    case "releaseControl":
      return releaseControl(state, command);
    case "expire":
      return expire(state, command);
    case "sendInput":
      return sendInput(state, command);
    case "resizeTerminal":
      return resizeTerminal(state, command);
    case "recordOutput":
      return recordOutput(state, command);
  }
}

function spawnSucceeded(
  state: DurableSessionState,
  command: Extract<DurableSessionCommand, { type: "spawnSucceeded" }>,
): DurableSessionTransition {
  const stale = checkRevisionAndRuntime(
    state,
    command.expectedSessionRevision,
    command.expectedRuntimeId,
  );
  if (stale !== null) return failure(state, stale);
  if (state.lifecycle !== "creating") return invalidState(state, "Session is not creating.");
  return lifecycleTransition(state, "running", command.nowMs);
}

function spawnFailed(
  state: DurableSessionState,
  command: Extract<DurableSessionCommand, { type: "spawnFailed" }>,
): DurableSessionTransition {
  const stale = checkRevisionAndRuntime(
    state,
    command.expectedSessionRevision,
    command.expectedRuntimeId,
  );
  if (stale !== null) return failure(state, stale);
  if (state.lifecycle !== "creating") return invalidState(state, "Session is not creating.");
  const next = {
    ...state,
    lifecycle: "failed" as const,
    sessionRevision: state.sessionRevision + 1,
    runtimeId: null,
    lastRuntime: {
      runtimeId: command.expectedRuntimeId,
      reason: "spawn-failed" as const,
      exitCode: null,
      signal: null,
    },
    updatedAtMs: command.nowMs,
  };
  return success(next, lifecycleEffects(next));
}

function start(
  state: DurableSessionState,
  command: Extract<DurableSessionCommand, { type: "start" }>,
): DurableSessionTransition {
  const revisionError = checkRevision(state, command.expectedSessionRevision);
  if (revisionError !== null) return failure(state, revisionError);
  if (!isTerminalLifecycle(state.lifecycle)) {
    return invalidState(state, "Only a terminal Session can start a new runtime.");
  }
  const next: DurableSessionState = {
    ...state,
    lifecycle: "creating",
    sessionRevision: state.sessionRevision + 1,
    runtimeId: command.newRuntimeId,
    nextSequence: 0,
    lastRuntime: state.lastRuntime,
    updatedAtMs: command.nowMs,
  };
  return success(next, [
    ...lifecycleEffects(next),
    {
      type: "spawn",
      sessionId: next.sessionId,
      runtimeId: command.newRuntimeId,
      command: next.command,
    },
  ]);
}

function stop(
  state: DurableSessionState,
  command: Extract<DurableSessionCommand, { type: "stop" }>,
): DurableSessionTransition {
  const stale = checkRevisionAndRuntime(
    state,
    command.expectedSessionRevision,
    command.expectedRuntimeId,
  );
  if (stale !== null) return failure(state, stale);
  if (state.lifecycle !== "running") return invalidState(state, "Only a running Session can stop.");

  const released = clearControl(state, "released", command.nowMs);
  const next: DurableSessionState = {
    ...released.state,
    lifecycle: "stopping",
    sessionRevision: state.sessionRevision + 1,
    updatedAtMs: command.nowMs,
  };
  return success(next, [
    ...released.effects,
    ...lifecycleEffects(next),
    { type: "kill", sessionId: state.sessionId, runtimeId: command.expectedRuntimeId },
  ]);
}

function runtimeExited(
  state: DurableSessionState,
  command: Extract<DurableSessionCommand, { type: "runtimeExited" }>,
): DurableSessionTransition {
  const runtimeError = checkRuntime(state, command.expectedRuntimeId);
  if (runtimeError !== null) return failure(state, runtimeError);
  if (
    state.lifecycle !== "running" &&
    state.lifecycle !== "stopping" &&
    state.lifecycle !== "creating"
  ) {
    return invalidState(state, "Session cannot accept a runtime exit in its current lifecycle.");
  }

  const target =
    state.lifecycle === "stopping"
      ? "stopped"
      : state.lifecycle === "creating"
        ? "failed"
        : "exited";
  const reason =
    state.lifecycle === "stopping"
      ? "explicit-stop"
      : state.lifecycle === "creating"
        ? "spawn-failed"
        : "natural-exit";
  const released = clearControl(state, "released", command.nowMs);
  const next: DurableSessionState = {
    ...released.state,
    lifecycle: target,
    sessionRevision: state.sessionRevision + 1,
    runtimeId: null,
    lastRuntime: {
      runtimeId: command.expectedRuntimeId,
      reason,
      exitCode: command.exitCode,
      signal: command.signal,
    },
    updatedAtMs: command.nowMs,
  };
  return success(next, [...released.effects, ...lifecycleEffects(next)]);
}

function runtimeFailed(
  state: DurableSessionState,
  command: Extract<DurableSessionCommand, { type: "runtimeFailed" }>,
): DurableSessionTransition {
  const runtimeError = checkRuntime(state, command.expectedRuntimeId);
  if (runtimeError !== null) return failure(state, runtimeError);
  if (
    state.lifecycle !== "creating" &&
    state.lifecycle !== "running" &&
    state.lifecycle !== "stopping"
  ) {
    return invalidState(state, "Session cannot fail a runtime in its current lifecycle.");
  }

  const released = clearControl(state, "expired", command.nowMs);
  const next: DurableSessionState = {
    ...released.state,
    lifecycle: "failed",
    sessionRevision: state.sessionRevision + 1,
    runtimeId: null,
    lastRuntime: {
      runtimeId: command.expectedRuntimeId,
      reason: "runtime-failed",
      exitCode: null,
      signal: null,
    },
    updatedAtMs: command.nowMs,
  };
  return success(next, [...released.effects, ...lifecycleEffects(next)]);
}

function recoverRuntimeLost(
  state: DurableSessionState,
  command: Extract<DurableSessionCommand, { type: "recoverRuntimeLost" }>,
): DurableSessionTransition {
  const runtimeError = checkRuntime(state, command.expectedRuntimeId);
  if (runtimeError !== null) return failure(state, runtimeError);
  if (
    state.lifecycle !== "creating" &&
    state.lifecycle !== "running" &&
    state.lifecycle !== "stopping"
  ) {
    return invalidState(state, "Only a live Session can recover a lost runtime.");
  }

  const released = clearControl(state, "expired", command.nowMs);
  const next: DurableSessionState = {
    ...released.state,
    lifecycle: "stopped",
    sessionRevision: state.sessionRevision + 1,
    runtimeId: null,
    nextSequence: 0,
    lastRuntime: {
      runtimeId: command.expectedRuntimeId,
      reason: "runtime-lost",
      exitCode: null,
      signal: null,
    },
    updatedAtMs: command.nowMs,
  };
  return success(next, [...released.effects, ...lifecycleEffects(next)]);
}

function forget(
  state: DurableSessionState,
  command: Extract<DurableSessionCommand, { type: "forget" }>,
): DurableSessionTransition {
  const revisionError = checkRevision(state, command.expectedSessionRevision);
  if (revisionError !== null) return failure(state, revisionError);
  if (!isTerminalLifecycle(state.lifecycle)) {
    return invalidState(state, "A live Session cannot be forgotten.");
  }
  return success(state, [
    ...Object.values(state.attachments).map((attachment): DurableSessionEffect => ({
      type: "closeAttachment",
      sessionId: state.sessionId,
      attachmentId: attachment.attachmentId,
      reason: "session-forgotten",
    })),
    { type: "deleteMetadata", sessionId: state.sessionId },
  ]);
}

function openAttachment(
  state: DurableSessionState,
  command: Extract<DurableSessionCommand, { type: "openAttachment" }>,
): DurableSessionTransition {
  if (state.attachments[command.attachmentId] !== undefined) {
    return failure(state, error("REQUEST_INVALID", "Attachment identity is already registered."));
  }
  const attachment: AttachmentState = {
    attachmentId: command.attachmentId,
    role: "observer",
    connected: true,
    lastSeenAtMs: command.nowMs,
    graceExpiresAtMs: null,
  };
  return success(
    {
      ...state,
      attachments: { ...state.attachments, [command.attachmentId]: attachment },
      updatedAtMs: command.nowMs,
    },
    [],
  );
}

function disconnectAttachment(
  state: DurableSessionState,
  command: Extract<DurableSessionCommand, { type: "disconnectAttachment" }>,
): DurableSessionTransition {
  const attachment = state.attachments[command.attachmentId];
  if (attachment === undefined) return missingAttachment(state);
  return success(
    {
      ...state,
      attachments: {
        ...state.attachments,
        [command.attachmentId]: {
          ...attachment,
          connected: false,
          graceExpiresAtMs: command.nowMs + DURABLE_SESSION_LIMITS.reconnectGraceMs,
        },
      },
      updatedAtMs: command.nowMs,
    },
    [],
  );
}

function resumeAttachment(
  state: DurableSessionState,
  command: Extract<DurableSessionCommand, { type: "resumeAttachment" }>,
): DurableSessionTransition {
  const stale = checkRuntimeAndGeneration(
    state,
    command.expectedRuntimeId,
    command.expectedControllerGeneration,
  );
  if (stale !== null) return failure(state, stale);
  const attachment = state.attachments[command.attachmentId];
  if (attachment === undefined) return missingAttachment(state);
  if (
    attachment.connected ||
    attachment.graceExpiresAtMs === null ||
    command.nowMs >= attachment.graceExpiresAtMs
  ) {
    return failure(
      state,
      error("ATTACHMENT_RESUME_REJECTED", "Attachment resume lease is not valid."),
    );
  }
  return success(
    {
      ...state,
      attachments: {
        ...state.attachments,
        [command.attachmentId]: {
          ...attachment,
          connected: true,
          lastSeenAtMs: command.nowMs,
          graceExpiresAtMs: null,
        },
      },
      updatedAtMs: command.nowMs,
    },
    [],
  );
}

function heartbeat(
  state: DurableSessionState,
  command: Extract<DurableSessionCommand, { type: "heartbeat" }>,
): DurableSessionTransition {
  const stale = checkRuntimeAndGeneration(
    state,
    command.expectedRuntimeId,
    command.expectedControllerGeneration,
  );
  if (stale !== null) return failure(state, stale);
  const attachment = state.attachments[command.attachmentId];
  if (attachment === undefined) return missingAttachment(state);
  if (!attachment.connected)
    return invalidState(state, "Disconnected attachment cannot heartbeat.");
  return success(
    {
      ...state,
      attachments: {
        ...state.attachments,
        [command.attachmentId]: { ...attachment, lastSeenAtMs: command.nowMs },
      },
      updatedAtMs: command.nowMs,
    },
    [],
  );
}

function closeAttachment(
  state: DurableSessionState,
  command: Extract<DurableSessionCommand, { type: "closeAttachment" }>,
): DurableSessionTransition {
  if (state.attachments[command.attachmentId] === undefined) return missingAttachment(state);
  const closed = removeAttachments(state, [command.attachmentId], "closed", command.nowMs);
  return success(closed.state, closed.effects);
}

function acquireControl(
  state: DurableSessionState,
  command: Extract<DurableSessionCommand, { type: "acquireControl" }>,
): DurableSessionTransition {
  const ready = checkControlMutation(state, command);
  if (ready !== null) return failure(state, ready);
  if (state.controllerAttachmentId !== null) {
    return failure(state, error("CONTROL_HELD", "Session control is already held."));
  }
  const attachmentError = checkConnectedAttachment(state, command.attachmentId);
  if (attachmentError !== null) return failure(state, attachmentError);
  const changed = assignController(
    state,
    command.attachmentId,
    command.terminal,
    "acquired",
    command.nowMs,
  );
  return success(changed.state, changed.effects);
}

function requestControl(
  state: DurableSessionState,
  command: Extract<DurableSessionCommand, { type: "requestControl" }>,
): DurableSessionTransition {
  const generationError = checkGeneration(state, command.expectedControllerGeneration);
  if (generationError !== null) return failure(state, generationError);
  if (state.lifecycle !== "running") return notRunning(state);
  const attachmentError = checkConnectedAttachment(state, command.attachmentId);
  if (attachmentError !== null) return failure(state, attachmentError);
  if (state.controllerAttachmentId === null) {
    return invalidState(state, "Control is available; acquire it instead of requesting transfer.");
  }
  if (state.controllerAttachmentId === command.attachmentId) {
    return failure(state, error("CONTROL_HELD", "Attachment already controls the Session."));
  }
  if (
    state.pendingControlRequests[command.controlRequestId] !== undefined ||
    Object.values(state.pendingControlRequests).some(
      (request) => request.requesterAttachmentId === command.attachmentId,
    )
  ) {
    return failure(
      state,
      error("REQUEST_INVALID", "Attachment already has a pending control request."),
    );
  }

  const request: PendingControlRequestState = {
    controlRequestId: command.controlRequestId,
    requesterAttachmentId: command.attachmentId,
    controllerGeneration: state.controllerGeneration,
    expiresAtMs: command.nowMs + DURABLE_SESSION_LIMITS.controlRequestTtlMs,
  };
  const next = {
    ...state,
    pendingControlRequests: {
      ...state.pendingControlRequests,
      [command.controlRequestId]: request,
    },
    updatedAtMs: command.nowMs,
  };
  return success(next, [
    eventEffect(state, {
      type: "control.requested",
      controllerGeneration: state.controllerGeneration,
      request,
    }),
  ]);
}

function approveControl(
  state: DurableSessionState,
  command: Extract<DurableSessionCommand, { type: "approveControl" }>,
): DurableSessionTransition {
  const actorError = checkCurrentController(state, command);
  if (actorError !== null) return failure(state, actorError);
  const request = state.pendingControlRequests[command.controlRequestId];
  if (request === undefined) return controlRequestMissing(state);
  if (command.nowMs >= request.expiresAtMs) return controlRequestExpired(state);
  if (state.activeControlOffer !== null) {
    return failure(state, error("CONTROL_HELD", "Another control offer is already active."));
  }
  const requesterError = checkConnectedAttachment(state, request.requesterAttachmentId);
  if (requesterError !== null) return failure(state, requesterError);

  const offer: ActiveControlOfferState = {
    controlOfferId: command.controlOfferId,
    controlRequestId: request.controlRequestId,
    requesterAttachmentId: request.requesterAttachmentId,
    controllerAttachmentId: command.attachmentId,
    controllerGeneration: state.controllerGeneration,
    expiresAtMs: command.nowMs + DURABLE_SESSION_LIMITS.controlOfferTtlMs,
  };
  return success({ ...state, activeControlOffer: offer, updatedAtMs: command.nowMs }, [
    eventEffect(state, {
      type: "control.offered",
      controllerGeneration: state.controllerGeneration,
      offer,
    }),
  ]);
}

function rejectControl(
  state: DurableSessionState,
  command: Extract<DurableSessionCommand, { type: "rejectControl" }>,
): DurableSessionTransition {
  const actorError = checkCurrentController(state, command);
  if (actorError !== null) return failure(state, actorError);
  const request = state.pendingControlRequests[command.controlRequestId];
  if (request === undefined) return controlRequestMissing(state);
  if (command.nowMs >= request.expiresAtMs) return controlRequestExpired(state);
  const requests = { ...state.pendingControlRequests };
  delete requests[command.controlRequestId];
  const next = {
    ...state,
    pendingControlRequests: requests,
    activeControlOffer:
      state.activeControlOffer?.controlRequestId === command.controlRequestId
        ? null
        : state.activeControlOffer,
    updatedAtMs: command.nowMs,
  };
  return success(next, [
    eventEffect(state, {
      type: "control.request-resolved",
      controllerGeneration: state.controllerGeneration,
      controlRequestId: command.controlRequestId,
      resolution: "rejected",
    }),
  ]);
}

function acceptControl(
  state: DurableSessionState,
  command: Extract<DurableSessionCommand, { type: "acceptControl" }>,
): DurableSessionTransition {
  const ready = checkControlMutation(state, command);
  if (ready !== null) return failure(state, ready);
  const attachmentError = checkConnectedAttachment(state, command.attachmentId);
  if (attachmentError !== null) return failure(state, attachmentError);
  const offer = state.activeControlOffer;
  if (
    offer === null ||
    offer.controlOfferId !== command.controlOfferId ||
    offer.requesterAttachmentId !== command.attachmentId
  ) {
    return failure(
      state,
      error("CONTROL_OFFER_NOT_FOUND", "Control offer is not active for this attachment."),
    );
  }
  if (command.nowMs >= offer.expiresAtMs) {
    return failure(state, error("CONTROL_REQUEST_EXPIRED", "Control offer has expired."));
  }
  const changed = assignController(
    state,
    command.attachmentId,
    command.terminal,
    "transferred",
    command.nowMs,
  );
  return success(changed.state, changed.effects);
}

function preemptControl(
  state: DurableSessionState,
  command: Extract<DurableSessionCommand, { type: "preemptControl" }>,
): DurableSessionTransition {
  const ready = checkControlMutation(state, command);
  if (ready !== null) return failure(state, ready);
  const attachmentError = checkConnectedAttachment(state, command.attachmentId);
  if (attachmentError !== null) return failure(state, attachmentError);
  if (state.controllerAttachmentId === command.attachmentId) {
    return failure(state, error("CONTROL_HELD", "Attachment already controls the Session."));
  }
  const changed = assignController(
    state,
    command.attachmentId,
    command.terminal,
    "preempted",
    command.nowMs,
  );
  return success(changed.state, changed.effects);
}

function releaseControl(
  state: DurableSessionState,
  command: Extract<DurableSessionCommand, { type: "releaseControl" }>,
): DurableSessionTransition {
  const actorError = checkCurrentController(state, command);
  if (actorError !== null) return failure(state, actorError);
  const released = clearControl(state, "released", command.nowMs);
  return success(released.state, released.effects);
}

function expire(
  state: DurableSessionState,
  command: Extract<DurableSessionCommand, { type: "expire" }>,
): DurableSessionTransition {
  const expiredAttachments = Object.values(state.attachments)
    .filter(
      (attachment) =>
        (!attachment.connected &&
          attachment.graceExpiresAtMs !== null &&
          command.nowMs >= attachment.graceExpiresAtMs) ||
        (attachment.connected &&
          command.nowMs - attachment.lastSeenAtMs >= DURABLE_SESSION_LIMITS.staleAfterMs),
    )
    .map((attachment) => attachment.attachmentId);
  const removed = removeAttachments(state, expiredAttachments, "expired", command.nowMs);

  const requests = { ...removed.state.pendingControlRequests };
  const effects = [...removed.effects];
  const resolvedRequestIds = new Set<ControlRequestId>();
  for (const request of Object.values(requests)) {
    if (command.nowMs >= request.expiresAtMs) {
      delete requests[request.controlRequestId];
      resolvedRequestIds.add(request.controlRequestId);
      effects.push(
        eventEffect(removed.state, {
          type: "control.request-resolved",
          controllerGeneration: removed.state.controllerGeneration,
          controlRequestId: request.controlRequestId,
          resolution: "expired",
        }),
      );
    }
  }
  let offer = removed.state.activeControlOffer;
  if (offer !== null && command.nowMs >= offer.expiresAtMs) {
    delete requests[offer.controlRequestId];
    if (!resolvedRequestIds.has(offer.controlRequestId)) {
      effects.push(
        eventEffect(removed.state, {
          type: "control.request-resolved",
          controllerGeneration: removed.state.controllerGeneration,
          controlRequestId: offer.controlRequestId,
          resolution: "expired",
        }),
      );
    }
    offer = null;
  }

  if (
    expiredAttachments.length === 0 &&
    Object.keys(requests).length === Object.keys(state.pendingControlRequests).length &&
    offer === state.activeControlOffer
  ) {
    return success(state, []);
  }
  return success(
    {
      ...removed.state,
      pendingControlRequests: requests,
      activeControlOffer: offer,
      updatedAtMs: command.nowMs,
    },
    effects,
  );
}

function sendInput(
  state: DurableSessionState,
  command: Extract<DurableSessionCommand, { type: "sendInput" }>,
): DurableSessionTransition {
  const actorError = checkCurrentControllerWithRuntime(state, command);
  if (actorError !== null) return failure(state, actorError);
  return success(state, [
    {
      type: "writePty",
      sessionId: state.sessionId,
      runtimeId: command.expectedRuntimeId,
      inputId: command.inputId,
      data: command.data,
    },
  ]);
}

function resizeTerminal(
  state: DurableSessionState,
  command: Extract<DurableSessionCommand, { type: "resizeTerminal" }>,
): DurableSessionTransition {
  const actorError = checkCurrentControllerWithRuntime(state, command);
  if (actorError !== null) return failure(state, actorError);
  const next = { ...state, terminal: command.terminal, updatedAtMs: command.nowMs };
  return success(next, [
    {
      type: "resizePty",
      sessionId: state.sessionId,
      runtimeId: command.expectedRuntimeId,
      terminal: command.terminal,
    },
    metadataEffect(next),
  ]);
}

function recordOutput(
  state: DurableSessionState,
  command: Extract<DurableSessionCommand, { type: "recordOutput" }>,
): DurableSessionTransition {
  const runtimeError = checkRuntime(state, command.expectedRuntimeId);
  if (runtimeError !== null) return failure(state, runtimeError);
  if (state.lifecycle !== "running" && state.lifecycle !== "stopping") return notRunning(state);
  if (state.nextSequence >= Number.MAX_SAFE_INTEGER) {
    return failure(state, error("SESSION_STATE_INVALID", "Terminal sequence is exhausted."));
  }
  return success(
    { ...state, nextSequence: state.nextSequence + 1, updatedAtMs: command.nowMs },
    [],
  );
}

function assignController(
  state: DurableSessionState,
  attachmentId: AttachmentId,
  terminal: TerminalSize,
  reason: Extract<ControlChangeReason, "acquired" | "transferred" | "preempted">,
  nowMs: number,
): { readonly state: DurableSessionState; readonly effects: readonly DurableSessionEffect[] } {
  const previous = state.controllerAttachmentId;
  const nextGeneration = state.controllerGeneration + 1;
  const attachments = Object.fromEntries(
    Object.entries(state.attachments).map(([id, attachment]) => [
      id,
      { ...attachment, role: id === attachmentId ? "controller" : "observer" },
    ]),
  ) as Record<AttachmentId, AttachmentState>;
  const resolutionEffects = resolveAllControlRequests(state, "controller-changed");
  const next: DurableSessionState = {
    ...state,
    terminal,
    controllerAttachmentId: attachmentId,
    controllerGeneration: nextGeneration,
    attachments,
    pendingControlRequests: {},
    activeControlOffer: null,
    updatedAtMs: nowMs,
  };
  const runtimeId = requireRuntime(next);
  return {
    state: next,
    effects: [
      { type: "resizePty", sessionId: next.sessionId, runtimeId, terminal },
      metadataEffect(next),
      ...resolutionEffects,
      eventEffect(next, {
        type: "control.changed",
        previousControllerAttachmentId: previous,
        controllerAttachmentId: attachmentId,
        controllerGeneration: nextGeneration,
        terminal,
        reason,
      }),
    ],
  };
}

function clearControl(
  state: DurableSessionState,
  reason: Extract<ControlChangeReason, "released" | "expired" | "closed">,
  nowMs: number,
): { readonly state: DurableSessionState; readonly effects: readonly DurableSessionEffect[] } {
  if (
    state.controllerAttachmentId === null &&
    Object.keys(state.pendingControlRequests).length === 0
  ) {
    return { state, effects: [] };
  }
  const previous = state.controllerAttachmentId;
  const generation =
    previous === null ? state.controllerGeneration : state.controllerGeneration + 1;
  const attachments = Object.fromEntries(
    Object.entries(state.attachments).map(([id, attachment]) => [
      id,
      { ...attachment, role: "observer" },
    ]),
  ) as Record<AttachmentId, AttachmentState>;
  const next: DurableSessionState = {
    ...state,
    controllerAttachmentId: null,
    controllerGeneration: generation,
    attachments,
    pendingControlRequests: {},
    activeControlOffer: null,
    updatedAtMs: nowMs,
  };
  const effects: DurableSessionEffect[] = [
    ...resolveAllControlRequests(state, "controller-changed"),
  ];
  if (previous !== null) {
    effects.push(
      metadataEffect(next),
      eventEffect(next, {
        type: "control.changed",
        previousControllerAttachmentId: previous,
        controllerAttachmentId: null,
        controllerGeneration: generation,
        terminal: next.terminal,
        reason,
      }),
      eventEffect(next, { type: "control.available", controllerGeneration: generation }),
    );
  }
  return { state: next, effects };
}

function removeAttachments(
  state: DurableSessionState,
  attachmentIds: readonly AttachmentId[],
  reason: Extract<ControlChangeReason, "expired" | "closed">,
  nowMs: number,
): { readonly state: DurableSessionState; readonly effects: readonly DurableSessionEffect[] } {
  if (attachmentIds.length === 0) return { state, effects: [] };
  const removal = new Set(attachmentIds);
  const controllerRemoved =
    state.controllerAttachmentId !== null && removal.has(state.controllerAttachmentId);
  const released = controllerRemoved ? clearControl(state, reason, nowMs) : { state, effects: [] };
  const attachments = { ...released.state.attachments };
  const requests = { ...released.state.pendingControlRequests };
  let offer = released.state.activeControlOffer;
  const effects = [...released.effects];

  for (const attachmentId of removal) {
    if (attachments[attachmentId] === undefined) continue;
    delete attachments[attachmentId];
    for (const request of Object.values(requests)) {
      if (request.requesterAttachmentId === attachmentId) {
        delete requests[request.controlRequestId];
        effects.push(
          eventEffect(released.state, {
            type: "control.request-resolved",
            controllerGeneration: released.state.controllerGeneration,
            controlRequestId: request.controlRequestId,
            resolution: "requester-closed",
          }),
        );
      }
    }
    if (offer?.requesterAttachmentId === attachmentId) offer = null;
    effects.push({
      type: "closeAttachment",
      sessionId: state.sessionId,
      attachmentId,
      reason: reason === "expired" ? "grace-expired" : "closed",
    });
  }
  return {
    state: {
      ...released.state,
      attachments,
      pendingControlRequests: requests,
      activeControlOffer: offer,
      updatedAtMs: nowMs,
    },
    effects,
  };
}

function resolveAllControlRequests(
  state: DurableSessionState,
  resolution: Extract<
    DurableSessionDomainEvent,
    { type: "control.request-resolved" }
  >["resolution"],
): readonly DurableSessionEffect[] {
  return Object.values(state.pendingControlRequests).map((request) =>
    eventEffect(state, {
      type: "control.request-resolved",
      controllerGeneration: state.controllerGeneration,
      controlRequestId: request.controlRequestId,
      resolution,
    }),
  );
}

function lifecycleTransition(
  state: DurableSessionState,
  lifecycle: "running",
  nowMs: number,
): DurableSessionTransition {
  const next = {
    ...state,
    lifecycle,
    sessionRevision: state.sessionRevision + 1,
    updatedAtMs: nowMs,
  };
  return success(next, lifecycleEffects(next));
}

function lifecycleEffects(state: DurableSessionState): readonly DurableSessionEffect[] {
  return [
    metadataEffect(state),
    eventEffect(state, {
      type: "session.changed",
      lifecycle: state.lifecycle,
      sessionRevision: state.sessionRevision,
      runtimeId: state.runtimeId,
    }),
  ];
}

function metadataEffect(state: DurableSessionState): DurableSessionEffect {
  return {
    type: "persistMetadata",
    sessionId: state.sessionId,
    sessionRevision: state.sessionRevision,
  };
}

function eventEffect(
  state: DurableSessionState,
  event: DurableSessionDomainEvent,
): DurableSessionEffect {
  return { type: "emitEvent", sessionId: state.sessionId, event };
}

function checkControlMutation(
  state: DurableSessionState,
  command: {
    readonly expectedRuntimeId: RuntimeId;
    readonly expectedControllerGeneration: number;
  },
): DurableSessionError | null {
  if (state.lifecycle !== "running") return error("SESSION_NOT_RUNNING", "Session is not running.");
  return checkRuntimeAndGeneration(
    state,
    command.expectedRuntimeId,
    command.expectedControllerGeneration,
  );
}

function checkCurrentController(
  state: DurableSessionState,
  command: { readonly attachmentId: AttachmentId; readonly expectedControllerGeneration: number },
): DurableSessionError | null {
  if (state.lifecycle !== "running") return error("SESSION_NOT_RUNNING", "Session is not running.");
  const generationError = checkGeneration(state, command.expectedControllerGeneration);
  if (generationError !== null) return generationError;
  const attachmentError = checkConnectedAttachment(state, command.attachmentId);
  if (attachmentError !== null) return attachmentError;
  if (state.controllerAttachmentId !== command.attachmentId) {
    return error("ATTACHMENT_NOT_CONTROLLER", "Attachment is not the current controller.");
  }
  return null;
}

function checkCurrentControllerWithRuntime(
  state: DurableSessionState,
  command: {
    readonly attachmentId: AttachmentId;
    readonly expectedRuntimeId: RuntimeId;
    readonly expectedControllerGeneration: number;
  },
): DurableSessionError | null {
  const ready = checkControlMutation(state, command);
  if (ready !== null) return ready;
  return checkCurrentController(state, command);
}

function checkConnectedAttachment(
  state: DurableSessionState,
  attachmentId: AttachmentId,
): DurableSessionError | null {
  const attachment = state.attachments[attachmentId];
  if (attachment === undefined) return error("ATTACHMENT_NOT_FOUND", "Attachment was not found.");
  if (!attachment.connected) return error("SESSION_STATE_INVALID", "Attachment is disconnected.");
  return null;
}

function checkRevision(state: DurableSessionState, expected: number): DurableSessionError | null {
  return state.sessionRevision === expected
    ? null
    : error("SESSION_REVISION_STALE", "Session revision is stale.");
}

function checkRuntime(state: DurableSessionState, expected: RuntimeId): DurableSessionError | null {
  return state.runtimeId === expected ? null : error("RUNTIME_STALE", "Runtime identity is stale.");
}

function checkGeneration(state: DurableSessionState, expected: number): DurableSessionError | null {
  return state.controllerGeneration === expected
    ? null
    : error("CONTROL_GENERATION_STALE", "Controller generation is stale.");
}

function checkRevisionAndRuntime(
  state: DurableSessionState,
  expectedRevision: number,
  expectedRuntimeId: RuntimeId,
): DurableSessionError | null {
  return checkRevision(state, expectedRevision) ?? checkRuntime(state, expectedRuntimeId);
}

function checkRuntimeAndGeneration(
  state: DurableSessionState,
  expectedRuntimeId: RuntimeId,
  expectedGeneration: number,
): DurableSessionError | null {
  return checkRuntime(state, expectedRuntimeId) ?? checkGeneration(state, expectedGeneration);
}

function requireRuntime(state: DurableSessionState): RuntimeId {
  if (state.runtimeId === null)
    throw new Error("Invariant violation: live operation has no runtime.");
  return state.runtimeId;
}

function isTerminalLifecycle(lifecycle: DurableSessionState["lifecycle"]): boolean {
  return lifecycle === "stopped" || lifecycle === "exited" || lifecycle === "failed";
}

function success(
  state: DurableSessionState,
  effects: readonly DurableSessionEffect[],
): DurableSessionTransition {
  assertSessionInvariants(state);
  return { ok: true, state, effects };
}

function failure(
  state: DurableSessionState,
  transitionError: DurableSessionError,
): DurableSessionTransition {
  return { ok: false, state, effects: [], error: transitionError };
}

function invalidState(state: DurableSessionState, message: string): DurableSessionTransition {
  return failure(state, error("SESSION_STATE_INVALID", message));
}

function notRunning(state: DurableSessionState): DurableSessionTransition {
  return failure(state, error("SESSION_NOT_RUNNING", "Session is not running."));
}

function missingAttachment(state: DurableSessionState): DurableSessionTransition {
  return failure(state, error("ATTACHMENT_NOT_FOUND", "Attachment was not found."));
}

function controlRequestMissing(state: DurableSessionState): DurableSessionTransition {
  return failure(state, error("CONTROL_REQUEST_NOT_FOUND", "Control request was not found."));
}

function controlRequestExpired(state: DurableSessionState): DurableSessionTransition {
  return failure(state, error("CONTROL_REQUEST_EXPIRED", "Control request has expired."));
}

function error(code: DurableSessionError["code"], message: string): DurableSessionError {
  return { code, message };
}
