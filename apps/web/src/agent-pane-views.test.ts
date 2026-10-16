import { describe, expect, it } from "vitest";
import { paneView } from "./agent-pane-views";

describe("agent Pane views (AP-D039)", () => {
  it("shows Claude's conversation while its runner runs and the TUI once taken over", () => {
    expect(paneView({ runtime: "claude", launchMode: "runner" }, undefined)).toBe("chat");
    expect(paneView({ runtime: "claude", launchMode: "tui" }, undefined)).toBe("tui");
    // The console is the person's choice, and only the runner has one.
    expect(paneView({ runtime: "claude", launchMode: "runner" }, "console")).toBe("console");
    expect(paneView({ runtime: "claude", launchMode: "tui" }, "console")).toBe("tui");
    // What the runtime is decides, not a choice left from before.
    expect(paneView({ runtime: "claude", launchMode: "runner" }, "tui")).toBe("chat");
  });

  it("follows the person's choice for Codex, whose chat and TUI share one thread", () => {
    expect(paneView({ runtime: "codex", launchMode: "runner" }, undefined)).toBe("chat");
    expect(paneView({ runtime: "codex", launchMode: "runner" }, "tui")).toBe("tui");
  });
});
