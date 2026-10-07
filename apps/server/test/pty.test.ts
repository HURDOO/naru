import { describe, expect, it, vi } from "vitest";
import type { Pane, PaneActivity, ServerWsFrame } from "@naru/contracts";
import type {
  CodexHookEvent,
  CodexSessionHookBridge,
  CodexSessionHookRegistration,
} from "../src/codex-session-hook.js";
import { NaruRepository } from "../src/database.js";
import type { PaneLaunchResolver } from "../src/launch-profiles.js";
import { PtySupervisor, type PtyProcess } from "../src/pty.js";

class FakePty implements PtyProcess {
  readonly pid = 4242;
  readonly writes: string[] = [];
  readonly sizes: Array<[number, number]> = [];
  readonly killSignals: Array<string | undefined> = [];
  readonly #dataListeners = new Set<(data: string) => void>();
  readonly #exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

  onData(listener: (data: string) => void): { dispose(): void } {
    this.#dataListeners.add(listener);
    return { dispose: () => this.#dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.#exitListeners.add(listener);
    return { dispose: () => this.#exitListeners.delete(listener) };
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(columns: number, rows: number): void {
    this.sizes.push([columns, rows]);
  }

  kill(signal?: string): void {
    this.killSignals.push(signal);
    this.emitExit(0);
  }

  emitData(data: string): void {
    for (const listener of this.#dataListeners) listener(data);
  }

  emitExit(exitCode: number, signal?: number): void {
    const event = { exitCode, ...(signal === undefined ? {} : { signal }) };
    for (const listener of this.#exitListeners) listener(event);
  }
}

class FakeCodexSessionHookBridge implements CodexSessionHookBridge {
  closeCalls = 0;
  readonly registrations: Array<{
    readonly onEvent: (event: CodexHookEvent) => void;
    disposed: boolean;
  }> = [];
  #active:
    | {
        readonly onEvent: (event: CodexHookEvent) => void;
        disposed: boolean;
      }
    | undefined;

  register(options: {
    paneId: string;
    runtimeId: string;
    cwd: string;
    onEvent: (event: CodexHookEvent) => void;
  }): CodexSessionHookRegistration {
    const active = { onEvent: options.onEvent, disposed: false };
    this.#active = active;
    this.registrations.push(active);
    return {
      environment: {
        NARU_CODEX_HOOK_PANE_ID: options.paneId,
        NARU_CODEX_HOOK_RUNTIME_ID: options.runtimeId,
        NARU_CODEX_HOOK_SOCKET: "/tmp/naru-test-hook.sock",
        NARU_CODEX_HOOK_TOKEN: "test-runtime-capability",
      },
      dispose: () => {
        active.disposed = true;
      },
    };
  }

  emit(event: CodexHookEvent): void {
    if (!this.#active?.disposed) this.#active?.onEvent(event);
  }

  emitRegistered(index: number, event: CodexHookEvent): void {
    this.registrations[index]?.onEvent(event);
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    return Promise.resolve();
  }
}

describe("PtySupervisor", () => {
  it("keeps ordered screen state for attach, input, resize, and normal exit", async () => {
    const fixture = createFixture();
    let spawnedCwd = "";
    const supervisor = new PtySupervisor(fixture.repository, (_file, _args, options) => {
      spawnedCwd = options.cwd;
      return fixture.process;
    });

    try {
      supervisor.start(fixture.pane.id, 80, 24);
      expect(spawnedCwd).toBe(fixture.projectPath);
      expect(fixture.repository.getPaneContext(fixture.pane.id)?.pane.status).toBe("running");

      fixture.process.emitData("before attach\r\n");
      const frames: ServerWsFrame[] = [];
      const detach = await supervisor.attach(fixture.pane.id, 92, 31, (frame) =>
        frames.push(frame),
      );
      expect(frames[0]).toMatchObject({
        type: "pane.snapshot",
        paneId: fixture.pane.id,
        sequence: 1,
      });
      expect(snapshotState(frames)).toContain("before attach");

      fixture.process.emitData("after attach\r\n");
      await waitFor(() => frames.some(isOutputSequence(2)));
      supervisor.write(fixture.pane.id, "echo hello\r");
      supervisor.resize(fixture.pane.id, 100, 40);
      expect(fixture.process.writes).toEqual(["echo hello\r"]);
      expect(fixture.process.sizes).toContainEqual([100, 40]);

      fixture.process.emitExit(7);
      await waitFor(
        () => fixture.repository.getPaneContext(fixture.pane.id)?.pane.status === "exited",
      );
      expect(frames.at(-1)).toMatchObject({
        type: "terminal.exit",
        paneId: fixture.pane.id,
        exitCode: 7,
      });
      detach();
    } finally {
      await supervisor.shutdown();
      fixture.repository.close();
    }
  });

  it("places snapshot capture in the output barrier without loss, duplication, or reordering", async () => {
    const fixture = createFixture();
    const supervisor = new PtySupervisor(fixture.repository, () => fixture.process);
    try {
      supervisor.start(fixture.pane.id, 80, 24);
      fixture.process.emitData("included in snapshot\r\n");

      const frames: ServerWsFrame[] = [];
      const attached = supervisor.attach(fixture.pane.id, 80, 24, (frame) => frames.push(frame));
      fixture.process.emitData("queued during snapshot\r\n");
      const detach = await attached;
      fixture.process.emitData("live after snapshot\r\n");
      await waitFor(() => frames.some(isOutputSequence(3)));

      expect(frames[0]).toMatchObject({ type: "pane.snapshot", sequence: 1 });
      expect(snapshotState(frames)).toContain("included in snapshot");
      expect(snapshotState(frames)).not.toContain("queued during snapshot");
      expect(
        frames
          .filter((frame) => frame.type === "terminal.output")
          .map((frame) => ({ sequence: frame.sequence, data: frame.data })),
      ).toEqual([
        { sequence: 2, data: "queued during snapshot\r\n" },
        { sequence: 3, data: "live after snapshot\r\n" },
      ]);
      detach();
    } finally {
      await supervisor.shutdown();
      fixture.repository.close();
    }
  });

  it("stages a bounded viewport preview and full snapshot at one sequence while preserving the scroll anchor", async () => {
    const fixture = createFixture();
    const supervisor = new PtySupervisor(fixture.repository, () => fixture.process);
    const restoreId = "33333333-3333-4333-8333-333333333333";
    try {
      supervisor.start(fixture.pane.id, 80, 10);
      fixture.process.emitData(
        Array.from(
          { length: 30 },
          (_, index) => `NARU_RESTORE_${String(index).padStart(2, "0")}\r\n`,
        ).join(""),
      );
      const legacyFrames: ServerWsFrame[] = [];
      const detachLegacy = await supervisor.attach(fixture.pane.id, 80, 10, (frame) =>
        legacyFrames.push(frame),
      );
      const legacy = legacyFrames[0];
      if (!legacy || legacy.type !== "pane.snapshot")
        throw new Error("Legacy snapshot is missing.");
      detachLegacy();

      supervisor.updateViewport(fixture.pane.id, legacy.runtimeId, 5);
      supervisor.updateViewport(fixture.pane.id, "44444444-4444-4444-8444-444444444444", 100);
      const stagedFrames: ServerWsFrame[] = [];
      const detachStaged = await supervisor.attach(
        fixture.pane.id,
        80,
        10,
        (frame) => stagedFrames.push(frame),
        "staged-v1",
        restoreId,
      );
      const preview = stagedFrames[0];
      const full = stagedFrames[1];
      if (preview?.type !== "pane.restore.preview" || full?.type !== "pane.restore.full") {
        throw new Error("Staged restore frames are missing.");
      }
      expect(preview).toMatchObject({
        restoreId,
        runtimeId: legacy.runtimeId,
        bottomOffset: 5,
        previewBottomOffset: 10,
        cols: 80,
        rows: 10,
      });
      expect(full).toMatchObject({
        restoreId,
        runtimeId: legacy.runtimeId,
        sequence: preview.sequence,
        bottomOffset: 5,
      });
      expect(preview.serializedState.length).toBeLessThan(full.serializedState.length);
      expect(preview.serializedState).toContain("NARU_RESTORE_16");
      expect(preview.serializedState).toContain("NARU_RESTORE_29");
      expect(full.serializedState).toContain("NARU_RESTORE_00");
      detachStaged();

      fixture.process.emitData("NARU_RESTORE_30\r\nNARU_RESTORE_31\r\nNARU_RESTORE_32\r\n");
      const anchoredFrames: ServerWsFrame[] = [];
      const detachAnchored = await supervisor.attach(
        fixture.pane.id,
        80,
        10,
        (frame) => anchoredFrames.push(frame),
        "staged-v1",
        "55555555-5555-4555-8555-555555555555",
      );
      expect(anchoredFrames[0]).toMatchObject({
        type: "pane.restore.preview",
        bottomOffset: 8,
      });
      detachAnchored();
    } finally {
      await supervisor.shutdown();
      fixture.repository.close();
    }
  });

  it("runs a Codex Pane through the same persistent PTY lifecycle without shell interpolation", async () => {
    const repository = new NaruRepository(":memory:");
    const project = repository.createProject("/tmp/naru-codex-project", "codex-project");
    const pane = repository
      .getWorkspace(project.id)
      .panes.find((candidate) => candidate.launchProfile === "codex-main");
    if (!pane) throw new Error("default Codex Pane is missing");
    const process = new FakePty();
    const resolver: PaneLaunchResolver = {
      resolve: () => ({
        file: "/opt/test/bin/codex",
        args: [
          "--model",
          "gpt-5.6-sol",
          "--config",
          'model_reasoning_effort="xhigh"',
          "--config",
          'service_tier="default"',
        ],
        environment: { TERM: "xterm-256color" },
      }),
    };
    const spawned: Array<{ file: string; args: string[]; cwd: string }> = [];
    const supervisor = new PtySupervisor(
      repository,
      (file, args, options) => {
        spawned.push({ file, args, cwd: options.cwd });
        return process;
      },
      resolver,
    );

    try {
      supervisor.start(pane.id);
      supervisor.start(pane.id);
      expect(spawned).toEqual([
        {
          file: "/opt/test/bin/codex",
          args: [
            "--model",
            "gpt-5.6-sol",
            "--config",
            'model_reasoning_effort="xhigh"',
            "--config",
            'service_tier="default"',
          ],
          cwd: project.path,
        },
      ]);

      const frames: ServerWsFrame[] = [];
      const detach = await supervisor.attach(pane.id, 100, 30, (frame) => frames.push(frame));
      process.emitData("CODEX_READY\r\n");
      await waitFor(() => frames.some(isOutputSequence(1)));
      const codexSessionId = "33333333-3333-4333-8333-333333333333";
      process.emitData(`Session ID: ${codexSessionId}\r\n`);
      await waitFor(() => frames.some(isOutputSequence(2)));
      expect(repository.getPaneContext(pane.id)?.pane.codexSessionId).toBeNull();

      supervisor.write(pane.id, "/status\r");
      process.emitData(`│  \u001b[2mSession:\u001b[0m          ${codexSessionId}  │\r\n`);
      await waitFor(
        () => repository.getPaneContext(pane.id)?.pane.codexSessionId === codexSessionId,
      );
      expect(repository.getPaneContext(pane.id)?.pane.codexSessionResumable).toBe(false);
      expect(process.writes).toContain("/status\r");

      supervisor.write(pane.id, "/new bug bash\r");
      expect(repository.getPaneContext(pane.id)?.pane.codexSessionId).toBeNull();
      process.emitData(`To continue this session, run codex resume ${codexSessionId}\r\n`);
      const nextCodexSessionId = "44444444-4444-4444-8444-444444444444";
      process.emitData(
        `To continue this session, run \u001b[36mcodex resume, then select bug bash (${nextCodexSessionId})\u001b[39m\r\n`,
      );
      process.emitExit(0);
      await waitFor(() => repository.getPaneContext(pane.id)?.pane.status === "exited");
      const exitedPane = repository.getPaneContext(pane.id)?.pane;
      expect(exitedPane).toMatchObject({
        status: "exited",
        exitCode: 0,
        codexSessionId: nextCodexSessionId,
        codexSessionResumable: true,
        lastErrorCode: null,
      });
      expect(exitedPane?.lastExitedAt).not.toBeNull();
      expect(Number.isNaN(Date.parse(exitedPane?.lastExitedAt ?? ""))).toBe(false);
      expect(frames.at(-1)).toMatchObject({
        type: "terminal.exit",
        codexSessionId: nextCodexSessionId,
        codexSessionResumable: true,
      });
      detach();
    } finally {
      await supervisor.shutdown();
      repository.close();
    }
  });

  it("persists authoritative SessionStart IDs across /new and /resume transitions", async () => {
    const repository = new NaruRepository(":memory:");
    const project = repository.createProject("/tmp/naru-hook-project", "hook-project");
    const pane = repository
      .getWorkspace(project.id)
      .panes.find((candidate) => candidate.launchProfile === "codex-main");
    if (!pane) throw new Error("default Codex Pane is missing");
    const process = new FakePty();
    const bridge = new FakeCodexSessionHookBridge();
    let spawnedEnvironment: Record<string, string> = {};
    const firstSessionId = "55555555-5555-4555-8555-555555555555";
    const identityChanges: Array<{ sessionId: string | null; resumable: boolean }> = [];
    const supervisor = new PtySupervisor(
      repository,
      (_file, _args, options) => {
        spawnedEnvironment = options.env;
        bridge.emit({
          type: "session-start",
          sessionId: firstSessionId,
          cwd: project.path,
          source: "startup",
        });
        return process;
      },
      {
        resolve: () => ({
          file: "/opt/test/bin/codex",
          args: [],
          environment: { TERM: "xterm-256color" },
        }),
      },
      bridge,
    );
    supervisor.onCodexIdentity(({ sessionId, resumable }) =>
      identityChanges.push({ sessionId, resumable }),
    );

    try {
      supervisor.start(pane.id);
      expect(spawnedEnvironment).toMatchObject({
        NARU_CODEX_HOOK_PANE_ID: pane.id,
        NARU_CODEX_HOOK_SOCKET: "/tmp/naru-test-hook.sock",
        NARU_CODEX_HOOK_TOKEN: "test-runtime-capability",
      });
      expect(spawnedEnvironment.NARU_CODEX_HOOK_RUNTIME_ID).toMatch(/^[0-9a-f-]{36}$/);
      expect(repository.getPaneContext(pane.id)?.pane.codexSessionId).toBe(firstSessionId);
      expect(repository.getPaneContext(pane.id)?.pane.codexSessionResumable).toBe(true);
      expect(identityChanges.at(-1)).toEqual({ sessionId: firstSessionId, resumable: true });

      supervisor.write(pane.id, "/new fresh work\r");
      expect(repository.getPaneContext(pane.id)?.pane.codexSessionId).toBeNull();
      expect(identityChanges.at(-1)).toEqual({ sessionId: null, resumable: false });
      const nextSessionId = "66666666-6666-4666-8666-666666666666";
      bridge.emit({
        type: "session-start",
        sessionId: nextSessionId,
        cwd: project.path,
        source: "clear",
      });
      expect(repository.getPaneContext(pane.id)?.pane).toMatchObject({
        codexSessionId: nextSessionId,
        codexSessionResumable: true,
      });
      expect(identityChanges.at(-1)).toEqual({ sessionId: nextSessionId, resumable: true });

      supervisor.write(pane.id, "/resume selected-chat\r");
      expect(repository.getPaneContext(pane.id)?.pane.codexSessionId).toBeNull();
      expect(identityChanges.at(-1)).toEqual({ sessionId: null, resumable: false });
      const resumedSessionId = "77777777-7777-4777-8777-777777777777";
      bridge.emit({
        type: "session-start",
        sessionId: resumedSessionId,
        cwd: project.path,
        source: "resume",
      });
      expect(repository.getPaneContext(pane.id)?.pane).toMatchObject({
        codexSessionId: resumedSessionId,
        codexSessionResumable: true,
      });
      expect(identityChanges.at(-1)).toEqual({ sessionId: resumedSessionId, resumable: true });

      process.emitExit(0);
      await waitFor(() => repository.getPaneContext(pane.id)?.pane.status === "exited");
      bridge.emit({
        type: "session-start",
        sessionId: "88888888-8888-4888-8888-888888888888",
        cwd: project.path,
        source: "startup",
      });
      expect(repository.getPaneContext(pane.id)?.pane.codexSessionId).toBe(resumedSessionId);
      expect(identityChanges.at(-1)).toEqual({ sessionId: resumedSessionId, resumable: true });
    } finally {
      await supervisor.shutdown();
      expect(bridge.closeCalls).toBeGreaterThan(0);
      repository.close();
    }
  });

  it("normalizes Codex turn hooks and rejects stale turn completion", async () => {
    const repository = new NaruRepository(":memory:");
    const project = repository.createProject("/tmp/naru-activity-project", "activity-project");
    const pane = repository
      .getWorkspace(project.id)
      .panes.find((candidate) => candidate.launchProfile === "codex-main");
    if (!pane) throw new Error("default Codex Pane is missing");
    const process = new FakePty();
    const bridge = new FakeCodexSessionHookBridge();
    const supervisor = new PtySupervisor(
      repository,
      () => process,
      {
        resolve: () => ({ file: "/opt/test/bin/codex", args: [], environment: {} }),
      },
      bridge,
    );
    const states: string[] = [];
    const activityRuntimeIds: Array<string | null> = [];
    supervisor.onActivity((change) => {
      states.push(change.activity.state);
      activityRuntimeIds.push(change.runtimeId);
    });
    const sessionId = "99999999-9999-4999-8999-999999999999";

    try {
      supervisor.start(pane.id);
      bridge.emit({
        type: "session-start",
        sessionId,
        cwd: project.path,
        source: "startup",
      });
      bridge.emit({
        type: "turn-start",
        sessionId: "88888888-8888-4888-8888-888888888888",
        cwd: project.path,
        turnId: "turn-other-session",
      });
      expect(repository.getPaneContext(pane.id)?.pane).toMatchObject({
        codexSessionId: sessionId,
        activity: { state: "idle" },
      });
      bridge.emit({
        type: "interaction-required",
        sessionId,
        cwd: project.path,
        turnId: "turn-without-start",
      });
      expect(repository.getPaneContext(pane.id)?.pane.activity.state).toBe("idle");
      bridge.emit({
        type: "turn-start",
        sessionId,
        cwd: project.path,
        turnId: "turn-current",
      });
      bridge.emit({
        type: "interaction-required",
        sessionId,
        cwd: project.path,
        turnId: "turn-current",
      });
      bridge.emit({
        type: "turn-completed",
        sessionId,
        cwd: project.path,
        turnId: "turn-stale",
      });
      expect(repository.getPaneContext(pane.id)?.pane.activity.state).toBe("interaction-required");
      bridge.emit({
        type: "turn-running",
        sessionId,
        cwd: project.path,
        turnId: "turn-current",
      });
      bridge.emit({
        type: "turn-completed",
        sessionId,
        cwd: project.path,
        turnId: "turn-current",
      });
      bridge.emit({
        type: "turn-start",
        sessionId,
        cwd: project.path,
        turnId: "turn-current",
      });

      expect(repository.getPaneContext(pane.id)?.pane.activity.state).toBe("completed");
      const completedEventId = repository.getPaneContext(pane.id)?.pane.activity.eventId;
      if (!completedEventId) throw new Error("completed activity event is missing");
      supervisor.acknowledgeCompleted(pane.id, completedEventId);
      expect(repository.getPaneContext(pane.id)?.pane.activity.state).toBe("idle");
      expect(states).toEqual([
        "idle",
        "running",
        "interaction-required",
        "running",
        "completed",
        "idle",
      ]);
      expect(new Set(activityRuntimeIds).size).toBe(1);
      expect(activityRuntimeIds[0]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    } finally {
      await supervisor.shutdown();
      repository.close();
    }
  });

  it.each([
    ["Escape", "\u001b"],
    ["Control+C", "\u0003"],
  ])(
    "attributes a current-turn %s interrupt to the user across reconnect and exit",
    async (_key, interruptInput) => {
      const repository = new NaruRepository(":memory:");
      const project = repository.createProject("/tmp/naru-interrupt-project", "interrupt-project");
      const pane = repository
        .getWorkspace(project.id)
        .panes.find((candidate) => candidate.launchProfile === "codex-main");
      if (!pane) throw new Error("default Codex Pane is missing");
      const process = new FakePty();
      const bridge = new FakeCodexSessionHookBridge();
      const supervisor = new PtySupervisor(
        repository,
        () => process,
        {
          resolve: () => ({ file: "/opt/test/bin/codex", args: [], environment: {} }),
        },
        bridge,
      );
      const states: string[] = [];
      supervisor.onActivity((change) => states.push(change.activity.state));
      const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

      try {
        supervisor.start(pane.id);
        bridge.emit({
          type: "session-start",
          sessionId,
          cwd: project.path,
          source: "startup",
        });
        bridge.emit({
          type: "turn-start",
          sessionId,
          cwd: project.path,
          turnId: "turn-to-cancel",
        });

        const firstFrames: ServerWsFrame[] = [];
        const detach = await supervisor.attach(pane.id, 80, 24, (frame) => firstFrames.push(frame));
        detach();
        const reconnectedFrames: ServerWsFrame[] = [];
        const detachReconnected = await supervisor.attach(pane.id, 80, 24, (frame) =>
          reconnectedFrames.push(frame),
        );

        supervisor.write(pane.id, interruptInput);
        expect(process.writes).toContain(interruptInput);
        expect(repository.getPaneContext(pane.id)?.pane).toMatchObject({
          status: "running",
          codexSessionId: sessionId,
          codexSessionResumable: true,
          activity: { state: "canceled" },
        });

        bridge.emit({
          type: "turn-running",
          sessionId,
          cwd: project.path,
          turnId: "turn-to-cancel",
        });
        bridge.emit({
          type: "turn-completed",
          sessionId,
          cwd: project.path,
          turnId: "turn-to-cancel",
        });
        expect(repository.getPaneContext(pane.id)?.pane.activity.state).toBe("canceled");

        process.emitExit(130, 2);
        await waitFor(() => repository.getPaneContext(pane.id)?.pane.status === "exited");
        expect(repository.getPaneContext(pane.id)?.pane).toMatchObject({
          status: "exited",
          exitCode: 130,
          activity: { state: "canceled" },
        });
        expect(states).toEqual(["idle", "running", "canceled"]);
        expect(firstFrames[0]).toMatchObject({ type: "pane.snapshot" });
        expect(reconnectedFrames.at(-1)).toMatchObject({
          type: "terminal.exit",
          exitCode: 130,
          signal: 2,
        });
        detachReconnected();
      } finally {
        await supervisor.shutdown();
        repository.close();
      }
    },
  );

  it("does not let an old interrupt hide a later abnormal exit or a new turn", async () => {
    const repository = new NaruRepository(":memory:");
    const project = repository.createProject("/tmp/naru-stale-interrupt", "stale-interrupt");
    const pane = repository
      .getWorkspace(project.id)
      .panes.find((candidate) => candidate.launchProfile === "codex-main");
    if (!pane) throw new Error("default Codex Pane is missing");
    const process = new FakePty();
    const bridge = new FakeCodexSessionHookBridge();
    const supervisor = new PtySupervisor(
      repository,
      () => process,
      {
        resolve: () => ({ file: "/opt/test/bin/codex", args: [], environment: {} }),
      },
      bridge,
    );
    const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const now = vi.spyOn(Date, "now");

    try {
      now.mockReturnValue(1_000);
      supervisor.start(pane.id);
      bridge.emit({
        type: "session-start",
        sessionId,
        cwd: project.path,
        source: "startup",
      });
      bridge.emit({
        type: "turn-start",
        sessionId,
        cwd: project.path,
        turnId: "turn-old",
      });
      supervisor.write(pane.id, "\u0003");
      expect(repository.getPaneContext(pane.id)?.pane.activity.state).toBe("canceled");

      bridge.emit({
        type: "turn-start",
        sessionId,
        cwd: project.path,
        turnId: "turn-new",
      });
      expect(repository.getPaneContext(pane.id)?.pane.activity.state).toBe("running");
      bridge.emit({
        type: "turn-start",
        sessionId,
        cwd: project.path,
        turnId: "turn-old",
      });
      bridge.emit({
        type: "interaction-required",
        sessionId,
        cwd: project.path,
        turnId: "turn-old",
      });
      expect(repository.getPaneContext(pane.id)?.pane.activity.state).toBe("running");
      now.mockReturnValue(4_001);
      process.emitExit(7);
      await waitFor(() => repository.getPaneContext(pane.id)?.pane.status === "exited");
      expect(repository.getPaneContext(pane.id)?.pane.activity.state).toBe("failed");
    } finally {
      now.mockRestore();
      await supervisor.shutdown();
      repository.close();
    }
  });

  it("limits canceled exit attribution to the immediate interrupt lifecycle", async () => {
    const repository = new NaruRepository(":memory:");
    const project = repository.createProject("/tmp/naru-expired-interrupt", "expired-interrupt");
    const pane = repository
      .getWorkspace(project.id)
      .panes.find((candidate) => candidate.launchProfile === "codex-main");
    if (!pane) throw new Error("default Codex Pane is missing");
    const process = new FakePty();
    const bridge = new FakeCodexSessionHookBridge();
    const supervisor = new PtySupervisor(
      repository,
      () => process,
      {
        resolve: () => ({ file: "/opt/test/bin/codex", args: [], environment: {} }),
      },
      bridge,
    );
    const sessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const now = vi.spyOn(Date, "now");

    try {
      now.mockReturnValue(1_000);
      supervisor.start(pane.id);
      bridge.emit({
        type: "session-start",
        sessionId,
        cwd: project.path,
        source: "startup",
      });
      bridge.emit({
        type: "turn-start",
        sessionId,
        cwd: project.path,
        turnId: "turn-to-expire",
      });
      supervisor.write(pane.id, "\u001b");
      expect(repository.getPaneContext(pane.id)?.pane.activity.state).toBe("canceled");

      now.mockReturnValue(3_001);
      process.emitExit(7);
      await waitFor(() => repository.getPaneContext(pane.id)?.pane.status === "exited");
      expect(repository.getPaneContext(pane.id)?.pane.activity.state).toBe("failed");
    } finally {
      now.mockRestore();
      await supervisor.shutdown();
      repository.close();
    }
  });

  it("clears saved resume metadata before starting a new Codex session", async () => {
    const repository = new NaruRepository(":memory:");
    const project = repository.createProject("/tmp/naru-new-codex", "new-codex");
    const pane = repository
      .getWorkspace(project.id)
      .panes.find((candidate) => candidate.launchProfile === "codex-main");
    if (!pane) throw new Error("default Codex Pane is missing");
    const savedSessionId = "99999999-9999-4999-8999-999999999999";
    repository.setCodexSession(pane.id, savedSessionId, true);
    const process = new FakePty();
    let launchPane: Pane | null = null;
    const supervisor = new PtySupervisor(repository, () => process, {
      resolve: (context) => {
        launchPane = context.pane;
        return {
          file: "/opt/test/bin/codex",
          args: [],
          environment: { TERM: "xterm-256color" },
        };
      },
    });

    try {
      supervisor.startNewCodex(pane.id);
      expect(launchPane).toMatchObject({
        codexSessionId: null,
        codexSessionResumable: false,
      });
      expect(repository.getPaneContext(pane.id)?.pane).toMatchObject({
        status: "running",
        codexSessionId: null,
        codexSessionResumable: false,
      });
    } finally {
      await supervisor.shutdown();
      repository.close();
    }
  });

  it("resumes a server-stopped Codex Pane as a new idle runtime and rejects the old generation", async () => {
    const repository = new NaruRepository(":memory:");
    const project = repository.createProject("/tmp/naru-resume-generation", "resume-generation");
    const pane = repository
      .getWorkspace(project.id)
      .panes.find((candidate) => candidate.launchProfile === "codex-main");
    if (!pane) throw new Error("default Codex Pane is missing");
    const savedSessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const previousRuntimeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    repository.setCodexSession(pane.id, savedSessionId, true);
    repository.beginPaneRuntime(pane.id, previousRuntimeId);
    repository.setPaneStatusForRuntime(pane.id, previousRuntimeId, "stopped");
    repository.setPaneActivityForRuntime(pane.id, previousRuntimeId, "server-stopped");
    const previousActivity = repository.getPaneContext(pane.id)?.pane.activity;
    if (!previousActivity) throw new Error("previous runtime activity is missing");

    const process = new FakePty();
    const bridge = new FakeCodexSessionHookBridge();
    const activityChanges: PaneActivity[] = [];
    let launchPane: Pane | null = null;
    const supervisor = new PtySupervisor(
      repository,
      () => process,
      {
        resolve: (context) => {
          launchPane = context.pane;
          return { file: "/opt/test/bin/codex", args: [], environment: {} };
        },
      },
      bridge,
    );
    supervisor.onActivity((change) => activityChanges.push(change.activity));

    try {
      supervisor.restart(pane.id);
      const started = repository.getPaneContext(pane.id)?.pane;
      expect(launchPane).toMatchObject({
        codexSessionId: savedSessionId,
        codexSessionResumable: true,
        activity: { state: "server-stopped", runtimeId: previousRuntimeId },
      });
      expect(started).toMatchObject({
        status: "running",
        codexSessionId: savedSessionId,
        activity: {
          state: "idle",
          revision: previousActivity.revision + 1,
        },
      });
      const currentRuntimeId = started?.activity.runtimeId;
      expect(currentRuntimeId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(currentRuntimeId).not.toBe(previousRuntimeId);
      expect(activityChanges).toHaveLength(1);
      expect(activityChanges[0]).toMatchObject({ state: "idle", runtimeId: currentRuntimeId });

      expect(repository.setPaneActivityForRuntime(pane.id, previousRuntimeId, "failed")).toBeNull();
      expect(
        repository.setPaneStatusForRuntime(
          pane.id,
          previousRuntimeId,
          "error",
          null,
          "PTY_SPAWN_FAILED",
        ),
      ).toBe(false);
      expect(repository.getPaneContext(pane.id)?.pane).toMatchObject({
        status: "running",
        activity: { state: "idle", runtimeId: currentRuntimeId },
      });

      bridge.emit({
        type: "session-start",
        sessionId: savedSessionId,
        cwd: project.path,
        source: "resume",
      });
      bridge.emit({
        type: "turn-start",
        sessionId: savedSessionId,
        cwd: project.path,
        turnId: "resumed-turn",
      });
      expect(repository.getPaneContext(pane.id)?.pane.activity).toMatchObject({
        state: "running",
        runtimeId: currentRuntimeId,
      });
    } finally {
      await supervisor.shutdown();
      repository.close();
    }
  });

  it("ignores late hook and exit callbacks after a stopped Codex Pane starts a new runtime", async () => {
    const repository = new NaruRepository(":memory:");
    const project = repository.createProject("/tmp/naru-stale-runtime", "stale-runtime");
    const pane = repository
      .getWorkspace(project.id)
      .panes.find((candidate) => candidate.launchProfile === "codex-main");
    if (!pane) throw new Error("default Codex Pane is missing");
    const processes = [new FakePty(), new FakePty()];
    let nextProcess = 0;
    const bridge = new FakeCodexSessionHookBridge();
    const states: string[] = [];
    const supervisor = new PtySupervisor(
      repository,
      () => processes[nextProcess++] as FakePty,
      {
        resolve: () => ({ file: "/opt/test/bin/codex", args: [], environment: {} }),
      },
      bridge,
    );
    supervisor.onActivity((change) => states.push(change.activity.state));
    const oldSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    try {
      supervisor.start(pane.id);
      bridge.emit({
        type: "session-start",
        sessionId: oldSessionId,
        cwd: project.path,
        source: "startup",
      });
      bridge.emit({
        type: "turn-start",
        sessionId: oldSessionId,
        cwd: project.path,
        turnId: "old-turn",
      });
      const oldRuntimeId = repository.getPaneContext(pane.id)?.pane.activity.runtimeId;

      supervisor.stop(pane.id);
      await waitFor(() => supervisor.count() === 0);
      supervisor.restart(pane.id);
      const currentActivity = repository.getPaneContext(pane.id)?.pane.activity;
      if (!currentActivity) throw new Error("current runtime activity is missing");
      expect(currentActivity).toMatchObject({ state: "idle" });
      expect(currentActivity.runtimeId).not.toBe(oldRuntimeId);
      const stateCountAfterRestart = states.length;

      bridge.emitRegistered(0, {
        type: "interaction-required",
        sessionId: oldSessionId,
        cwd: project.path,
        turnId: "old-turn",
      });
      processes[0]?.emitExit(9);
      await Promise.resolve();

      expect(repository.getPaneContext(pane.id)?.pane).toMatchObject({
        status: "running",
        codexSessionId: oldSessionId,
        activity: currentActivity,
      });
      expect(states).toHaveLength(stateCountAfterRestart);
      expect(states.slice(-2)).toEqual(["server-stopped", "idle"]);
    } finally {
      await supervisor.shutdown();
      repository.close();
    }
  });

  it("does not carry an identified-only ID into a generic Codex restart", async () => {
    const repository = new NaruRepository(":memory:");
    const project = repository.createProject("/tmp/naru-restart-codex", "restart-codex");
    const pane = repository
      .getWorkspace(project.id)
      .panes.find((candidate) => candidate.launchProfile === "codex-main");
    if (!pane) throw new Error("default Codex Pane is missing");
    const previousRuntimeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    repository.beginPaneRuntime(pane.id, previousRuntimeId);
    repository.setCodexSession(pane.id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", false);
    const process = new FakePty();
    let launchPane: Pane | null = null;
    const identityChanges: Array<{ sessionId: string | null; runtimeId: string }> = [];
    const supervisor = new PtySupervisor(repository, () => process, {
      resolve: (context) => {
        launchPane = context.pane;
        return {
          file: "/opt/test/bin/codex",
          args: [],
          environment: { TERM: "xterm-256color" },
        };
      },
    });
    supervisor.onCodexIdentity((change) =>
      identityChanges.push({ sessionId: change.sessionId, runtimeId: change.runtimeId }),
    );

    try {
      supervisor.restart(pane.id);
      expect(launchPane).toMatchObject({
        codexSessionId: null,
        codexSessionResumable: false,
      });
      expect(identityChanges[0]).toEqual({ sessionId: null, runtimeId: previousRuntimeId });
    } finally {
      await supervisor.shutdown();
      repository.close();
    }
  });

  it("serializes the currently active alternate screen and restores the primary screen", async () => {
    const fixture = createFixture();
    const supervisor = new PtySupervisor(fixture.repository, () => fixture.process);
    try {
      supervisor.start(fixture.pane.id, 80, 24);
      fixture.process.emitData("PRIMARY SCREEN");
      const primaryFrames: ServerWsFrame[] = [];
      const detachPrimary = await supervisor.attach(fixture.pane.id, 80, 24, (frame) =>
        primaryFrames.push(frame),
      );
      expect(snapshotState(primaryFrames)).toContain("PRIMARY SCREEN");
      detachPrimary();

      fixture.process.emitData("\u001b[?1049h\u001b[?1003;1006h\u001b[2J\u001b[HALTERNATE SCREEN");
      const alternateFrames: ServerWsFrame[] = [];
      const detachAlternate = await supervisor.attach(fixture.pane.id, 80, 24, (frame) =>
        alternateFrames.push(frame),
      );
      const alternateSnapshot = snapshotState(alternateFrames);
      expect(alternateSnapshot).toContain("PRIMARY SCREEN");
      expect(alternateSnapshot).toContain("\u001b[?1049h");
      expect(alternateSnapshot).toContain("ALTERNATE SCREEN");
      expect(alternateSnapshot).toContain("\u001b[?1006h");
      expect(alternateSnapshot.indexOf("\u001b[?1049h")).toBeLessThan(
        alternateSnapshot.indexOf("ALTERNATE SCREEN"),
      );
      detachAlternate();

      fixture.process.emitData("\u001b[?1049;1003;1006l");
      const restoredFrames: ServerWsFrame[] = [];
      const detachRestored = await supervisor.attach(fixture.pane.id, 80, 24, (frame) =>
        restoredFrames.push(frame),
      );
      expect(snapshotState(restoredFrames)).toContain("PRIMARY SCREEN");
      expect(snapshotState(restoredFrames)).not.toContain("\u001b[?1006h");
      detachRestored();
    } finally {
      await supervisor.shutdown();
      fixture.repository.close();
    }
  });

  it("reports signal exits separately from normal exits", async () => {
    const fixture = createFixture();
    const supervisor = new PtySupervisor(fixture.repository, () => fixture.process);
    try {
      supervisor.start(fixture.pane.id);
      const frames: ServerWsFrame[] = [];
      const detach = await supervisor.attach(fixture.pane.id, 80, 24, (frame) =>
        frames.push(frame),
      );

      fixture.process.emitExit(143, 15);
      await waitFor(() => frames.some((frame) => frame.type === "terminal.exit"));
      expect(frames.at(-1)).toEqual({
        type: "terminal.exit",
        paneId: fixture.pane.id,
        exitCode: 143,
        signal: 15,
      });
      detach();
    } finally {
      await supervisor.shutdown();
      fixture.repository.close();
    }
  });

  it("marks the Pane as an error without retaining a runtime when spawn fails", async () => {
    const fixture = createFixture();
    const previousFailure = fixture.repository.setPaneActivity(fixture.pane.id, "failed");
    if (!previousFailure) throw new Error("previous failure event is missing");
    const activityChanges: PaneActivity[] = [];
    const supervisor = new PtySupervisor(fixture.repository, () => {
      throw new Error("fake spawn failure");
    });
    supervisor.onActivity((change) => activityChanges.push(change.activity));
    try {
      expect(() => supervisor.start(fixture.pane.id)).toThrow(
        /터미널 프로세스를 시작하지 못했습니다/,
      );
      expect(supervisor.count()).toBe(0);
      expect(fixture.repository.getPaneContext(fixture.pane.id)?.pane).toMatchObject({
        status: "error",
        exitCode: null,
        lastErrorCode: "PTY_SPAWN_FAILED",
        activity: {
          state: "failed",
          revision: previousFailure.activity.revision + 2,
        },
      });
      expect(activityChanges.map((activity) => activity.state)).toEqual(["idle", "failed"]);
      expect(new Set(activityChanges.map((activity) => activity.runtimeId)).size).toBe(1);
      expect(activityChanges[0]?.runtimeId).not.toBeNull();
    } finally {
      await supervisor.shutdown();
      fixture.repository.close();
    }
  });

  it("bounds serialized scrollback while retaining the newest output", async () => {
    const fixture = createFixture();
    const supervisor = new PtySupervisor(fixture.repository, () => fixture.process);
    try {
      supervisor.start(fixture.pane.id, 40, 10);
      const rows = Array.from(
        { length: 2_105 },
        (_, index) => `ROW_${String(index).padStart(4, "0")}`,
      );
      fixture.process.emitData(`${rows.join("\r\n")}\r\n`);
      const frames: ServerWsFrame[] = [];
      const detach = await supervisor.attach(fixture.pane.id, 40, 10, (frame) =>
        frames.push(frame),
      );

      expect(snapshotState(frames)).not.toContain("ROW_0000");
      expect(snapshotState(frames)).toContain("ROW_2104");
      detach();
    } finally {
      await supervisor.shutdown();
      fixture.repository.close();
    }
  });

  it("terminates every child during graceful shutdown", async () => {
    const repository = new NaruRepository(":memory:");
    const project = repository.createProject("/tmp/naru-pty-shutdown", "pty-shutdown");
    const workspace = repository.getWorkspace(project.id);
    const defaultTerminal = workspace.panes.find((pane) => pane.kind === "terminal");
    if (!defaultTerminal) throw new Error("default terminal is missing");
    const panes = [
      defaultTerminal,
      repository.createPane(project.id, {
        kind: "terminal",
        workspaceVersion: workspace.version,
        targetPaneId: defaultTerminal.id,
        direction: "horizontal",
      }),
    ];
    const processes = [new FakePty(), new FakePty()];
    let nextProcess = 0;
    const supervisor = new PtySupervisor(repository, () => processes[nextProcess++] as FakePty);
    try {
      for (const pane of panes) supervisor.start(pane.id);
      expect(supervisor.count()).toBe(2);
      const shutdownActivity: string[] = [];
      supervisor.onActivity((change) => shutdownActivity.push(change.activity.state));

      await supervisor.shutdown();

      expect(supervisor.count()).toBe(0);
      expect(processes.map((process) => process.killSignals)).toEqual([["SIGHUP"], ["SIGHUP"]]);
      expect(shutdownActivity).toEqual(["server-stopped", "server-stopped"]);
      for (const pane of panes) {
        expect(repository.getPaneContext(pane.id)?.pane).toMatchObject({
          status: "stopped",
          exitCode: null,
          activity: { state: "server-stopped" },
        });
      }
    } finally {
      await supervisor.shutdown();
      repository.close();
    }
  });
});

function createFixture(): {
  repository: NaruRepository;
  pane: Pane;
  process: FakePty;
  projectPath: string;
} {
  const repository = new NaruRepository(":memory:");
  const project = repository.createProject("/tmp/naru-pty-project", "pty-project");
  const pane = repository.getWorkspace(project.id).panes.find((item) => item.kind === "terminal");
  if (!pane) throw new Error("default terminal is missing");
  return { repository, pane, process: new FakePty(), projectPath: project.path };
}

function snapshotState(frames: readonly ServerWsFrame[]): string {
  const snapshot = frames.find((frame) => frame.type === "pane.snapshot");
  if (!snapshot || snapshot.type !== "pane.snapshot") throw new Error("Snapshot frame is missing.");
  return snapshot.serializedState;
}

function isOutputSequence(sequence: number): (frame: ServerWsFrame) => boolean {
  return (frame) => frame.type === "terminal.output" && frame.sequence === sequence;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for PTY state.");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
