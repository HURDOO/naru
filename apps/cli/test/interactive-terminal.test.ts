import type {
  AttachmentId,
  ControlOfferId,
  ControlRequestId,
  ControlView,
  DurableSessionEvent,
  SessionId,
  TerminalSize,
  TerminalSnapshot,
} from "@naru/contracts/durable-session/v0";
import type {
  DurableSessionAttachmentView,
  TerminalSequenceResult,
} from "@naru/durable-session-client";
import { describe, expect, it } from "vitest";
import {
  InteractiveTerminalController,
  type InteractiveTerminalIo,
} from "../src/interactive-terminal.js";

const SESSION_ID = "10000000-0000-4000-8000-000000000001" as SessionId;
const RUNTIME_ID = "20000000-0000-4000-8000-000000000001";
const ATTACHMENT_ID = "30000000-0000-4000-8000-000000000001" as AttachmentId;
const CONTROL_REQUEST_ID = "40000000-0000-4000-8000-000000000001" as ControlRequestId;
const CONTROL_OFFER_ID = "50000000-0000-4000-8000-000000000001" as ControlOfferId;

describe("InteractiveTerminalController", () => {
  it("keeps observer input and resize local, then forwards them only after control", async () => {
    const attachment = new FixtureAttachment();
    const fixture = fixtureIo();
    const controller = new InteractiveTerminalController(attachment, fixture.io);

    await controller.handleInput("observer-input");
    await controller.handleResize();
    expect(attachment.inputs).toEqual([]);
    expect(attachment.resizes).toEqual([]);
    expect(fixture.status.join(" ")).toContain("observer mode");
    expect(fixture.status.join(" ")).toContain("Host geometry was not changed");

    await controller.handleInput("\u001d");
    await controller.handleInput("c");
    await controller.handleInput("controller-input");
    await controller.handleResize();
    expect(attachment.inputs).toEqual(["controller-input"]);
    expect(attachment.resizes).toEqual([{ cols: 100, rows: 30 }]);
  });

  it("requires an explicit repeated takeover command", async () => {
    const attachment = new FixtureAttachment();
    const fixture = fixtureIo();
    const controller = new InteractiveTerminalController(attachment, fixture.io, {
      preemptEnabled: true,
    });

    await controller.handleInput("\u001d");
    await controller.handleInput("p");
    expect(attachment.preempts).toBe(0);
    expect(fixture.status.at(-1)).toContain("again to confirm");

    await controller.handleInput("\u001d");
    await controller.handleInput("p");
    expect(attachment.preempts).toBe(1);
    expect(attachment.view.role).toBe("controller");
  });

  it("handles a control prefix, palette key and terminal input from one chunk", async () => {
    const attachment = new FixtureAttachment();
    const fixture = fixtureIo();
    const controller = new InteractiveTerminalController(attachment, fixture.io);

    await controller.handleInput("\u001dccontroller-input");

    expect(attachment.view.role).toBe("controller");
    expect(attachment.inputs).toEqual(["controller-input"]);
  });

  it("does not expose explicit preempt from the attach-mode palette", async () => {
    const attachment = new FixtureAttachment();
    const fixture = fixtureIo();
    const controller = new InteractiveTerminalController(attachment, fixture.io);

    await controller.handleInput("\u001dp\u001dp");

    expect(attachment.preempts).toBe(0);
    expect(fixture.status.join(" ")).toContain("requires the control command");
  });

  it("shows request/offer prompts and performs approve/accept/release", async () => {
    const attachment = new FixtureAttachment();
    const fixture = fixtureIo();
    const controller = new InteractiveTerminalController(attachment, fixture.io);
    await controller.handleInput("\u001d");
    await controller.handleInput("c");

    await controller.handleEvent(controlRequested());
    await controller.handleInput("\u001d");
    await controller.handleInput("a");
    expect(attachment.approved).toEqual([CONTROL_REQUEST_ID]);

    attachment.setRole("observer", 2);
    await controller.handleEvent(controlOffered());
    await controller.handleInput("\u001d");
    await controller.handleInput("a");
    expect(attachment.accepted).toEqual([CONTROL_OFFER_ID]);

    await controller.handleInput("\u001d");
    await controller.handleInput("l");
    expect(attachment.view.role).toBe("observer");
  });

  it("restores a full snapshot when sequence handling requires resync", async () => {
    const attachment = new FixtureAttachment();
    attachment.nextSequenceResult = {
      kind: "resync-required",
      reason: "sequence-discontinuity",
    };
    const fixture = fixtureIo();
    const controller = new InteractiveTerminalController(attachment, fixture.io);

    await controller.handleEvent({
      version: 0,
      eventId: "60000000-0000-4000-8000-000000000001",
      sessionId: SESSION_ID,
      occurredAtMs: 1,
      type: "terminal.output",
      runtimeId: RUNTIME_ID,
      sequence: 3,
      data: "gap-output",
    });

    expect(attachment.resyncs).toBe(1);
    expect(fixture.terminal).toEqual(["restored-state"]);
    expect(fixture.terminal.join("")).not.toContain("gap-output");
  });

  it("renders the stream's initial snapshot event", async () => {
    const attachment = new FixtureAttachment();
    attachment.nextSequenceResult = {
      kind: "snapshot",
      runtimeId: RUNTIME_ID,
      sequence: 2,
      serializedState: "stream-snapshot",
    };
    const fixture = fixtureIo();
    const controller = new InteractiveTerminalController(attachment, fixture.io);

    await controller.handleEvent({
      version: 0,
      eventId: "60000000-0000-4000-8000-000000000010",
      sessionId: SESSION_ID,
      occurredAtMs: 1,
      type: "terminal.snapshot",
      runtimeId: RUNTIME_ID,
      sequence: 2,
      terminal: { cols: 80, rows: 24 },
      serializedState: "stream-snapshot",
    });

    expect(fixture.terminal).toEqual(["stream-snapshot"]);
  });
});

class FixtureAttachment {
  view: DurableSessionAttachmentView = {
    sessionId: SESSION_ID,
    attachmentId: ATTACHMENT_ID,
    runtimeId: RUNTIME_ID,
    role: "observer",
    controllerGeneration: 0,
    resumeExpiresAtMs: 10_000,
    appId: "fixture-app",
    subject: "fixture-owner",
  };
  readonly inputs: string[] = [];
  readonly resizes: TerminalSize[] = [];
  readonly approved: ControlRequestId[] = [];
  readonly accepted: ControlOfferId[] = [];
  preempts = 0;
  resyncs = 0;
  nextSequenceResult: TerminalSequenceResult = { kind: "ignored" };

  snapshot(): Promise<TerminalSnapshot> {
    return Promise.resolve(snapshot("initial-state"));
  }

  resync(): Promise<TerminalSnapshot> {
    this.resyncs += 1;
    return Promise.resolve(snapshot("restored-state"));
  }

  acceptEvent(): TerminalSequenceResult {
    return this.nextSequenceResult;
  }

  acquireControl(terminal: TerminalSize): Promise<ControlView> {
    this.setRole("controller", this.view.controllerGeneration + 1);
    return Promise.resolve(control(ATTACHMENT_ID, this.view.controllerGeneration, terminal));
  }

  requestControl(): Promise<ControlRequestId> {
    return Promise.resolve(CONTROL_REQUEST_ID);
  }

  approveControl(controlRequestId: ControlRequestId): Promise<ControlOfferId> {
    this.approved.push(controlRequestId);
    return Promise.resolve(CONTROL_OFFER_ID);
  }

  rejectControl(): Promise<void> {
    return Promise.resolve();
  }

  acceptControl(controlOfferId: ControlOfferId, terminal: TerminalSize): Promise<ControlView> {
    this.accepted.push(controlOfferId);
    this.setRole("controller", this.view.controllerGeneration + 1);
    return Promise.resolve(control(ATTACHMENT_ID, this.view.controllerGeneration, terminal));
  }

  preemptControl(terminal: TerminalSize): Promise<ControlView> {
    this.preempts += 1;
    this.setRole("controller", this.view.controllerGeneration + 1);
    return Promise.resolve(control(ATTACHMENT_ID, this.view.controllerGeneration, terminal));
  }

  releaseControl(): Promise<ControlView> {
    this.setRole("observer", this.view.controllerGeneration + 1);
    return Promise.resolve(control(null, this.view.controllerGeneration, { cols: 100, rows: 30 }));
  }

  sendInput(data: string): Promise<void> {
    this.inputs.push(data);
    return Promise.resolve();
  }

  resizeTerminal(terminal: TerminalSize): Promise<void> {
    this.resizes.push(terminal);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  setRole(role: "observer" | "controller", controllerGeneration: number): void {
    this.view = { ...this.view, role, controllerGeneration };
  }
}

function fixtureIo(): {
  readonly io: InteractiveTerminalIo;
  readonly terminal: string[];
  readonly status: string[];
} {
  const terminal: string[] = [];
  const status: string[] = [];
  return {
    terminal,
    status,
    io: {
      writeTerminal: (data) => terminal.push(data),
      writeStatus: (message) => status.push(message),
      terminalSize: () => ({ cols: 100, rows: 30 }),
    },
  };
}

function snapshot(serializedState: string): TerminalSnapshot {
  return {
    sessionId: SESSION_ID,
    attachmentId: ATTACHMENT_ID,
    runtimeId: RUNTIME_ID,
    sequence: 2,
    terminal: { cols: 80, rows: 24 },
    serializedState,
  };
}

function control(
  controllerAttachmentId: AttachmentId | null,
  controllerGeneration: number,
  terminal: TerminalSize,
): ControlView {
  return {
    sessionId: SESSION_ID,
    runtimeId: RUNTIME_ID,
    controllerAttachmentId,
    controllerGeneration,
    terminal,
  };
}

function controlRequested(): DurableSessionEvent {
  return {
    version: 0,
    eventId: "60000000-0000-4000-8000-000000000001",
    sessionId: SESSION_ID,
    occurredAtMs: 1,
    type: "control.requested",
    controllerGeneration: 1,
    request: {
      controlRequestId: CONTROL_REQUEST_ID,
      requesterAttachmentId: "30000000-0000-4000-8000-000000000002",
      controllerGeneration: 1,
      expiresAtMs: 10_000,
    },
  };
}

function controlOffered(): DurableSessionEvent {
  return {
    version: 0,
    eventId: "60000000-0000-4000-8000-000000000002",
    sessionId: SESSION_ID,
    occurredAtMs: 2,
    type: "control.offered",
    controllerGeneration: 2,
    offer: {
      controlOfferId: CONTROL_OFFER_ID,
      controlRequestId: CONTROL_REQUEST_ID,
      requesterAttachmentId: ATTACHMENT_ID,
      controllerAttachmentId: "30000000-0000-4000-8000-000000000002",
      controllerGeneration: 2,
      expiresAtMs: 10_000,
    },
  };
}
