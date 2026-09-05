import WebSocket, { type RawData } from "ws";
import { connect as connectUnixSocket } from "node:net";
import {
  AppIdSchema,
  DURABLE_SESSION_PROTOCOL_VERSION,
  DurableSessionCallerContextSchema,
  DurableSessionStreamClientFrameSchema,
  DurableSessionStreamServerFrameSchema,
  type AttachmentId,
  type DurableSessionCallerContext,
  type DurableSessionOperationRequest,
  type DurableSessionOperationResponse,
  type DurableSessionStreamAttachmentEvent,
  type DurableSessionStreamClientFrame,
  type DurableSessionStreamServerFrame,
  type RuntimeId,
  type SessionId,
} from "@naru/contracts/durable-session/v0";
import { DurableSessionClientError, DurableSessionStreamProtocolError } from "./errors.js";
import { assertPrivateSocket } from "./node-security.js";
import type {
  DurableSessionOperationEnvelope,
  DurableSessionOperationTransport,
  DurableSessionRequestOptions,
} from "./transport.js";

const DEFAULT_FRAME_BYTES = 4 * 1_024 * 1_024;
const DEFAULT_EVENT_QUEUE_FRAMES = 1_024;
const DEFAULT_EVENT_QUEUE_BYTES = 8 * 1_024 * 1_024;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 35_000;
const MAX_RETIRED_REQUEST_IDS = 1_024;
const PRIVATE_WEBSOCKET_REQUEST_URL = "ws://localhost/v0/stream";

export interface UdsWebSocketDurableSessionTransportOptions {
  readonly socketPath: string;
  readonly appId: string;
  readonly credential: string;
  readonly callerContext: DurableSessionCallerContext;
  readonly frameBytes?: number;
  readonly eventQueueFrames?: number;
  readonly eventQueueBytes?: number;
  readonly connectTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

interface TrackedAttachment {
  readonly sessionId: SessionId;
  readonly runtimeId: RuntimeId;
  controllerGeneration: number;
}

interface PendingOperation {
  readonly request: DurableSessionOperationRequest;
  readonly resolve: (response: DurableSessionOperationResponse) => void;
  readonly reject: (error: unknown) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal | undefined;
  readonly abort: (() => void) | undefined;
}

interface PendingEvent {
  readonly resolve: (frame: DurableSessionStreamAttachmentEvent) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly abort: (() => void) | undefined;
}

interface QueuedEvent {
  readonly frame: DurableSessionStreamAttachmentEvent;
  readonly bytes: number;
}

export class UdsWebSocketDurableSessionTransport implements DurableSessionOperationTransport {
  readonly #socketPath: string;
  readonly #appId: string;
  readonly #credential: string;
  readonly #caller: DurableSessionCallerContext;
  readonly #callerBinding: string;
  readonly #frameBytes: number;
  readonly #eventQueueFrames: number;
  readonly #eventQueueBytes: number;
  readonly #operationTimeoutMs: number;
  readonly #socket: WebSocket;
  readonly #pending = new Map<string, PendingOperation>();
  readonly #retiredRequestIds = new Set<string>();
  readonly #attachments = new Map<AttachmentId, TrackedAttachment>();
  readonly #events: QueuedEvent[] = [];
  readonly #readyPromise: Promise<void>;
  readonly #closedPromise: Promise<void>;
  readonly #readyResolve: () => void;
  readonly #readyReject: (error: unknown) => void;
  readonly #closedResolve: () => void;
  #state: "connecting" | "ready" | "closing" | "closed" = "connecting";
  #readySettled = false;
  #terminalError: Error | null = null;
  #eventBytes = 0;
  #eventWaiter: PendingEvent | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #connectTimer: ReturnType<typeof setTimeout>;

  private constructor(options: UdsWebSocketDurableSessionTransportOptions) {
    if (!AppIdSchema.safeParse(options.appId).success) {
      throw invalid("DurableSession app ID is invalid.");
    }
    if (
      options.credential.length < 32 ||
      options.credential.length > 1_024 ||
      /\s/.test(options.credential)
    ) {
      throw new DurableSessionClientError(
        "CREDENTIAL_FILE_INVALID",
        "DurableSession app credential is invalid.",
      );
    }
    const parsedCaller = DurableSessionCallerContextSchema.safeParse(options.callerContext);
    if (!parsedCaller.success || parsedCaller.data.appId !== options.appId) {
      throw new DurableSessionClientError(
        "CALLER_CONTEXT_INVALID",
        "Stream caller context does not match public protocol v0 or the transport app ID.",
      );
    }
    if (options.signal?.aborted === true) {
      throw new DurableSessionClientError("REQUEST_ABORTED", "DurableSession stream was aborted.");
    }

    assertPrivateSocket(options.socketPath);
    this.#socketPath = options.socketPath;
    this.#appId = options.appId;
    this.#credential = options.credential;
    this.#caller = parsedCaller.data;
    this.#callerBinding = JSON.stringify(parsedCaller.data);
    this.#frameBytes = boundedPositiveInteger(
      options.frameBytes ?? DEFAULT_FRAME_BYTES,
      "stream frame byte limit",
    );
    this.#eventQueueFrames = boundedPositiveInteger(
      options.eventQueueFrames ?? DEFAULT_EVENT_QUEUE_FRAMES,
      "stream event queue frame limit",
    );
    this.#eventQueueBytes = boundedPositiveInteger(
      options.eventQueueBytes ?? DEFAULT_EVENT_QUEUE_BYTES,
      "stream event queue byte limit",
    );
    this.#operationTimeoutMs = boundedPositiveInteger(
      options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
      "stream operation timeout",
    );

    let readyResolve!: () => void;
    let readyReject!: (error: unknown) => void;
    this.#readyPromise = new Promise<void>((resolvePromise, rejectPromise) => {
      readyResolve = resolvePromise;
      readyReject = rejectPromise;
    });
    this.#readyResolve = readyResolve;
    this.#readyReject = readyReject;
    let closedResolve!: () => void;
    this.#closedPromise = new Promise<void>((resolvePromise) => {
      closedResolve = resolvePromise;
    });
    this.#closedResolve = closedResolve;

    this.#socket = new WebSocket(PRIVATE_WEBSOCKET_REQUEST_URL, {
      // `ws+unix:` percent-encodes spaces but does not decode the resulting socket path.
      // Connect the already validated exact UDS path directly and use the URL only for the
      // private HTTP upgrade request target.
      createConnection: () => connectUnixSocket(this.#socketPath),
      headers: {
        authorization: `Bearer ${this.#credential}`,
        "x-durable-session-app-id": this.#appId,
      },
      handshakeTimeout: boundedPositiveInteger(
        options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        "stream connect timeout",
      ),
      maxPayload: this.#frameBytes,
      perMessageDeflate: false,
      followRedirects: false,
    });
    this.#socket.on("open", () => this.#onOpen());
    this.#socket.on("message", (data, isBinary) => this.#onMessage(data, isBinary));
    this.#socket.on("error", (error) => {
      this.#fail(unavailable(error));
    });
    this.#socket.on("close", () => this.#onClose());
    options.signal?.addEventListener("abort", () => this.#fail(aborted()), { once: true });
    this.#connectTimer = setTimeout(
      () =>
        this.#fail(new DurableSessionClientError("TRANSPORT_TIMEOUT", "Stream hello timed out.")),
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    );
  }

  static async connect(
    options: UdsWebSocketDurableSessionTransportOptions,
  ): Promise<UdsWebSocketDurableSessionTransport> {
    const transport = new UdsWebSocketDurableSessionTransport(options);
    await transport.#readyPromise;
    return transport;
  }

  async send(
    envelope: DurableSessionOperationEnvelope,
    options: DurableSessionRequestOptions = {},
  ): Promise<unknown> {
    this.#assertReady();
    if (JSON.stringify(envelope.callerContext) !== this.#callerBinding) {
      throw new DurableSessionClientError(
        "CALLER_CONTEXT_INVALID",
        "Operation caller context does not match the authenticated stream caller.",
      );
    }
    if (options.signal?.aborted === true) throw aborted();
    if (
      this.#pending.has(envelope.request.requestId) ||
      this.#retiredRequestIds.has(envelope.request.requestId)
    ) {
      throw invalid("A stream operation with this request ID is already pending.");
    }

    const timeoutMs =
      envelope.request.operation === "waitForEvents"
        ? Math.max(this.#operationTimeoutMs, envelope.request.timeoutMs + 2_000)
        : this.#operationTimeoutMs;
    return await new Promise<DurableSessionOperationResponse>((resolvePromise, rejectPromise) => {
      const abort =
        options.signal === undefined
          ? undefined
          : () => this.#rejectPending(envelope.request.requestId, aborted());
      const pending: PendingOperation = {
        request: envelope.request,
        resolve: resolvePromise,
        reject: rejectPromise,
        timeout: setTimeout(
          () =>
            this.#rejectPending(
              envelope.request.requestId,
              new DurableSessionClientError(
                "TRANSPORT_TIMEOUT",
                "DurableSession stream operation timed out.",
              ),
            ),
          timeoutMs,
        ),
        signal: options.signal,
        abort,
      };
      this.#pending.set(envelope.request.requestId, pending);
      options.signal?.addEventListener("abort", abort!, { once: true });
      this.#sendFrame({
        version: DURABLE_SESSION_PROTOCOL_VERSION,
        type: "stream.operation",
        request: envelope.request,
      }).catch((error: unknown) => this.#rejectPending(envelope.request.requestId, error));
    });
  }

  nextAttachmentEvent(
    options: DurableSessionRequestOptions = {},
  ): Promise<DurableSessionStreamAttachmentEvent> {
    if (options.signal?.aborted === true) return Promise.reject(aborted());
    const queued = this.#events.shift();
    if (queued !== undefined) {
      this.#eventBytes -= queued.bytes;
      return Promise.resolve(queued.frame);
    }
    if (this.#terminalError !== null) return Promise.reject(this.#terminalError);
    this.#assertReady();
    if (this.#eventWaiter !== null) {
      return Promise.reject(invalid("Only one stream event read may be pending at a time."));
    }
    return new Promise((resolvePromise, rejectPromise) => {
      const abort =
        options.signal === undefined
          ? undefined
          : () => {
              if (this.#eventWaiter?.abort !== abort) return;
              this.#eventWaiter = null;
              rejectPromise(aborted());
            };
      this.#eventWaiter = {
        resolve: resolvePromise,
        reject: rejectPromise,
        signal: options.signal,
        abort,
      };
      options.signal?.addEventListener("abort", abort!, { once: true });
    });
  }

  async close(): Promise<void> {
    if (this.#state === "closed") return;
    if (this.#state !== "closing") {
      this.#state = "closing";
      this.#clearHeartbeat();
      if (this.#socket.readyState === WebSocket.CONNECTING) this.#socket.terminate();
      else if (this.#socket.readyState === WebSocket.OPEN)
        this.#socket.close(1000, "Client closed.");
      else if (this.#socket.readyState === WebSocket.CLOSED) this.#onClose();
    }
    await this.#closedPromise;
  }

  #onOpen(): void {
    if (this.#state !== "connecting") return;
    void this.#sendFrame({
      version: DURABLE_SESSION_PROTOCOL_VERSION,
      type: "stream.hello",
      callerContext: this.#caller,
    }).catch((error: unknown) => this.#fail(error));
  }

  #onMessage(data: RawData, isBinary: boolean): void {
    if (this.#state === "closed" || this.#state === "closing") return;
    const buffer = rawDataBuffer(data);
    if (isBinary || buffer.byteLength > this.#frameBytes) {
      this.#fail(
        new DurableSessionClientError(
          "TRANSPORT_RESPONSE_INVALID",
          "Host stream returned an invalid binary or oversized frame.",
        ),
      );
      return;
    }
    let source: unknown;
    try {
      source = JSON.parse(buffer.toString("utf8")) as unknown;
    } catch {
      this.#fail(invalidResponse());
      return;
    }
    const parsed = DurableSessionStreamServerFrameSchema.safeParse(source);
    if (!parsed.success) {
      this.#fail(invalidResponse());
      return;
    }
    const frame = parsed.data;
    if (frame.type === "stream.error") {
      this.#fail(new DurableSessionStreamProtocolError(frame.error));
      return;
    }
    if (frame.type === "stream.ready") {
      if (this.#state !== "connecting") {
        this.#fail(invalidResponse());
        return;
      }
      this.#state = "ready";
      clearTimeout(this.#connectTimer);
      this.#heartbeatTimer = setInterval(() => this.#heartbeat(), frame.heartbeatIntervalMs);
      this.#heartbeatTimer.unref?.();
      this.#settleReady();
      return;
    }
    if (this.#state !== "ready") {
      this.#fail(invalidResponse());
      return;
    }
    if (frame.type === "stream.operation-response") {
      this.#resolvePending(frame.response);
      return;
    }
    if (frame.type === "stream.attachment-event") {
      this.#recordEvent(frame);
      this.#enqueueEvent(frame, buffer.byteLength);
      return;
    }
    this.#recordHeartbeatAck(frame);
  }

  #resolvePending(response: DurableSessionOperationResponse): void {
    const pending = this.#pending.get(response.requestId);
    if (pending === undefined) {
      if (this.#retiredRequestIds.delete(response.requestId)) return;
      this.#fail(invalidResponse());
      return;
    }
    if (response.ok && response.result.operation !== pending.request.operation) {
      this.#fail(invalidResponse());
      return;
    }
    this.#pending.delete(response.requestId);
    this.#cleanupPending(pending);
    this.#recordResponse(pending.request, response);
    pending.resolve(response);
  }

  #rejectPending(requestId: string, error: unknown): void {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return;
    this.#pending.delete(requestId);
    this.#retireRequestId(requestId);
    this.#cleanupPending(pending);
    pending.reject(error);
  }

  #cleanupPending(pending: PendingOperation): void {
    clearTimeout(pending.timeout);
    if (pending.abort !== undefined) {
      pending.signal?.removeEventListener("abort", pending.abort);
    }
  }

  #retireRequestId(requestId: string): void {
    this.#retiredRequestIds.add(requestId);
    while (this.#retiredRequestIds.size > MAX_RETIRED_REQUEST_IDS) {
      const oldest = this.#retiredRequestIds.values().next().value;
      if (oldest === undefined) return;
      this.#retiredRequestIds.delete(oldest);
    }
  }

  #recordResponse(
    request: DurableSessionOperationRequest,
    response: DurableSessionOperationResponse,
  ): void {
    if (!response.ok) return;
    const result = response.result;
    if (result.operation === "openAttachment" || result.operation === "resumeAttachment") {
      this.#attachments.set(result.attachment.attachmentId, {
        sessionId: result.attachment.sessionId,
        runtimeId: result.attachment.runtimeId,
        controllerGeneration: result.attachment.controllerGeneration,
      });
      return;
    }
    if (result.operation === "closeAttachment" && "attachmentId" in request) {
      this.#attachments.delete(request.attachmentId);
      return;
    }
    if ("control" in result) {
      this.#setSessionGeneration(result.control.sessionId, result.control.controllerGeneration);
    }
  }

  #recordEvent(frame: DurableSessionStreamAttachmentEvent): void {
    if (frame.event.type === "control.changed") {
      this.#setSessionGeneration(frame.event.sessionId, frame.event.controllerGeneration);
    }
  }

  #recordHeartbeatAck(
    frame: Extract<DurableSessionStreamServerFrame, { type: "stream.heartbeat-ack" }>,
  ): void {
    const tracked = this.#attachments.get(frame.attachmentId);
    if (tracked?.sessionId === frame.sessionId) {
      tracked.controllerGeneration = frame.controllerGeneration;
    }
  }

  #setSessionGeneration(sessionId: SessionId, generation: number): void {
    for (const attachment of this.#attachments.values()) {
      if (attachment.sessionId === sessionId) attachment.controllerGeneration = generation;
    }
  }

  #heartbeat(): void {
    if (this.#state !== "ready") return;
    for (const [attachmentId, attachment] of this.#attachments) {
      void this.#sendFrame({
        version: DURABLE_SESSION_PROTOCOL_VERSION,
        type: "stream.heartbeat",
        sessionId: attachment.sessionId,
        attachmentId,
        expectedRuntimeId: attachment.runtimeId,
        expectedControllerGeneration: attachment.controllerGeneration,
        sentAtMs: Date.now(),
      }).catch((error: unknown) => this.#fail(error));
    }
  }

  #enqueueEvent(frame: DurableSessionStreamAttachmentEvent, bytes: number): void {
    const waiter = this.#eventWaiter;
    if (waiter !== null) {
      this.#eventWaiter = null;
      if (waiter.abort !== undefined) waiter.signal?.removeEventListener("abort", waiter.abort);
      waiter.resolve(frame);
      return;
    }
    if (
      this.#events.length >= this.#eventQueueFrames ||
      this.#eventBytes + bytes > this.#eventQueueBytes
    ) {
      this.#fail(
        new DurableSessionClientError(
          "STREAM_QUEUE_OVERFLOW",
          "DurableSession client stream event queue overflowed; reconnect and resync.",
        ),
      );
      return;
    }
    this.#events.push({ frame, bytes });
    this.#eventBytes += bytes;
  }

  #sendFrame(frame: DurableSessionStreamClientFrame): Promise<void> {
    const parsed = DurableSessionStreamClientFrameSchema.parse(frame);
    return new Promise((resolvePromise, rejectPromise) => {
      if (this.#socket.readyState !== WebSocket.OPEN) {
        rejectPromise(unavailable());
        return;
      }
      this.#socket.send(JSON.stringify(parsed), (error) => {
        if (error === undefined || error === null) resolvePromise();
        else rejectPromise(unavailable(error));
      });
    });
  }

  #assertReady(): void {
    if (this.#state !== "ready") {
      if (this.#terminalError !== null) throw this.#terminalError;
      throw unavailable();
    }
  }

  #fail(error: unknown): void {
    if (this.#terminalError === null) {
      this.#terminalError =
        error instanceof Error
          ? error
          : new DurableSessionClientError(
              "TRANSPORT_UNAVAILABLE",
              "DurableSession Host stream failed.",
            );
    }
    clearTimeout(this.#connectTimer);
    this.#clearHeartbeat();
    if (!this.#readySettled) {
      this.#readySettled = true;
      this.#readyReject(this.#terminalError);
    }
    for (const requestId of [...this.#pending.keys()]) {
      this.#rejectPending(requestId, this.#terminalError);
    }
    const waiter = this.#eventWaiter;
    this.#eventWaiter = null;
    if (waiter !== null) {
      if (waiter.abort !== undefined) waiter.signal?.removeEventListener("abort", waiter.abort);
      waiter.reject(this.#terminalError);
    }
    if (this.#state !== "closed") {
      this.#state = "closing";
      if (this.#socket.readyState === WebSocket.CONNECTING) this.#socket.terminate();
      else if (this.#socket.readyState === WebSocket.OPEN)
        this.#socket.close(1008, "Client failed.");
      else if (this.#socket.readyState === WebSocket.CLOSED) this.#onClose();
    }
  }

  #settleReady(): void {
    if (this.#readySettled) return;
    this.#readySettled = true;
    this.#readyResolve();
  }

  #onClose(): void {
    if (this.#state === "closed") return;
    clearTimeout(this.#connectTimer);
    this.#clearHeartbeat();
    const error = this.#terminalError ?? unavailable();
    if (!this.#readySettled) {
      this.#readySettled = true;
      this.#readyReject(error);
    }
    for (const requestId of [...this.#pending.keys()]) this.#rejectPending(requestId, error);
    const waiter = this.#eventWaiter;
    this.#eventWaiter = null;
    if (waiter !== null) {
      if (waiter.abort !== undefined) waiter.signal?.removeEventListener("abort", waiter.abort);
      waiter.reject(error);
    }
    this.#state = "closed";
    this.#closedResolve();
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimer === null) return;
    clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
  }
}

function rawDataBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data);
}

function boundedPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalid(`DurableSession ${label} must be a positive integer.`);
  }
  return value;
}

function invalid(message: string): DurableSessionClientError {
  return new DurableSessionClientError("CLIENT_REQUEST_INVALID", message);
}

function invalidResponse(): DurableSessionClientError {
  return new DurableSessionClientError(
    "TRANSPORT_RESPONSE_INVALID",
    "Host stream response did not match public protocol v0.",
  );
}

function unavailable(cause?: unknown): DurableSessionClientError {
  return new DurableSessionClientError(
    "TRANSPORT_UNAVAILABLE",
    "DurableSession Host stream is unavailable.",
    cause === undefined ? undefined : { cause },
  );
}

function aborted(): DurableSessionClientError {
  return new DurableSessionClientError("REQUEST_ABORTED", "DurableSession stream was aborted.");
}
