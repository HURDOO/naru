import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PaneControlPolicy } from "../src/agent-runtime/shared-processes.js";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { NaruRepository } from "../src/database.js";
import { ProjectPathPolicy } from "../src/path-policy.js";
import { hashPassword } from "../src/password.js";
import type { NaruSessionFacade, SessionAttachmentOptions } from "../src/session-facade.js";

const origin = "http://127.0.0.1:5173";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Records what the WebSocket surface asks of the session facade. */
class RecordingFacade implements NaruSessionFacade {
  readonly attaches: { paneId: string; control: string | undefined }[] = [];
  readonly controlDesired: { paneId: string; desired: boolean }[] = [];
  readonly writes: string[] = [];
  readiness(): boolean {
    return true;
  }
  count(): number {
    return 0;
  }
  isRunning(): boolean {
    return true;
  }
  onActivity(): () => void {
    return () => undefined;
  }
  onCodexIdentity(): () => void {
    return () => undefined;
  }
  acknowledgeCompleted(): void {}
  start(): void {}
  attach(
    paneId: string,
    _columns: number,
    _rows: number,
    _listener: unknown,
    _restoreProtocol?: unknown,
    _restoreId?: string,
    options?: SessionAttachmentOptions,
  ): Promise<() => void> {
    this.attaches.push({ paneId, control: options?.control });
    return Promise.resolve(() => undefined);
  }
  write(paneId: string): void {
    this.writes.push(paneId);
  }
  resize(): void {}
  updateViewport(): void {}
  setControlDesired(paneId: string, desired: boolean): void {
    this.controlDesired.push({ paneId, desired });
  }
  preemptControl(): void {}
  approveControl(): void {}
  rejectControl(): void {}
  releaseControl(): void {}
  restart(): void {}
  startNewCodex(): void {}
  startNewClaude(): void {}
  stop(): void {}
  remove(): void {}
  async shutdown(): Promise<void> {}
}

describe("Pane control for agent-run Panes (AP-D005)", () => {
  it("observes an agent's Pane until a person holds it, and notes human input", async () => {
    const base = await mkdtemp(join(tmpdir(), "naru-pane-control-"));
    cleanups.push(() => rm(base, { recursive: true, force: true }));
    const root = join(base, "coding");
    await mkdir(join(root, "project"), { recursive: true });
    const realRoot = await realpath(root);
    const repository = new NaruRepository(":memory:");
    const project = repository.createProject(join(realRoot, "project"), "project");
    const [agentPane, userPane] = repository.getWorkspace(project.id).panes;
    const held = new Set<string>();
    const listeners = new Set<(paneId: string) => void>();
    const policy: PaneControlPolicy = {
      humanMayControl: (paneId) => paneId !== agentPane!.id || held.has(paneId),
      onChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const facade = new RecordingFacade();
    const noted: unknown[] = [];
    const config: AppConfig = {
      authMode: "app-managed",
      environment: "test",
      host: "127.0.0.1",
      port: 4174,
      allowedOrigins: new Set([origin]),
      projectRoots: [realRoot],
      passwordHash: await hashPassword("naru-test-password", {
        N: 1024,
        salt: Buffer.alloc(16, 4),
      }),
      sessionSecret: "naru-test-session-secret-that-is-long-enough",
      sessionCookieName: "naru_test_session",
      appBasePath: "/",
      dataDir: base,
      secureCookie: false,
      sessionRuntime: { owner: "legacy" },
    };
    const app = await buildApp(config, {
      repository,
      pathPolicy: await ProjectPathPolicy.create([realRoot]),
      supervisor: facade,
      paneControlPolicy: policy,
      noteHumanInput: (target) => noted.push(target),
    });
    cleanups.push(async () => {
      await app.close();
      repository.close();
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin },
      payload: { password: "naru-test-password" },
    });
    const header = login.headers["set-cookie"];
    const cookie = (Array.isArray(header) ? header[0] : header)?.split(";")[0] ?? "";
    const socket = await app.injectWS("/api/terminal", { headers: { cookie, origin } });
    cleanups.push(() => {
      socket.terminate();
      return Promise.resolve();
    });
    const frames: Record<string, unknown>[] = [];
    socket.on("message", (data: { toString(): string }) => {
      frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    const waitFor = async (check: () => boolean, label: string): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (!check()) {
        if (Date.now() > deadline) {
          throw new Error(`timed out: ${label} ${JSON.stringify(frames.map((f) => f.type))}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    socket.send(
      JSON.stringify({ type: "lease.acquire", clientId: "11111111-1111-4111-8111-111111111111" }),
    );
    await waitFor(
      () => frames.some((frame) => frame.type === "surface.state" && frame.role === "controller"),
      "controller lease",
    );
    const generation = frames.find((frame) => frame.type === "surface.state")?.generation;

    for (const pane of [agentPane!, userPane!]) {
      socket.send(
        JSON.stringify({
          type: "pane.attach",
          paneId: pane.id,
          leaseGeneration: generation,
          cols: 80,
          rows: 24,
        }),
      );
    }
    await waitFor(() => facade.attaches.length === 2, "attaches");
    expect(facade.attaches).toEqual([
      { paneId: agentPane!.id, control: "observer" },
      { paneId: userPane!.id, control: "controller" },
    ]);

    // A person takes the agent's Pane over: this controller device asks for control.
    held.add(agentPane!.id);
    for (const listener of listeners) listener(agentPane!.id);
    await waitFor(
      () => facade.controlDesired.some((call) => call.paneId === agentPane!.id && call.desired),
      "control after hold",
    );
    socket.send(
      JSON.stringify({
        type: "terminal.input",
        paneId: agentPane!.id,
        leaseGeneration: generation,
        data: "y\r",
      }),
    );
    await waitFor(() => facade.writes.length === 1, "input");
    expect(noted).toEqual([{ paneId: agentPane!.id }]);
    // Secure input (AP-D003) reaches the PTY; Naru notes only that a person typed.
    socket.send(
      JSON.stringify({
        type: "terminal.input",
        paneId: agentPane!.id,
        leaseGeneration: generation,
        data: "not-a-real-secret\r",
        secure: true,
      }),
    );
    await waitFor(() => facade.writes.length === 2, "secure input");
    expect(JSON.stringify(noted)).not.toContain("not-a-real-secret");

    // Returned to the agent: the device lets go again.
    held.delete(agentPane!.id);
    for (const listener of listeners) listener(agentPane!.id);
    await waitFor(
      () => facade.controlDesired.at(-1)?.desired === false,
      "control released after return",
    );
  }, 20_000);
});
