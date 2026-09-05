import type {
  AttachmentId,
  DurableSessionEvent,
  TerminalSnapshot,
} from "@naru/contracts/durable-session/v0";
import { describe, expect, it } from "vitest";
import { TerminalSequenceTracker } from "../src/terminal-sequence.js";

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const RUNTIME_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_RUNTIME_ID = "20000000-0000-4000-8000-000000000002";
const ATTACHMENT_ID = "30000000-0000-4000-8000-000000000001" as AttachmentId;

describe("TerminalSequenceTracker", () => {
  it("initializes ordering from a stream snapshot event", () => {
    const tracker = new TerminalSequenceTracker();

    expect(
      tracker.accept({
        version: 0,
        eventId: "40000000-0000-4000-8000-000000000010",
        sessionId: SESSION_ID,
        occurredAtMs: 1,
        type: "terminal.snapshot",
        runtimeId: RUNTIME_ID,
        sequence: 4,
        terminal: { cols: 80, rows: 24 },
        serializedState: "snapshot-state",
      }),
    ).toEqual({
      kind: "snapshot",
      runtimeId: RUNTIME_ID,
      sequence: 4,
      serializedState: "snapshot-state",
    });
    expect(tracker.accept(output(5, "live"))).toEqual({
      kind: "output",
      sequence: 5,
      data: "live",
    });
  });

  it("accepts exactly snapshot N plus live N+1", () => {
    const tracker = new TerminalSequenceTracker();
    tracker.restore(snapshot(4));

    expect(tracker.accept(output(5, "safe-output"))).toEqual({
      kind: "output",
      sequence: 5,
      data: "safe-output",
    });
    expect(tracker.sequence).toBe(5);
  });

  it("requires resync for a gap, duplicate, runtime change, or output before snapshot", () => {
    expect(new TerminalSequenceTracker().accept(output(1, "first"))).toMatchObject({
      kind: "resync-required",
      reason: "not-initialized",
    });

    const tracker = new TerminalSequenceTracker();
    tracker.restore(snapshot(4));
    expect(tracker.accept(output(6, "gap"))).toMatchObject({
      reason: "sequence-discontinuity",
    });
    expect(tracker.accept(output(4, "duplicate"))).toMatchObject({
      reason: "sequence-discontinuity",
    });
    expect(tracker.accept(output(5, "other", OTHER_RUNTIME_ID))).toMatchObject({
      reason: "runtime-changed",
    });
    expect(tracker.sequence).toBe(4);
  });

  it("honors attachment-scoped host resync events", () => {
    const tracker = new TerminalSequenceTracker();
    tracker.restore(snapshot(4));
    const event: DurableSessionEvent = {
      version: 0,
      eventId: "40000000-0000-4000-8000-000000000001",
      sessionId: SESSION_ID,
      occurredAtMs: 1,
      type: "attachment.resync-required",
      attachmentId: ATTACHMENT_ID,
      runtimeId: RUNTIME_ID,
      afterSequence: 4,
      reason: "queue-overflow",
    };

    expect(tracker.accept(event, ATTACHMENT_ID)).toMatchObject({
      kind: "resync-required",
      reason: "host-required",
    });
    expect(tracker.accept(event, "30000000-0000-4000-8000-000000000002")).toEqual({
      kind: "ignored",
    });
  });
});

function snapshot(sequence: number): TerminalSnapshot {
  return {
    sessionId: SESSION_ID,
    attachmentId: ATTACHMENT_ID,
    runtimeId: RUNTIME_ID,
    sequence,
    terminal: { cols: 80, rows: 24 },
    serializedState: "",
  };
}

function output(sequence: number, data: string, runtimeId = RUNTIME_ID): DurableSessionEvent {
  return {
    version: 0,
    eventId: "40000000-0000-4000-8000-000000000001",
    sessionId: SESSION_ID,
    occurredAtMs: 1,
    type: "terminal.output",
    runtimeId,
    sequence,
    data,
  };
}
