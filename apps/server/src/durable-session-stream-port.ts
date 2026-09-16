import { randomUUID } from "node:crypto";
import type { ServerWsFrame } from "@naru/contracts";
import {
  type AttachmentLease,
  type DurableSessionCallerContext,
  type DurableSessionCapability,
  type DurableSessionEvent,
  type TerminalSize,
} from "@naru/contracts/durable-session/v0";
import {
  DurableSessionClient,
  DurableSessionClientError,
  DurableSessionProtocolError,
  DurableSessionStreamProtocolError,
} from "@naru/durable-session-client";
import {
  readPrivateCredentialFile,
  UdsWebSocketDurableSessionTransport,
} from "@naru/durable-session-client/node";
import type { DurableHostConfig } from "./durable-session-host-client.js";
import type {
  DurableSessionRuntimeUnavailableReason,
  DurableSessionStreamBinding,
  DurableSessionStreamPort,
} from "./durable-session-facade.js";
import { AppError } from "./errors.js";
import type { SessionFrameListener } from "./session-facade.js";

const STREAM_CAPABILITIES = [
  "session:observe",
  "control:request",
  "control:preempt",
] as const satisfies readonly DurableSessionCapability[];
const PROBE_CACHE_MS = 1_000;
const RECONNECT_INITIAL_DELAY_MS = 25;
const RECONNECT_MAX_DELAY_MS = 500;

interface StreamConnection {
  readonly transport: UdsWebSocketDurableSessionTransport;
  readonly client: DurableSessionClient;
  readonly expiresAtMs: number;
}

interface PaneAttachment {
  readonly binding: DurableSessionStreamBinding;
  readonly listener: SessionFrameListener;
  readonly onRuntimeUnavailable:
    ((reason: DurableSessionRuntimeUnavailableReason) => void) | undefined;
  terminal: TerminalSize;
  canonicalTerminal: TerminalSize;
  desiredControl: boolean;
  lease: AttachmentLease;
  connection: StreamConnection;
  resumedConnection: StreamConnection | null;
  projectedSequence: number | null;
  rotationTimer: ReturnType<typeof setTimeout> | null;
  recovery: Promise<void> | null;
  healthy: boolean;
  closed: boolean;
}

/**
 * Naru's compatibility adapter for the public T07/T08 Host stream.
 *
 * The browser keeps using the legacy Naru WebSocket frames while this port owns only a Host
 * attachment. It never owns a PTY, runtime, terminal emulator, sequence, or process lifecycle.
 */
export class UdsDurableSessionStreamPort implements DurableSessionStreamPort {
  readonly #attachments = new Map<string, PaneAttachment>();
  readonly #closing = new Map<string, Promise<void>>();
  readonly #now: () => number;
  #probe: Promise<boolean> | null = null;
  #probeReadyUntil = 0;
  #shuttingDown = false;

  constructor(
    private readonly config: DurableHostConfig,
    options: { readonly now?: () => number } = {},
  ) {
    this.#now = options.now ?? Date.now;
  }

  async readiness(): Promise<boolean> {
    if (this.#shuttingDown) return false;
    if (this.#attachments.size > 0) {
      return [...this.#attachments.values()].every(
        (attachment) => attachment.healthy && !attachment.closed,
      );
    }
    if (this.#probeReadyUntil > this.#now()) return true;
    this.#probe ??= this.#probeStream().finally(() => {
      this.#probe = null;
    });
    return this.#probe;
  }

  async attach(
    binding: DurableSessionStreamBinding,
    columns: number,
    rows: number,
    listener: SessionFrameListener,
    _restoreProtocol?: unknown,
    _restoreId?: string,
    desiredControl = true,
    onRuntimeUnavailable?: (reason: DurableSessionRuntimeUnavailableReason) => void,
  ): Promise<() => void> {
    if (this.#shuttingDown) throw unavailable();
    await this.#detachAttachment(binding.attachmentKey);
    const pendingClose = this.#closing.get(binding.attachmentKey);
    if (pendingClose !== undefined) await pendingClose;

    const terminal = { cols: columns, rows };
    const connection = await this.#connect();
    let lease: AttachmentLease;
    try {
      const opened = await connection.client.request({
        operation: "openAttachment",
        sessionId: binding.sessionId,
        clientInstanceId: randomUUID(),
      });
      lease = opened.attachment;
      assertLeaseBinding(binding, lease);
    } catch (error) {
      await connection.transport.close().catch(() => undefined);
      throw toStreamAppError(error);
    }

    const attachment: PaneAttachment = {
      binding,
      listener,
      onRuntimeUnavailable,
      terminal,
      canonicalTerminal: terminal,
      desiredControl,
      lease,
      connection,
      resumedConnection: null,
      projectedSequence: null,
      rotationTimer: null,
      recovery: null,
      healthy: true,
      closed: false,
    };
    this.#attachments.set(binding.attachmentKey, attachment);
    try {
      if (desiredControl) await this.#acquireIfAvailable(attachment);
      this.#scheduleRotation(attachment);
      this.#startPump(attachment, connection);
    } catch (error) {
      await this.#detachRecord(attachment);
      throw toStreamAppError(error);
    }

    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      void this.#detachRecord(attachment);
    };
  }

  async write(binding: DurableSessionStreamBinding, data: string): Promise<void> {
    const attachment = await this.#requireAttachment(binding);
    if (!attachment.desiredControl) throw controlUnavailable();
    if (!(await this.#acquireIfAvailable(attachment))) throw controlUnavailable();
    try {
      await attachment.connection.client.request({
        operation: "sendInput",
        ...currentIdentity(attachment.lease),
        inputId: randomUUID(),
        data,
      });
    } catch (error) {
      throw toStreamAppError(error);
    }
  }

  async resize(binding: DurableSessionStreamBinding, columns: number, rows: number): Promise<void> {
    const attachment = await this.#requireAttachment(binding);
    attachment.terminal = { cols: columns, rows };
    if (!attachment.desiredControl) throw controlUnavailable();
    if (!(await this.#acquireIfAvailable(attachment))) throw controlUnavailable();
    try {
      await attachment.connection.client.request({
        operation: "resizeTerminal",
        ...currentIdentity(attachment.lease),
        terminal: attachment.terminal,
      });
    } catch (error) {
      throw toStreamAppError(error);
    }
  }

  async updateViewport(binding: DurableSessionStreamBinding, runtimeId: string): Promise<void> {
    const attachment = await this.#requireAttachment(binding);
    if (attachment.lease.runtimeId !== runtimeId) {
      throw new AppError("PTY_NOT_RUNNING", 409, "Host runtime이 변경되었습니다.");
    }
    // DurableSession v0 keeps canonical terminal state in Host and presentation scroll locally.
    // The legacy Naru viewport frame is therefore validation-only at this compatibility seam.
  }

  async setControlDesired(
    binding: DurableSessionStreamBinding,
    desired: boolean,
    columns: number,
    rows: number,
  ): Promise<void> {
    const attachment = await this.#requireAttachment(binding);
    attachment.terminal = { cols: columns, rows };
    attachment.desiredControl = desired;
    if (desired) {
      await this.#acquireIfAvailable(attachment);
      return;
    }
    if (attachment.lease.role !== "controller") return;
    try {
      const result = await attachment.connection.client.request({
        operation: "releaseControl",
        sessionId: attachment.lease.sessionId,
        attachmentId: attachment.lease.attachmentId,
        expectedControllerGeneration: attachment.lease.controllerGeneration,
      });
      updateControl(
        attachment,
        result.control.controllerAttachmentId,
        result.control.controllerGeneration,
      );
      attachment.canonicalTerminal = result.control.terminal;
      this.#emitControlState(attachment, result.control.terminal, "released");
    } catch (error) {
      if (
        isProtocolError(error, "ATTACHMENT_NOT_CONTROLLER") ||
        isProtocolError(error, "CONTROL_GENERATION_STALE")
      ) {
        return;
      }
      throw toStreamAppError(error);
    }
  }

  async preemptControl(
    binding: DurableSessionStreamBinding,
    columns: number,
    rows: number,
  ): Promise<void> {
    const attachment = await this.#requireAttachment(binding);
    attachment.terminal = { cols: columns, rows };
    attachment.desiredControl = true;
    try {
      const result = await attachment.connection.client.request({
        operation: "preemptControl",
        ...currentIdentity(attachment.lease),
        idempotencyKey: randomUUID(),
        terminal: attachment.terminal,
        reasonCode: "naru-user-takeover",
      });
      updateControl(
        attachment,
        result.control.controllerAttachmentId,
        result.control.controllerGeneration,
      );
      attachment.canonicalTerminal = result.control.terminal;
      this.#emitControlState(attachment, result.control.terminal, "preempted");
    } catch (error) {
      throw toStreamAppError(error);
    }
  }

  async approveControl(
    binding: DurableSessionStreamBinding,
    controlRequestId: string,
  ): Promise<void> {
    const attachment = await this.#requireAttachment(binding);
    if (!attachment.desiredControl || attachment.lease.role !== "controller") {
      throw controlUnavailable();
    }
    try {
      await attachment.connection.client.request({
        operation: "approveControl",
        sessionId: attachment.lease.sessionId,
        attachmentId: attachment.lease.attachmentId,
        controlRequestId,
        expectedControllerGeneration: attachment.lease.controllerGeneration,
      });
    } catch (error) {
      throw toStreamAppError(error);
    }
  }

  async rejectControl(
    binding: DurableSessionStreamBinding,
    controlRequestId: string,
  ): Promise<void> {
    const attachment = await this.#requireAttachment(binding);
    if (!attachment.desiredControl || attachment.lease.role !== "controller") {
      throw controlUnavailable();
    }
    try {
      await attachment.connection.client.request({
        operation: "rejectControl",
        sessionId: attachment.lease.sessionId,
        attachmentId: attachment.lease.attachmentId,
        controlRequestId,
        expectedControllerGeneration: attachment.lease.controllerGeneration,
      });
    } catch (error) {
      throw toStreamAppError(error);
    }
  }

  async releaseControl(binding: DurableSessionStreamBinding): Promise<void> {
    const attachment = await this.#requireAttachment(binding);
    attachment.desiredControl = false;
    if (attachment.lease.role !== "controller") return;
    try {
      const result = await attachment.connection.client.request({
        operation: "releaseControl",
        sessionId: attachment.lease.sessionId,
        attachmentId: attachment.lease.attachmentId,
        expectedControllerGeneration: attachment.lease.controllerGeneration,
      });
      updateControl(
        attachment,
        result.control.controllerAttachmentId,
        result.control.controllerGeneration,
      );
      attachment.canonicalTerminal = result.control.terminal;
      this.#emitControlState(attachment, result.control.terminal, "released");
    } catch (error) {
      throw toStreamAppError(error);
    }
  }

  async shutdown(): Promise<void> {
    if (this.#shuttingDown) {
      await Promise.allSettled(this.#closing.values());
      return;
    }
    this.#shuttingDown = true;
    const attachments = [...this.#attachments.values()];
    await Promise.allSettled(attachments.map((attachment) => this.#detachRecord(attachment)));
    await Promise.allSettled(this.#closing.values());
  }

  async #probeStream(): Promise<boolean> {
    let connection: StreamConnection | null = null;
    try {
      connection = await this.#connect();
      this.#probeReadyUntil = this.#now() + PROBE_CACHE_MS;
      return true;
    } catch {
      this.#probeReadyUntil = 0;
      return false;
    } finally {
      await connection?.transport.close().catch(() => undefined);
    }
  }

  async #connect(): Promise<StreamConnection> {
    const expiresAtMs = this.#now() + this.config.callerTtlMs;
    const callerContext = streamCallerContext(this.config, expiresAtMs);
    const transport = await UdsWebSocketDurableSessionTransport.connect({
      socketPath: this.config.socketPath,
      appId: this.config.appId,
      credential: readPrivateCredentialFile(this.config.credentialFile),
      callerContext,
      operationTimeoutMs: 35_000,
    });
    return {
      transport,
      client: new DurableSessionClient({ transport, callerContext }),
      expiresAtMs,
    };
  }

  async #requireAttachment(binding: DurableSessionStreamBinding): Promise<PaneAttachment> {
    const attachment = this.#attachments.get(binding.attachmentKey);
    if (
      attachment === undefined ||
      attachment.closed ||
      attachment.binding.sessionId !== binding.sessionId ||
      attachment.binding.runtimeId !== binding.runtimeId ||
      attachment.binding.paneId !== binding.paneId
    ) {
      throw new AppError("PTY_NOT_RUNNING", 409, "실행 중인 Host attachment가 없습니다.");
    }
    if (attachment.recovery !== null) await attachment.recovery;
    if (!attachment.healthy || attachment.closed) throw unavailable();
    return attachment;
  }

  async #acquireIfAvailable(attachment: PaneAttachment): Promise<boolean> {
    if (attachment.lease.role === "controller") return true;
    try {
      const result = await attachment.connection.client.request({
        operation: "acquireControl",
        ...currentIdentity(attachment.lease),
        terminal: attachment.terminal,
      });
      const acquired = result.control.controllerAttachmentId === attachment.lease.attachmentId;
      updateControl(
        attachment,
        result.control.controllerAttachmentId,
        result.control.controllerGeneration,
      );
      attachment.canonicalTerminal = result.control.terminal;
      this.#emitControlState(attachment, result.control.terminal, "acquired");
      return acquired;
    } catch (error) {
      if (
        isProtocolError(error, "CONTROL_HELD") ||
        isProtocolError(error, "SESSION_NOT_RUNNING") ||
        isProtocolError(error, "RUNTIME_STALE")
      ) {
        return false;
      }
      throw error;
    }
  }

  #startPump(attachment: PaneAttachment, connection: StreamConnection): void {
    void this.#pump(attachment, connection).catch(() => undefined);
  }

  async #pump(attachment: PaneAttachment, connection: StreamConnection): Promise<void> {
    while (
      !attachment.closed &&
      attachment.connection === connection &&
      this.#attachments.get(attachment.binding.attachmentKey) === attachment
    ) {
      let frame;
      try {
        frame = await connection.transport.nextAttachmentEvent();
      } catch {
        if (!attachment.closed && attachment.connection === connection) {
          await this.#recover(attachment, connection);
        }
        return;
      }
      if (frame.attachmentId !== attachment.lease.attachmentId) continue;
      try {
        await this.#handleEvent(attachment, connection, frame.event);
      } catch {
        if (!attachment.closed && attachment.connection === connection) {
          await this.#recover(attachment, connection);
        }
        return;
      }
    }
  }

  async #handleEvent(
    attachment: PaneAttachment,
    connection: StreamConnection,
    event: DurableSessionEvent,
  ): Promise<void> {
    if (event.sessionId !== attachment.binding.sessionId) return;
    switch (event.type) {
      case "terminal.snapshot":
        if (event.runtimeId !== attachment.binding.runtimeId) return;
        attachment.canonicalTerminal = event.terminal;
        if (attachment.resumedConnection === connection) {
          attachment.resumedConnection = null;
          if (
            attachment.projectedSequence !== null &&
            event.sequence <= attachment.projectedSequence
          ) {
            return;
          }
          attachment.projectedSequence = event.sequence;
          this.#emitSnapshot(attachment, event);
          return;
        }
        this.#emitControlState(attachment, event.terminal, "attached");
        attachment.projectedSequence = event.sequence;
        this.#emitSnapshot(attachment, event);
        return;
      case "terminal.output":
        if (event.runtimeId !== attachment.binding.runtimeId) return;
        attachment.projectedSequence = Math.max(attachment.projectedSequence ?? 0, event.sequence);
        this.#emit(attachment, {
          type: "terminal.output",
          paneId: attachment.binding.paneId,
          sequence: event.sequence,
          data: event.data,
        });
        return;
      case "terminal.exited":
        if (event.runtimeId !== attachment.binding.runtimeId) return;
        this.#emit(attachment, {
          type: "terminal.exit",
          paneId: attachment.binding.paneId,
          exitCode: event.exitCode ?? 0,
          ...(event.signal === null ? {} : { signal: event.signal }),
        });
        await this.#detachRecord(attachment);
        return;
      case "attachment.resync-required":
        if (event.attachmentId !== attachment.lease.attachmentId) return;
        await this.#resync(attachment, event.afterSequence);
        return;
      case "control.available":
        attachment.lease = {
          ...attachment.lease,
          controllerGeneration: event.controllerGeneration,
          role: "observer",
        };
        this.#emitControlState(attachment, attachment.canonicalTerminal, "released");
        if (attachment.desiredControl) await this.#acquireIfAvailable(attachment);
        return;
      case "control.changed":
        updateControl(attachment, event.controllerAttachmentId, event.controllerGeneration);
        attachment.canonicalTerminal = event.terminal;
        this.#emitControlState(attachment, event.terminal, event.reason);
        return;
      case "control.requested":
        this.#emit(attachment, {
          type: "pane.control.requested",
          paneId: attachment.binding.paneId,
          controlRequestId: event.request.controlRequestId,
          controllerGeneration: event.controllerGeneration,
          expiresAtMs: event.request.expiresAtMs,
        });
        return;
      case "control.request-resolved":
        this.#emit(attachment, {
          type: "pane.control.request-resolved",
          paneId: attachment.binding.paneId,
          controlRequestId: event.controlRequestId,
          controllerGeneration: event.controllerGeneration,
          resolution: event.resolution,
        });
        return;
      case "session.changed":
      case "control.offered":
      case "integration.event":
        return;
    }
  }

  async #resync(attachment: PaneAttachment, afterSequence: number): Promise<void> {
    const result = await attachment.connection.client.request({
      operation: "resyncAttachment",
      sessionId: attachment.lease.sessionId,
      attachmentId: attachment.lease.attachmentId,
      expectedRuntimeId: attachment.lease.runtimeId,
      afterSequence,
    });
    const snapshot = result.snapshot;
    if (
      snapshot.sessionId !== attachment.binding.sessionId ||
      snapshot.attachmentId !== attachment.lease.attachmentId ||
      snapshot.runtimeId !== attachment.binding.runtimeId
    ) {
      throw new Error("Host resync snapshot identity mismatch.");
    }
    this.#emit(attachment, {
      type: "pane.snapshot",
      paneId: attachment.binding.paneId,
      runtimeId: snapshot.runtimeId,
      sequence: snapshot.sequence,
      serializedState: snapshot.serializedState,
      cols: snapshot.terminal.cols,
      rows: snapshot.terminal.rows,
    });
    attachment.canonicalTerminal = snapshot.terminal;
    attachment.projectedSequence = snapshot.sequence;
  }

  #emitSnapshot(
    attachment: PaneAttachment,
    snapshot: Extract<DurableSessionEvent, { type: "terminal.snapshot" }>,
  ): void {
    this.#emit(attachment, {
      type: "pane.snapshot",
      paneId: attachment.binding.paneId,
      runtimeId: snapshot.runtimeId,
      sequence: snapshot.sequence,
      serializedState: snapshot.serializedState,
      cols: snapshot.terminal.cols,
      rows: snapshot.terminal.rows,
    });
  }

  #emitControlState(
    attachment: PaneAttachment,
    terminal: TerminalSize,
    reason:
      "attached" | "acquired" | "transferred" | "preempted" | "released" | "expired" | "closed",
  ): void {
    this.#emit(attachment, {
      type: "pane.control.state",
      paneId: attachment.binding.paneId,
      role: attachment.lease.role,
      controllerGeneration: attachment.lease.controllerGeneration,
      terminal,
      reason,
    });
  }

  #emit(attachment: PaneAttachment, frame: ServerWsFrame): void {
    if (attachment.closed) return;
    try {
      attachment.listener(frame);
    } catch {
      // The outer Naru socket owns its own close/detach lifecycle.
    }
  }

  #scheduleRotation(attachment: PaneAttachment): void {
    if (attachment.closed) return;
    if (attachment.rotationTimer !== null) clearTimeout(attachment.rotationTimer);
    // Heartbeats refresh the Host-side token window without issuing a new lease. Rotate before
    // the earliest deadline that this adapter can prove instead of trusting the longer caller TTL.
    const remainingMs =
      Math.min(attachment.connection.expiresAtMs, attachment.lease.resumeExpiresAtMs) - this.#now();
    const safetyMs = Math.min(
      5_000,
      Math.max(250, Math.floor(Math.min(this.config.callerTtlMs, remainingMs) / 4)),
    );
    const delayMs = Math.max(0, remainingMs - safetyMs);
    const connection = attachment.connection;
    attachment.rotationTimer = setTimeout(() => {
      void this.#recover(attachment, connection).catch(() => undefined);
    }, delayMs);
    attachment.rotationTimer.unref?.();
  }

  async #recover(attachment: PaneAttachment, connection: StreamConnection): Promise<void> {
    if (attachment.closed || attachment.connection !== connection) return;
    if (attachment.recovery !== null) return attachment.recovery;
    const recovery = this.#performRecovery(attachment, connection);
    attachment.recovery = recovery;
    try {
      await recovery;
    } finally {
      if (attachment.recovery === recovery) attachment.recovery = null;
    }
  }

  async #performRecovery(attachment: PaneAttachment, previous: StreamConnection): Promise<void> {
    attachment.healthy = false;
    if (attachment.rotationTimer !== null) clearTimeout(attachment.rotationTimer);
    attachment.rotationTimer = null;
    await previous.transport.close().catch(() => undefined);
    if (attachment.closed) return;

    const previousLease = attachment.lease;
    let delayMs = RECONNECT_INITIAL_DELAY_MS;
    while (!attachment.closed && this.#now() < previousLease.resumeExpiresAtMs) {
      let next: StreamConnection | null = null;
      try {
        next = await this.#connect();
        const resumed = await next.client.request({
          operation: "resumeAttachment",
          sessionId: previousLease.sessionId,
          attachmentId: previousLease.attachmentId,
          expectedRuntimeId: previousLease.runtimeId,
          expectedControllerGeneration: previousLease.controllerGeneration,
          attachmentResumeToken: previousLease.attachmentResumeToken,
        });
        assertLeaseBinding(attachment.binding, resumed.attachment);
        attachment.lease = resumed.attachment;
        attachment.resumedConnection = next;
        this.#activateRecoveredConnection(attachment, next);
        return;
      } catch (error) {
        await next?.transport.close().catch(() => undefined);
        if (isResumeTerminalError(error)) break;
        if (!isRetryableConnectionError(error)) break;
      }
      await delay(delayMs);
      delayMs = Math.min(RECONNECT_MAX_DELAY_MS, delayMs * 2);
    }
    if (attachment.closed) return;

    let replacement: StreamConnection | null = null;
    try {
      replacement = await this.#connect();
      const opened = await replacement.client.request({
        operation: "openAttachment",
        sessionId: attachment.binding.sessionId,
        clientInstanceId: randomUUID(),
      });
      assertLeaseBinding(attachment.binding, opened.attachment);
      attachment.lease = opened.attachment;
      attachment.connection = replacement;
      attachment.resumedConnection = null;
      if (attachment.desiredControl) await this.#acquireIfAvailable(attachment);
      this.#activateRecoveredConnection(attachment, replacement);
    } catch (error) {
      await replacement?.transport.close().catch(() => undefined);
      const reason = runtimeUnavailableReason(error);
      if (reason !== null) {
        this.#retireRuntimeUnavailableAttachment(attachment, reason);
        return;
      }
      attachment.healthy = false;
      throw error;
    }
  }

  #retireRuntimeUnavailableAttachment(
    attachment: PaneAttachment,
    reason: DurableSessionRuntimeUnavailableReason,
  ): void {
    if (this.#attachments.get(attachment.binding.attachmentKey) === attachment) {
      this.#attachments.delete(attachment.binding.attachmentKey);
    }
    attachment.closed = true;
    attachment.healthy = false;
    if (attachment.rotationTimer !== null) clearTimeout(attachment.rotationTimer);
    attachment.rotationTimer = null;
    try {
      attachment.onRuntimeUnavailable?.(reason);
    } catch {
      // Runtime retirement must not be undone by an outer projection listener.
    }
  }

  #activateRecoveredConnection(attachment: PaneAttachment, connection: StreamConnection): void {
    attachment.connection = connection;
    attachment.healthy = true;
    this.#scheduleRotation(attachment);
    this.#startPump(attachment, connection);
  }

  async #detachAttachment(attachmentKey: string): Promise<void> {
    const existing = this.#attachments.get(attachmentKey);
    if (existing !== undefined) await this.#detachRecord(existing);
  }

  #detachRecord(attachment: PaneAttachment): Promise<void> {
    const attachmentKey = attachment.binding.attachmentKey;
    const existingClose = this.#closing.get(attachmentKey);
    if (existingClose !== undefined) return existingClose;
    if (attachment.closed && this.#attachments.get(attachmentKey) !== attachment) {
      return Promise.resolve();
    }
    if (this.#attachments.get(attachmentKey) === attachment) {
      this.#attachments.delete(attachmentKey);
    }
    attachment.closed = true;
    attachment.healthy = false;
    if (attachment.rotationTimer !== null) clearTimeout(attachment.rotationTimer);
    attachment.rotationTimer = null;
    const closing = (async () => {
      await attachment.recovery?.catch(() => undefined);
      try {
        await attachment.connection.client.request({
          operation: "closeAttachment",
          sessionId: attachment.lease.sessionId,
          attachmentId: attachment.lease.attachmentId,
        });
      } catch {
        // Closing the stream starts bounded Host grace when explicit close is no longer possible.
      }
      await attachment.connection.transport.close().catch(() => undefined);
    })().finally(() => {
      if (this.#closing.get(attachmentKey) === closing) this.#closing.delete(attachmentKey);
    });
    this.#closing.set(attachmentKey, closing);
    return closing;
  }
}

function streamCallerContext(
  config: DurableHostConfig,
  expiresAtMs: number,
): DurableSessionCallerContext {
  return {
    appId: config.appId,
    subject: config.subject,
    capabilities: [...STREAM_CAPABILITIES],
    sessionScope: { kind: "all" },
    profileScope: { kind: "ids", ids: [...config.profileIds] },
    rootScope: { kind: "ids", ids: config.roots.map((root) => root.rootId) },
    expiresAtMs,
  };
}

function currentIdentity(lease: AttachmentLease) {
  return {
    sessionId: lease.sessionId,
    attachmentId: lease.attachmentId,
    expectedRuntimeId: lease.runtimeId,
    expectedControllerGeneration: lease.controllerGeneration,
  } as const;
}

function updateControl(
  attachment: PaneAttachment,
  controllerAttachmentId: string | null,
  controllerGeneration: number,
): void {
  attachment.lease = {
    ...attachment.lease,
    controllerGeneration,
    role: controllerAttachmentId === attachment.lease.attachmentId ? "controller" : "observer",
  };
}

function assertLeaseBinding(binding: DurableSessionStreamBinding, lease: AttachmentLease): void {
  if (lease.sessionId !== binding.sessionId || lease.runtimeId !== binding.runtimeId) {
    throw new AppError("PTY_NOT_RUNNING", 409, "Host attachment runtime이 일치하지 않습니다.");
  }
}

function isProtocolError(error: unknown, code: string): boolean {
  return (
    (error instanceof DurableSessionProtocolError ||
      error instanceof DurableSessionStreamProtocolError) &&
    error.code === code
  );
}

function isResumeTerminalError(error: unknown): boolean {
  return (
    error instanceof DurableSessionProtocolError &&
    (error.code === "ATTACHMENT_RESUME_REJECTED" ||
      error.code === "ATTACHMENT_NOT_FOUND" ||
      error.code === "RUNTIME_STALE" ||
      error.code === "CONTROL_GENERATION_STALE")
  );
}

function isRetryableConnectionError(error: unknown): boolean {
  return (
    error instanceof DurableSessionClientError &&
    (error.code === "TRANSPORT_UNAVAILABLE" ||
      error.code === "TRANSPORT_TIMEOUT" ||
      error.code === "PRIVATE_ENDPOINT_INVALID")
  );
}

function runtimeUnavailableReason(error: unknown): DurableSessionRuntimeUnavailableReason | null {
  if (error instanceof DurableSessionProtocolError) {
    if (
      error.code === "SESSION_NOT_FOUND" ||
      error.code === "SESSION_NOT_RUNNING" ||
      error.code === "RUNTIME_STALE"
    ) {
      return error.code;
    }
  }
  if (error instanceof AppError && error.code === "PTY_NOT_RUNNING") return "RUNTIME_STALE";
  return null;
}

function toStreamAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (
    error instanceof DurableSessionProtocolError ||
    error instanceof DurableSessionStreamProtocolError
  ) {
    switch (error.code) {
      case "SESSION_NOT_FOUND":
      case "SESSION_NOT_RUNNING":
      case "RUNTIME_STALE":
      case "ATTACHMENT_NOT_FOUND":
      case "ATTACHMENT_RESUME_REJECTED":
        return new AppError("PTY_NOT_RUNNING", 409, "실행 중인 Host Session이 아닙니다.");
      case "CONTROL_HELD":
      case "CONTROL_GENERATION_STALE":
      case "ATTACHMENT_NOT_CONTROLLER":
        return controlUnavailable();
      case "RESYNC_REQUIRED":
      case "SESSION_REVISION_STALE":
      case "SESSION_STATE_INVALID":
        return new AppError("REQUEST_INVALID", 409, "Host Session 상태가 변경되었습니다.");
      case "REQUEST_INVALID":
      case "PROTOCOL_VERSION_UNSUPPORTED":
        return new AppError("REQUEST_INVALID", 400, "Host stream 요청이 올바르지 않습니다.");
      default:
        return new AppError("INTERNAL_ERROR", 503, "DurableSession Host 요청이 거부되었습니다.");
    }
  }
  return unavailable();
}

function unavailable(): AppError {
  return new AppError("INTERNAL_ERROR", 503, "DurableSession Host stream에 연결할 수 없습니다.");
}

function controlUnavailable(): AppError {
  return new AppError("LEASE_REQUIRED", 409, "현재 Host terminal 제어권이 필요합니다.");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
