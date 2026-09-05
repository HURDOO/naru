import { describe, expect, it, vi } from "vitest";
import { CodexSessionTracker } from "../src/codex-session-tracker.js";

const SESSION_ID = "33333333-3333-4333-8333-333333333333";

describe("CodexSessionTracker", () => {
  it("captures a labeled session ID only after the exact /status command", () => {
    const tracker = new CodexSessionTracker();

    expect(tracker.observeOutput(`│  Session:          ${SESSION_ID}  │`)).toBeNull();
    tracker.observeInput("/sta");
    tracker.observeInput("tus\r");
    expect(tracker.observeOutput("unrelated 11111111-1111-4111-8111-111111111111")).toBeNull();
    expect(tracker.observeOutput(`│  \u001b[2mSession:\u001b[0m          ${SESSION_ID}  │`)).toBe(
      SESSION_ID,
    );
    expect(tracker.observeOutput(`Session ID: ${SESSION_ID}`)).toBeNull();
  });

  it("supports edited and bracketed-paste input plus the documented Chat ID label", () => {
    const tracker = new CodexSessionTracker();
    tracker.observeInput("\u001b[200~/statuz\u007fs\u001b[201~\r");

    expect(tracker.observeOutput(`Chat ID │ ${SESSION_ID}`)).toBe(SESSION_ID);
  });

  it("can parse the bounded current screen when TUI diff chunks do not contain the full row", () => {
    const tracker = new CodexSessionTracker();
    const currentScreen = vi.fn(() => `\u001b[HSession  ${SESSION_ID}`);
    tracker.observeInput("/status\r");

    expect(tracker.observeOutput("Session\u001b[7;12H", currentScreen)).toBe(SESSION_ID);
    expect(currentScreen).toHaveBeenCalledOnce();
  });

  it("does not read an old status row from the current screen before fresh labeled output", () => {
    const tracker = new CodexSessionTracker();
    const currentScreen = vi.fn(() => `Session ID: ${SESSION_ID}`);
    tracker.observeInput("/status\r");

    expect(tracker.observeOutput("\u001b[7;12H", currentScreen)).toBeNull();
    expect(currentScreen).not.toHaveBeenCalled();
  });

  it("disarms expired, oversized, and superseded captures", () => {
    let now = 1_000;
    const tracker = new CodexSessionTracker({
      now: () => now,
      maxCaptureLength: 16,
      captureWindowMs: 100,
    });

    tracker.observeInput("/status\r");
    now += 101;
    expect(tracker.observeOutput(`Session ID: ${SESSION_ID}`)).toBeNull();

    tracker.observeInput("/status\r");
    expect(tracker.observeOutput("x".repeat(17))).toBeNull();
    expect(tracker.observeOutput(`Session ID: ${SESSION_ID}`)).toBeNull();

    tracker.observeInput("/status\r");
    tracker.observeInput("/model\r");
    expect(tracker.observeOutput(`Session ID: ${SESSION_ID}`)).toBeNull();
  });

  it("captures an exact trailing Codex resume hint only when the process exits", () => {
    const tracker = new CodexSessionTracker();

    expect(
      tracker.observeOutput(
        `To continue this session, run \u001b[36mcodex resume ${SESSION_ID}\u001b[39m\r\n`,
      ),
    ).toBeNull();
    expect(tracker.observeExit()).toBe(SESSION_ID);

    tracker.observeOutput(`To continue this session, run codex resume ${SESSION_ID}\r\n`);
    tracker.observeOutput("later terminal output\r\n");
    expect(tracker.observeExit()).toBeNull();
  });

  it("invalidates the current ID on /new and never treats its old resume hint as current", () => {
    const tracker = new CodexSessionTracker();
    const nextSessionId = "44444444-4444-4444-8444-444444444444";

    expect(tracker.observeInput("/newsletter\r")).toBe(false);
    expect(tracker.observeInput("/new bug bash\r")).toBe(true);
    tracker.observeOutput(`To continue this session, run codex resume ${SESSION_ID}\r\n`);
    expect(tracker.observeExit()).toBeNull();

    tracker.observeOutput(
      `To continue this session, run codex resume, then select bug bash (${nextSessionId})\r\n`,
    );
    expect(tracker.observeExit()).toBe(nextSessionId);
  });

  it("recognizes a /new old-session hint split across terminal chunks", () => {
    const tracker = new CodexSessionTracker();

    expect(tracker.observeInput("/new\r")).toBe(true);
    tracker.observeOutput("To continue this session, run codex res");
    tracker.observeOutput(`ume ${SESSION_ID}\r\n`);

    expect(tracker.observeExit()).toBeNull();
  });

  it("fails closed when /new output is too ambiguous to identify the old hint", () => {
    const tracker = new CodexSessionTracker({ maxCaptureLength: 16 });

    expect(tracker.observeInput("/new\r")).toBe(true);
    tracker.observeOutput("x".repeat(17));
    tracker.observeOutput(`To continue this session, run codex resume ${SESSION_ID}\r\n`);

    expect(tracker.observeExit()).toBeNull();
  });

  it("accepts the new current ID after an empty /new session has no old resume hint", () => {
    const tracker = new CodexSessionTracker();
    const nextSessionId = "44444444-4444-4444-8444-444444444444";

    expect(tracker.observeInput("/new\r")).toBe(true);
    tracker.observeInput("/status\r");
    expect(tracker.observeOutput(`│  Session:  ${nextSessionId}  │`)).toBe(nextSessionId);
    tracker.observeOutput(`To continue this session, run codex resume ${nextSessionId}\r\n`);

    expect(tracker.observeExit()).toBe(nextSessionId);
  });

  it("invalidates the current ID for /resume picker and direct targets", () => {
    const tracker = new CodexSessionTracker();

    expect(tracker.observeInput("/resume-later\r")).toBe(false);
    expect(tracker.observeInput("/resume\r")).toBe(true);
    tracker.observeOutput(`To continue this session, run codex resume ${SESSION_ID}\r\n`);
    expect(tracker.observeExit()).toBeNull();

    expect(tracker.observeInput("/resume selected-chat\r")).toBe(true);
  });

  it("continues parsing commands after a session transition in the same input chunk", () => {
    const tracker = new CodexSessionTracker();

    expect(tracker.observeInput("/resume\r/status\r")).toBe(true);
    expect(tracker.observeOutput(`Session: ${SESSION_ID}`)).toBe(SESSION_ID);
  });

  it("accepts the selected session exit hint after an in-TUI /resume transition", () => {
    const tracker = new CodexSessionTracker();
    const selectedSessionId = "44444444-4444-4444-8444-444444444444";

    expect(tracker.observeInput("/resume selected-chat\r")).toBe(true);
    tracker.observeOutput(`To continue this session, run codex resume ${SESSION_ID}\r\n`);
    tracker.observeOutput(`To continue this session, run codex resume ${selectedSessionId}\r\n`);

    expect(tracker.observeExit()).toBe(selectedSessionId);
  });
});
