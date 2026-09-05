import { randomUUID } from "node:crypto";
import type {
  AttachmentId,
  DurableSessionCallerContext,
  DurableSessionOperationRequest,
  DurableSessionOperationResponse,
  SessionId,
} from "@naru/contracts/durable-session/v0";
import type { HostAppRegistry } from "./app-registry.js";
import { HostOperationError } from "./host-error.js";
import type { HostClock, SessionService } from "./session-service.js";
import { SystemHostClock } from "./session-service.js";
import {
  DurableSessionStreamClientFrameSchema,
  DurableSessionStreamHelloSchema,
  DurableSessionStreamServerFrameSchema,
  type DurableSessionStreamServerFrame,
} from "./stream-protocol.js";

export interface HostStreamSink {
  send(frame: DurableSessionStreamServerFrame): Promise<void>;
  close(code: number, reason: string): void;
}

export interface HostStreamSessionOptions {
  readonly appId: string;
  readonly credential: string;
  readonly appRegistry: HostAppRegistry;
  readonly service: SessionService;
  readonly sink: HostStreamSink;
  readonly clock?: HostClock;
  readonly streamId?: string;
}

interface BoundAttachment {
  readonly sessionId: SessionId;
  readonly unsubscribe: () => void;
  pumpQueued: boolean;
  pumpDirty: boolean;
}

const MAX_PENDING_STREAM_WAITS = 8;

/**
 * Transport-independent state machine used by the private UDS WebSocket
 * adapter. It fixes caller identity at hello, correlates operations, and pumps
 * each attachment independently without blocking SessionService output.
 */
export class HostStreamSession {
  readonly #appId: string;
  readonly #credential: string;
  readonly #appRegistry: HostAppRegistry;
  readonly #service: SessionService;
  readonly #sink: HostStreamSink;
  readonly #clock: HostClock;
  readonly #streamId: string;
  readonly #attachments = new Map<AttachmentId, BoundAttachment>();
  readonly #pendingWaitRequestIds = new Set<string>();
  #caller: DurableSessionCallerContext | null = null;
  #integrationBootstrapKey: Buffer | null = null;
  #tail: Promise<void> = Promise.resolve();
  #accepting = true;
  #closed = false;

  constructor(options: HostStreamSessionOptions) {
    this.#appId = options.appId;
    this.#credential = options.credential;
    this.#appRegistry = options.appRegistry;
    this.#service = options.service;
    this.#sink = options.sink;
    this.#clock = options.clock ?? new SystemHostClock();
    this.#streamId = options.streamId ?? randomUUID();
  }

  receive(source: unknown): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#closed || !this.#accepting) return;
      if (this.#caller === null) {
        await this.#hello(source);
        return;
      }
      const parsed = DurableSessionStreamClientFrameSchema.safeParse(source);
      if (!parsed.success || parsed.data.type === "stream.hello") {
        await this.#protocolFailure("Host stream frame is invalid.");
        return;
      }
      if (parsed.data.type === "stream.heartbeat") {
        await this.#heartbeat(parsed.data);
        return;
      }
      if (parsed.data.request.operation === "waitForEvents") {
        await this.#startWaitOperation(parsed.data.request);
        return;
      }
      await this.#operation(parsed.data.request);
    });
  }

  close(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#closed) return;
      this.#closed = true;
      this.#accepting = false;
      const caller = this.#caller;
      const attachments = [...this.#attachments.entries()];
      this.#attachments.clear();
      this.#pendingWaitRequestIds.clear();
      this.#clearIntegrationBootstrapKey();
      for (const [, attachment] of attachments) attachment.unsubscribe();
      if (caller === null) return;
      await Promise.all(
        attachments.map(async ([attachmentId, attachment]) => {
          try {
            await this.#service.disconnectStreamAttachment(
              caller,
              attachment.sessionId,
              attachmentId,
            );
          } catch {
            // Explicit close/forget may already have removed this attachment.
          }
        }),
      );
    });
  }

  async #hello(source: unknown): Promise<void> {
    const parsed = DurableSessionStreamHelloSchema.safeParse(source);
    if (!parsed.success) {
      await this.#protocolFailure("Host stream hello is invalid.");
      return;
    }
    try {
      const authenticated = this.#appRegistry.authenticateOperation(
        this.#appId,
        this.#credential,
        parsed.data.callerContext,
        this.#clock.nowMs(),
      );
      this.#caller = authenticated.caller;
      this.#integrationBootstrapKey = authenticated.integrationBootstrapKey;
      await this.#send({
        version: 0,
        type: "stream.ready",
        heartbeatIntervalMs: 15_000,
        staleAfterMs: 35_000,
        reconnectGraceMs: 10_000,
      });
    } catch (error) {
      this.#clearIntegrationBootstrapKey();
      await this.#operationFailure(error);
      this.#sink.close(1008, "Host stream authentication failed.");
      this.#accepting = false;
    }
  }

  async #operation(request: DurableSessionOperationRequest): Promise<void> {
    let caller: DurableSessionCallerContext;
    try {
      caller = this.#requireCaller();
    } catch (error) {
      await this.#send({
        version: 0,
        type: "stream.operation-response",
        response: operationFailure(request.requestId, error),
      });
      this.#closeExpiredCaller();
      return;
    }
    try {
      if ("attachmentId" in request && request.operation !== "resumeAttachment") {
        await this.#bind(caller, request.sessionId, request.attachmentId);
      }
      const response = await this.#service.execute(
        caller,
        request,
        this.#integrationBootstrapKey === null
          ? {}
          : { integrationBootstrapKey: this.#integrationBootstrapKey },
      );
      await this.#send({ version: 0, type: "stream.operation-response", response });
      if (!response.ok) return;

      if (
        response.result.operation === "openAttachment" ||
        response.result.operation === "resumeAttachment"
      ) {
        await this.#bind(
          caller,
          response.result.attachment.sessionId,
          response.result.attachment.attachmentId,
        );
        await this.#pumpOnce(response.result.attachment.attachmentId);
      } else if (response.result.operation === "closeAttachment" && "attachmentId" in request) {
        this.#unbind(request.attachmentId);
      }
    } catch (error) {
      await this.#send({
        version: 0,
        type: "stream.operation-response",
        response: operationFailure(request.requestId, error),
      });
    }
  }

  async #startWaitOperation(
    request: Extract<DurableSessionOperationRequest, { operation: "waitForEvents" }>,
  ): Promise<void> {
    let caller: DurableSessionCallerContext;
    try {
      caller = this.#requireCaller();
    } catch (error) {
      await this.#send({
        version: 0,
        type: "stream.operation-response",
        response: operationFailure(request.requestId, error),
      });
      this.#closeExpiredCaller();
      return;
    }
    if (
      this.#pendingWaitRequestIds.has(request.requestId) ||
      this.#pendingWaitRequestIds.size >= MAX_PENDING_STREAM_WAITS
    ) {
      await this.#send({
        version: 0,
        type: "stream.operation-response",
        response: operationFailure(
          request.requestId,
          new HostOperationError("REQUEST_INVALID", "Host stream waitForEvents limit was reached."),
        ),
      });
      return;
    }

    this.#pendingWaitRequestIds.add(request.requestId);
    void this.#service
      .execute(caller, request)
      .then(
        (response) =>
          this.#enqueue(async () => {
            if (this.#closed || !this.#accepting) return;
            await this.#send({ version: 0, type: "stream.operation-response", response });
          }),
        (error: unknown) =>
          this.#enqueue(async () => {
            if (this.#closed || !this.#accepting) return;
            await this.#send({
              version: 0,
              type: "stream.operation-response",
              response: operationFailure(request.requestId, error),
            });
          }),
      )
      .then(
        () => {
          this.#pendingWaitRequestIds.delete(request.requestId);
        },
        () => {
          this.#pendingWaitRequestIds.delete(request.requestId);
          this.#accepting = false;
          this.#sink.close(1011, "Host stream failed.");
        },
      );
  }

  async #heartbeat(
    frame: Extract<
      ReturnType<typeof DurableSessionStreamClientFrameSchema.parse>,
      { type: "stream.heartbeat" }
    >,
  ): Promise<void> {
    let caller: DurableSessionCallerContext;
    try {
      caller = this.#requireCaller();
    } catch (error) {
      await this.#operationFailure(error);
      this.#closeExpiredCaller();
      return;
    }
    try {
      await this.#bind(caller, frame.sessionId, frame.attachmentId);
      const result = await this.#service.heartbeatAttachment(caller, {
        sessionId: frame.sessionId,
        attachmentId: frame.attachmentId,
        expectedRuntimeId: frame.expectedRuntimeId,
        expectedControllerGeneration: frame.expectedControllerGeneration,
      });
      await this.#send({
        version: 0,
        type: "stream.heartbeat-ack",
        sessionId: frame.sessionId,
        attachmentId: frame.attachmentId,
        receivedAtMs: result.receivedAtMs,
        controllerGeneration: result.controllerGeneration,
      });
    } catch (error) {
      await this.#operationFailure(error);
    }
  }

  async #bind(
    caller: DurableSessionCallerContext,
    sessionId: SessionId,
    attachmentId: AttachmentId,
  ): Promise<void> {
    if (this.#attachments.has(attachmentId)) return;
    const unsubscribe = await this.#service.bindStreamAttachment(
      caller,
      sessionId,
      attachmentId,
      this.#streamId,
      () => {
        this.#schedulePump(attachmentId);
      },
    );
    this.#attachments.set(attachmentId, {
      sessionId,
      unsubscribe,
      pumpQueued: false,
      pumpDirty: false,
    });
    this.#schedulePump(attachmentId);
  }

  #unbind(attachmentId: AttachmentId): void {
    this.#attachments.get(attachmentId)?.unsubscribe();
    this.#attachments.delete(attachmentId);
  }

  async #pumpOnce(attachmentId: AttachmentId): Promise<boolean> {
    if (this.#closed || !this.#accepting || !this.#attachments.has(attachmentId)) return false;
    try {
      this.#requireCaller();
    } catch (error) {
      await this.#operationFailure(error);
      this.#closeExpiredCaller();
      return false;
    }
    const event = await this.#service.takeStreamEvent(attachmentId, this.#streamId);
    if (event === null) return false;
    await this.#send({
      version: 0,
      type: "stream.attachment-event",
      attachmentId,
      event,
    });
    return true;
  }

  #schedulePump(attachmentId: AttachmentId): void {
    const attachment = this.#attachments.get(attachmentId);
    if (attachment === undefined || this.#closed || !this.#accepting) return;
    attachment.pumpDirty = true;
    if (attachment.pumpQueued) return;
    attachment.pumpQueued = true;
    void this.#enqueue(async () => {
      const current = this.#attachments.get(attachmentId);
      if (current !== attachment) return false;
      attachment.pumpDirty = false;
      return this.#pumpOnce(attachmentId);
    }).then(
      (sent) => {
        if (this.#attachments.get(attachmentId) !== attachment) return;
        attachment.pumpQueued = false;
        if (sent || attachment.pumpDirty) this.#schedulePump(attachmentId);
      },
      () => {
        if (this.#attachments.get(attachmentId) !== attachment) return;
        attachment.pumpQueued = false;
        this.#accepting = false;
        this.#sink.close(1011, "Host stream failed.");
      },
    );
  }

  async #operationFailure(error: unknown): Promise<void> {
    const normalized = normalizeStreamError(error);
    await this.#send({
      version: 0,
      type: "stream.error",
      error: normalized.toDurableSessionError(),
    });
  }

  async #protocolFailure(message: string): Promise<void> {
    await this.#operationFailure(new HostOperationError("REQUEST_INVALID", message));
    this.#sink.close(1008, message);
    this.#accepting = false;
  }

  #requireCaller(): DurableSessionCallerContext {
    if (this.#caller === null) throw new Error("Host stream caller is not authenticated.");
    if (this.#caller.expiresAtMs <= this.#clock.nowMs()) {
      throw new HostOperationError("CAPABILITY_REQUIRED", "Host stream caller has expired.");
    }
    return this.#caller;
  }

  #closeExpiredCaller(): void {
    this.#accepting = false;
    this.#sink.close(1008, "Host stream caller expired.");
  }

  #send(frame: DurableSessionStreamServerFrame): Promise<void> {
    return this.#sink.send(DurableSessionStreamServerFrameSchema.parse(frame));
  }

  #clearIntegrationBootstrapKey(): void {
    this.#integrationBootstrapKey?.fill(0);
    this.#integrationBootstrapKey = null;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function operationFailure(requestId: string, error: unknown): DurableSessionOperationResponse {
  const normalized = normalizeStreamError(error);
  return { version: 0, requestId, ok: false, error: normalized.toDurableSessionError() };
}

function normalizeStreamError(error: unknown): HostOperationError {
  return error instanceof HostOperationError
    ? error
    : new HostOperationError("INTERNAL_ERROR", "Host stream operation failed.", randomUUID());
}
