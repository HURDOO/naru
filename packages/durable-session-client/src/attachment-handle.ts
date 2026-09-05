import {
  type AttachmentId,
  type AttachmentLease,
  type ControlOfferId,
  type ControlRequestId,
  type ControlView,
  type DurableSessionEvent,
  type IdempotencyKey,
  type InputId,
  type SessionId,
  type TerminalSize,
  type TerminalSnapshot,
} from "@naru/contracts/durable-session/v0";
import type { DurableSessionClient } from "./client.js";
import { DurableSessionClientError } from "./errors.js";
import { TerminalSequenceTracker, type TerminalSequenceResult } from "./terminal-sequence.js";
import type { DurableSessionRequestOptions } from "./transport.js";

export interface DurableSessionAttachmentView {
  readonly sessionId: SessionId;
  readonly attachmentId: AttachmentId;
  readonly runtimeId: AttachmentLease["runtimeId"];
  readonly role: AttachmentLease["role"];
  readonly controllerGeneration: number;
  readonly resumeExpiresAtMs: number;
  readonly appId: string;
  readonly subject: string;
}

export interface DurableSessionAttachmentIds {
  readonly inputId: () => InputId;
  readonly idempotencyKey: () => IdempotencyKey;
}

export class DurableSessionAttachmentHandle {
  readonly #client: DurableSessionClient;
  readonly #tracker = new TerminalSequenceTracker();
  readonly #ids: DurableSessionAttachmentIds;
  #lease: AttachmentLease;
  #closed = false;

  private constructor(
    client: DurableSessionClient,
    lease: AttachmentLease,
    ids: DurableSessionAttachmentIds,
  ) {
    this.#client = client;
    this.#lease = lease;
    this.#ids = ids;
  }

  static async open(
    client: DurableSessionClient,
    input: {
      readonly sessionId: SessionId;
      readonly clientInstanceId?: string;
      readonly ids?: DurableSessionAttachmentIds;
      readonly options?: DurableSessionRequestOptions;
    },
  ): Promise<DurableSessionAttachmentHandle> {
    const result = await client.request(
      {
        operation: "openAttachment",
        sessionId: input.sessionId,
        ...(input.clientInstanceId === undefined
          ? {}
          : { clientInstanceId: input.clientInstanceId }),
      },
      input.options,
    );
    return new DurableSessionAttachmentHandle(
      client,
      result.attachment,
      input.ids ?? defaultAttachmentIds,
    );
  }

  get view(): DurableSessionAttachmentView {
    return safeLeaseView(this.#lease);
  }

  get terminalSequence(): number | null {
    return this.#tracker.sequence;
  }

  toJSON(): DurableSessionAttachmentView {
    return this.view;
  }

  async resume(options?: DurableSessionRequestOptions): Promise<DurableSessionAttachmentView> {
    this.#assertOpen();
    const previous = this.#lease;
    const result = await this.#client.request(
      {
        operation: "resumeAttachment",
        sessionId: previous.sessionId,
        attachmentId: previous.attachmentId,
        expectedRuntimeId: previous.runtimeId,
        expectedControllerGeneration: previous.controllerGeneration,
        attachmentResumeToken: previous.attachmentResumeToken,
      },
      options,
    );
    const next = result.attachment;
    if (
      next.sessionId !== previous.sessionId ||
      next.attachmentId !== previous.attachmentId ||
      next.runtimeId !== previous.runtimeId ||
      next.appId !== previous.appId ||
      next.subject !== previous.subject ||
      next.attachmentResumeToken === previous.attachmentResumeToken
    ) {
      throw mismatch("Host returned an invalid attachment resume rotation.");
    }
    this.#lease = next;
    return this.view;
  }

  async snapshot(options?: DurableSessionRequestOptions): Promise<TerminalSnapshot> {
    this.#assertOpen();
    const result = await this.#client.request(
      {
        operation: "requestSnapshot",
        sessionId: this.#lease.sessionId,
        attachmentId: this.#lease.attachmentId,
        expectedRuntimeId: this.#lease.runtimeId,
      },
      options,
    );
    this.#acceptSnapshot(result.snapshot);
    return result.snapshot;
  }

  async resync(options?: DurableSessionRequestOptions): Promise<TerminalSnapshot> {
    this.#assertOpen();
    const result = await this.#client.request(
      {
        operation: "resyncAttachment",
        sessionId: this.#lease.sessionId,
        attachmentId: this.#lease.attachmentId,
        expectedRuntimeId: this.#lease.runtimeId,
        afterSequence: this.#tracker.sequence ?? 0,
      },
      options,
    );
    this.#acceptSnapshot(result.snapshot);
    return result.snapshot;
  }

  acceptEvent(event: DurableSessionEvent): TerminalSequenceResult {
    this.#assertOpen();
    if (event.sessionId !== this.#lease.sessionId) return { kind: "ignored" };
    if (event.type === "control.changed") {
      this.#lease = {
        ...this.#lease,
        controllerGeneration: event.controllerGeneration,
        role: event.controllerAttachmentId === this.#lease.attachmentId ? "controller" : "observer",
      };
    }
    return this.#tracker.accept(event, this.#lease.attachmentId);
  }

  async acquireControl(
    terminal: TerminalSize,
    options?: DurableSessionRequestOptions,
  ): Promise<ControlView> {
    this.#assertOpen();
    const result = await this.#client.request(
      {
        operation: "acquireControl",
        ...this.#currentIdentity(),
        terminal,
      },
      options,
    );
    return this.#acceptControl(result.control);
  }

  async requestControl(options?: DurableSessionRequestOptions): Promise<ControlRequestId> {
    this.#assertOpen();
    const result = await this.#client.request(
      {
        operation: "requestControl",
        sessionId: this.#lease.sessionId,
        attachmentId: this.#lease.attachmentId,
        expectedControllerGeneration: this.#lease.controllerGeneration,
      },
      options,
    );
    return result.request.controlRequestId;
  }

  async approveControl(
    controlRequestId: ControlRequestId,
    options?: DurableSessionRequestOptions,
  ): Promise<ControlOfferId> {
    this.#assertController();
    const result = await this.#client.request(
      {
        operation: "approveControl",
        sessionId: this.#lease.sessionId,
        attachmentId: this.#lease.attachmentId,
        controlRequestId,
        expectedControllerGeneration: this.#lease.controllerGeneration,
      },
      options,
    );
    return result.offer.controlOfferId;
  }

  async rejectControl(
    controlRequestId: ControlRequestId,
    options?: DurableSessionRequestOptions,
  ): Promise<void> {
    this.#assertController();
    await this.#client.request(
      {
        operation: "rejectControl",
        sessionId: this.#lease.sessionId,
        attachmentId: this.#lease.attachmentId,
        controlRequestId,
        expectedControllerGeneration: this.#lease.controllerGeneration,
      },
      options,
    );
  }

  async acceptControl(
    controlOfferId: ControlOfferId,
    terminal: TerminalSize,
    options?: DurableSessionRequestOptions,
  ): Promise<ControlView> {
    this.#assertOpen();
    const result = await this.#client.request(
      {
        operation: "acceptControl",
        ...this.#currentIdentity(),
        controlOfferId,
        idempotencyKey: this.#ids.idempotencyKey(),
        terminal,
      },
      options,
    );
    return this.#acceptControl(result.control);
  }

  async preemptControl(
    terminal: TerminalSize,
    reasonCode: string,
    options?: DurableSessionRequestOptions,
  ): Promise<ControlView> {
    this.#assertOpen();
    const result = await this.#client.request(
      {
        operation: "preemptControl",
        ...this.#currentIdentity(),
        idempotencyKey: this.#ids.idempotencyKey(),
        terminal,
        reasonCode,
      },
      options,
    );
    return this.#acceptControl(result.control);
  }

  async releaseControl(options?: DurableSessionRequestOptions): Promise<ControlView> {
    this.#assertController();
    const result = await this.#client.request(
      {
        operation: "releaseControl",
        sessionId: this.#lease.sessionId,
        attachmentId: this.#lease.attachmentId,
        expectedControllerGeneration: this.#lease.controllerGeneration,
      },
      options,
    );
    return this.#acceptControl(result.control);
  }

  async sendInput(data: string, options?: DurableSessionRequestOptions): Promise<void> {
    this.#assertController();
    await this.#client.request(
      {
        operation: "sendInput",
        ...this.#currentIdentity(),
        inputId: this.#ids.inputId(),
        data,
      },
      options,
    );
  }

  async resizeTerminal(
    terminal: TerminalSize,
    options?: DurableSessionRequestOptions,
  ): Promise<void> {
    this.#assertController();
    await this.#client.request(
      {
        operation: "resizeTerminal",
        ...this.#currentIdentity(),
        terminal,
      },
      options,
    );
  }

  async close(options?: DurableSessionRequestOptions): Promise<void> {
    if (this.#closed) return;
    await this.#client.request(
      {
        operation: "closeAttachment",
        sessionId: this.#lease.sessionId,
        attachmentId: this.#lease.attachmentId,
      },
      options,
    );
    this.#closed = true;
  }

  #acceptSnapshot(snapshot: TerminalSnapshot): void {
    if (
      snapshot.sessionId !== this.#lease.sessionId ||
      snapshot.attachmentId !== this.#lease.attachmentId ||
      snapshot.runtimeId !== this.#lease.runtimeId
    ) {
      throw mismatch("Host returned a snapshot for a different attachment runtime.");
    }
    this.#tracker.restore(snapshot);
  }

  #acceptControl(control: ControlView): ControlView {
    if (
      control.sessionId !== this.#lease.sessionId ||
      control.runtimeId !== this.#lease.runtimeId ||
      control.controllerGeneration < this.#lease.controllerGeneration
    ) {
      throw mismatch("Host returned control state for a different attachment runtime.");
    }
    this.#lease = {
      ...this.#lease,
      controllerGeneration: control.controllerGeneration,
      role: control.controllerAttachmentId === this.#lease.attachmentId ? "controller" : "observer",
    };
    return control;
  }

  #currentIdentity() {
    return {
      sessionId: this.#lease.sessionId,
      attachmentId: this.#lease.attachmentId,
      expectedRuntimeId: this.#lease.runtimeId,
      expectedControllerGeneration: this.#lease.controllerGeneration,
    } as const;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new DurableSessionClientError(
        "CLIENT_REQUEST_INVALID",
        "Attachment is already closed.",
      );
    }
  }

  #assertController(): void {
    this.#assertOpen();
    if (this.#lease.role !== "controller") {
      throw new DurableSessionClientError(
        "CLIENT_REQUEST_INVALID",
        "Observer attachment cannot send input, resize, approve, reject, or release control.",
      );
    }
  }
}

const defaultAttachmentIds: DurableSessionAttachmentIds = {
  inputId: () => globalThis.crypto.randomUUID(),
  idempotencyKey: () => globalThis.crypto.randomUUID(),
};

function safeLeaseView(lease: AttachmentLease): DurableSessionAttachmentView {
  return {
    sessionId: lease.sessionId,
    attachmentId: lease.attachmentId,
    runtimeId: lease.runtimeId,
    role: lease.role,
    controllerGeneration: lease.controllerGeneration,
    resumeExpiresAtMs: lease.resumeExpiresAtMs,
    appId: lease.appId,
    subject: lease.subject,
  };
}

function mismatch(message: string): DurableSessionClientError {
  return new DurableSessionClientError("PROTOCOL_RESPONSE_MISMATCH", message);
}
