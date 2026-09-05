import { createHash, timingSafeEqual } from "node:crypto";
import type {
  AttachmentId,
  AttachmentLease,
  DurableSessionCallerContext,
  DurableSessionEvent,
  RuntimeId,
  SessionId,
} from "@naru/contracts/durable-session/v0";
import type { DurableSessionState } from "@naru/domain/durable-session";
import { HostOperationError } from "./host-error.js";

interface AttachmentRecord {
  readonly attachmentId: AttachmentId;
  readonly sessionId: SessionId;
  runtimeId: RuntimeId;
  readonly appId: string;
  readonly subject: string;
  tokenDigest: Buffer;
  tokenExpiresAtMs: number;
  streamId: string | null;
  terminalResyncRequired: boolean;
  lastSentSequence: number;
  readonly queue: DurableSessionEvent[];
  queueBytes: number;
}

export interface AttachmentOpenInput {
  readonly state: DurableSessionState;
  readonly caller: DurableSessionCallerContext;
  readonly attachmentId: AttachmentId;
  readonly resumeToken: string;
  readonly resumeExpiresAtMs: number;
  readonly initialEvent: DurableSessionEvent;
}

export interface AttachmentResumeInput {
  readonly state: DurableSessionState;
  readonly caller: DurableSessionCallerContext;
  readonly attachmentId: AttachmentId;
  readonly previousToken: string;
  readonly nextToken: string;
  readonly resumeExpiresAtMs: number;
  readonly initialEvent: DurableSessionEvent;
}

export class AttachmentCoordinator {
  readonly #maxPerSession: number;
  readonly #queueBytesLimit: number;
  readonly #records = new Map<AttachmentId, AttachmentRecord>();
  readonly #listeners = new Map<AttachmentId, Set<() => void>>();

  constructor(options: { readonly maxPerSession: number; readonly queueBytesLimit: number }) {
    this.#maxPerSession = options.maxPerSession;
    this.#queueBytesLimit = options.queueBytesLimit;
  }

  countForSession(sessionId: SessionId): number {
    let count = 0;
    for (const record of this.#records.values()) {
      if (record.sessionId === sessionId) count += 1;
    }
    return count;
  }

  attachmentIds(sessionId: SessionId): readonly AttachmentId[] {
    return [...this.#records.values()]
      .filter((record) => record.sessionId === sessionId)
      .map((record) => record.attachmentId);
  }

  assertCanOpen(sessionId: SessionId): void {
    if (this.countForSession(sessionId) >= this.#maxPerSession) {
      throw new HostOperationError(
        "SESSION_LIMIT_REACHED",
        "Session attachment limit was reached.",
      );
    }
  }

  open(input: AttachmentOpenInput): AttachmentLease {
    const runtimeId = requireRuntime(input.state);
    this.assertCanOpen(input.state.sessionId);
    const record: AttachmentRecord = {
      attachmentId: input.attachmentId,
      sessionId: input.state.sessionId,
      runtimeId,
      appId: input.caller.appId,
      subject: input.caller.subject,
      tokenDigest: tokenDigest(input.resumeToken),
      tokenExpiresAtMs: input.resumeExpiresAtMs,
      streamId: null,
      terminalResyncRequired: false,
      lastSentSequence: 0,
      queue: [input.initialEvent],
      queueBytes: eventBytes(input.initialEvent),
    };
    this.#records.set(input.attachmentId, record);
    return lease(input.state, record, input.resumeToken);
  }

  validateResume(
    caller: DurableSessionCallerContext,
    input: {
      readonly sessionId: SessionId;
      readonly attachmentId: AttachmentId;
      readonly runtimeId: RuntimeId;
      readonly token: string;
      readonly nowMs: number;
    },
  ): void {
    const record = this.#records.get(input.attachmentId);
    if (
      record === undefined ||
      record.sessionId !== input.sessionId ||
      record.runtimeId !== input.runtimeId ||
      record.appId !== caller.appId ||
      record.subject !== caller.subject ||
      input.nowMs >= record.tokenExpiresAtMs ||
      !tokensMatch(input.token, record.tokenDigest)
    ) {
      throw resumeRejected();
    }
  }

  completeResume(input: AttachmentResumeInput): AttachmentLease {
    const record = this.#requireOwned(input.caller, input.state.sessionId, input.attachmentId);
    if (!tokensMatch(input.previousToken, record.tokenDigest)) throw resumeRejected();
    record.runtimeId = requireRuntime(input.state);
    record.tokenDigest = tokenDigest(input.nextToken);
    record.tokenExpiresAtMs = input.resumeExpiresAtMs;
    record.streamId = null;
    record.terminalResyncRequired = false;
    record.queue.length = 0;
    record.queue.push(input.initialEvent);
    record.queueBytes = eventBytes(input.initialEvent);
    this.#notify(record.attachmentId);
    return lease(input.state, record, input.nextToken);
  }

  assertOwned(
    caller: DurableSessionCallerContext,
    sessionId: SessionId,
    attachmentId: AttachmentId,
  ): void {
    this.#requireOwned(caller, sessionId, attachmentId);
  }

  refreshToken(attachmentId: AttachmentId, expiresAtMs: number): void {
    const record = this.#records.get(attachmentId);
    if (record !== undefined) record.tokenExpiresAtMs = expiresAtMs;
  }

  disconnect(attachmentId: AttachmentId, expiresAtMs: number): void {
    const record = this.#records.get(attachmentId);
    if (record === undefined) return;
    record.streamId = null;
    record.tokenExpiresAtMs = Math.min(record.tokenExpiresAtMs, expiresAtMs);
  }

  remove(attachmentId: AttachmentId): void {
    this.#records.delete(attachmentId);
    this.#listeners.delete(attachmentId);
  }

  removeSession(sessionId: SessionId): void {
    for (const record of this.#records.values()) {
      if (record.sessionId === sessionId) this.remove(record.attachmentId);
    }
  }

  bindStream(
    caller: DurableSessionCallerContext,
    sessionId: SessionId,
    attachmentId: AttachmentId,
    streamId: string,
  ): void {
    const record = this.#requireOwned(caller, sessionId, attachmentId);
    if (record.streamId !== null && record.streamId !== streamId) {
      throw new HostOperationError(
        "SESSION_STATE_INVALID",
        "Attachment is already bound to another stream.",
      );
    }
    record.streamId = streamId;
  }

  subscribe(attachmentId: AttachmentId, listener: () => void): () => void {
    const listeners = this.#listeners.get(attachmentId) ?? new Set<() => void>();
    listeners.add(listener);
    this.#listeners.set(attachmentId, listeners);
    if ((this.#records.get(attachmentId)?.queue.length ?? 0) > 0) queueMicrotask(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(attachmentId);
    };
  }

  enqueue(
    sessionId: SessionId,
    event: DurableSessionEvent,
    targetAttachmentId?: AttachmentId,
  ): readonly AttachmentId[] {
    const overflowed: AttachmentId[] = [];
    for (const record of this.#records.values()) {
      if (
        record.sessionId !== sessionId ||
        (targetAttachmentId !== undefined && record.attachmentId !== targetAttachmentId) ||
        (record.terminalResyncRequired && event.type === "terminal.output")
      ) {
        continue;
      }
      const bytes = eventBytes(event);
      if (record.queueBytes + bytes > this.#queueBytesLimit) {
        overflowed.push(record.attachmentId);
        continue;
      }
      const shouldNotify = record.queue.length === 0;
      record.queue.push(event);
      record.queueBytes += bytes;
      if (shouldNotify) this.#notify(record.attachmentId);
    }
    return overflowed;
  }

  requireResync(attachmentId: AttachmentId, event: DurableSessionEvent): void {
    const record = this.#records.get(attachmentId);
    if (record === undefined) return;
    record.terminalResyncRequired = true;
    record.queue.length = 0;
    record.queue.push(event);
    record.queueBytes = eventBytes(event);
    this.#notify(attachmentId);
  }

  lastSentSequence(attachmentId: AttachmentId): number {
    return this.#records.get(attachmentId)?.lastSentSequence ?? 0;
  }

  resetWithSnapshot(attachmentId: AttachmentId, event: DurableSessionEvent): void {
    const record = this.#records.get(attachmentId);
    if (record === undefined) return;
    record.terminalResyncRequired = false;
    record.queue.length = 0;
    record.queue.push(event);
    record.queueBytes = eventBytes(event);
    this.#notify(attachmentId);
  }

  confirmSnapshot(attachmentId: AttachmentId, sequence: number): void {
    const record = this.#records.get(attachmentId);
    if (record === undefined) return;
    record.terminalResyncRequired = false;
    record.queue.length = 0;
    record.queueBytes = 0;
    record.lastSentSequence = sequence;
  }

  take(attachmentId: AttachmentId, streamId: string): DurableSessionEvent | null {
    const record = this.#records.get(attachmentId);
    if (record === undefined || record.streamId !== streamId) return null;
    const event = record.queue.shift() ?? null;
    if (event !== null) {
      record.queueBytes -= eventBytes(event);
      if (event.type === "terminal.snapshot" || event.type === "terminal.output") {
        record.lastSentSequence = event.sequence;
      }
    }
    return event;
  }

  #requireOwned(
    caller: DurableSessionCallerContext,
    sessionId: SessionId,
    attachmentId: AttachmentId,
  ): AttachmentRecord {
    const record = this.#records.get(attachmentId);
    if (
      record === undefined ||
      record.sessionId !== sessionId ||
      record.appId !== caller.appId ||
      record.subject !== caller.subject
    ) {
      throw new HostOperationError("ATTACHMENT_NOT_FOUND", "Attachment was not found.");
    }
    return record;
  }

  #notify(attachmentId: AttachmentId): void {
    for (const listener of this.#listeners.get(attachmentId) ?? []) queueMicrotask(listener);
  }
}

function lease(
  state: DurableSessionState,
  record: AttachmentRecord,
  resumeToken: string,
): AttachmentLease {
  const attachment = state.attachments[record.attachmentId];
  if (attachment === undefined) throw new Error("Attachment coordinator and Core state disagree.");
  return {
    sessionId: state.sessionId,
    attachmentId: record.attachmentId,
    runtimeId: requireRuntime(state),
    role: attachment.role,
    controllerGeneration: state.controllerGeneration,
    attachmentResumeToken: resumeToken,
    resumeExpiresAtMs: record.tokenExpiresAtMs,
    appId: record.appId,
    subject: record.subject,
  };
}

function eventBytes(event: DurableSessionEvent): number {
  return Buffer.byteLength(JSON.stringify(event));
}

function tokenDigest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function tokensMatch(value: string, digest: Buffer): boolean {
  const candidate = tokenDigest(value);
  return candidate.byteLength === digest.byteLength && timingSafeEqual(candidate, digest);
}

function resumeRejected(): HostOperationError {
  return new HostOperationError(
    "ATTACHMENT_RESUME_REJECTED",
    "Attachment resume token or binding was rejected.",
  );
}

function requireRuntime(state: DurableSessionState): RuntimeId {
  if (state.runtimeId === null) {
    throw new HostOperationError("SESSION_NOT_RUNNING", "Session is not running.");
  }
  return state.runtimeId;
}
