import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionView } from "@naru/contracts/durable-session/v0";
import {
  createIntegrationBootstrap,
  deriveIntegrationBootstrapKey,
} from "@naru/durable-session-integration";
import { describe, expect, it } from "vitest";
import { NaruRepository } from "../src/database.js";
import { CodexInteractionState } from "../src/codex-interaction-state.js";
import type { CodexInteractionSnapshot } from "../src/integrations/codex/events.js";
import type { DurableHostConfig } from "../src/durable-session-host-client.js";
import type { PaneLaunchResolver } from "../src/launch-profiles.js";
import {
  NaruCodexIntegration,
  NARU_CODEX_INTEGRATION_POLICY_REF,
} from "../src/integrations/codex/port.js";

const CREDENTIAL = "naru-codex-fixture-credential-0123456789abcdef";
const CODEX_SESSION_ID = "11111111-1111-4111-8111-111111111111";

describe("Naru-owned Codex integration port", () => {
  it("projects a signed generic runtime into redacted Codex session and activity events", () => {
    const fixture = integrationFixture();
    const bindingId = randomUUID();
    const pending = fixture.repository.preparePaneSessionOperation(
      fixture.paneId,
      "create",
      null,
      bindingId,
    );
    const session = sessionView();
    const bootstrap = fixture.bootstrap(bindingId, session);
    const events: Array<{ eventKind: string }> = [];
    fixture.integration.onEvent((event) => events.push(event));

    expect(fixture.integration.launch(bootstrap)).toEqual({
      executable: "/fixture/codex",
      args: ["--fixture-profile", "codex-main"],
    });
    fixture.repository.completePaneSessionOperation(
      fixture.paneId,
      "create",
      pending.operationKey as string,
      session,
    );
    fixture.integration.bindRuntime(fixture.paneId, session);
    fixture.integration.bindRuntime(fixture.paneId, session);

    expect(
      fixture.integration.acceptHook(bootstrap, {
        type: "session-start",
        sessionId: CODEX_SESSION_ID,
        cwd: "/safe/project",
        source: "startup",
      }),
    ).toBe(true);
    expect(
      fixture.integration.acceptHook(bootstrap, {
        type: "turn-start",
        sessionId: CODEX_SESSION_ID,
        cwd: "/safe/project",
        turnId: "turn-1",
      }),
    ).toBe(true);
    expect(fixture.repository.getPaneContext(fixture.paneId)?.pane).toMatchObject({
      codexSessionId: CODEX_SESSION_ID,
      codexSessionResumable: true,
      activity: { state: "running", runtimeId: session.runtimeId },
    });
    expect(
      fixture.integration.acceptHook(bootstrap, {
        type: "interaction-required",
        sessionId: CODEX_SESSION_ID,
        cwd: "/safe/project",
        turnId: "turn-1",
      }),
    ).toBe(true);
    expect(fixture.repository.getPaneContext(fixture.paneId)?.pane.activity.state).toBe(
      "interaction-required",
    );
    expect(
      fixture.integration.acceptHook(bootstrap, {
        type: "turn-completed",
        sessionId: CODEX_SESSION_ID,
        cwd: "/safe/project",
        turnId: "turn-1",
      }),
    ).toBe(true);
    expect(fixture.repository.getPaneContext(fixture.paneId)?.pane.activity.state).toBe(
      "completed",
    );
    fixture.repository.syncPaneSession(fixture.paneId, session);
    expect(fixture.repository.getPaneContext(fixture.paneId)?.pane.activity).toMatchObject({
      state: "completed",
      runtimeId: session.runtimeId,
    });
    expect(events.map((event) => event.eventKind)).toEqual([
      "launch.requested",
      "runtime.bound",
      "session.identified",
      "activity.changed",
      "activity.changed",
      "activity.changed",
    ]);
    fixture.repository.close();
  });

  it("allows the Host response to win the launch race and consumes the binding once", () => {
    const fixture = integrationFixture();
    const bindingId = randomUUID();
    const pending = fixture.repository.preparePaneSessionOperation(
      fixture.paneId,
      "create",
      null,
      bindingId,
    );
    const session = sessionView();
    const bootstrap = fixture.bootstrap(bindingId, session);

    fixture.repository.completePaneSessionOperation(
      fixture.paneId,
      "create",
      pending.operationKey as string,
      session,
    );
    fixture.integration.bindRuntime(fixture.paneId, session);
    expect(fixture.integration.launch(bootstrap)).toEqual({
      executable: "/fixture/codex",
      args: ["--fixture-profile", "codex-main"],
    });
    expect(fixture.repository.getPaneSessionLink(fixture.paneId)).toMatchObject({
      integrationLaunchRuntimeId: session.runtimeId,
    });

    const restarted = new NaruCodexIntegration(
      fixture.repository,
      fixture.config,
      fixture.launchProfiles,
    );
    restarted.bindRuntime(fixture.paneId, session);
    expect(() => restarted.launch(bootstrap)).toThrow(/consumed/);
    const differentRuntimeBootstrap = fixture.bootstrap(bindingId, {
      ...session,
      runtimeId: randomUUID(),
      sessionRevision: session.sessionRevision + 1,
      updatedAtMs: session.updatedAtMs + 1,
    });
    expect(() => restarted.launch(differentRuntimeBootstrap)).toThrow(/consumed/);
    fixture.repository.close();
  });

  it("invalidates session identity on /new and rejects the previous signed runtime generation", () => {
    const fixture = integrationFixture();
    const events: Array<{ eventKind: string }> = [];
    fixture.integration.onEvent((event) => events.push(event));
    const bindingId = randomUUID();
    const create = fixture.repository.preparePaneSessionOperation(
      fixture.paneId,
      "create",
      null,
      bindingId,
    );
    const first = sessionView();
    const firstBootstrap = fixture.bootstrap(bindingId, first);
    fixture.integration.launch(firstBootstrap);
    fixture.repository.completePaneSessionOperation(
      fixture.paneId,
      "create",
      create.operationKey as string,
      first,
    );
    fixture.integration.bindRuntime(fixture.paneId, first);
    fixture.integration.acceptHook(firstBootstrap, {
      type: "session-start",
      sessionId: CODEX_SESSION_ID,
      cwd: "/safe/project",
      source: "startup",
    });
    fixture.integration.observeInput(fixture.paneId, first.runtimeId as string, "/new\r");
    expect(fixture.repository.getPaneContext(fixture.paneId)?.pane).toMatchObject({
      codexSessionId: null,
      codexSessionResumable: false,
    });
    expect(events.at(-1)?.eventKind).toBe("session.cleared");

    fixture.integration.disposeRuntime(fixture.paneId, first.runtimeId as string);
    fixture.repository.deletePaneSessionLink(fixture.paneId);
    const secondBindingId = randomUUID();
    const restart = fixture.repository.preparePaneSessionOperation(
      fixture.paneId,
      "create",
      null,
      secondBindingId,
    );
    const second = sessionView();
    const secondBootstrap = fixture.bootstrap(secondBindingId, second);
    fixture.integration.launch(secondBootstrap);
    fixture.repository.completePaneSessionOperation(
      fixture.paneId,
      "create",
      restart.operationKey as string,
      second,
    );
    fixture.integration.bindRuntime(fixture.paneId, second);

    expect(
      fixture.integration.acceptHook(firstBootstrap, {
        type: "turn-start",
        sessionId: CODEX_SESSION_ID,
        cwd: "/safe/project",
        turnId: "stale-turn",
      }),
    ).toBe(false);
    expect(fixture.repository.getPaneContext(fixture.paneId)?.pane.activity).toMatchObject({
      state: "idle",
      runtimeId: second.runtimeId,
    });
    fixture.repository.close();
  });

  it("attributes only an exact active-turn interrupt and keeps a recent canceled exit", () => {
    const fixture = integrationFixture();
    const bindingId = randomUUID();
    const create = fixture.repository.preparePaneSessionOperation(
      fixture.paneId,
      "create",
      null,
      bindingId,
    );
    const session = sessionView();
    const bootstrap = fixture.bootstrap(bindingId, session);
    fixture.integration.launch(bootstrap);
    fixture.repository.completePaneSessionOperation(
      fixture.paneId,
      "create",
      create.operationKey as string,
      session,
    );
    fixture.integration.bindRuntime(fixture.paneId, session);
    fixture.integration.acceptHook(bootstrap, {
      type: "session-start",
      sessionId: CODEX_SESSION_ID,
      cwd: "/safe/project",
      source: "startup",
    });
    fixture.integration.acceptHook(bootstrap, {
      type: "turn-start",
      sessionId: CODEX_SESSION_ID,
      cwd: "/safe/project",
      turnId: "turn-cancel",
    });

    fixture.integration.observeInput(fixture.paneId, session.runtimeId as string, "x");
    expect(fixture.repository.getPaneContext(fixture.paneId)?.pane.activity.state).toBe("running");
    fixture.integration.observeInput(fixture.paneId, session.runtimeId as string, "\u001b");
    fixture.integration.observeExit(fixture.paneId, session.runtimeId as string, 130);
    expect(fixture.repository.getPaneContext(fixture.paneId)?.pane.activity.state).toBe("canceled");
    fixture.repository.close();
  });

  it("rejects launch replay and hook delivery after the bound runtime has exited", () => {
    const fixture = integrationFixture();
    const bindingId = randomUUID();
    const create = fixture.repository.preparePaneSessionOperation(
      fixture.paneId,
      "create",
      null,
      bindingId,
    );
    const session = sessionView();
    const bootstrap = fixture.bootstrap(bindingId, session);
    fixture.integration.launch(bootstrap);
    fixture.repository.completePaneSessionOperation(
      fixture.paneId,
      "create",
      create.operationKey as string,
      session,
    );
    fixture.integration.bindRuntime(fixture.paneId, session);

    expect(() => fixture.integration.launch(bootstrap)).toThrow(/stale/);
    fixture.integration.observeExit(fixture.paneId, session.runtimeId as string, 0);
    fixture.repository.setPaneStatus(fixture.paneId, "exited", 0, null, new Date().toISOString());
    fixture.integration.disposeRuntime(fixture.paneId, session.runtimeId as string);
    expect(
      fixture.integration.acceptHook(bootstrap, {
        type: "session-start",
        sessionId: CODEX_SESSION_ID,
        cwd: "/safe/project",
        source: "startup",
      }),
    ).toBe(false);
    fixture.repository.close();
  });

  it("reconstructs the active turn from a current hook after Naru loses memory", () => {
    const fixture = integrationFixture();
    const bindingId = randomUUID();
    const create = fixture.repository.preparePaneSessionOperation(
      fixture.paneId,
      "create",
      null,
      bindingId,
    );
    const session = sessionView();
    const bootstrap = fixture.bootstrap(bindingId, session);
    fixture.integration.launch(bootstrap);
    fixture.repository.completePaneSessionOperation(
      fixture.paneId,
      "create",
      create.operationKey as string,
      session,
    );
    fixture.integration.bindRuntime(fixture.paneId, session);
    fixture.integration.acceptHook(bootstrap, {
      type: "session-start",
      sessionId: CODEX_SESSION_ID,
      cwd: "/safe/project",
      source: "startup",
    });
    fixture.integration.acceptHook(bootstrap, {
      type: "turn-start",
      sessionId: CODEX_SESSION_ID,
      cwd: "/safe/project",
      turnId: "turn-across-naru-restart",
    });
    expect(fixture.repository.getPaneContext(fixture.paneId)?.pane.activity.state).toBe("running");

    fixture.integration.disposeRuntime(fixture.paneId, session.runtimeId as string);
    fixture.integration.bindRuntime(fixture.paneId, session);
    expect(
      fixture.integration.acceptHook(bootstrap, {
        type: "turn-completed",
        sessionId: CODEX_SESSION_ID,
        cwd: "/safe/project",
        turnId: "turn-across-naru-restart",
      }),
    ).toBe(true);
    expect(fixture.repository.getPaneContext(fixture.paneId)?.pane.activity.state).toBe(
      "completed",
    );
    fixture.repository.close();
  });

  it("keeps each actual pending request until its own resolution, even after turn completion", () => {
    const fixture = integrationFixture();
    const bindingId = randomUUID();
    const create = fixture.repository.preparePaneSessionOperation(
      fixture.paneId,
      "create",
      null,
      bindingId,
    );
    const session = sessionView();
    const bootstrap = fixture.bootstrap(bindingId, session);
    fixture.integration.launch(bootstrap);
    fixture.repository.completePaneSessionOperation(
      fixture.paneId,
      "create",
      create.operationKey as string,
      session,
    );
    fixture.integration.bindRuntime(fixture.paneId, session);
    fixture.repository.setCodexSessionForRuntime(
      fixture.paneId,
      session.runtimeId as string,
      CODEX_SESSION_ID,
      false,
    );

    const streamId = randomUUID();
    const base: CodexInteractionSnapshot = {
      streamId,
      sequence: 1,
      cwd: "/safe/project",
      sessionId: CODEX_SESSION_ID,
      identity: "bound",
      turnId: "turn-1",
      phase: "running",
      pending: [],
    };
    expect(fixture.integration.acceptInteraction(bootstrap, base)).toBe(true);
    expect(fixture.repository.getPaneContext(fixture.paneId)?.pane.activity.state).toBe("running");
    expect(fixture.repository.getPaneContext(fixture.paneId)?.pane.codexSessionResumable).toBe(
      true,
    );

    const first = { requestId: "approval-a", turnId: "turn-1", kind: "permissions" } as const;
    const second = { requestId: 17, turnId: "turn-1", kind: "user-input" } as const;
    expect(
      fixture.integration.acceptInteraction(bootstrap, {
        ...base,
        sequence: 2,
        pending: [first, second],
      }),
    ).toBe(true);
    expect(fixture.repository.getPaneContext(fixture.paneId)?.pane.activity.state).toBe(
      "interaction-required",
    );

    // A key used to close a picker does not cancel the active turn or answer a request.
    fixture.integration.observeInput(fixture.paneId, session.runtimeId as string, "\u001b");
    fixture.integration.acceptHook(bootstrap, {
      type: "turn-running",
      sessionId: CODEX_SESSION_ID,
      cwd: "/safe/project",
      turnId: "turn-1",
    });
    expect(fixture.repository.getPaneContext(fixture.paneId)?.pane.activity.state).toBe(
      "interaction-required",
    );

    fixture.integration.acceptInteraction(bootstrap, {
      ...base,
      sequence: 3,
      pending: [second],
    });
    fixture.integration.acceptInteraction(bootstrap, {
      ...base,
      sequence: 4,
      phase: "completed",
      pending: [second],
    });
    expect(fixture.repository.getPaneContext(fixture.paneId)?.pane.activity.state).toBe(
      "interaction-required",
    );
    fixture.integration.acceptInteraction(bootstrap, {
      ...base,
      sequence: 5,
      phase: "completed",
    });
    expect(fixture.repository.getPaneContext(fixture.paneId)?.pane.activity.state).toBe(
      "completed",
    );

    fixture.integration.acceptInteraction(bootstrap, { ...base, sequence: 3, pending: [first] });
    expect(fixture.repository.getPaneContext(fixture.paneId)?.pane.activity.state).toBe(
      "completed",
    );
    expect(
      fixture.integration.acceptInteraction(bootstrap, {
        ...base,
        sequence: 6,
        streamId: randomUUID(),
      }),
    ).toBe(false);
    fixture.integration.acceptInteraction(bootstrap, {
      ...base,
      sequence: 6,
      phase: "running",
      pending: [first],
    });
    fixture.integration.observeExit(fixture.paneId, session.runtimeId as string, 1);
    expect(fixture.repository.getPaneContext(fixture.paneId)?.pane.activity.state).toBe("failed");
    expect(
      fixture.integration.acceptInteraction(bootstrap, {
        ...base,
        sequence: 7,
        pending: [first],
      }),
    ).toBe(false);
    expect(fixture.repository.getPaneContext(fixture.paneId)?.pane.activity.state).toBe("failed");
    fixture.repository.close();
  });

  it("projects auto-review as running and only a real approval RPC as interaction-required", () => {
    const fixture = integrationFixture();
    const bindingId = randomUUID();
    const create = fixture.repository.preparePaneSessionOperation(
      fixture.paneId,
      "create",
      null,
      bindingId,
    );
    const session = sessionView();
    const bootstrap = fixture.bootstrap(bindingId, session);
    fixture.integration.launch(bootstrap);
    fixture.repository.completePaneSessionOperation(
      fixture.paneId,
      "create",
      create.operationKey as string,
      session,
    );
    fixture.integration.bindRuntime(fixture.paneId, session);

    const state = new CodexInteractionState("/safe/project", (snapshot) => {
      expect(fixture.integration.acceptInteraction(bootstrap, snapshot)).toBe(true);
    });
    state.start();
    state.observeClient({ id: 1, method: "thread/start", params: {} });
    state.observeServer({
      id: 1,
      result: {
        thread: {
          id: CODEX_SESSION_ID,
          cwd: "/safe/project",
          parentThreadId: null,
          status: { type: "idle" },
        },
      },
    });
    state.observeClient({ id: 2, method: "turn/start", params: { threadId: CODEX_SESSION_ID } });
    state.observeServer({
      method: "turn/started",
      params: { threadId: CODEX_SESSION_ID, turn: { id: "turn-1" } },
    });
    state.observeServer({
      method: "item/autoApprovalReview/started",
      params: {
        threadId: CODEX_SESSION_ID,
        turnId: "turn-1",
        reviewId: "review-1",
        startedAtMs: 1,
        action: { type: "requestPermissions", permissions: {} },
        review: { status: "inProgress" },
      },
    });
    // A legacy hook may also fire, but this runtime's app-server stream owns activity.
    fixture.integration.acceptHook(bootstrap, {
      type: "interaction-required",
      sessionId: CODEX_SESSION_ID,
      cwd: "/safe/project",
      turnId: "turn-1",
    });
    expect(fixture.repository.getPaneContext(fixture.paneId)?.pane.activity.state).toBe("running");
    state.observeServer({
      method: "item/autoApprovalReview/completed",
      params: {
        threadId: CODEX_SESSION_ID,
        turnId: "turn-1",
        reviewId: "review-1",
        startedAtMs: 1,
        completedAtMs: 2,
        decisionSource: "agent",
        action: { type: "requestPermissions", permissions: {} },
        review: { status: "approved" },
      },
    });
    expect(fixture.repository.getPaneContext(fixture.paneId)?.pane.activity.state).toBe("running");
    state.observeServer({
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: { threadId: CODEX_SESSION_ID, turnId: "turn-1" },
    });
    expect(fixture.repository.getPaneContext(fixture.paneId)?.pane.activity.state).toBe(
      "interaction-required",
    );
    state.observeServer({
      method: "serverRequest/resolved",
      params: { threadId: CODEX_SESSION_ID, requestId: 7 },
    });
    expect(fixture.repository.getPaneContext(fixture.paneId)?.pane.activity.state).toBe("running");
    fixture.repository.close();
  });

  it("does not erase a resumable session before the remote TUI has identified its thread", () => {
    const fixture = integrationFixture();
    const bindingId = randomUUID();
    const create = fixture.repository.preparePaneSessionOperation(
      fixture.paneId,
      "create",
      null,
      bindingId,
    );
    const session = sessionView();
    const bootstrap = fixture.bootstrap(bindingId, session);
    fixture.integration.launch(bootstrap);
    fixture.repository.completePaneSessionOperation(
      fixture.paneId,
      "create",
      create.operationKey as string,
      session,
    );
    fixture.integration.bindRuntime(fixture.paneId, session);
    fixture.integration.acceptHook(bootstrap, {
      type: "session-start",
      sessionId: CODEX_SESSION_ID,
      cwd: "/safe/project",
      source: "resume",
    });
    expect(fixture.repository.getPaneContext(fixture.paneId)?.pane.codexSessionResumable).toBe(
      true,
    );

    expect(
      fixture.integration.acceptInteraction(bootstrap, {
        streamId: randomUUID(),
        sequence: 0,
        cwd: "/safe/project",
        sessionId: null,
        identity: "unbound",
        turnId: null,
        phase: "idle",
        pending: [],
      }),
    ).toBe(true);
    fixture.integration.observeExit(fixture.paneId, session.runtimeId as string, 1);
    expect(fixture.repository.getPaneContext(fixture.paneId)?.pane).toMatchObject({
      codexSessionId: CODEX_SESSION_ID,
      codexSessionResumable: true,
      activity: { state: "failed" },
    });
    fixture.repository.close();
  });
});

function integrationFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "naru-codex-port-")));
  const credentialDirectory = join(root, "credentials");
  mkdirSync(credentialDirectory, { mode: 0o700 });
  const credentialFile = join(credentialDirectory, "naru");
  writeFileSync(credentialFile, `${CREDENTIAL}\n`, { mode: 0o600 });
  chmodSync(credentialFile, 0o600);
  const repository = new NaruRepository(":memory:", { sessionOwner: "durable-host" });
  const project = repository.createProject("/safe/project", "project");
  const pane = repository
    .getWorkspace(project.id)
    .panes.find((candidate) => candidate.launchProfile === "codex-main");
  if (pane === undefined) throw new Error("Fixture Codex Pane is missing.");
  const config: DurableHostConfig = {
    owner: "durable-host",
    socketPath: "/safe/host.sock",
    credentialFile,
    appId: "naru",
    subject: "local-owner",
    callerTtlMs: 60_000,
    idempotencyTtlMs: 30_000,
    profileIds: ["codex-main", "codex-quick"],
    roots: [{ rootId: "safe", path: "/safe" }],
  };
  let now = 1_000;
  const launchProfiles = {
    resolve: (context: Parameters<PaneLaunchResolver["resolve"]>[0]) => ({
      file: "/fixture/codex",
      args: ["--fixture-profile", context.pane.launchProfile],
      environment: {},
    }),
  } satisfies PaneLaunchResolver;
  const integration = new NaruCodexIntegration(repository, config, launchProfiles, () => now++);
  return {
    repository,
    paneId: pane.id,
    config,
    launchProfiles,
    integration,
    bootstrap: (bindingId: string, session: SessionView) =>
      createIntegrationBootstrap(
        {
          version: 0,
          appId: config.appId,
          subject: config.subject,
          sessionId: session.sessionId,
          runtimeId: session.runtimeId as string,
          profileId: "codex-main",
          cwd: { rootId: "safe", relativePath: "project" },
          integration: {
            kind: "codex",
            config: { policyRef: NARU_CODEX_INTEGRATION_POLICY_REF, bindingId },
          },
          issuedAtMs: now,
        },
        deriveIntegrationBootstrapKey(CREDENTIAL),
      ),
  };
}

function sessionView(): SessionView {
  return {
    sessionId: randomUUID(),
    lifecycle: "running",
    sessionRevision: 1,
    runtimeId: randomUUID(),
    terminal: { cols: 100, rows: 30 },
    controllerAttachmentId: null,
    controllerGeneration: 0,
    nextSequence: 0,
    command: { kind: "profile", profileId: "codex-main", rootId: "safe" },
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  };
}
