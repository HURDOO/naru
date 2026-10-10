import { describe, expect, it } from "vitest";
import { NaruRepository } from "../src/database.js";
import { ClaudeActivitySemantics } from "../src/claude-activity-semantics.js";
import type { ClaudeActivityEvent } from "../src/claude-activity-events.js";

const firstRuntime = "11111111-1111-4111-8111-111111111111";
const secondRuntime = "22222222-2222-4222-8222-222222222222";

describe("ClaudeActivitySemantics", () => {
  it("tracks a main turn without retaining hook content or reviving stale sessions", () => {
    const repository = new NaruRepository(":memory:", { defaultAgentPaneKind: "claude" });
    try {
      const project = repository.createProject("/tmp/naru-claude-activity", "fixture");
      const pane = repository
        .getWorkspace(project.id)
        .panes.find((candidate) => candidate.kind === "claude");
      if (pane === undefined) throw new Error("Claude fixture Pane is missing.");
      repository.beginPaneRuntime(pane.id, firstRuntime);
      const changes: string[] = [];
      const semantics = new ClaudeActivitySemantics({
        repository,
        paneId: pane.id,
        runtimeId: firstRuntime,
        emitActivity: (change) => changes.push(change.activity.state),
      });
      const send = (type: ClaudeActivityEvent["type"], sessionId = "session-1"): void =>
        semantics.accept({ type, sessionId, cwd: project.path });

      send("session-start");
      send("turn-start");
      send("interaction-required");
      send("interaction-required");
      send("turn-running");
      send("turn-completed");
      send("turn-running");
      expect(changes).toEqual(["running", "interaction-required", "running", "completed"]);
      expect(repository.getPaneContext(pane.id)?.pane.activity.state).toBe("completed");

      send("turn-start", "old-session");
      expect(repository.getPaneContext(pane.id)?.pane.activity.state).toBe("completed");
      send("session-start", "session-2");
      send("turn-start", "session-2");
      send("turn-failed", "session-2");
      expect(repository.getPaneContext(pane.id)?.pane.activity.state).toBe("failed");

      repository.beginPaneRuntime(pane.id, secondRuntime);
      send("session-start", "session-3");
      send("turn-start", "session-3");
      expect(repository.getPaneContext(pane.id)?.pane.activity).toMatchObject({
        runtimeId: secondRuntime,
        state: "idle",
      });
      semantics.markStopping();
      send("turn-failed", "session-3");
      expect(repository.getPaneContext(pane.id)?.pane.activity.state).toBe("idle");
    } finally {
      repository.close();
    }
  });

  it("remembers the current runtime's latest conversation for a later resume", () => {
    const repository = new NaruRepository(":memory:", { defaultAgentPaneKind: "claude" });
    try {
      const project = repository.createProject("/tmp/naru-claude-resume", "fixture");
      const pane = repository
        .getWorkspace(project.id)
        .panes.find((candidate) => candidate.kind === "claude");
      if (pane === undefined) throw new Error("Claude fixture Pane is missing.");
      repository.beginPaneRuntime(pane.id, firstRuntime);
      const semantics = new ClaudeActivitySemantics({
        repository,
        paneId: pane.id,
        runtimeId: firstRuntime,
        emitActivity: () => undefined,
      });
      const started = "33333333-3333-4333-8333-333333333333";
      const cleared = "44444444-4444-4444-8444-444444444444";
      const stored = () => repository.getPaneContext(pane.id)?.pane.claudeSessionId;
      expect(stored()).toBeNull();

      semantics.accept({ type: "session-start", sessionId: started, cwd: project.path });
      expect(stored()).toBe(started);
      semantics.accept({ type: "session-start", sessionId: cleared, cwd: project.path });
      expect(stored()).toBe(cleared);

      // A non-UUID value is never persisted as a resume target.
      semantics.accept({ type: "session-start", sessionId: "not-a-uuid", cwd: project.path });
      expect(stored()).toBe(cleared);

      // A runtime that is no longer current cannot replace the stored conversation.
      repository.beginPaneRuntime(pane.id, secondRuntime);
      semantics.accept({ type: "session-start", sessionId: started, cwd: project.path });
      expect(stored()).toBe(cleared);

      repository.clearClaudeSession(pane.id);
      expect(stored()).toBeNull();
    } finally {
      repository.close();
    }
  });

  it("marks an interrupted or nonzero-exit turn failed, but not an idle clean exit", () => {
    const repository = new NaruRepository(":memory:", { defaultAgentPaneKind: "claude" });
    try {
      const project = repository.createProject("/tmp/naru-claude-exit", "fixture");
      const pane = repository
        .getWorkspace(project.id)
        .panes.find((candidate) => candidate.kind === "claude");
      if (pane === undefined) throw new Error("Claude fixture Pane is missing.");
      repository.beginPaneRuntime(pane.id, firstRuntime);
      const semantics = new ClaudeActivitySemantics({
        repository,
        paneId: pane.id,
        runtimeId: firstRuntime,
        emitActivity: () => undefined,
      });
      semantics.accept({ type: "session-start", sessionId: "session-1", cwd: project.path });
      semantics.observeExit(0);
      expect(repository.getPaneContext(pane.id)?.pane.activity.state).toBe("idle");
      semantics.accept({ type: "turn-start", sessionId: "session-1", cwd: project.path });
      semantics.observeExit(0);
      expect(repository.getPaneContext(pane.id)?.pane.activity.state).toBe("failed");
    } finally {
      repository.close();
    }
  });
});
