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
