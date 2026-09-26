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
  NaruClaudeIntegration,
  NARU_CLAUDE_INTEGRATION_POLICY_REF,
} from "../src/integrations/claude/port.js";

const CREDENTIAL = "naru-claude-fixture-credential-0123456789abcdef";

describe("Naru-owned Claude Host integration", () => {
  it("projects a Host-signed current runtime through redacted hook activity", () => {
    const fixture = integrationFixture();
    try {
      const bindingId = randomUUID();
      const pending = fixture.repository.preparePaneSessionOperation(
        fixture.paneId,
        "create",
        null,
        bindingId,
      );
      const session = sessionView();
      const bootstrap = fixture.bootstrap(bindingId, session);
      expect(fixture.integration.launch(bootstrap)).toEqual({
        executable: "/fixture/claude",
        args: ["--settings", "fixture"],
      });
      expect(() => fixture.integration.launch(bootstrap)).toThrow(/consumed/);
      expect(
        fixture.integration.acceptHook(bootstrap, {
          type: "session-start",
          sessionId: "claude-session-1",
          cwd: "/safe/project",
        }),
      ).toBe(true);
      fixture.repository.completePaneSessionOperation(
        fixture.paneId,
        "create",
        pending.operationKey as string,
        session,
      );
      fixture.integration.bindRuntime(fixture.paneId, session);
      for (const [type, expected] of [
        ["turn-start", "running"],
        ["interaction-required", "interaction-required"],
        ["turn-running", "running"],
        ["turn-completed", "completed"],
      ] as const) {
        expect(
          fixture.integration.acceptHook(bootstrap, {
            type,
            sessionId: "claude-session-1",
            cwd: "/safe/project",
          }),
        ).toBe(true);
        expect(fixture.repository.getPaneContext(fixture.paneId)?.pane.activity.state).toBe(
          expected,
        );
      }
      expect(fixture.repository.getPaneContext(fixture.paneId)?.pane.activity.runtimeId).toBe(
        session.runtimeId,
      );
    } finally {
      fixture.repository.close();
    }
  });

  it("rejects stale binding, wrong cwd, signature and session generation", () => {
    const fixture = integrationFixture();
    try {
      const bindingId = randomUUID();
      const pending = fixture.repository.preparePaneSessionOperation(
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
        pending.operationKey as string,
        session,
      );
      fixture.integration.bindRuntime(fixture.paneId, session);
      const event = {
        type: "turn-start" as const,
        sessionId: "claude-session-1",
        cwd: "/safe/project",
      };
      expect(fixture.integration.acceptHook(bootstrap, { ...event, cwd: "/safe/other" })).toBe(
        false,
      );
      expect(fixture.integration.acceptHook(`${bootstrap}x`, event)).toBe(false);
      expect(
        fixture.integration.acceptHook(
          fixture.bootstrap(bindingId, { ...session, runtimeId: randomUUID() }),
          event,
        ),
      ).toBe(false);
      fixture.integration.disposeRuntime(fixture.paneId, session.runtimeId as string);
      fixture.repository.deletePaneSessionLink(fixture.paneId);
      expect(fixture.integration.acceptHook(bootstrap, event)).toBe(false);
    } finally {
      fixture.repository.close();
    }
  });

  it("retains a Host runtime across Naru integration reinitialization", () => {
    const fixture = integrationFixture();
    try {
      const bindingId = randomUUID();
      const pending = fixture.repository.preparePaneSessionOperation(
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
        pending.operationKey as string,
        session,
      );
      fixture.integration.bindRuntime(fixture.paneId, session);
      fixture.integration.acceptHook(bootstrap, {
        type: "session-start",
        sessionId: "claude-session-1",
        cwd: "/safe/project",
      });
      fixture.integration.acceptHook(bootstrap, {
        type: "turn-start",
        sessionId: "claude-session-1",
        cwd: "/safe/project",
      });
      expect(fixture.repository.getPaneContext(fixture.paneId)?.pane.activity.state).toBe(
        "running",
      );
      const restarted = new NaruClaudeIntegration(
        fixture.repository,
        fixture.config,
        fixture.launchProfiles,
      );
      restarted.bindRuntime(fixture.paneId, session);
      expect(
        restarted.acceptHook(bootstrap, {
          type: "turn-completed",
          sessionId: "claude-session-1",
          cwd: "/safe/project",
        }),
      ).toBe(true);
      expect(fixture.repository.getPaneContext(fixture.paneId)?.pane.activity.state).toBe(
        "completed",
      );
    } finally {
      fixture.repository.close();
    }
  });
});

function integrationFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "naru-claude-port-")));
  const credentialDirectory = join(root, "credentials");
  mkdirSync(credentialDirectory, { mode: 0o700 });
  const credentialFile = join(credentialDirectory, "naru");
  writeFileSync(credentialFile, `${CREDENTIAL}\n`, { mode: 0o600 });
  chmodSync(credentialFile, 0o600);
  const repository = new NaruRepository(":memory:", {
    sessionOwner: "durable-host",
    defaultAgentPaneKind: "claude",
  });
  const project = repository.createProject("/safe/project", "project");
  const pane = repository
    .getWorkspace(project.id)
    .panes.find((candidate) => candidate.kind === "claude");
  if (pane === undefined) throw new Error("Fixture Claude Pane is missing.");
  const config: DurableHostConfig = {
    owner: "durable-host",
    socketPath: "/safe/host.sock",
    credentialFile,
    appId: "naru-claude",
    subject: "local-owner",
    callerTtlMs: 60_000,
    idempotencyTtlMs: 30_000,
    profileIds: ["claude-code"],
    roots: [{ rootId: "safe", path: "/safe" }],
  };
  const launchProfiles = {
    resolve: () => ({
      file: "/fixture/claude",
      args: ["--settings", "fixture"],
      environment: {},
    }),
  } satisfies PaneLaunchResolver;
  const integration = new NaruClaudeIntegration(repository, config, launchProfiles, () => 1_000);
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
          profileId: "claude-code",
          cwd: { rootId: "safe", relativePath: "project" },
          integration: {
            kind: "claude",
            config: { policyRef: NARU_CLAUDE_INTEGRATION_POLICY_REF, bindingId },
          },
          issuedAtMs: 1_000,
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
    command: { kind: "profile", profileId: "claude-code", rootId: "safe" },
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  };
}
