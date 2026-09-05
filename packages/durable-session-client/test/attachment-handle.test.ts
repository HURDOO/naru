import type {
  AttachmentLease,
  DurableSessionCallerContext,
  DurableSessionOperationRequest,
  DurableSessionOperationResult,
  DurableSessionOperationResponse,
  ProtocolRequestId,
} from "@naru/contracts/durable-session/v0";
import { describe, expect, it } from "vitest";
import {
  DurableSessionAttachmentHandle,
  type DurableSessionAttachmentIds,
} from "../src/attachment-handle.js";
import { DurableSessionClient } from "../src/client.js";
import type {
  DurableSessionOperationEnvelope,
  DurableSessionOperationTransport,
} from "../src/transport.js";

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const RUNTIME_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_RUNTIME_ID = "20000000-0000-4000-8000-000000000002";
const ATTACHMENT_ID = "30000000-0000-4000-8000-000000000001";
const OTHER_ATTACHMENT_ID = "30000000-0000-4000-8000-000000000002";
const REQUEST_ID = "70000000-0000-4000-8000-000000000001" as ProtocolRequestId;
const INPUT_ID = "80000000-0000-4000-8000-000000000001";
const IDEMPOTENCY_KEY = "90000000-0000-4000-8000-000000000001";
const TOKEN_1 = "fixture-resume-token-one-00000000000000000000";
const TOKEN_2 = "fixture-resume-token-two-00000000000000000000";
const CONTROL_REQUEST_ID = "40000000-0000-4000-8000-000000000001";
const CONTROL_OFFER_ID = "50000000-0000-4000-8000-000000000001";

describe("DurableSessionAttachmentHandle", () => {
  it("keeps resume tokens private and enforces snapshot plus live ordering", async () => {
    const transport = new AttachmentFixtureTransport();
    const handle = await openHandle(transport);

    expect(JSON.stringify(handle)).not.toContain(TOKEN_1);
    expect(handle.view).toMatchObject({ attachmentId: ATTACHMENT_ID, role: "observer" });
    const snapshot = await handle.snapshot();
    expect(snapshot.sequence).toBe(4);
    expect(
      handle.acceptEvent({
        version: 0,
        eventId: "60000000-0000-4000-8000-000000000001",
        sessionId: SESSION_ID,
        occurredAtMs: 1,
        type: "terminal.output",
        runtimeId: RUNTIME_ID,
        sequence: 5,
        data: "safe-output",
      }),
    ).toEqual({ kind: "output", sequence: 5, data: "safe-output" });
    expect(
      handle.acceptEvent({
        version: 0,
        eventId: "60000000-0000-4000-8000-000000000002",
        sessionId: SESSION_ID,
        occurredAtMs: 2,
        type: "terminal.output",
        runtimeId: RUNTIME_ID,
        sequence: 7,
        data: "gap",
      }),
    ).toMatchObject({ kind: "resync-required", reason: "sequence-discontinuity" });
  });

  it("prevents observer input/resize and fences controller operations", async () => {
    const transport = new AttachmentFixtureTransport();
    const handle = await openHandle(transport);

    await expect(handle.sendInput("observer-input")).rejects.toMatchObject({
      code: "CLIENT_REQUEST_INVALID",
    });
    await expect(handle.resizeTerminal({ cols: 100, rows: 30 })).rejects.toMatchObject({
      code: "CLIENT_REQUEST_INVALID",
    });

    await handle.acquireControl({ cols: 100, rows: 30 });
    expect(handle.view).toMatchObject({ role: "controller", controllerGeneration: 1 });
    await handle.sendInput("controller-input");
    await handle.resizeTerminal({ cols: 120, rows: 40 });
    expect(transport.envelopes.map((entry) => entry.request.operation)).toEqual([
      "openAttachment",
      "acquireControl",
      "sendInput",
      "resizeTerminal",
    ]);
    expect(transport.envelopes[2]?.request).toMatchObject({
      expectedControllerGeneration: 1,
      inputId: INPUT_ID,
      data: "controller-input",
    });

    handle.acceptEvent({
      version: 0,
      eventId: "60000000-0000-4000-8000-000000000003",
      sessionId: SESSION_ID,
      occurredAtMs: 3,
      type: "control.changed",
      controllerGeneration: 2,
      previousControllerAttachmentId: ATTACHMENT_ID,
      controllerAttachmentId: OTHER_ATTACHMENT_ID,
      terminal: { cols: 90, rows: 25 },
      reason: "transferred",
    });
    expect(handle.view).toMatchObject({ role: "observer", controllerGeneration: 2 });
    await expect(handle.sendInput("stale-input")).rejects.toMatchObject({
      code: "CLIENT_REQUEST_INVALID",
    });
  });

  it("rotates in-memory resume proof and rejects an unrotated Host response", async () => {
    const transport = new AttachmentFixtureTransport();
    const handle = await openHandle(transport);
    await handle.resume();

    expect(transport.envelopes[1]?.request).toMatchObject({
      operation: "resumeAttachment",
      attachmentResumeToken: TOKEN_1,
    });
    expect(JSON.stringify(handle)).not.toContain(TOKEN_1);
    expect(JSON.stringify(handle)).not.toContain(TOKEN_2);

    transport.reuseResumeToken = true;
    await expect(handle.resume()).rejects.toMatchObject({ code: "PROTOCOL_RESPONSE_MISMATCH" });
  });

  it("rejects a resume response that changes the fenced runtime", async () => {
    const transport = new AttachmentFixtureTransport();
    const handle = await openHandle(transport);
    transport.resumeRuntimeMismatch = true;

    await expect(handle.resume()).rejects.toMatchObject({ code: "PROTOCOL_RESPONSE_MISMATCH" });
    expect(handle.view.runtimeId).toBe(RUNTIME_ID);
  });

  it("rejects a control response whose generation moves backward", async () => {
    const transport = new AttachmentFixtureTransport();
    const handle = await openHandle(transport);
    await handle.acquireControl({ cols: 100, rows: 30 });
    transport.generation = -1;

    await expect(handle.releaseControl()).rejects.toMatchObject({
      code: "PROTOCOL_RESPONSE_MISMATCH",
    });
    expect(handle.view).toMatchObject({ role: "controller", controllerGeneration: 1 });
  });

  it("supports request/approve/accept/release/preempt without exposing credentials", async () => {
    const transport = new AttachmentFixtureTransport();
    const handle = await openHandle(transport);
    expect(await handle.requestControl()).toBe(CONTROL_REQUEST_ID);
    expect(await handle.acceptControl(CONTROL_OFFER_ID, { cols: 100, rows: 30 })).toMatchObject({
      controllerAttachmentId: ATTACHMENT_ID,
    });
    expect(await handle.approveControl(CONTROL_REQUEST_ID)).toBe(CONTROL_OFFER_ID);
    await handle.releaseControl();
    expect(handle.view.role).toBe("observer");
    await handle.preemptControl({ cols: 110, rows: 35 }, "owner-takeover");
    expect(handle.view.role).toBe("controller");
    expect(
      transport.envelopes.find((entry) => entry.request.operation === "preemptControl")?.request,
    ).toMatchObject({ idempotencyKey: IDEMPOTENCY_KEY, reasonCode: "owner-takeover" });
  });
});

class AttachmentFixtureTransport implements DurableSessionOperationTransport {
  readonly envelopes: DurableSessionOperationEnvelope[] = [];
  reuseResumeToken = false;
  resumeRuntimeMismatch = false;
  generation = 0;

  send(envelope: DurableSessionOperationEnvelope): Promise<unknown> {
    this.envelopes.push(envelope);
    return Promise.resolve(success(envelope.request, this.#result(envelope.request)));
  }

  #result(request: DurableSessionOperationRequest): DurableSessionOperationResult {
    switch (request.operation) {
      case "openAttachment":
        return { operation: request.operation, attachment: lease(TOKEN_1, "observer", 0) };
      case "resumeAttachment":
        return {
          operation: request.operation,
          attachment: lease(
            this.reuseResumeToken ? request.attachmentResumeToken : TOKEN_2,
            "observer",
            request.expectedControllerGeneration,
            this.resumeRuntimeMismatch ? OTHER_RUNTIME_ID : RUNTIME_ID,
          ),
        };
      case "requestSnapshot":
      case "resyncAttachment":
        return {
          operation: request.operation,
          snapshot: {
            sessionId: SESSION_ID,
            attachmentId: ATTACHMENT_ID,
            runtimeId: RUNTIME_ID,
            sequence: 4,
            terminal: { cols: 80, rows: 24 },
            serializedState: "safe-state",
          },
        };
      case "acquireControl":
      case "acceptControl":
      case "preemptControl":
        this.generation += 1;
        return {
          operation: request.operation,
          control: control(ATTACHMENT_ID, this.generation, request.terminal),
        };
      case "releaseControl":
        this.generation += 1;
        return {
          operation: request.operation,
          control: control(null, this.generation, { cols: 100, rows: 30 }),
        };
      case "requestControl":
        return {
          operation: request.operation,
          request: {
            controlRequestId: CONTROL_REQUEST_ID,
            requesterAttachmentId: ATTACHMENT_ID,
            controllerGeneration: request.expectedControllerGeneration,
            expiresAtMs: 10_000,
          },
        };
      case "approveControl":
        return {
          operation: request.operation,
          offer: {
            controlOfferId: CONTROL_OFFER_ID,
            controlRequestId: request.controlRequestId,
            requesterAttachmentId: OTHER_ATTACHMENT_ID,
            controllerAttachmentId: ATTACHMENT_ID,
            controllerGeneration: request.expectedControllerGeneration,
            expiresAtMs: 10_000,
          },
        };
      case "rejectControl":
        return {
          operation: request.operation,
          controlRequestId: request.controlRequestId,
          resolution: "rejected",
        };
      case "sendInput":
        return {
          operation: request.operation,
          runtimeId: request.expectedRuntimeId,
          controllerGeneration: request.expectedControllerGeneration,
          inputId: request.inputId,
          accepted: true,
        };
      case "resizeTerminal":
        return {
          operation: request.operation,
          runtimeId: request.expectedRuntimeId,
          controllerGeneration: request.expectedControllerGeneration,
          terminal: request.terminal,
        };
      case "closeAttachment":
        return { operation: request.operation, closed: true };
      default:
        throw new Error(`Unexpected fixture operation: ${request.operation}`);
    }
  }
}

async function openHandle(
  transport: DurableSessionOperationTransport,
): Promise<DurableSessionAttachmentHandle> {
  const client = new DurableSessionClient({
    transport,
    callerContext: caller(),
    requestId: () => REQUEST_ID,
  });
  const ids: DurableSessionAttachmentIds = {
    inputId: () => INPUT_ID,
    idempotencyKey: () => IDEMPOTENCY_KEY,
  };
  return await DurableSessionAttachmentHandle.open(client, { sessionId: SESSION_ID, ids });
}

function caller(): DurableSessionCallerContext {
  return {
    appId: "fixture-app",
    subject: "fixture-owner",
    capabilities: ["session:observe", "control:request", "control:preempt"],
    sessionScope: { kind: "all" },
    profileScope: { kind: "all" },
    rootScope: { kind: "all" },
    expiresAtMs: 4_000_000_000_000,
  };
}

function lease(
  attachmentResumeToken: string,
  role: AttachmentLease["role"],
  controllerGeneration: number,
  runtimeId = RUNTIME_ID,
): AttachmentLease {
  return {
    sessionId: SESSION_ID,
    attachmentId: ATTACHMENT_ID,
    runtimeId,
    role,
    controllerGeneration,
    attachmentResumeToken,
    resumeExpiresAtMs: 10_000,
    appId: "fixture-app",
    subject: "fixture-owner",
  };
}

function control(
  controllerAttachmentId: string | null,
  controllerGeneration: number,
  terminal: { readonly cols: number; readonly rows: number },
) {
  return {
    sessionId: SESSION_ID,
    runtimeId: RUNTIME_ID,
    controllerAttachmentId,
    controllerGeneration,
    terminal,
  };
}

function success(
  request: DurableSessionOperationRequest,
  result: DurableSessionOperationResult,
): DurableSessionOperationResponse {
  return { version: 0, requestId: request.requestId, ok: true, result };
}
