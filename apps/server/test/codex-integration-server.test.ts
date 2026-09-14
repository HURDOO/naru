import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { IntegrationDescriptor } from "@naru/contracts/durable-session/v0";
import { describe, expect, it } from "vitest";
import { sendCodexHookEvent } from "../src/codex-session-hook-client.js";
import { requestCodexIntegration } from "../src/integrations/codex/client.js";
import type { CodexHookEvent, CodexInteractionSnapshot } from "../src/integrations/codex/events.js";
import type { CodexLaunchPlan, NaruCodexIntegrationPort } from "../src/integrations/codex/port.js";
import { CodexIntegrationServer } from "../src/integrations/codex/server.js";

const BOOTSTRAP = "b".repeat(64);
const SESSION_ID = "11111111-1111-4111-8111-111111111111";

describe("private Naru Codex integration transport", () => {
  it("serves bounded launch and durable hook requests on an owner-only socket", async () => {
    const dataDirectory = privateTemporaryDirectory("naru-codex-integration-");
    const port = new FakeCodexPort();
    const server = new CodexIntegrationServer(dataDirectory, port);
    await bounded(server.start(), "start");
    try {
      const metadata = lstatSync(server.socketPath);
      expect(metadata.isSocket()).toBe(true);
      expect(metadata.mode & 0o777).toBe(0o600);
      const launchReply = await bounded(
        requestCodexIntegration(server.socketPath, {
          version: 1,
          type: "launch",
          bootstrap: BOOTSTRAP,
        }),
        "launch request",
      );
      expect(launchReply).toEqual({
        version: 1,
        ok: true,
        type: "launch",
        plan: { executable: "/fixture/codex", args: ["--fixture"] },
      });
      expect(
        await bounded(
          sendCodexHookEvent(
            {
              type: "session-start",
              sessionId: SESSION_ID,
              cwd: "/fixture/project",
              source: "startup",
            },
            { socketPath: server.socketPath, bootstrap: BOOTSTRAP },
          ),
          "hook request",
        ),
      ).toBe(true);
      expect(port.launches).toEqual([BOOTSTRAP]);
      expect(port.hooks).toHaveLength(1);
      const snapshot: CodexInteractionSnapshot = {
        streamId: "22222222-2222-4222-8222-222222222222",
        sequence: 1,
        cwd: "/fixture/project",
        sessionId: SESSION_ID,
        identity: "bound",
        turnId: "turn-1",
        phase: "running",
        pending: [{ requestId: 7, turnId: "turn-1", kind: "user-input" }],
      };
      expect(
        await bounded(
          requestCodexIntegration(server.socketPath, {
            version: 1,
            type: "interaction",
            bootstrap: BOOTSTRAP,
            snapshot,
          }),
          "interaction snapshot",
        ),
      ).toEqual({ version: 1, ok: true, type: "interaction" });
      expect(port.interactions).toEqual([snapshot]);

      const contender = new CodexIntegrationServer(dataDirectory, new FakeCodexPort());
      await expect(bounded(contender.start(), "active socket rejection")).rejects.toThrow(
        /already running/,
      );
      await bounded(contender.close(), "contender close");
    } finally {
      await bounded(server.close(), "server close");
    }
  });

  it("refuses to replace a non-socket integration path", async () => {
    const dataDirectory = privateTemporaryDirectory("naru-codex-integration-path-");
    const server = new CodexIntegrationServer(dataDirectory, new FakeCodexPort());
    mkdirSync(dirname(server.socketPath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(server.socketPath), 0o700);
    writeFileSync(server.socketPath, "do-not-replace", { mode: 0o600 });

    await expect(server.start()).rejects.toThrow(/non-socket/);
  });

  it("uses an exact pre-created private custom socket directory", async () => {
    const root = privateShortTemporaryDirectory("ncs-");
    const runtimeDirectory = join(root, "run");
    mkdirSync(runtimeDirectory, { mode: 0o700 });
    const socketPath = join(runtimeDirectory, "naru-integration.sock");
    const server = new CodexIntegrationServer(root, new FakeCodexPort(), { socketPath });

    await bounded(server.start(), "custom socket start");
    try {
      expect(server.socketPath).toBe(socketPath);
      expect(lstatSync(socketPath).mode & 0o777).toBe(0o600);
    } finally {
      await bounded(server.close(), "custom socket close");
    }
  });

  it("rejects a configured runtime directory reached through a symbolic link", async () => {
    const root = privateShortTemporaryDirectory("nss-");
    const target = join(root, "target");
    mkdirSync(target, { mode: 0o700 });
    const linked = join(root, "linked");
    symlinkSync(target, linked, "dir");
    const server = new CodexIntegrationServer(root, new FakeCodexPort(), {
      socketPath: join(linked, "naru-integration.sock"),
    });

    await expect(server.start()).rejects.toThrow(/regular directory|symbolic links/);
  });
});

class FakeCodexPort implements NaruCodexIntegrationPort {
  readonly launches: string[] = [];
  readonly hooks: CodexHookEvent[] = [];
  readonly interactions: CodexInteractionSnapshot[] = [];

  descriptor(bindingId: string): IntegrationDescriptor {
    return { kind: "codex", config: { policyRef: "fixture", bindingId } };
  }

  preflight(): void {}

  launch(bootstrap: string): CodexLaunchPlan {
    this.launches.push(bootstrap);
    return { executable: "/fixture/codex", args: ["--fixture"] };
  }

  acceptHook(bootstrap: string, event: CodexHookEvent): boolean {
    if (bootstrap !== BOOTSTRAP) return false;
    this.hooks.push(event);
    return true;
  }

  acceptInteraction(bootstrap: string, snapshot: CodexInteractionSnapshot): boolean {
    if (bootstrap !== BOOTSTRAP) return false;
    this.interactions.push(snapshot);
    return true;
  }

  bindRuntime(): void {}

  observeInput(): void {}

  observeOutput(): void {}

  observeExit(): void {}

  markStopping(): void {}

  cancelStopping(): void {}

  disposeRuntime(): void {}

  onActivity(): () => void {
    return () => undefined;
  }

  onEvent(): () => void {
    return () => undefined;
  }
}

function privateTemporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(directory, 0o700);
  return directory;
}

function privateShortTemporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join("/private/tmp", prefix));
  chmodSync(directory, 0o700);
  return realpathSync(directory);
}

function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    operation,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`Timed out during ${label}.`)), 1_000).unref(),
    ),
  ]);
}
