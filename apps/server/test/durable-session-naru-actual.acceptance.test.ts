import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerWsFrame } from "@naru/contracts";
import type { SessionView } from "@naru/contracts/durable-session/v0";
import { describe, expect, it } from "vitest";
import {
  CODEX_SESSION_HOOK_COMMAND,
  CODEX_SESSION_HOOK_ENVIRONMENT_KEYS,
} from "../src/codex-session-hook.js";
import { DurableSessionHostConfigSchema } from "../../durable-session-host/src/config.js";
import {
  startDurableSessionHost,
  type RunningDurableSessionHost,
} from "../../durable-session-host/src/host.js";
import { silentHostLogger } from "../../durable-session-host/src/logging.js";
import { createHostFixture } from "../../durable-session-host/test/support.js";
import { NaruRepository } from "../src/database.js";
import { DurableHostSessionFacade } from "../src/durable-session-facade.js";
import {
  operationRequestBase,
  type DurableHostConfig,
  UdsDurableSessionLifecycleClient,
} from "../src/durable-session-host-client.js";
import { UdsDurableSessionStreamPort } from "../src/durable-session-stream-port.js";
import { NaruCodexIntegration } from "../src/integrations/codex/port.js";
import type { CodexIntegrationEventV1 } from "../src/integrations/codex/events.js";
import { NARU_CODEX_INTEGRATION_SOCKET_ENV } from "../src/integrations/codex/protocol.js";
import { CodexIntegrationServer } from "../src/integrations/codex/server.js";
import { LaunchProfileRegistry } from "../src/launch-profiles.js";

const actualDescribe = describe.skipIf(process.env.DURABLE_SESSION_NARU_ACTUAL_PTY !== "1");
const ACTUAL_TURN_MARKER = "NARU_T13_ACTUAL_READY_20260824";

actualDescribe("Naru DurableSession actual PTY continuity acceptance", () => {
  it("separates Naru process continuity from actual Codex semantic recovery", async () => {
    expect(process.versions.node.split(".")[0]).toBe("24");
    const fixture = createHostFixture();
    const nodeExecutable = realpathSync(process.execPath);
    const codexExecutable = realpathSync(resolveExecutable("codex"));
    const tsxExecutable = realpathSync(
      fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url)),
    );
    const codexLauncher = realpathSync(
      fileURLToPath(new URL("../src/codex-integration-launcher.ts", import.meta.url)),
    );
    const codexHookEntrypoint = realpathSync(
      fileURLToPath(new URL("../src/codex-session-hook-cli.ts", import.meta.url)),
    );
    const genericTui = realpathSync(
      fileURLToPath(
        new URL("../../durable-session-host/test/fixtures/generic-tui.mjs", import.meta.url),
      ),
    );
    const acceptanceProjectRoot = realpathSync(
      fileURLToPath(new URL("../../../", import.meta.url)),
    );
    const resourcePolicy = fixture.config.resourcePolicies[0];
    if (resourcePolicy === undefined) throw new Error("Fixture resource policy is missing.");
    const config = clientConfig(fixture, acceptanceProjectRoot);
    const database = join(fixture.root, "data", "naru-actual.sqlite");
    const integrationDataDirectory = join(fixture.root, "data", "codex-integration");
    let firstRepository: NaruRepository | null = new NaruRepository(database, {
      sessionOwner: "durable-host",
    });
    const project = firstRepository.createProject(acceptanceProjectRoot, "actual");
    const panes = firstRepository.getWorkspace(project.id).panes;
    const terminal = panes.find((pane) => pane.launchProfile === "shell");
    const codex = panes.find((pane) => pane.launchProfile === "codex-main");
    if (terminal === undefined || codex === undefined) {
      throw new Error("Actual Naru Pane fixtures are missing.");
    }
    let firstIntegration: Awaited<ReturnType<typeof startCodexIntegration>> | null =
      await startCodexIntegration(
        firstRepository,
        config,
        integrationDataDirectory,
        codexExecutable,
      );
    const hostConfig = DurableSessionHostConfigSchema.parse({
      ...fixture.config,
      roots: config.roots,
      profiles: [
        actualProfile("shell", nodeExecutable, [genericTui]),
        actualProfile("codex-main", tsxExecutable, [codexLauncher]),
        actualProfile("codex-quick", tsxExecutable, [codexLauncher]),
      ],
      environmentPolicies: [
        {
          envPolicyId: "naru-actual-env",
          inherit: [
            "HOME",
            "PATH",
            "USER",
            "LOGNAME",
            "SHELL",
            "LANG",
            "LC_ALL",
            "TMPDIR",
            "XDG_CONFIG_HOME",
            "CODEX_HOME",
          ],
          values: {
            COLORTERM: "truecolor",
            PATH: `${dirname(nodeExecutable)}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
            [NARU_CODEX_INTEGRATION_SOCKET_ENV]: firstIntegration.server.socketPath,
            [CODEX_SESSION_HOOK_ENVIRONMENT_KEYS.runner]: tsxExecutable,
            [CODEX_SESSION_HOOK_ENVIRONMENT_KEYS.entry]: codexHookEntrypoint,
          },
        },
      ],
      resourcePolicies: [
        {
          ...resourcePolicy,
          resourcePolicyId: "naru-actual-resource",
          allowedExecutables: [nodeExecutable, tsxExecutable],
          stopTimeoutMs: 5_000,
        },
      ],
      integrationPolicies: [
        {
          policyRef: "naru-codex-v0",
          appId: config.appId,
          integrationKind: "codex",
          profileIds: ["codex-main", "codex-quick"],
          configKeys: ["policyRef", "bindingId"],
        },
      ],
    });
    let host: RunningDurableSessionHost | null = null;
    let restartedRepository: NaruRepository | null = null;
    let first: DurableHostSessionFacade | null = null;
    let restarted: DurableHostSessionFacade | null = null;
    let restartedIntegration: Awaited<ReturnType<typeof startCodexIntegration>> | null = null;

    try {
      host = await startDurableSessionHost(hostConfig, {
        logger: silentHostLogger,
        hostEnvironment: process.env,
      });
      const firstLifecycle = new UdsDurableSessionLifecycleClient(config);
      first = new DurableHostSessionFacade(
        firstRepository,
        config,
        firstLifecycle,
        new UdsDurableSessionStreamPort(config),
        Date.now,
        firstIntegration.integration,
        firstIntegration.server,
      );
      await first.start(terminal.id, 100, 30);
      await first.start(codex.id, 120, 40);
      const codexFrames: ServerWsFrame[] = [];
      await first.attach(codex.id, 120, 40, (frame) => codexFrames.push(frame));
      await waitForTerminalText(codexFrames, "Ask Codex");
      await first.write(codex.id, `Reply with exactly ${ACTUAL_TURN_MARKER}. Do not use tools.`);
      await delay(250);
      await first.write(codex.id, "\r");
      const semanticSessionId = await waitForCodexSession(firstRepository, codex.id, codexFrames);
      await waitForPaneActivity(firstRepository, codex.id, "completed");

      const terminalBefore = await runningSession(firstRepository, firstLifecycle, terminal.id);
      const codexBefore = await runningSession(firstRepository, firstLifecycle, codex.id);
      const terminalFrames: ServerWsFrame[] = [];
      await first.attach(terminal.id, 100, 30, (frame) => terminalFrames.push(frame));
      const terminalSnapshot = await waitForSnapshot(terminalFrames);
      await waitForOutput(terminalFrames, (frame) => frame.data.includes("heartbeat:"));
      const codexSnapshot = await waitForSnapshot(codexFrames);
      if (codexSnapshot.sequence === 0) {
        await waitForOutput(codexFrames, (frame) => frame.data.length > 0);
      }

      await first.shutdown();
      first = null;
      firstIntegration = null;
      firstRepository.close();
      firstRepository = null;

      restartedRepository = new NaruRepository(database, { sessionOwner: "durable-host" });
      restartedIntegration = await startCodexIntegration(
        restartedRepository,
        config,
        integrationDataDirectory,
        codexExecutable,
      );
      expect(restartedIntegration.server.socketPath).toBe(
        hostConfig.environmentPolicies[0]?.values[NARU_CODEX_INTEGRATION_SOCKET_ENV],
      );
      const integrationEvents: CodexIntegrationEventV1[] = [];
      restartedIntegration.integration.onEvent((event) => integrationEvents.push(event));
      const restartedLifecycle = new UdsDurableSessionLifecycleClient(config);
      restarted = new DurableHostSessionFacade(
        restartedRepository,
        config,
        restartedLifecycle,
        new UdsDurableSessionStreamPort(config),
        Date.now,
        restartedIntegration.integration,
        restartedIntegration.server,
      );
      await restarted.reconcile();

      const terminalAfter = await runningSession(
        restartedRepository,
        restartedLifecycle,
        terminal.id,
      );
      const codexAfter = await runningSession(restartedRepository, restartedLifecycle, codex.id);
      expect(terminalAfter).toMatchObject({
        sessionId: terminalBefore.sessionId,
        runtimeId: terminalBefore.runtimeId,
        lifecycle: "running",
      });
      expect(codexAfter).toMatchObject({
        sessionId: codexBefore.sessionId,
        runtimeId: codexBefore.runtimeId,
        lifecycle: "running",
      });

      const restoredTerminalFrames: ServerWsFrame[] = [];
      const restoredCodexFrames: ServerWsFrame[] = [];
      await restarted.attach(terminal.id, 100, 30, (frame) => restoredTerminalFrames.push(frame));
      await restarted.attach(codex.id, 120, 40, (frame) => restoredCodexFrames.push(frame));
      const restoredTerminal = await waitForSnapshot(restoredTerminalFrames);
      const restoredCodex = await waitForSnapshot(restoredCodexFrames);
      expect(restoredTerminal).toMatchObject({ runtimeId: terminalBefore.runtimeId });
      expect(restoredCodex).toMatchObject({ runtimeId: codexBefore.runtimeId });
      expect(restoredTerminal.sequence).toBeGreaterThanOrEqual(terminalSnapshot.sequence);
      expect(restoredCodex.sequence).toBeGreaterThanOrEqual(codexSnapshot.sequence);

      expect(await waitForCodexSession(restartedRepository, codex.id, restoredCodexFrames)).toBe(
        semanticSessionId,
      );
      await restarted.stop(codex.id);
      await waitForTerminalSession(restartedRepository, restartedLifecycle, codex.id);
      await restarted.restart(codex.id);
      const recoveredCodex = await runningSession(
        restartedRepository,
        restartedLifecycle,
        codex.id,
      );
      expect(recoveredCodex.sessionId).not.toBe(codexBefore.sessionId);
      expect(recoveredCodex.runtimeId).not.toBe(codexBefore.runtimeId);
      expect(await waitForCodexSession(restartedRepository, codex.id)).toBe(semanticSessionId);
      await waitForIntegrationEvent(
        integrationEvents,
        (event) =>
          event.eventKind === "launch.requested" &&
          event.runtimeId === recoveredCodex.runtimeId &&
          event.recovery === "semantic-resume",
      );
      const recoveredFrames: ServerWsFrame[] = [];
      await restarted.attach(codex.id, 120, 40, (frame) => recoveredFrames.push(frame));
      await waitForSnapshot(
        recoveredFrames,
        (frame) => frame.runtimeId === recoveredCodex.runtimeId,
      );
      await waitForTerminalText(recoveredFrames, ACTUAL_TURN_MARKER);
    } finally {
      await first?.shutdown();
      await restarted?.shutdown();
      await firstIntegration?.server.close();
      await restartedIntegration?.server.close();
      firstRepository?.close();
      restartedRepository?.close();
      await host?.close();
    }
  }, 90_000);
});

function actualProfile(profileId: string, executable: string, args: readonly string[]) {
  return {
    profileId,
    executable,
    args: [...args],
    envPolicyId: "naru-actual-env",
    resourcePolicyId: "naru-actual-resource",
  };
}

function clientConfig(
  fixture: ReturnType<typeof createHostFixture>,
  acceptanceProjectRoot: string,
): DurableHostConfig {
  return {
    owner: "durable-host",
    socketPath: fixture.config.socketPath,
    credentialFile: fixture.credentialFile,
    appId: "fixture-app",
    subject: "fixture-owner",
    callerTtlMs: 50_000,
    idempotencyTtlMs: fixture.config.idempotencyTtlMs,
    profileIds: fixture.config.profiles.map((profile) => profile.profileId),
    roots: [{ rootId: "acceptance-project", path: acceptanceProjectRoot }],
  };
}

async function startCodexIntegration(
  repository: NaruRepository,
  config: DurableHostConfig,
  dataDirectory: string,
  codexExecutable: string,
) {
  const integration = new NaruCodexIntegration(
    repository,
    config,
    new LaunchProfileRegistry({
      codexExecutable,
      codexSessionHookCommand: CODEX_SESSION_HOOK_COMMAND,
    }),
  );
  const server = new CodexIntegrationServer(dataDirectory, integration);
  await server.start();
  return { integration, server };
}

async function runningSession(
  repository: NaruRepository,
  lifecycle: UdsDurableSessionLifecycleClient,
  paneId: string,
): Promise<SessionView> {
  const link = repository.getPaneSessionLink(paneId);
  if (link?.sessionId === null || link?.sessionId === undefined) {
    throw new Error("Naru Pane is not linked to a Host Session.");
  }
  const result = await lifecycle.execute({
    ...operationRequestBase(),
    operation: "getSession",
    sessionId: link.sessionId,
  });
  if (result.operation !== "getSession" || result.session.runtimeId === null) {
    throw new Error("Host Session is not running.");
  }
  return result.session;
}

async function waitForTerminalSession(
  repository: NaruRepository,
  lifecycle: UdsDurableSessionLifecycleClient,
  paneId: string,
): Promise<SessionView> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const link = repository.getPaneSessionLink(paneId);
    if (link?.sessionId === null || link?.sessionId === undefined) {
      throw new Error("Naru Pane lost its Host Session link.");
    }
    const result = await lifecycle.execute({
      ...operationRequestBase(),
      operation: "getSession",
      sessionId: link.sessionId,
    });
    if (result.operation === "getSession" && result.session.lifecycle !== "running") {
      if (result.session.lifecycle !== "stopping") return result.session;
    }
    await delay(25);
  }
  throw new Error("Timed out waiting for the actual Codex Host Session to stop.");
}

async function waitForCodexSession(
  repository: NaruRepository,
  paneId: string,
  frames: readonly ServerWsFrame[] = [],
): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const pane = repository.getPaneContext(paneId)?.pane;
    if (pane?.codexSessionId !== null && pane?.codexSessionId !== undefined) {
      if (!pane.codexSessionResumable) {
        throw new Error("Codex session identity was not marked resumable.");
      }
      return pane.codexSessionId;
    }
    await delay(25);
  }
  const pane = repository.getPaneContext(paneId)?.pane;
  const output = frames
    .map((frame) =>
      frame.type === "terminal.output"
        ? frame.data
        : frame.type === "pane.snapshot"
          ? frame.serializedState
          : "",
    )
    .join("")
    .slice(-4_096);
  throw new Error(
    `Timed out waiting for the actual Codex session hook; pane=${JSON.stringify({
      status: pane?.status,
      activity: pane?.activity.state,
      runtimeId: pane?.activity.runtimeId,
    })}; terminal=${JSON.stringify(output)}`,
  );
}

async function waitForSnapshot(
  frames: ServerWsFrame[],
  predicate: (frame: Extract<ServerWsFrame, { type: "pane.snapshot" }>) => boolean = () => true,
): Promise<Extract<ServerWsFrame, { type: "pane.snapshot" }>> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const frame = frames.find(
      (candidate): candidate is Extract<ServerWsFrame, { type: "pane.snapshot" }> =>
        candidate.type === "pane.snapshot" && predicate(candidate),
    );
    if (frame !== undefined) return frame;
    await delay(25);
  }
  throw new Error("Timed out waiting for an actual Host terminal snapshot.");
}

async function waitForOutput(
  frames: ServerWsFrame[],
  predicate: (frame: Extract<ServerWsFrame, { type: "terminal.output" }>) => boolean,
): Promise<Extract<ServerWsFrame, { type: "terminal.output" }>> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const frame = frames.find(
      (candidate): candidate is Extract<ServerWsFrame, { type: "terminal.output" }> =>
        candidate.type === "terminal.output" && predicate(candidate),
    );
    if (frame !== undefined) return frame;
    await delay(25);
  }
  throw new Error("Timed out waiting for actual Host terminal output.");
}

async function waitForTerminalText(frames: readonly ServerWsFrame[], text: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const rendered = frames
      .map((frame) =>
        frame.type === "terminal.output"
          ? frame.data
          : frame.type === "pane.snapshot"
            ? frame.serializedState
            : "",
      )
      .join("");
    if (rendered.includes(text)) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for actual Host terminal marker ${text}.`);
}

async function waitForPaneActivity(
  repository: NaruRepository,
  paneId: string,
  expected: "completed",
): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (repository.getPaneContext(paneId)?.pane.activity.state === expected) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for actual Codex activity ${expected}.`);
}

async function waitForIntegrationEvent(
  events: readonly CodexIntegrationEventV1[],
  predicate: (event: CodexIntegrationEventV1) => boolean,
): Promise<CodexIntegrationEventV1> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const event = events.find(predicate);
    if (event !== undefined) return event;
    await delay(25);
  }
  throw new Error("Timed out waiting for the actual Codex integration event.");
}

function resolveExecutable(name: string): string {
  const configured = process.env.NARU_T06_CODEX_EXECUTABLE;
  if (configured !== undefined) return executableFile(configured);
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    try {
      return executableFile(join(directory, name));
    } catch {
      // Keep searching the explicit PATH entries.
    }
  }
  throw new Error(`Could not find ${name} on PATH.`);
}

function executableFile(path: string): string {
  accessSync(path, constants.X_OK);
  return path;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
