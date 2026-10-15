import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { Actor, AgentEvent, HandoffPayload } from "@naru/contracts/naru-agent/v1";
import { AgentPlatformCore, AgentPlatformError } from "../src/agent-platform/core.js";
import { HoldMonitor } from "../src/agent-runtime/hold-monitor.js";
import { DATABASE_MIGRATIONS, NaruRepository, runDatabaseMigrations } from "../src/database.js";

const HUMAN: Actor = { kind: "human" };
const SYSTEM: Actor = { kind: "system" };

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Agent Platform core", () => {
  it("links every delegation to the original human instruction (INV-01)", () => {
    const fixture = platform();
    const { orchestrator } = fixture.team();
    const goal = fixture.core.createHumanInstruction(fixture.ctx(HUMAN), {
      scope: { kind: "project", projectId: fixture.projectId },
      verbatim: "Kiro 기존 에이전트에 Hook/MCP로 가이드를 연결해 줘.",
    });
    const delegation = fixture.core.delegate(fixture.ctx(agent(orchestrator)), {
      scope: { kind: "project", projectId: fixture.projectId },
      verbatim: "공식 확장 지점을 검증하고 통합 계획을 제안하라.",
      originUserInstructionId: goal.id,
    });
    expect(delegation).toMatchObject({
      author: { kind: "agent", agentSessionId: orchestrator },
      channel: "mcp",
      originUserInstructionId: goal.id,
    });

    // An agent's own message is never accepted as the "original" instruction.
    expectCode(
      () =>
        fixture.core.delegate(fixture.ctx(agent(orchestrator)), {
          scope: { kind: "project", projectId: fixture.projectId },
          verbatim: "재해석한 지시",
          originUserInstructionId: delegation.id,
        }),
      "AGENT_INVALID_REFERENCE",
    );
    // Agents cannot author human instructions.
    expectCode(
      () =>
        fixture.core.createHumanInstruction(fixture.ctx(agent(orchestrator)), {
          scope: { kind: "global" },
          verbatim: "spoofed",
        }),
      "AGENT_ROLE_DENIED",
    );
  });

  it("keeps the latest human instruction in force and forgets text on request", () => {
    const fixture = platform();
    const { worker } = fixture.team();
    const global = fixture.core.createHumanInstruction(fixture.ctx(HUMAN), {
      scope: { kind: "global" },
      verbatim: "비공식 API는 승인 없이 쓰지 않는다.",
    });
    const first = fixture.core.createHumanInstruction(fixture.ctx(HUMAN), {
      scope: { kind: "project", projectId: fixture.projectId },
      verbatim: "로그인은 OAuth로.",
    });
    const second = fixture.core.createHumanInstruction(fixture.ctx(HUMAN), {
      scope: { kind: "project", projectId: fixture.projectId },
      verbatim: "로그인은 OAuth 말고 passkey로.",
      supersedesId: first.id,
    });
    const otherProject = fixture.repository.createProject("/tmp/naru-other-project", "other");
    fixture.core.createHumanInstruction(fixture.ctx(HUMAN), {
      scope: { kind: "project", projectId: otherProject.id },
      verbatim: "다른 프로젝트 지시",
    });
    const tui = fixture.core.recordTuiPrompt(fixture.ctx(SYSTEM), {
      agentSessionId: worker,
      verbatim: "테스트는 먼저 실패하게 써.",
    });
    expect(tui).toMatchObject({ author: { kind: "human" }, channel: "tui" });

    const applicable = fixture.core.getApplicableInstructions(agent(worker), {
      projectId: fixture.projectId,
      agentSessionId: worker,
    });
    expect(applicable.map((instruction) => instruction.id)).toEqual([global.id, second.id, tui.id]);
    expectCode(
      () => fixture.core.getApplicableInstructions(agent(worker), { projectId: otherProject.id }),
      "AGENT_SCOPE_DENIED",
    );

    const forgotten = fixture.core.forgetInstruction(fixture.ctx(HUMAN), {
      instructionId: second.id,
    });
    expect(forgotten).toMatchObject({ verbatim: null });
    expect(forgotten.forgottenAt).not.toBeNull();
  });

  it("enforces role and project scope for agent actors", () => {
    const fixture = platform();
    const { main, worker, orchestrator } = fixture.team();
    const goal = fixture.goal();
    expectCode(
      () =>
        fixture.core.createTask(fixture.ctx(agent(worker)), {
          projectId: fixture.projectId,
          title: "worker task",
          purpose: "",
          completionCriteria: [],
          originInstructionId: goal,
        }),
      "AGENT_ROLE_DENIED",
    );
    expectCode(
      () =>
        fixture.core.createPlan(fixture.ctx(agent(main)), {
          projectId: fixture.projectId,
          summary: "global plan",
          activate: true,
        }),
      "AGENT_ROLE_DENIED",
    );
    const other = fixture.repository.createProject("/tmp/naru-scope-project", "scope");
    expectCode(
      () =>
        fixture.core.createPlan(fixture.ctx(agent(orchestrator)), {
          projectId: other.id,
          summary: "cross-project",
          activate: true,
        }),
      "AGENT_SCOPE_DENIED",
    );
    expectCode(
      () =>
        fixture.core.registerAgentSession(fixture.ctx(agent(orchestrator)), {
          projectId: fixture.projectId,
          role: "project-orchestrator",
          runtime: "codex",
          native: false,
          observation: "pty",
          conversationWriter: "orchestrator",
        }),
      "AGENT_ROLE_DENIED",
    );
  });

  it("rejects orchestrator messages to a human-held agent and announces the release (AP-D005)", () => {
    const fixture = platform();
    const { orchestrator, worker } = fixture.team();
    const goal = fixture.goal();
    const events: AgentEvent[] = [];
    fixture.core.subscribe((event) => events.push(event));

    fixture.core.setHumanHold(fixture.ctx(HUMAN), {
      agentSessionId: worker,
      held: true,
      reason: "takeover",
    });
    expectCode(
      () =>
        fixture.core.delegate(fixture.ctx(agent(orchestrator)), {
          scope: { kind: "agent", projectId: fixture.projectId, agentSessionId: worker },
          verbatim: "이어서 진행해.",
          originUserInstructionId: goal,
        }),
      "AGENT_HELD_BY_HUMAN",
    );
    expectCode(
      () =>
        fixture.core.createTask(fixture.ctx(agent(orchestrator)), {
          projectId: fixture.projectId,
          title: "new work",
          purpose: "",
          completionCriteria: [],
          assigneeAgentSessionId: worker,
          originInstructionId: goal,
        }),
      "AGENT_HELD_BY_HUMAN",
    );
    // The human still talks to the held agent; that becomes a verbatim human instruction.
    fixture.core.createHumanInstruction(fixture.ctx(HUMAN), {
      scope: { kind: "agent", projectId: fixture.projectId, agentSessionId: worker },
      verbatim: "이 부분은 내가 직접 고칠게.",
    });
    expectCode(
      () =>
        fixture.core.setHumanHold(fixture.ctx(agent(orchestrator)), {
          agentSessionId: worker,
          held: false,
          reason: "release",
        }),
      "AGENT_ROLE_DENIED",
    );

    fixture.core.setHumanHold(fixture.ctx(SYSTEM), {
      agentSessionId: worker,
      held: false,
      reason: "disconnect-timeout",
    });
    expect(events.map((event) => event.type)).toEqual([
      "agent_session.hold_started",
      "instruction.created",
      "agent_session.hold_released",
    ]);
    expect(events.at(-1)).toMatchObject({
      subjectId: worker,
      data: { reason: "disconnect-timeout" },
    });
    expect(
      fixture.core.delegate(fixture.ctx(agent(orchestrator)), {
        scope: { kind: "agent", projectId: fixture.projectId, agentSessionId: worker },
        verbatim: "최신 지시를 읽고 이어서 진행해.",
        originUserInstructionId: goal,
      }).originUserInstructionId,
    ).toBe(goal);
  });

  it("replays duplicate commands without new effects and rejects key reuse (INV-07)", () => {
    const fixture = platform();
    const goal = fixture.goal();
    const key = fixture.key();
    const input = {
      projectId: fixture.projectId,
      title: "migrate store",
      purpose: "v20 tables",
      completionCriteria: ["migration test passes"],
      originInstructionId: goal,
    };
    const first = fixture.core.createTask({ actor: HUMAN, idempotencyKey: key }, input);
    const replay = fixture.core.createTask({ actor: HUMAN, idempotencyKey: key }, input);
    expect(replay.id).toBe(first.id);
    expect(fixture.core.listTasks(HUMAN, fixture.projectId)).toHaveLength(1);
    expect(
      fixture.core
        .readEvents(HUMAN, { afterSeq: 0 })
        .filter((event) => event.type === "task.created"),
    ).toHaveLength(1);
    expectCode(
      () =>
        fixture.core.createTask(
          { actor: HUMAN, idempotencyKey: key },
          { ...input, title: "different" },
        ),
      "AGENT_IDEMPOTENCY_CONFLICT",
    );
  });

  it("fences stale task revisions, dependency cycles and worker status changes", () => {
    const fixture = platform();
    const { orchestrator, worker, reviewer } = fixture.team();
    const goal = fixture.goal();
    const create = (title: string, dependsOn: string[] = []) =>
      fixture.core.createTask(fixture.ctx(agent(orchestrator)), {
        projectId: fixture.projectId,
        title,
        purpose: "",
        completionCriteria: [],
        originInstructionId: goal,
        assigneeAgentSessionId: worker,
        dependsOn,
      });
    const a = create("a");
    const b = create("b", [a.id]);
    expect(a.status).toBe("ready");
    expect(b.status).toBe("pending");

    expectCode(
      () =>
        fixture.core.updateTask(fixture.ctx(agent(orchestrator)), {
          taskId: a.id,
          expectedRevision: a.revision,
          dependsOn: [b.id],
        }),
      "AGENT_DEPENDENCY_CYCLE",
    );
    const running = fixture.core.updateTask(fixture.ctx(agent(worker)), {
      taskId: a.id,
      expectedRevision: a.revision,
      status: "running",
    });
    expect(running.revision).toBe(2);
    expectCode(
      () =>
        fixture.core.updateTask(fixture.ctx(agent(orchestrator)), {
          taskId: a.id,
          expectedRevision: a.revision,
          priority: 900,
        }),
      "AGENT_REVISION_STALE",
    );
    expectCode(
      () =>
        fixture.core.updateTask(fixture.ctx(agent(worker)), {
          taskId: a.id,
          expectedRevision: running.revision,
          status: "done",
        }),
      "AGENT_ROLE_DENIED",
    );
    expectCode(
      () =>
        fixture.core.updateTask(fixture.ctx(agent(reviewer)), {
          taskId: a.id,
          expectedRevision: running.revision,
          status: "review",
        }),
      "AGENT_ROLE_DENIED",
    );
  });

  it("keeps the merge gate closed when the reviewer finds an intent violation (A11)", () => {
    const fixture = platform();
    const { orchestrator, worker, reviewer } = fixture.team();
    const task = fixture.core.createTask(fixture.ctx(agent(orchestrator)), {
      projectId: fixture.projectId,
      title: "Kiro guide integration",
      purpose: "",
      completionCriteria: ["tests pass"],
      originInstructionId: fixture.goal(),
      assigneeAgentSessionId: worker,
    });
    const run = fixture.core.startRun(fixture.ctx(agent(orchestrator)), {
      taskId: task.id,
      agentSessionId: worker,
      runtime: "claude",
    });
    fixture.core.publishArtifact(fixture.ctx(agent(worker)), {
      taskId: task.id,
      runId: run.id,
      kind: "test-result",
      reference: "pnpm test",
      exitCode: 0,
    });
    fixture.core.finishRun(fixture.ctx(agent(worker)), { runId: run.id, status: "succeeded" });
    expect(fixture.core.mergeGate(HUMAN, task.id)).toEqual({
      open: false,
      reasons: ["missing-correctness-review", "missing-intent-review"],
    });

    fixture.core.submitReview(fixture.ctx(agent(reviewer)), {
      taskId: task.id,
      runId: run.id,
      kind: "correctness",
      verdict: "pass",
      findings: "tests cover the change",
    });
    fixture.core.submitReview(fixture.ctx(agent(reviewer)), {
      taskId: task.id,
      runId: run.id,
      kind: "intent",
      verdict: "fail",
      findings: "re-implements a separate agent UI instead of Hook/MCP",
    });
    expect(fixture.core.mergeGate(HUMAN, task.id)).toEqual({
      open: false,
      reasons: ["intent-review-fail"],
    });

    const handoff = fixture.core.requestHandoff(fixture.ctx(agent(worker)), {
      projectId: fixture.projectId,
      kind: "design-deviation",
      payload: handoffPayload([task.id]),
    });
    fixture.core.submitReview(fixture.ctx(agent(reviewer)), {
      taskId: task.id,
      kind: "intent",
      verdict: "pass",
      findings: "uses the official extension point",
    });
    expect(fixture.core.mergeGate(HUMAN, task.id)).toEqual({
      open: false,
      reasons: ["open-handoff-design-deviation"],
    });
    expectCode(
      () =>
        fixture.core.resolveHandoff(fixture.ctx(agent(worker)), {
          handoffId: handoff.id,
          decision: "self-approved",
        }),
      "AGENT_ROLE_DENIED",
    );
    fixture.core.resolveHandoff(fixture.ctx(HUMAN), {
      handoffId: handoff.id,
      decision: "공식 Hook/MCP 방식으로 진행",
      chosenOption: "Hook/MCP",
    });
    expectCode(
      () =>
        fixture.core.resolveHandoff(fixture.ctx(HUMAN), {
          handoffId: handoff.id,
          decision: "again",
        }),
      "AGENT_INVALID_STATE",
    );
    expect(fixture.core.mergeGate(HUMAN, task.id)).toEqual({ open: true, reasons: [] });
  });

  it("marks interrupted runs unknown instead of inventing an outcome", () => {
    const fixture = platform();
    const { orchestrator, worker } = fixture.team();
    const task = fixture.core.createTask(fixture.ctx(agent(orchestrator)), {
      projectId: fixture.projectId,
      title: "long run",
      purpose: "",
      completionCriteria: [],
      originInstructionId: fixture.goal(),
      assigneeAgentSessionId: worker,
    });
    const live = fixture.core.startRun(fixture.ctx(agent(orchestrator)), {
      taskId: task.id,
      agentSessionId: worker,
      runtime: "codex",
    });
    const done = fixture.core.startRun(fixture.ctx(agent(orchestrator)), {
      taskId: task.id,
      agentSessionId: worker,
      runtime: "codex",
    });
    fixture.core.finishRun(fixture.ctx(agent(worker)), { runId: done.id, status: "failed" });

    const changed = fixture.core.markInterruptedRunsUnknown(fixture.ctx(SYSTEM));
    expect(changed.map((run) => [run.id, run.status])).toEqual([[live.id, "unknown"]]);
    expectCode(
      () => fixture.core.markInterruptedRunsUnknown(fixture.ctx(agent(orchestrator))),
      "AGENT_ROLE_DENIED",
    );
  });

  it("orders events globally, filters by project and moves cursors forward only", () => {
    const fixture = platform();
    const other = fixture.repository.createProject("/tmp/naru-events-project", "events");
    fixture.core.createHumanInstruction(fixture.ctx(HUMAN), {
      scope: { kind: "global" },
      verbatim: "global",
    });
    fixture.core.createHumanInstruction(fixture.ctx(HUMAN), {
      scope: { kind: "project", projectId: other.id },
      verbatim: "other",
    });
    fixture.core.createHumanInstruction(fixture.ctx(HUMAN), {
      scope: { kind: "project", projectId: fixture.projectId },
      verbatim: "mine",
    });
    const all = fixture.core.readEvents(HUMAN, { afterSeq: 0 });
    expect(all.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(JSON.stringify(all)).not.toContain("mine");
    expect(
      fixture.core
        .readEvents(HUMAN, { afterSeq: 0, projectId: fixture.projectId })
        .map((event) => event.seq),
    ).toEqual([1, 3]);

    fixture.core.advanceCursor("orchestrator", 3);
    fixture.core.advanceCursor("orchestrator", 1);
    expect(fixture.core.getCursor("orchestrator")).toBe(3);

    // A failed command appends nothing.
    expectCode(
      () =>
        fixture.core.createHumanInstruction(fixture.ctx(HUMAN), {
          scope: { kind: "project", projectId: "00000000-0000-4000-8000-000000000000" },
          verbatim: "missing project",
        }),
      "AGENT_NOT_FOUND",
    );
    expect(fixture.core.readEvents(HUMAN, { afterSeq: 3 })).toEqual([]);
  });

  it("removes a project's agent data with the project", () => {
    const fixture = platform();
    fixture.team();
    fixture.goal();
    expect(fixture.repository.deleteProject(fixture.projectId)).toBe(true);
    // Global events (the main orchestrator) remain; nothing scoped to the project does.
    const remaining = fixture.core.readEvents(HUMAN, { afterSeq: 0 });
    expect(remaining.filter((event) => event.projectId === fixture.projectId)).toEqual([]);
    expect(remaining.map((event) => event.projectId)).toEqual([null]);
  });

  it("upgrades a populated v19 database additively after a pre-migration backup (V14)", () => {
    const directory = mkdtempSync(join(tmpdir(), "naru-agent-v20-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "naru.sqlite");
    const legacy = new Database(filename);
    legacy.pragma("foreign_keys = ON");
    runDatabaseMigrations(
      legacy,
      DATABASE_MIGRATIONS.filter((migration) => migration.version <= 19),
    );
    const projectId = "11111111-1111-4111-8111-111111111111";
    const now = new Date().toISOString();
    legacy
      .prepare(
        `INSERT INTO project_groups (id, name, kind, git_common_dir, git_relative_path, created_at,
           updated_at) VALUES (?, ?, 'standalone', NULL, NULL, ?, ?)`,
      )
      .run("22222222-2222-4222-8222-222222222222", "v19", now, now);
    legacy
      .prepare(
        `INSERT INTO projects (id, name, real_path, group_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        "v19",
        "/tmp/naru-v19-project",
        "22222222-2222-4222-8222-222222222222",
        now,
        now,
      );
    legacy.close();

    const upgraded = new NaruRepository(filename);
    try {
      expect(upgraded.isReady()).toBe(true);
      expect(upgraded.listProjects().map((item) => item.id)).toEqual([projectId]);
      expect(existsSync(join(directory, "backups"))).toBe(true);
      expect(readdirSync(join(directory, "backups")).join(" ")).toContain("v19");
    } finally {
      upgraded.close();
    }
  });
});

describe("shared processes, holds and spawned agents (AP-D005, AP-D006)", () => {
  it("records a process before it runs and lets only its agent write while nobody holds it", () => {
    const fixture = platform();
    const { orchestrator, worker, reviewer } = fixture.team();
    const events: AgentEvent[] = [];
    fixture.core.subscribe((event) => events.push(event));
    const started = fixture.core.startSharedProcess(fixture.ctx(agent(worker)), {
      projectId: fixture.projectId,
      purpose: "dev server",
      command: "pnpm dev --port 5173",
      ports: [5173],
      keep: "keep",
    });
    expect(started).toMatchObject({
      status: "starting",
      agentSessionId: worker,
      paneId: null,
      command: "pnpm dev --port 5173",
    });
    expect(events.at(-1)).toMatchObject({
      type: "shared_process.started",
      subjectId: started.id,
      data: { ports: "5173", keep: "keep" },
    });
    expect(JSON.stringify(events)).not.toContain("pnpm dev");
    expectCode(
      () =>
        fixture.core.startSharedProcess(fixture.ctx(agent(worker)), {
          projectId: fixture.projectId,
          purpose: "tied to nothing",
          command: "sleep 1",
          ports: [],
          keep: "run",
        }),
      "AGENT_INVALID_REFERENCE",
    );
    expectCode(
      () =>
        fixture.core.startSharedProcess(fixture.ctx(agent(reviewer)), {
          projectId: fixture.projectId,
          purpose: "not mine",
          command: "true",
          ports: [],
          keep: "keep",
        }),
      "AGENT_ROLE_DENIED",
    );

    fixture.core.updateSharedProcessState(SYSTEM, { processId: started.id, status: "running" });
    const retryKey = fixture.key();
    const write = (actor: Actor, idempotencyKey = fixture.key()) =>
      fixture.core.recordSharedProcessInput(
        { actor, idempotencyKey },
        { processId: started.id, text: "rs\r" },
      );
    expect(write(agent(worker), retryKey).replayed).toBe(false);
    expect(write(agent(worker), retryKey).replayed).toBe(true);
    expect(fixture.repository.agentPlatform.listSharedProcessInputs(started.id)).toEqual([
      { verbatim: "rs\r", agentSessionId: worker },
    ]);
    expectCode(() => write(agent(orchestrator)), "AGENT_SCOPE_DENIED");

    // A person takes over: the agent's input is refused, not queued, until the hold returns.
    fixture.core.setSharedProcessHold(fixture.ctx(HUMAN), {
      processId: started.id,
      held: true,
      reason: "takeover",
    });
    expectCode(() => write(agent(worker)), "AGENT_HELD_BY_HUMAN");
    expectCode(
      () =>
        fixture.core.setSharedProcessHold(fixture.ctx(agent(worker)), {
          processId: started.id,
          held: false,
          reason: "release",
        }),
      "AGENT_ROLE_DENIED",
    );
    fixture.core.setSharedProcessHold(fixture.ctx(SYSTEM), {
      processId: started.id,
      held: false,
      reason: "idle-timeout",
    });
    expect(events.at(-1)).toMatchObject({
      type: "shared_process.hold_released",
      data: { reason: "idle-timeout", agentSessionId: worker },
    });
    expect(write(agent(worker)).replayed).toBe(false);

    expect(fixture.core.authorizeSharedProcessStop(agent(orchestrator), started.id).id).toBe(
      started.id,
    );
    expectCode(
      () => fixture.core.authorizeSharedProcessStop(agent(reviewer), started.id),
      "AGENT_ROLE_DENIED",
    );
    fixture.core.updateSharedProcessState(SYSTEM, {
      processId: started.id,
      status: "exited",
      exitCode: 0,
    });
    expectCode(() => write(agent(worker)), "AGENT_INVALID_STATE");
  });

  it("lets orchestrators spawn agents below their own role and records the parent", () => {
    const fixture = platform();
    const { main, orchestrator, worker } = fixture.team();
    const spawned = fixture.core.spawnAgentSession(fixture.ctx(agent(orchestrator)), {
      projectId: fixture.projectId,
      role: "worker",
    });
    expect(spawned).toMatchObject({
      role: "worker",
      runtime: "claude",
      projectId: fixture.projectId,
      parentAgentSessionId: orchestrator,
    });
    expectCode(
      () =>
        fixture.core.spawnAgentSession(fixture.ctx(agent(worker)), {
          projectId: fixture.projectId,
          role: "specialist",
        }),
      "AGENT_ROLE_DENIED",
    );
    expectCode(
      () =>
        fixture.core.spawnAgentSession(fixture.ctx(agent(orchestrator)), {
          projectId: fixture.projectId,
          role: "project-orchestrator",
        }),
      "AGENT_ROLE_DENIED",
    );
    const fromMain = fixture.core.spawnAgentSession(fixture.ctx(agent(main)), {
      projectId: fixture.projectId,
      role: "project-orchestrator",
    });
    expect(fromMain.parentAgentSessionId).toBe(main);
  });

  it("returns holds after idle time or a disconnect grace, not while the person is active", async () => {
    const fixture = platform();
    const { worker } = fixture.team();
    const process = fixture.core.startSharedProcess(fixture.ctx(agent(worker)), {
      projectId: fixture.projectId,
      purpose: "ansible",
      command: "ansible-playbook site.yml",
      ports: [],
      keep: "keep",
    });
    fixture.core.setHumanHold(fixture.ctx(HUMAN), {
      agentSessionId: worker,
      held: true,
      reason: "takeover",
    });
    fixture.core.setSharedProcessHold(fixture.ctx(HUMAN), {
      processId: process.id,
      held: true,
      reason: "takeover",
    });
    const start = Date.now();
    let now = start;
    let connected = true;
    const released: string[] = [];
    const monitor = new HoldMonitor({
      store: fixture.repository.agentPlatform,
      humanConnected: () => connected,
      idleMs: 60_000,
      disconnectMs: 10_000,
      now: () => now,
      release: {
        agent: (agentSessionId, reason) => {
          released.push(`agent:${reason}`);
          fixture.core.setHumanHold(fixture.ctx(SYSTEM), { agentSessionId, held: false, reason });
          return Promise.resolve();
        },
        process: (processId, reason) => {
          released.push(`process:${reason}`);
          fixture.core.setSharedProcessHold(fixture.ctx(SYSTEM), { processId, held: false, reason });
          return Promise.resolve();
        },
      },
    });
    now = start + 50_000;
    monitor.noteHumanInput({ agentSessionId: worker });
    await monitor.tick();
    expect(released).toEqual([]);
    now = start + 70_000;
    await monitor.tick();
    expect(released).toEqual(["process:idle-timeout"]);
    connected = false;
    now = start + 80_000;
    await monitor.tick();
    expect(released).toEqual(["process:idle-timeout"]);
    now = start + 95_000;
    await monitor.tick();
    expect(released).toEqual(["process:idle-timeout", "agent:disconnect-timeout"]);
    expect(fixture.repository.agentPlatform.listHumanHolds()).toEqual([]);
  });
});

function platform() {
  const repository = new NaruRepository(":memory:");
  const project = repository.createProject("/tmp/naru-agent-project", "agent-project");
  const core = new AgentPlatformCore(repository.agentPlatform);
  let ordinal = 0;
  const key = () => `50000000-0000-4000-8000-${String(++ordinal).padStart(12, "0")}`;
  const ctx = (actor: Actor) => ({ actor, idempotencyKey: key() });
  const team = () => {
    const register = (
      role: "main-orchestrator" | "project-orchestrator" | "worker" | "reviewer",
      projectId: string | null,
    ) =>
      core.registerAgentSession(ctx(HUMAN), {
        projectId,
        role,
        runtime: role === "reviewer" ? "codex" : "claude",
        native: false,
        observation: "pty",
        conversationWriter: "orchestrator",
      }).id;
    return {
      main: register("main-orchestrator", null),
      orchestrator: register("project-orchestrator", project.id),
      worker: register("worker", project.id),
      reviewer: register("reviewer", project.id),
    };
  };
  const goal = () =>
    core.createHumanInstruction(ctx(HUMAN), {
      scope: { kind: "project", projectId: project.id },
      verbatim: "프로젝트 목표",
    }).id;
  return { repository, core, projectId: project.id, key, ctx, team, goal };
}

function agent(agentSessionId: string): Actor {
  return { kind: "agent", agentSessionId };
}

function handoffPayload(blockingTaskIds: string[]): HandoffPayload {
  return {
    reason: "Hook/MCP 대신 별도 UI가 필요해 보임",
    blockingTaskIds,
    independentWorkToContinue: ["문서 정리"],
    options: [
      { label: "Hook/MCP", description: "공식 확장 지점 유지" },
      { label: "별도 UI", description: "비공식 API 필요" },
    ],
    recommendation: "Hook/MCP",
    risks: ["별도 UI는 비공식 API 의존"],
    preparedEnvironment: [],
    resumeCondition: "사용자 선택",
  };
}

function expectCode(action: () => unknown, code: AgentPlatformError["code"]): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentPlatformError);
    expect((error as AgentPlatformError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}
