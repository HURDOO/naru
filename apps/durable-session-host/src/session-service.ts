import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  DURABLE_SESSION_LIMITS,
  type AttachmentId,
  type ControlOfferId,
  type ControlRequestId,
  type DurableSessionCallerContext,
  type DurableSessionError,
  type DurableSessionEvent,
  type DurableSessionJournalEvent,
  type DurableSessionOperationRequest,
  type DurableSessionOperationResponse,
  type DurableSessionOperationResult,
  type EventId,
  type InputId,
  type ProtocolRequestId,
  type RuntimeId,
  type SessionId,
  SessionIdSchema,
  type TerminalSnapshot,
} from "@naru/contracts/durable-session/v0";
import {
  assertSessionInvariants,
  authorizeDurableSessionOperation,
  createSessionState,
  effectsForCreatedSession,
  reduceDurableSession,
  toSessionView,
  type DurableSessionDomainEvent,
  type DurableSessionEffect,
  type DurableSessionState,
  type DurableSessionTransition,
} from "@naru/domain/durable-session";
import { AttachmentCoordinator } from "./attachment-coordinator.js";
import type { HostCommandPolicy, Restartability } from "./command-policy.js";
import { BoundedEventJournal } from "./event-journal.js";
import { fromDurableSessionError, HostOperationError } from "./host-error.js";
import type { HostLogger } from "./logging.js";
import { silentHostLogger } from "./logging.js";
import type { MetadataRepository, StoredSession } from "./metadata.js";
import type { ResolvedLaunchCommand, RuntimeHandle, RuntimePort } from "./runtime.js";
import { BoundedTerminalState, type TerminalStateSnapshot } from "./terminal-state.js";

export interface HostClock {
  nowMs(): number;
}

export interface HostIds {
  sessionId(): SessionId;
  runtimeId(): RuntimeId;
  attachmentId(): AttachmentId;
  controlRequestId(): ControlRequestId;
  controlOfferId(): ControlOfferId;
  eventId(): EventId;
  diagnosticId(): string;
}

export interface SessionServiceOptions {
  readonly metadata: MetadataRepository;
  readonly runtime: RuntimePort;
  readonly commandPolicy: HostCommandPolicy;
  readonly sessionLimit: number;
  readonly idempotencyTtlMs: number;
  readonly idempotencyLimit?: number;
  readonly maxAttachmentsPerSession?: number;
  readonly attachmentQueueBytes?: number;
  readonly eventJournalLimit?: number;
  readonly inputDedupeTtlMs?: number;
  readonly inputDedupeLimit?: number;
  readonly expirySweepIntervalMs?: number;
  readonly clock?: HostClock;
  readonly ids?: HostIds;
  readonly logger?: HostLogger;
}

export interface HostOperationExecutionContext {
  readonly integrationBootstrapKey?: Uint8Array;
}

interface SessionIntegrationAuthorization {
  readonly appId: string;
  readonly subject: string;
  readonly bootstrapKey: Buffer;
}

interface SessionEntry {
  state: DurableSessionState;
  readonly restartability: Restartability;
  readonly commandAvailable: boolean;
  readonly integrationAuthorization?: SessionIntegrationAuthorization;
}

interface ActiveRuntime {
  readonly handle: RuntimeHandle;
  readonly terminal: BoundedTerminalState;
  readonly stopTimeoutMs: number;
  readonly outputQueueLimitCharacters: number;
  readonly pendingOutput: string[];
  pendingOutputCharacters: number;
  outputDrainScheduled: boolean;
  outputFailed: boolean;
}

type ResponsePayload =
  | { readonly ok: true; readonly result: DurableSessionOperationResult }
  | { readonly ok: false; readonly error: DurableSessionError };

interface IdempotencyEntry {
  readonly fingerprint: string;
  readonly expiresAtMs: number;
  readonly payload: ResponsePayload;
}

interface InputDedupeEntry {
  readonly fingerprint: string;
  readonly expiresAtMs: number;
}

export class SystemHostClock implements HostClock {
  #last = 0;

  nowMs(): number {
    this.#last = Math.max(this.#last, Date.now());
    return this.#last;
  }
}

export const defaultHostIds: HostIds = {
  sessionId: () => randomUUID(),
  runtimeId: () => randomUUID(),
  attachmentId: () => randomUUID(),
  controlRequestId: () => randomUUID(),
  controlOfferId: () => randomUUID(),
  eventId: () => randomUUID(),
  diagnosticId: () => randomUUID(),
};

export class SessionService {
  readonly #metadata: MetadataRepository;
  readonly #runtime: RuntimePort;
  readonly #commandPolicy: HostCommandPolicy;
  readonly #sessionLimit: number;
  readonly #idempotencyTtlMs: number;
  readonly #idempotencyLimit: number;
  readonly #inputDedupeTtlMs: number;
  readonly #inputDedupeLimit: number;
  readonly #expirySweepIntervalMs: number;
  readonly #clock: HostClock;
  readonly #ids: HostIds;
  readonly #logger: HostLogger;
  readonly #sessions = new Map<SessionId, SessionEntry>();
  readonly #activeRuntimes = new Map<SessionId, ActiveRuntime>();
  readonly #terminalStates = new Map<SessionId, BoundedTerminalState>();
  readonly #idempotency = new Map<string, IdempotencyEntry>();
  readonly #inputDedupe = new Map<string, InputDedupeEntry>();
  // Input fingerprints are keyed per process so a remembered secret cannot be guessed back from
  // its hash (AP-D003).
  readonly #inputFingerprintKey = randomBytes(32);
  readonly #attachments: AttachmentCoordinator;
  readonly #journal: BoundedEventJournal;
  readonly #eventWaiterClosers = new Set<() => void>();
  #tail: Promise<void> = Promise.resolve();
  #expiryTimer: ReturnType<typeof setInterval> | null = null;
  #initialized = false;
  #accepting = false;
  #closed = false;
  #metadataDiagnosticId: string | null = null;

  constructor(options: SessionServiceOptions) {
    this.#metadata = options.metadata;
    this.#runtime = options.runtime;
    this.#commandPolicy = options.commandPolicy;
    this.#sessionLimit = options.sessionLimit;
    this.#idempotencyTtlMs = options.idempotencyTtlMs;
    this.#idempotencyLimit = options.idempotencyLimit ?? 10_000;
    this.#inputDedupeTtlMs = options.inputDedupeTtlMs ?? 60_000;
    this.#inputDedupeLimit = options.inputDedupeLimit ?? 10_000;
    this.#expirySweepIntervalMs = options.expirySweepIntervalMs ?? 1_000;
    this.#clock = options.clock ?? new SystemHostClock();
    this.#ids = options.ids ?? defaultHostIds;
    this.#logger = options.logger ?? silentHostLogger;
    this.#attachments = new AttachmentCoordinator({
      maxPerSession: options.maxAttachmentsPerSession ?? 32,
      queueBytesLimit: options.attachmentQueueBytes ?? 4 * 1_024 * 1_024,
    });
    this.#journal = new BoundedEventJournal(options.eventJournalLimit ?? 10_000);
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    const nowMs = this.#clock.nowMs();
    let storedSessions: readonly StoredSession[];
    try {
      storedSessions = this.#metadata.loadAll();
    } catch {
      throw this.#metadataFailure();
    }
    for (const stored of storedSessions) {
      assertSessionInvariants(stored.state);
      const entry: SessionEntry = {
        state: stored.state,
        restartability: stored.restartability,
        commandAvailable: stored.restartability === "profile-reference",
      };
      this.#sessions.set(entry.state.sessionId, entry);
      if (isLiveLifecycle(entry.state.lifecycle)) {
        const runtimeId = requireRuntime(entry.state);
        const transition = reduceDurableSession(entry.state, {
          type: "recoverRuntimeLost",
          expectedRuntimeId: runtimeId,
          nowMs,
        });
        await this.#commitTransition(entry, transition);
        this.#logger.write({
          level: "warn",
          event: "session.recovered",
          sessionId: entry.state.sessionId,
          runtimeId,
          code: "runtime-lost",
        });
      }
    }
    this.#initialized = true;
    this.#accepting = true;
    this.#expiryTimer = setInterval(() => {
      void this.#enqueue(() => this.#expireAll(this.#clock.nowMs()));
    }, this.#expirySweepIntervalMs);
    this.#expiryTimer.unref();
  }

  get ready(): boolean {
    if (!this.#initialized || !this.#accepting || this.#closed) return false;
    try {
      return this.#metadata.ping();
    } catch {
      this.#metadataFailure();
      return false;
    }
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  execute(
    caller: DurableSessionCallerContext,
    request: DurableSessionOperationRequest,
    executionContext: HostOperationExecutionContext = {},
  ): Promise<DurableSessionOperationResponse> {
    if (request.operation === "waitForEvents") {
      return this.#waitForEvents(caller, request);
    }
    return this.#enqueue(async () => {
      const nowMs = this.#clock.nowMs();
      if (!this.#accepting) {
        return failureResponse(
          request.requestId,
          new HostOperationError("SESSION_STATE_INVALID", "Host is not accepting operations."),
        );
      }
      await this.#expireAll(nowMs);
      const authorization = authorizeDurableSessionOperation(caller, request, nowMs);
      if (!authorization.allowed) {
        this.#logger.write({
          level: "warn",
          event: "request.denied",
          code: authorization.error.code,
        });
        return failureResponse(request.requestId, fromDurableSessionError(authorization.error));
      }

      this.#expireIdempotency(nowMs);
      const idempotency = this.#idempotencyIdentity(caller, request);
      if (idempotency !== null) {
        const existing = this.#idempotency.get(idempotency.key);
        if (existing !== undefined) {
          if (existing.fingerprint !== idempotency.fingerprint) {
            return failureResponse(
              request.requestId,
              new HostOperationError(
                "REQUEST_INVALID",
                "Idempotency key was reused with a different request.",
              ),
            );
          }
          return responseFromPayload(request.requestId, existing.payload);
        }
      }

      let payload: ResponsePayload;
      try {
        payload = {
          ok: true,
          result: await this.#executeResult(caller, request, executionContext),
        };
      } catch (error) {
        const normalized = this.#normalizeError(error);
        if (normalized.code !== "INTERNAL_ERROR") {
          this.#logger.write({ level: "warn", event: "request.denied", code: normalized.code });
        }
        payload = { ok: false, error: normalized.toDurableSessionError() };
      }
      if (idempotency !== null) {
        this.#rememberIdempotency(idempotency.key, {
          fingerprint: idempotency.fingerprint,
          expiresAtMs: nowMs + this.#idempotencyTtlMs,
          payload,
        });
      }
      return responseFromPayload(request.requestId, payload);
    });
  }

  terminalSnapshot(sessionId: SessionId): Promise<TerminalStateSnapshot> {
    return this.#enqueue(async () => {
      const terminal = this.#terminalStates.get(sessionId);
      if (terminal === undefined) {
        throw new HostOperationError("SESSION_NOT_RUNNING", "Session has no terminal state.");
      }
      return terminal.snapshot();
    });
  }

  bindStreamAttachment(
    caller: DurableSessionCallerContext,
    sessionId: SessionId,
    attachmentId: AttachmentId,
    streamId: string,
    listener: () => void,
  ): Promise<() => void> {
    return this.#enqueue(() => {
      const nowMs = this.#clock.nowMs();
      this.#assertStreamObservation(caller, sessionId, nowMs);
      const entry = this.#requireSession(sessionId);
      this.#attachments.assertOwned(caller, sessionId, attachmentId);
      this.#assertConnectedAttachment(entry, attachmentId);
      this.#attachments.bindStream(caller, sessionId, attachmentId, streamId);
      return this.#attachments.subscribe(attachmentId, listener);
    });
  }

  takeStreamEvent(
    attachmentId: AttachmentId,
    streamId: string,
  ): Promise<DurableSessionEvent | null> {
    return this.#enqueue(() => this.#attachments.take(attachmentId, streamId));
  }

  disconnectStreamAttachment(
    caller: DurableSessionCallerContext,
    sessionId: SessionId,
    attachmentId: AttachmentId,
  ): Promise<void> {
    return this.#enqueue(async () => {
      const entry = this.#requireSession(sessionId);
      this.#attachments.assertOwned(caller, sessionId, attachmentId);
      const nowMs = this.#clock.nowMs();
      const transition = reduceDurableSession(entry.state, {
        type: "disconnectAttachment",
        attachmentId,
        nowMs,
      });
      await this.#commitTransition(entry, transition);
      this.#attachments.disconnect(attachmentId, nowMs + DURABLE_SESSION_LIMITS.reconnectGraceMs);
    });
  }

  heartbeatAttachment(
    caller: DurableSessionCallerContext,
    input: {
      readonly sessionId: SessionId;
      readonly attachmentId: AttachmentId;
      readonly expectedRuntimeId: RuntimeId;
      readonly expectedControllerGeneration: number;
    },
  ): Promise<{ readonly receivedAtMs: number; readonly controllerGeneration: number }> {
    return this.#enqueue(async () => {
      const nowMs = this.#clock.nowMs();
      this.#assertStreamObservation(caller, input.sessionId, nowMs);
      const entry = this.#requireRunningSession(input.sessionId);
      this.#attachments.assertOwned(caller, input.sessionId, input.attachmentId);
      const transition = reduceDurableSession(entry.state, {
        type: "heartbeat",
        attachmentId: input.attachmentId,
        expectedRuntimeId: input.expectedRuntimeId,
        expectedControllerGeneration: input.expectedControllerGeneration,
        nowMs,
      });
      await this.#commitTransition(entry, transition);
      this.#attachments.refreshToken(input.attachmentId, connectedTokenExpiry(nowMs));
      return { receivedAtMs: nowMs, controllerGeneration: entry.state.controllerGeneration };
    });
  }

  expireNow(): Promise<void> {
    return this.#enqueue(() => this.#expireAll(this.#clock.nowMs()));
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#accepting = false;
    for (const closeWaiter of [...this.#eventWaiterClosers]) closeWaiter();
    if (this.#expiryTimer !== null) {
      clearInterval(this.#expiryTimer);
      this.#expiryTimer = null;
    }
    await this.#enqueue(async () => {
      const nowMs = this.#clock.nowMs();
      for (const entry of this.#sessions.values()) {
        if (entry.state.lifecycle !== "running") continue;
        const transition = reduceDurableSession(entry.state, {
          type: "stop",
          expectedSessionRevision: entry.state.sessionRevision,
          expectedRuntimeId: requireRuntime(entry.state),
          nowMs,
        });
        try {
          await this.#commitTransition(entry, transition);
        } catch (error) {
          const runtimeId = entry.state.runtimeId;
          this.#logger.write({
            level: "error",
            event: "runtime.kill-failed",
            sessionId: entry.state.sessionId,
            ...(runtimeId === null ? {} : { runtimeId }),
            code: this.#normalizeError(error).code,
          });
        }
      }
    });

    const active = [...this.#activeRuntimes.values()];
    await Promise.all(
      active.map(async ({ handle, stopTimeoutMs }) => {
        const exited = await waitForExit(handle, stopTimeoutMs);
        if (!exited) {
          try {
            handle.kill("SIGKILL");
          } catch {
            this.#logger.write({
              level: "error",
              event: "runtime.kill-failed",
              sessionId: handle.sessionId,
              runtimeId: handle.runtimeId,
            });
          }
        }
      }),
    );
    await this.#enqueue(() => undefined);
    await this.#enqueue(async () => {
      const nowMs = this.#clock.nowMs();
      for (const entry of this.#sessions.values()) {
        if (!isLiveLifecycle(entry.state.lifecycle)) continue;
        const runtimeId = requireRuntime(entry.state);
        const recovered = reduceDurableSession(entry.state, {
          type: "recoverRuntimeLost",
          expectedRuntimeId: runtimeId,
          nowMs,
        });
        await this.#commitTransition(entry, recovered);
      }
    });
    for (const terminal of this.#terminalStates.values()) terminal.dispose();
    for (const entry of this.#sessions.values()) {
      entry.integrationAuthorization?.bootstrapKey.fill(0);
    }
    this.#terminalStates.clear();
    this.#activeRuntimes.clear();
    this.#metadata.close();
    this.#closed = true;
  }

  async #executeResult(
    caller: DurableSessionCallerContext,
    request: DurableSessionOperationRequest,
    executionContext: HostOperationExecutionContext,
  ): Promise<DurableSessionOperationResult> {
    switch (request.operation) {
      case "createSession":
        return this.#createSession(caller, request, executionContext);
      case "listSessions":
        return this.#listSessions(caller, request);
      case "getSession":
        return {
          operation: "getSession",
          session: toSessionView(this.#requireSession(request.sessionId).state),
        };
      case "startSession":
        return this.#startSession(request);
      case "stopSession":
        return this.#stopSession(request);
      case "forgetSession":
        return this.#forgetSession(request);
      case "openAttachment":
        return this.#openAttachment(caller, request);
      case "resumeAttachment":
        return this.#resumeAttachment(caller, request);
      case "closeAttachment":
        return this.#closeAttachment(caller, request);
      case "requestSnapshot":
        return this.#requestSnapshot(caller, request, false);
      case "resyncAttachment":
        return this.#requestSnapshot(caller, request, true);
      case "acquireControl":
        return this.#acquireControl(caller, request);
      case "requestControl":
        return this.#requestControl(caller, request);
      case "approveControl":
        return this.#approveControl(caller, request);
      case "rejectControl":
        return this.#rejectControl(caller, request);
      case "acceptControl":
        return this.#acceptControl(caller, request);
      case "preemptControl":
        return this.#preemptControl(caller, request);
      case "releaseControl":
        return this.#releaseControl(caller, request);
      case "sendInput":
        return this.#sendInput(caller, request);
      case "resizeTerminal":
        return this.#resizeTerminal(caller, request);
      case "readEvents":
        return this.#readEvents(caller, request);
      case "waitForEvents":
        throw new Error("waitForEvents must not execute inside the SessionService serial queue.");
    }
  }

  async #createSession(
    caller: DurableSessionCallerContext,
    request: Extract<DurableSessionOperationRequest, { operation: "createSession" }>,
    executionContext: HostOperationExecutionContext,
  ): Promise<DurableSessionOperationResult> {
    if (this.#sessions.size >= this.#sessionLimit) {
      throw new HostOperationError("SESSION_LIMIT_REACHED", "Host Session limit was reached.");
    }
    this.#commandPolicy.resolve(request.command, { mode: "validate", appId: caller.appId });
    const integrationAuthorization =
      request.command.integration === undefined
        ? undefined
        : integrationAuthorizationFor(caller, executionContext.integrationBootstrapKey);
    const nowMs = this.#clock.nowMs();
    const sessionId = this.#uniqueSessionId();
    const runtimeId = this.#ids.runtimeId();
    const state = createSessionState({ sessionId, runtimeId, command: request.command, nowMs });
    const entry: SessionEntry = {
      state,
      restartability: this.#commandPolicy.restartability(request.command),
      commandAvailable: true,
      ...(integrationAuthorization === undefined ? {} : { integrationAuthorization }),
    };
    this.#sessions.set(sessionId, entry);
    await this.#applyEffects(entry, effectsForCreatedSession(state));
    this.#logger.write({ level: "info", event: "session.created", sessionId, runtimeId });
    return { operation: "createSession", session: toSessionView(entry.state) };
  }

  #listSessions(
    caller: DurableSessionCallerContext,
    request: Extract<DurableSessionOperationRequest, { operation: "listSessions" }>,
  ): DurableSessionOperationResult {
    const cursor = request.cursor === undefined ? null : decodeCursor(request.cursor);
    const sessions = [...this.#sessions.values()]
      .filter((entry) => scopeContains(caller.sessionScope, entry.state.sessionId))
      .sort(compareEntries)
      .filter((entry) => cursor === null || compareEntryToCursor(entry, cursor) > 0);
    const page = sessions.slice(0, request.limit);
    const hasMore = sessions.length > page.length;
    const last = page.at(-1);
    return {
      operation: "listSessions",
      sessions: page.map((entry) => toSessionView(entry.state)),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
    };
  }

  async #startSession(
    request: Extract<DurableSessionOperationRequest, { operation: "startSession" }>,
  ): Promise<DurableSessionOperationResult> {
    const entry = this.#requireSession(request.sessionId);
    const runtimeId = this.#ids.runtimeId();
    const transition = reduceDurableSession(entry.state, {
      type: "start",
      expectedSessionRevision: request.expectedSessionRevision,
      newRuntimeId: runtimeId,
      nowMs: this.#clock.nowMs(),
    });
    if (!transition.ok) throw fromDurableSessionError(transition.error);
    if (!entry.commandAvailable) {
      throw new HostOperationError(
        "COMMAND_POLICY_DENIED",
        "Recovered runtime-only command was intentionally not persisted.",
      );
    }
    const command = withCurrentTerminal(transition.state);
    this.#commandPolicy.resolve(
      command,
      command.integration === undefined
        ? undefined
        : entry.integrationAuthorization === undefined
          ? undefined
          : { mode: "validate", appId: entry.integrationAuthorization.appId },
    );
    await this.#commitTransition(entry, transition);
    this.#logger.write({
      level: "info",
      event: "session.started",
      sessionId: request.sessionId,
      runtimeId,
    });
    return { operation: "startSession", session: toSessionView(entry.state) };
  }

  async #stopSession(
    request: Extract<DurableSessionOperationRequest, { operation: "stopSession" }>,
  ): Promise<DurableSessionOperationResult> {
    const entry = this.#requireSession(request.sessionId);
    const transition = reduceDurableSession(entry.state, {
      type: "stop",
      expectedSessionRevision: request.expectedSessionRevision,
      expectedRuntimeId: request.expectedRuntimeId,
      nowMs: this.#clock.nowMs(),
    });
    await this.#commitTransition(entry, transition);
    this.#logger.write({
      level: "info",
      event: "session.stopping",
      sessionId: request.sessionId,
      runtimeId: request.expectedRuntimeId,
    });
    return { operation: "stopSession", session: toSessionView(entry.state) };
  }

  async #forgetSession(
    request: Extract<DurableSessionOperationRequest, { operation: "forgetSession" }>,
  ): Promise<DurableSessionOperationResult> {
    const entry = this.#requireSession(request.sessionId);
    const transition = reduceDurableSession(entry.state, {
      type: "forget",
      expectedSessionRevision: request.expectedSessionRevision,
      nowMs: this.#clock.nowMs(),
    });
    await this.#commitTransition(entry, transition);
    this.#logger.write({
      level: "info",
      event: "session.forgotten",
      sessionId: request.sessionId,
    });
    return { operation: "forgetSession", forgotten: true };
  }

  async #openAttachment(
    caller: DurableSessionCallerContext,
    request: Extract<DurableSessionOperationRequest, { operation: "openAttachment" }>,
  ): Promise<DurableSessionOperationResult> {
    const entry = this.#requireRunningSession(request.sessionId);
    this.#attachments.assertCanOpen(request.sessionId);
    const attachmentId = this.#uniqueAttachmentId(entry);
    const nowMs = this.#clock.nowMs();
    const snapshot = await this.#snapshot(entry, attachmentId);
    const transition = reduceDurableSession(entry.state, {
      type: "openAttachment",
      attachmentId,
      nowMs,
    });
    await this.#commitTransition(entry, transition);
    const resumeToken = newResumeToken();
    const resumeExpiresAtMs = connectedTokenExpiry(nowMs);
    const attachment = this.#attachments.open({
      state: entry.state,
      caller,
      attachmentId,
      resumeToken,
      resumeExpiresAtMs,
      initialEvent: this.#snapshotEvent(request.sessionId, snapshot),
    });
    return { operation: "openAttachment", attachment };
  }

  async #resumeAttachment(
    caller: DurableSessionCallerContext,
    request: Extract<DurableSessionOperationRequest, { operation: "resumeAttachment" }>,
  ): Promise<DurableSessionOperationResult> {
    const entry = this.#requireRunningSession(request.sessionId);
    const nowMs = this.#clock.nowMs();
    this.#attachments.validateResume(caller, {
      sessionId: request.sessionId,
      attachmentId: request.attachmentId,
      runtimeId: request.expectedRuntimeId,
      token: request.attachmentResumeToken,
      nowMs,
    });
    const snapshot = await this.#snapshot(entry, request.attachmentId);
    const transition = reduceDurableSession(entry.state, {
      type: "resumeAttachment",
      attachmentId: request.attachmentId,
      expectedRuntimeId: request.expectedRuntimeId,
      expectedControllerGeneration: request.expectedControllerGeneration,
      nowMs,
    });
    await this.#commitTransition(entry, transition);
    const nextToken = newResumeToken();
    const attachment = this.#attachments.completeResume({
      state: entry.state,
      caller,
      attachmentId: request.attachmentId,
      previousToken: request.attachmentResumeToken,
      nextToken,
      resumeExpiresAtMs: connectedTokenExpiry(nowMs),
      initialEvent: this.#snapshotEvent(request.sessionId, snapshot),
    });
    return { operation: "resumeAttachment", attachment };
  }

  async #closeAttachment(
    caller: DurableSessionCallerContext,
    request: Extract<DurableSessionOperationRequest, { operation: "closeAttachment" }>,
  ): Promise<DurableSessionOperationResult> {
    const entry = this.#requireSession(request.sessionId);
    this.#attachments.assertOwned(caller, request.sessionId, request.attachmentId);
    const transition = reduceDurableSession(entry.state, {
      type: "closeAttachment",
      attachmentId: request.attachmentId,
      nowMs: this.#clock.nowMs(),
    });
    await this.#commitTransition(entry, transition);
    return { operation: "closeAttachment", closed: true };
  }

  async #requestSnapshot(
    caller: DurableSessionCallerContext,
    request:
      | Extract<DurableSessionOperationRequest, { operation: "requestSnapshot" }>
      | Extract<DurableSessionOperationRequest, { operation: "resyncAttachment" }>,
    resync: boolean,
  ): Promise<DurableSessionOperationResult> {
    const entry = this.#requireRunningSession(request.sessionId);
    this.#attachments.assertOwned(caller, request.sessionId, request.attachmentId);
    this.#assertConnectedAttachment(entry, request.attachmentId);
    if (entry.state.runtimeId !== request.expectedRuntimeId) {
      throw new HostOperationError("RUNTIME_STALE", "Runtime identity is stale.");
    }
    const snapshot = await this.#snapshot(entry, request.attachmentId);
    if (resync && "afterSequence" in request && request.afterSequence > snapshot.sequence) {
      throw new HostOperationError(
        "REQUEST_INVALID",
        "Resync cursor is ahead of the canonical terminal sequence.",
      );
    }
    this.#attachments.confirmSnapshot(request.attachmentId, snapshot.sequence);
    return resync
      ? { operation: "resyncAttachment", snapshot }
      : { operation: "requestSnapshot", snapshot };
  }

  async #acquireControl(
    caller: DurableSessionCallerContext,
    request: Extract<DurableSessionOperationRequest, { operation: "acquireControl" }>,
  ): Promise<DurableSessionOperationResult> {
    const entry = this.#ownedEntry(caller, request);
    const transition = reduceDurableSession(entry.state, {
      type: "acquireControl",
      attachmentId: request.attachmentId,
      expectedRuntimeId: request.expectedRuntimeId,
      expectedControllerGeneration: request.expectedControllerGeneration,
      terminal: request.terminal,
      nowMs: this.#clock.nowMs(),
    });
    await this.#commitTransition(entry, transition);
    return { operation: "acquireControl", control: controlView(entry.state) };
  }

  async #requestControl(
    caller: DurableSessionCallerContext,
    request: Extract<DurableSessionOperationRequest, { operation: "requestControl" }>,
  ): Promise<DurableSessionOperationResult> {
    const entry = this.#ownedEntry(caller, request);
    const controlRequestId = this.#ids.controlRequestId();
    const transition = reduceDurableSession(entry.state, {
      type: "requestControl",
      attachmentId: request.attachmentId,
      controlRequestId,
      expectedControllerGeneration: request.expectedControllerGeneration,
      nowMs: this.#clock.nowMs(),
    });
    await this.#commitTransition(entry, transition);
    const controlRequest = entry.state.pendingControlRequests[controlRequestId];
    if (controlRequest === undefined) throw new Error("Control request was not committed.");
    return { operation: "requestControl", request: controlRequest };
  }

  async #approveControl(
    caller: DurableSessionCallerContext,
    request: Extract<DurableSessionOperationRequest, { operation: "approveControl" }>,
  ): Promise<DurableSessionOperationResult> {
    const entry = this.#ownedEntry(caller, request);
    const controlOfferId = this.#ids.controlOfferId();
    const transition = reduceDurableSession(entry.state, {
      type: "approveControl",
      attachmentId: request.attachmentId,
      controlRequestId: request.controlRequestId,
      controlOfferId,
      expectedControllerGeneration: request.expectedControllerGeneration,
      nowMs: this.#clock.nowMs(),
    });
    await this.#commitTransition(entry, transition);
    const offer = entry.state.activeControlOffer;
    if (offer === null || offer.controlOfferId !== controlOfferId) {
      throw new Error("Control offer was not committed.");
    }
    return { operation: "approveControl", offer };
  }

  async #rejectControl(
    caller: DurableSessionCallerContext,
    request: Extract<DurableSessionOperationRequest, { operation: "rejectControl" }>,
  ): Promise<DurableSessionOperationResult> {
    const entry = this.#ownedEntry(caller, request);
    const transition = reduceDurableSession(entry.state, {
      type: "rejectControl",
      attachmentId: request.attachmentId,
      controlRequestId: request.controlRequestId,
      expectedControllerGeneration: request.expectedControllerGeneration,
      nowMs: this.#clock.nowMs(),
    });
    await this.#commitTransition(entry, transition);
    return {
      operation: "rejectControl",
      controlRequestId: request.controlRequestId,
      resolution: "rejected",
    };
  }

  async #acceptControl(
    caller: DurableSessionCallerContext,
    request: Extract<DurableSessionOperationRequest, { operation: "acceptControl" }>,
  ): Promise<DurableSessionOperationResult> {
    const entry = this.#ownedEntry(caller, request);
    const transition = reduceDurableSession(entry.state, {
      type: "acceptControl",
      attachmentId: request.attachmentId,
      controlOfferId: request.controlOfferId,
      expectedRuntimeId: request.expectedRuntimeId,
      expectedControllerGeneration: request.expectedControllerGeneration,
      terminal: request.terminal,
      nowMs: this.#clock.nowMs(),
    });
    await this.#commitTransition(entry, transition);
    return { operation: "acceptControl", control: controlView(entry.state) };
  }

  async #preemptControl(
    caller: DurableSessionCallerContext,
    request: Extract<DurableSessionOperationRequest, { operation: "preemptControl" }>,
  ): Promise<DurableSessionOperationResult> {
    const entry = this.#ownedEntry(caller, request);
    const transition = reduceDurableSession(entry.state, {
      type: "preemptControl",
      attachmentId: request.attachmentId,
      expectedRuntimeId: request.expectedRuntimeId,
      expectedControllerGeneration: request.expectedControllerGeneration,
      terminal: request.terminal,
      nowMs: this.#clock.nowMs(),
    });
    await this.#commitTransition(entry, transition);
    return { operation: "preemptControl", control: controlView(entry.state) };
  }

  async #releaseControl(
    caller: DurableSessionCallerContext,
    request: Extract<DurableSessionOperationRequest, { operation: "releaseControl" }>,
  ): Promise<DurableSessionOperationResult> {
    const entry = this.#ownedEntry(caller, request);
    const transition = reduceDurableSession(entry.state, {
      type: "releaseControl",
      attachmentId: request.attachmentId,
      expectedControllerGeneration: request.expectedControllerGeneration,
      nowMs: this.#clock.nowMs(),
    });
    await this.#commitTransition(entry, transition);
    return { operation: "releaseControl", control: controlView(entry.state) };
  }

  async #sendInput(
    caller: DurableSessionCallerContext,
    request: Extract<DurableSessionOperationRequest, { operation: "sendInput" }>,
  ): Promise<DurableSessionOperationResult> {
    const entry = this.#ownedEntry(caller, request);
    const transition = reduceDurableSession(entry.state, {
      type: "sendInput",
      attachmentId: request.attachmentId,
      expectedRuntimeId: request.expectedRuntimeId,
      expectedControllerGeneration: request.expectedControllerGeneration,
      inputId: request.inputId,
      data: request.data,
      nowMs: this.#clock.nowMs(),
    });
    if (!transition.ok) throw fromDurableSessionError(transition.error);
    const dedupeKey = inputDedupeKey(
      request.sessionId,
      request.expectedRuntimeId,
      request.expectedControllerGeneration,
      request.inputId,
    );
    const fingerprint = createHmac("sha256", this.#inputFingerprintKey)
      .update(request.data)
      .digest("hex");
    const existing = this.#inputDedupe.get(dedupeKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new HostOperationError(
          "REQUEST_INVALID",
          "Input ID was reused with different terminal data.",
        );
      }
    } else {
      await this.#commitTransition(entry, transition);
      this.#rememberInput(dedupeKey, {
        fingerprint,
        expiresAtMs: this.#clock.nowMs() + this.#inputDedupeTtlMs,
      });
    }
    return {
      operation: "sendInput",
      runtimeId: request.expectedRuntimeId,
      controllerGeneration: request.expectedControllerGeneration,
      inputId: request.inputId,
      accepted: true,
    };
  }

  async #resizeTerminal(
    caller: DurableSessionCallerContext,
    request: Extract<DurableSessionOperationRequest, { operation: "resizeTerminal" }>,
  ): Promise<DurableSessionOperationResult> {
    const entry = this.#ownedEntry(caller, request);
    const transition = reduceDurableSession(entry.state, {
      type: "resizeTerminal",
      attachmentId: request.attachmentId,
      expectedRuntimeId: request.expectedRuntimeId,
      expectedControllerGeneration: request.expectedControllerGeneration,
      terminal: request.terminal,
      nowMs: this.#clock.nowMs(),
    });
    await this.#commitTransition(entry, transition);
    return {
      operation: "resizeTerminal",
      runtimeId: request.expectedRuntimeId,
      controllerGeneration: request.expectedControllerGeneration,
      terminal: request.terminal,
    };
  }

  #readEvents(
    caller: DurableSessionCallerContext,
    request: Extract<DurableSessionOperationRequest, { operation: "readEvents" }>,
  ): DurableSessionOperationResult {
    const read = this.#journal.read(caller, {
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      ...(request.afterEventId === undefined ? {} : { afterEventId: request.afterEventId }),
      limit: request.limit,
    });
    return { operation: "readEvents", events: [...read.events], cursor: read.cursor };
  }

  async #commitTransition(
    entry: SessionEntry,
    transition: DurableSessionTransition,
  ): Promise<void> {
    if (!transition.ok) throw fromDurableSessionError(transition.error);
    let stateApplied = false;
    for (const effect of transition.effects) {
      if (effect.type === "persistMetadata" && !stateApplied) {
        this.#persistMetadata(entry, transition.state);
        continue;
      }
      if (!stateApplied) {
        entry.state = transition.state;
        stateApplied = true;
      }
      await this.#applyEffects(entry, [effect]);
    }
    if (!stateApplied) entry.state = transition.state;
  }

  async #applyEffects(
    entry: SessionEntry,
    effects: readonly DurableSessionEffect[],
  ): Promise<void> {
    for (const effect of effects) {
      switch (effect.type) {
        case "persistMetadata":
          this.#persistMetadata(entry, entry.state);
          break;
        case "deleteMetadata": {
          try {
            this.#metadata.delete(effect.sessionId);
          } catch {
            throw this.#metadataFailure();
          }
          this.#sessions.delete(effect.sessionId);
          entry.integrationAuthorization?.bootstrapKey.fill(0);
          this.#activeRuntimes.delete(effect.sessionId);
          this.#attachments.removeSession(effect.sessionId);
          this.#terminalStates.get(effect.sessionId)?.dispose();
          this.#terminalStates.delete(effect.sessionId);
          break;
        }
        case "spawn":
          await this.#spawnRuntime(entry, effect.runtimeId);
          break;
        case "kill": {
          const active = this.#activeRuntimes.get(effect.sessionId);
          if (active === undefined || active.handle.runtimeId !== effect.runtimeId) {
            throw new HostOperationError(
              "RUNTIME_STALE",
              "Runtime is no longer owned by this Host.",
            );
          }
          active.handle.kill();
          break;
        }
        case "writePty": {
          const active = this.#requireActiveRuntime(effect.sessionId, effect.runtimeId);
          active.handle.write(effect.data);
          break;
        }
        case "resizePty": {
          const active = this.#requireActiveRuntime(effect.sessionId, effect.runtimeId);
          active.handle.resize(effect.terminal);
          await active.terminal.resize(effect.terminal);
          break;
        }
        case "emitEvent":
          this.#emitDomainEvent(effect.sessionId, effect.event);
          break;
        case "closeAttachment":
          this.#attachments.remove(effect.attachmentId);
          break;
      }
    }
  }

  async #spawnRuntime(entry: SessionEntry, runtimeId: RuntimeId): Promise<void> {
    const sessionId = entry.state.sessionId;
    let launch: ResolvedLaunchCommand;
    let terminal: BoundedTerminalState | null = null;
    let handle: RuntimeHandle;
    try {
      const command = withCurrentTerminal(entry.state);
      const integration = entry.integrationAuthorization;
      launch = this.#commandPolicy.resolve(
        command,
        command.integration === undefined
          ? undefined
          : integration === undefined
            ? undefined
            : {
                mode: "runtime",
                appId: integration.appId,
                subject: integration.subject,
                sessionId,
                runtimeId,
                issuedAtMs: this.#clock.nowMs(),
                integrationBootstrapKey: integration.bootstrapKey,
              },
      );
      terminal = new BoundedTerminalState(sessionId, runtimeId, entry.state.terminal, {
        scrollbackRows: launch.scrollbackRows,
        outputRingCharacters: launch.outputRingCharacters,
      });
      handle = this.#runtime.spawn(
        { sessionId, runtimeId, launch },
        {
          onData: (data) => {
            this.#queueRuntimeOutput(sessionId, runtimeId, data);
          },
          onExit: (event) => {
            void this.#enqueue(() => this.#recordExit(sessionId, runtimeId, event));
          },
        },
      );
    } catch (error) {
      terminal?.dispose();
      const failed = reduceDurableSession(entry.state, {
        type: "spawnFailed",
        expectedSessionRevision: entry.state.sessionRevision,
        expectedRuntimeId: runtimeId,
        nowMs: this.#clock.nowMs(),
      });
      await this.#commitTransition(entry, failed);
      if (error instanceof HostOperationError) throw error;
      const diagnosticId = this.#ids.diagnosticId();
      this.#logger.write({
        level: "error",
        event: "runtime.spawn-failed",
        sessionId,
        runtimeId,
        code: "INTERNAL_ERROR",
        diagnosticId,
      });
      throw new HostOperationError("INTERNAL_ERROR", "Runtime spawn failed.", diagnosticId);
    }

    this.#terminalStates.get(sessionId)?.dispose();
    this.#terminalStates.set(sessionId, terminal);
    this.#activeRuntimes.set(sessionId, {
      handle,
      terminal,
      stopTimeoutMs: launch.stopTimeoutMs,
      outputQueueLimitCharacters: launch.outputRingCharacters,
      pendingOutput: [],
      pendingOutputCharacters: 0,
      outputDrainScheduled: false,
      outputFailed: false,
    });
    const succeeded = reduceDurableSession(entry.state, {
      type: "spawnSucceeded",
      expectedSessionRevision: entry.state.sessionRevision,
      expectedRuntimeId: runtimeId,
      nowMs: this.#clock.nowMs(),
    });
    try {
      await this.#commitTransition(entry, succeeded);
      for (const attachmentId of this.#attachments.attachmentIds(sessionId)) {
        this.#attachments.requireResync(attachmentId, {
          version: 0,
          eventId: this.#ids.eventId(),
          sessionId,
          occurredAtMs: this.#clock.nowMs(),
          type: "attachment.resync-required",
          attachmentId,
          runtimeId,
          afterSequence: 0,
          reason: "runtime-changed",
        });
      }
    } catch (error) {
      try {
        handle.kill();
      } catch {
        this.#logger.write({
          level: "error",
          event: "runtime.kill-failed",
          sessionId,
          runtimeId,
          ...(error instanceof HostOperationError && error.diagnosticId !== undefined
            ? { diagnosticId: error.diagnosticId }
            : {}),
        });
      }
      throw error;
    }
  }

  #queueRuntimeOutput(sessionId: SessionId, runtimeId: RuntimeId, data: string): void {
    const active = this.#activeRuntimes.get(sessionId);
    if (
      active === undefined ||
      active.handle.runtimeId !== runtimeId ||
      active.outputFailed ||
      data.length === 0
    ) {
      return;
    }
    if (active.pendingOutputCharacters + data.length > active.outputQueueLimitCharacters) {
      active.outputFailed = true;
      active.pendingOutput.length = 0;
      active.pendingOutputCharacters = 0;
      void this.#enqueue(() => this.#failRuntimeOutput(sessionId, runtimeId));
      return;
    }
    active.pendingOutput.push(data);
    active.pendingOutputCharacters += data.length;
    if (active.outputDrainScheduled) return;
    active.outputDrainScheduled = true;
    void this.#enqueue(() => this.#drainRuntimeOutput(sessionId, runtimeId));
  }

  async #drainRuntimeOutput(sessionId: SessionId, runtimeId: RuntimeId): Promise<void> {
    const active = this.#activeRuntimes.get(sessionId);
    if (active === undefined || active.handle.runtimeId !== runtimeId || active.outputFailed)
      return;
    try {
      while (active.pendingOutput.length > 0) {
        const data = active.pendingOutput.shift();
        if (data === undefined) break;
        active.pendingOutputCharacters -= data.length;
        await this.#recordOutput(sessionId, runtimeId, data);
      }
    } catch {
      active.outputFailed = true;
      active.pendingOutput.length = 0;
      active.pendingOutputCharacters = 0;
      await this.#failRuntimeOutput(sessionId, runtimeId);
    } finally {
      active.outputDrainScheduled = false;
      if (!active.outputFailed && active.pendingOutput.length > 0) {
        active.outputDrainScheduled = true;
        void this.#enqueue(() => this.#drainRuntimeOutput(sessionId, runtimeId));
      }
    }
  }

  async #recordOutput(sessionId: SessionId, runtimeId: RuntimeId, data: string): Promise<void> {
    const entry = this.#sessions.get(sessionId);
    const active = this.#activeRuntimes.get(sessionId);
    if (entry === undefined || active === undefined || active.handle.runtimeId !== runtimeId)
      return;
    for (const chunk of chunkTerminalData(data)) {
      const transition = reduceDurableSession(entry.state, {
        type: "recordOutput",
        expectedRuntimeId: runtimeId,
        nowMs: this.#clock.nowMs(),
      });
      if (!transition.ok) {
        if (transition.error.code === "RUNTIME_STALE") return;
        throw fromDurableSessionError(transition.error);
      }
      entry.state = transition.state;
      await active.terminal.recordOutput(chunk, entry.state.nextSequence);
      this.#emitTerminalEvent({
        version: 0,
        eventId: this.#ids.eventId(),
        sessionId,
        occurredAtMs: this.#clock.nowMs(),
        type: "terminal.output",
        runtimeId,
        sequence: entry.state.nextSequence,
        data: chunk,
      });
    }
  }

  async #failRuntimeOutput(sessionId: SessionId, runtimeId: RuntimeId): Promise<void> {
    const entry = this.#sessions.get(sessionId);
    const active = this.#activeRuntimes.get(sessionId);
    if (entry === undefined || active === undefined || active.handle.runtimeId !== runtimeId)
      return;
    active.outputFailed = true;
    active.pendingOutput.length = 0;
    active.pendingOutputCharacters = 0;
    const diagnosticId = this.#ids.diagnosticId();
    this.#logger.write({
      level: "error",
      event: "runtime.output-failed",
      sessionId,
      runtimeId,
      code: "INTERNAL_ERROR",
      diagnosticId,
    });
    try {
      active.handle.kill();
    } catch {
      this.#logger.write({
        level: "error",
        event: "runtime.kill-failed",
        sessionId,
        runtimeId,
        diagnosticId,
      });
    }
    const failed = reduceDurableSession(entry.state, {
      type: "runtimeFailed",
      expectedRuntimeId: runtimeId,
      nowMs: this.#clock.nowMs(),
    });
    if (!failed.ok && failed.error.code === "RUNTIME_STALE") return;
    try {
      await this.#commitTransition(entry, failed);
    } finally {
      const current = this.#activeRuntimes.get(sessionId);
      if (current?.handle.runtimeId === runtimeId) this.#activeRuntimes.delete(sessionId);
    }
  }

  async #recordExit(
    sessionId: SessionId,
    runtimeId: RuntimeId,
    event: { readonly exitCode: number; readonly signal: number | null },
  ): Promise<void> {
    const entry = this.#sessions.get(sessionId);
    const active = this.#activeRuntimes.get(sessionId);
    if (entry === undefined || active === undefined || active.handle.runtimeId !== runtimeId)
      return;
    await active.terminal.drain();
    const transition = reduceDurableSession(entry.state, {
      type: "runtimeExited",
      expectedRuntimeId: runtimeId,
      exitCode: event.exitCode,
      signal: event.signal,
      nowMs: this.#clock.nowMs(),
    });
    if (!transition.ok && transition.error.code === "RUNTIME_STALE") {
      this.#activeRuntimes.delete(sessionId);
      return;
    }
    try {
      await this.#commitTransition(entry, transition);
    } finally {
      const current = this.#activeRuntimes.get(sessionId);
      if (current?.handle.runtimeId === runtimeId) this.#activeRuntimes.delete(sessionId);
    }
    this.#emitPublicEvent({
      version: 0,
      eventId: this.#ids.eventId(),
      sessionId,
      occurredAtMs: this.#clock.nowMs(),
      type: "terminal.exited",
      runtimeId,
      sessionRevision: entry.state.sessionRevision,
      exitCode: event.exitCode,
      signal: event.signal,
    });
    this.#logger.write({
      level: "info",
      event: "session.exited",
      sessionId,
      runtimeId,
      code: entry.state.lifecycle,
    });
  }

  async #snapshot(entry: SessionEntry, attachmentId: AttachmentId): Promise<TerminalSnapshot> {
    const terminal = this.#terminalStates.get(entry.state.sessionId);
    if (terminal === undefined || entry.state.runtimeId === null) {
      throw new HostOperationError("SESSION_NOT_RUNNING", "Session has no terminal state.");
    }
    const snapshot = await terminal.snapshot();
    if (snapshot.runtimeId !== entry.state.runtimeId) {
      throw new HostOperationError("RUNTIME_STALE", "Runtime identity is stale.");
    }
    return {
      sessionId: entry.state.sessionId,
      attachmentId,
      runtimeId: snapshot.runtimeId,
      sequence: snapshot.sequence,
      terminal: snapshot.terminal,
      serializedState: snapshot.serializedState,
    };
  }

  #snapshotEvent(sessionId: SessionId, snapshot: TerminalSnapshot): DurableSessionEvent {
    return {
      version: 0,
      eventId: this.#ids.eventId(),
      sessionId,
      occurredAtMs: this.#clock.nowMs(),
      type: "terminal.snapshot",
      runtimeId: snapshot.runtimeId,
      sequence: snapshot.sequence,
      terminal: snapshot.terminal,
      serializedState: snapshot.serializedState,
    };
  }

  #emitDomainEvent(sessionId: SessionId, event: DurableSessionDomainEvent): void {
    const base = {
      version: 0 as const,
      eventId: this.#ids.eventId(),
      sessionId,
      occurredAtMs: this.#clock.nowMs(),
    };
    switch (event.type) {
      case "session.changed":
        this.#emitPublicEvent({ ...base, ...event });
        break;
      case "control.requested":
        this.#emitPublicEvent({ ...base, ...event });
        break;
      case "control.offered":
        this.#emitPublicEvent({ ...base, ...event }, event.offer.requesterAttachmentId);
        break;
      case "control.request-resolved":
        this.#emitPublicEvent({ ...base, ...event });
        break;
      case "control.available":
        this.#emitPublicEvent({ ...base, ...event });
        break;
      case "control.changed":
        this.#emitPublicEvent({ ...base, ...event });
        break;
    }
  }

  #emitPublicEvent(event: DurableSessionJournalEvent, targetAttachmentId?: AttachmentId): void {
    this.#journal.append(event);
    this.#fanOut(event, targetAttachmentId);
  }

  #emitTerminalEvent(event: DurableSessionEvent): void {
    this.#fanOut(event);
  }

  #fanOut(event: DurableSessionEvent, targetAttachmentId?: AttachmentId): void {
    const overflowed = this.#attachments.enqueue(event.sessionId, event, targetAttachmentId);
    const entry = this.#sessions.get(event.sessionId);
    if (entry?.state.runtimeId === null || entry === undefined) return;
    for (const attachmentId of overflowed) {
      this.#attachments.requireResync(attachmentId, {
        version: 0,
        eventId: this.#ids.eventId(),
        sessionId: event.sessionId,
        occurredAtMs: this.#clock.nowMs(),
        type: "attachment.resync-required",
        attachmentId,
        runtimeId: entry.state.runtimeId,
        afterSequence: this.#attachments.lastSentSequence(attachmentId),
        reason: "queue-overflow",
      });
    }
  }

  #ownedEntry(
    caller: DurableSessionCallerContext,
    request: { readonly sessionId: SessionId; readonly attachmentId: AttachmentId },
  ): SessionEntry {
    const entry = this.#requireSession(request.sessionId);
    this.#attachments.assertOwned(caller, request.sessionId, request.attachmentId);
    return entry;
  }

  #assertStreamObservation(
    caller: DurableSessionCallerContext,
    sessionId: SessionId,
    nowMs: number,
  ): void {
    if (
      nowMs >= caller.expiresAtMs ||
      !caller.capabilities.includes("session:observe") ||
      !scopeContains(caller.sessionScope, sessionId)
    ) {
      throw new HostOperationError(
        "CAPABILITY_REQUIRED",
        "Caller is not authorized to observe this Session stream.",
      );
    }
  }

  #assertConnectedAttachment(entry: SessionEntry, attachmentId: AttachmentId): void {
    const attachment = entry.state.attachments[attachmentId];
    if (attachment === undefined) {
      throw new HostOperationError("ATTACHMENT_NOT_FOUND", "Attachment was not found.");
    }
    if (!attachment.connected) {
      throw new HostOperationError("SESSION_STATE_INVALID", "Attachment is disconnected.");
    }
  }

  #requireRunningSession(sessionId: SessionId): SessionEntry {
    const entry = this.#requireSession(sessionId);
    if (entry.state.lifecycle !== "running" || entry.state.runtimeId === null) {
      throw new HostOperationError("SESSION_NOT_RUNNING", "Session is not running.");
    }
    return entry;
  }

  #uniqueAttachmentId(entry: SessionEntry): AttachmentId {
    for (let attempts = 0; attempts < 10; attempts += 1) {
      const attachmentId = this.#ids.attachmentId();
      const collision = [...this.#sessions.values()].some(
        (candidate) => candidate.state.attachments[attachmentId] !== undefined,
      );
      if (!collision && entry.state.attachments[attachmentId] === undefined) return attachmentId;
    }
    throw new Error("Unable to allocate a unique attachment ID.");
  }

  async #expireAll(nowMs: number): Promise<void> {
    this.#expireIdempotency(nowMs);
    this.#expireInput(nowMs);
    for (const entry of this.#sessions.values()) {
      const transition = reduceDurableSession(entry.state, { type: "expire", nowMs });
      await this.#commitTransition(entry, transition);
    }
  }

  async #waitForEvents(
    caller: DurableSessionCallerContext,
    request: Extract<DurableSessionOperationRequest, { operation: "waitForEvents" }>,
  ): Promise<DurableSessionOperationResponse> {
    const prepared = await this.#enqueue(async () => {
      const nowMs = this.#clock.nowMs();
      if (!this.#accepting) {
        return {
          kind: "response" as const,
          response: failureResponse(
            request.requestId,
            new HostOperationError("SESSION_STATE_INVALID", "Host is not accepting operations."),
          ),
        };
      }
      await this.#expireAll(nowMs);
      const authorization = authorizeDurableSessionOperation(caller, request, nowMs);
      if (!authorization.allowed) {
        return {
          kind: "response" as const,
          response: failureResponse(
            request.requestId,
            fromDurableSessionError(authorization.error),
          ),
        };
      }
      try {
        const immediate = this.#readWaitEvents(caller, request);
        if (immediate.events.length > 0) {
          return {
            kind: "response" as const,
            response: successResponse(request.requestId, {
              operation: "waitForEvents",
              events: [...immediate.events],
              cursor: immediate.cursor,
              timedOut: false,
            }),
          };
        }
        return { kind: "waiter" as const, waiter: this.#createEventWaiter(caller, request) };
      } catch (error) {
        return {
          kind: "response" as const,
          response: failureResponse(request.requestId, this.#normalizeError(error)),
        };
      }
    });
    return prepared.kind === "response" ? prepared.response : prepared.waiter;
  }

  #createEventWaiter(
    caller: DurableSessionCallerContext,
    request: Extract<DurableSessionOperationRequest, { operation: "waitForEvents" }>,
  ): Promise<DurableSessionOperationResponse> {
    return new Promise((resolvePromise) => {
      let settled = false;
      let unsubscribe = (): void => undefined;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (response: DurableSessionOperationResponse): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        unsubscribe();
        this.#eventWaiterClosers.delete(closeWaiter);
        resolvePromise(response);
      };
      const closeWaiter = (): void => {
        finish(
          failureResponse(
            request.requestId,
            new HostOperationError("SESSION_STATE_INVALID", "Host is not accepting operations."),
          ),
        );
      };
      const check = (): void => {
        void this.#enqueue(() => {
          if (settled) return;
          try {
            const read = this.#readAuthorizedWaitEvents(caller, request);
            if (read.events.length > 0) {
              finish(
                successResponse(request.requestId, {
                  operation: "waitForEvents",
                  events: [...read.events],
                  cursor: read.cursor,
                  timedOut: false,
                }),
              );
            }
          } catch (error) {
            finish(failureResponse(request.requestId, this.#normalizeError(error)));
          }
        });
      };
      unsubscribe = this.#journal.subscribe(check);
      this.#eventWaiterClosers.add(closeWaiter);
      timer = setTimeout(() => {
        let read;
        try {
          read = this.#readAuthorizedWaitEvents(caller, request);
        } catch (error) {
          finish(failureResponse(request.requestId, this.#normalizeError(error)));
          return;
        }
        finish(
          successResponse(request.requestId, {
            operation: "waitForEvents",
            events: [...read.events],
            cursor: read.cursor,
            timedOut: read.events.length === 0,
          }),
        );
      }, request.timeoutMs);
      timer.unref();
    });
  }

  #readWaitEvents(
    caller: DurableSessionCallerContext,
    request: Extract<DurableSessionOperationRequest, { operation: "waitForEvents" }>,
  ) {
    return this.#journal.read(caller, {
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      ...(request.afterEventId === undefined ? {} : { afterEventId: request.afterEventId }),
      limit: request.limit,
    });
  }

  #readAuthorizedWaitEvents(
    caller: DurableSessionCallerContext,
    request: Extract<DurableSessionOperationRequest, { operation: "waitForEvents" }>,
  ) {
    const authorization = authorizeDurableSessionOperation(caller, request, this.#clock.nowMs());
    if (!authorization.allowed) throw fromDurableSessionError(authorization.error);
    return this.#readWaitEvents(caller, request);
  }

  #requireSession(sessionId: SessionId): SessionEntry {
    const entry = this.#sessions.get(sessionId);
    if (entry === undefined) {
      throw new HostOperationError("SESSION_NOT_FOUND", "Session was not found.");
    }
    return entry;
  }

  #requireActiveRuntime(sessionId: SessionId, runtimeId: RuntimeId): ActiveRuntime {
    const active = this.#activeRuntimes.get(sessionId);
    if (active === undefined || active.handle.runtimeId !== runtimeId) {
      throw new HostOperationError("RUNTIME_STALE", "Runtime is no longer owned by this Host.");
    }
    return active;
  }

  #uniqueSessionId(): SessionId {
    for (let attempts = 0; attempts < 10; attempts += 1) {
      const sessionId = this.#ids.sessionId();
      if (!this.#sessions.has(sessionId)) return sessionId;
    }
    throw new Error("Unable to allocate a unique Session ID.");
  }

  #idempotencyIdentity(
    caller: DurableSessionCallerContext,
    request: DurableSessionOperationRequest,
  ): { readonly key: string; readonly fingerprint: string } | null {
    if (!("idempotencyKey" in request)) return null;
    const stableRequest = Object.fromEntries(
      Object.entries(request).filter(([key]) => key !== "requestId"),
    );
    return {
      key: `${caller.appId}\0${caller.subject}\0${request.operation}\0${request.idempotencyKey}`,
      fingerprint: createHash("sha256").update(JSON.stringify(stableRequest)).digest("hex"),
    };
  }

  #expireIdempotency(nowMs: number): void {
    for (const [key, entry] of this.#idempotency) {
      if (entry.expiresAtMs <= nowMs) this.#idempotency.delete(key);
    }
  }

  #rememberIdempotency(key: string, entry: IdempotencyEntry): void {
    while (this.#idempotency.size >= this.#idempotencyLimit) {
      const oldest = this.#idempotency.keys().next().value;
      if (oldest === undefined) break;
      this.#idempotency.delete(oldest);
    }
    this.#idempotency.set(key, entry);
  }

  #expireInput(nowMs: number): void {
    for (const [key, entry] of this.#inputDedupe) {
      if (entry.expiresAtMs <= nowMs) this.#inputDedupe.delete(key);
    }
  }

  #rememberInput(key: string, entry: InputDedupeEntry): void {
    while (this.#inputDedupe.size >= this.#inputDedupeLimit) {
      const oldest = this.#inputDedupe.keys().next().value;
      if (oldest === undefined) break;
      this.#inputDedupe.delete(oldest);
    }
    this.#inputDedupe.set(key, entry);
  }

  #normalizeError(error: unknown): HostOperationError {
    if (error instanceof HostOperationError) return error;
    const diagnosticId = this.#ids.diagnosticId();
    this.#logger.write({
      level: "error",
      event: "transport.error",
      code: "INTERNAL_ERROR",
      diagnosticId,
    });
    return new HostOperationError("INTERNAL_ERROR", "Host operation failed.", diagnosticId);
  }

  #persistMetadata(entry: SessionEntry, state: DurableSessionState): void {
    try {
      this.#metadata.save(asStoredSession(entry, state));
    } catch {
      throw this.#metadataFailure();
    }
  }

  #metadataFailure(): HostOperationError {
    this.#accepting = false;
    if (this.#metadataDiagnosticId === null) {
      this.#metadataDiagnosticId = this.#ids.diagnosticId();
      this.#logger.write({
        level: "error",
        event: "metadata.failed",
        code: "INTERNAL_ERROR",
        diagnosticId: this.#metadataDiagnosticId,
      });
    }
    return new HostOperationError(
      "INTERNAL_ERROR",
      "Host metadata operation failed.",
      this.#metadataDiagnosticId,
    );
  }

  #enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function failureResponse(
  requestId: ProtocolRequestId,
  error: HostOperationError,
): DurableSessionOperationResponse {
  return { version: 0, requestId, ok: false, error: error.toDurableSessionError() };
}

function successResponse(
  requestId: ProtocolRequestId,
  result: DurableSessionOperationResult,
): DurableSessionOperationResponse {
  return { version: 0, requestId, ok: true, result };
}

function responseFromPayload(
  requestId: ProtocolRequestId,
  payload: ResponsePayload,
): DurableSessionOperationResponse {
  return payload.ok
    ? { version: 0, requestId, ok: true, result: payload.result }
    : { version: 0, requestId, ok: false, error: payload.error };
}

function asStoredSession(entry: SessionEntry, state = entry.state): StoredSession {
  return { state, restartability: entry.restartability };
}

function requireRuntime(state: DurableSessionState): RuntimeId {
  if (state.runtimeId === null) throw new Error("Live Session has no runtime identity.");
  return state.runtimeId;
}

function controlView(state: DurableSessionState) {
  return {
    sessionId: state.sessionId,
    runtimeId: requireRuntime(state),
    controllerAttachmentId: state.controllerAttachmentId,
    controllerGeneration: state.controllerGeneration,
    terminal: state.terminal,
  };
}

function newResumeToken(): string {
  return randomBytes(32).toString("base64url");
}

function connectedTokenExpiry(nowMs: number): number {
  return nowMs + DURABLE_SESSION_LIMITS.staleAfterMs + DURABLE_SESSION_LIMITS.reconnectGraceMs;
}

function inputDedupeKey(
  sessionId: SessionId,
  runtimeId: RuntimeId,
  controllerGeneration: number,
  inputId: InputId,
): string {
  return `${sessionId}\0${runtimeId}\0${controllerGeneration}\0${inputId}`;
}

function isLiveLifecycle(lifecycle: DurableSessionState["lifecycle"]): boolean {
  return lifecycle === "creating" || lifecycle === "running" || lifecycle === "stopping";
}

function withCurrentTerminal(state: DurableSessionState): DurableSessionState["command"] {
  return {
    ...state.command,
    terminal: {
      cols: state.terminal.cols,
      rows: state.terminal.rows,
      ...(state.command.terminal.term === undefined ? {} : { term: state.command.terminal.term }),
    },
  };
}

function scopeContains(
  scope: DurableSessionCallerContext["sessionScope"],
  sessionId: SessionId,
): boolean {
  return scope.kind === "all" || scope.ids.includes(sessionId);
}

function integrationAuthorizationFor(
  caller: DurableSessionCallerContext,
  bootstrapKey: Uint8Array | undefined,
): SessionIntegrationAuthorization {
  if (bootstrapKey === undefined || bootstrapKey.byteLength !== 32) {
    throw new HostOperationError(
      "CAPABILITY_REQUIRED",
      "Integration command requires authenticated Host bootstrap material.",
    );
  }
  return {
    appId: caller.appId,
    subject: caller.subject,
    bootstrapKey: Buffer.from(bootstrapKey),
  };
}

interface SessionCursor {
  readonly createdAtMs: number;
  readonly sessionId: SessionId;
}

function encodeCursor(entry: SessionEntry): string {
  return Buffer.from(
    JSON.stringify({ createdAtMs: entry.state.createdAtMs, sessionId: entry.state.sessionId }),
  ).toString("base64url");
}

function decodeCursor(value: string): SessionCursor {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      !("createdAtMs" in decoded) ||
      !("sessionId" in decoded) ||
      typeof decoded.createdAtMs !== "number" ||
      !Number.isSafeInteger(decoded.createdAtMs) ||
      typeof decoded.sessionId !== "string" ||
      !SessionIdSchema.safeParse(decoded.sessionId).success
    ) {
      throw new Error("invalid cursor");
    }
    return { createdAtMs: decoded.createdAtMs, sessionId: decoded.sessionId };
  } catch {
    throw new HostOperationError("REQUEST_INVALID", "Session list cursor is invalid.");
  }
}

function compareEntries(left: SessionEntry, right: SessionEntry): number {
  return (
    left.state.createdAtMs - right.state.createdAtMs ||
    left.state.sessionId.localeCompare(right.state.sessionId)
  );
}

function compareEntryToCursor(entry: SessionEntry, cursor: SessionCursor): number {
  return (
    entry.state.createdAtMs - cursor.createdAtMs ||
    entry.state.sessionId.localeCompare(cursor.sessionId)
  );
}

function chunkTerminalData(data: string): readonly string[] {
  if (data.length === 0) return [];
  const chunks: string[] = [];
  for (
    let offset = 0;
    offset < data.length;
    offset += DURABLE_SESSION_LIMITS.terminalDataCharacters
  ) {
    chunks.push(data.slice(offset, offset + DURABLE_SESSION_LIMITS.terminalDataCharacters));
  }
  return chunks;
}

function waitForExit(handle: RuntimeHandle, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), timeoutMs);
    timer.unref();
    void handle.exited.then(() => {
      clearTimeout(timer);
      resolvePromise(true);
    });
  });
}
