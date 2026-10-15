import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NARU_SURFACE_CONNECTION_HEADER,
  NARU_SURFACE_GENERATION_HEADER,
} from "../../../packages/contracts/src/index.js";
import type { Actor, Handoff, Instruction } from "@naru/contracts/naru-agent/v1";
import { AgentPlatformCore, AgentPlatformError } from "../src/agent-platform/core.js";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { NaruRepository } from "../src/database.js";
import { ProjectPathPolicy } from "../src/path-policy.js";
import { hashPassword } from "../src/password.js";
import { PtySupervisor, type PtyProcess } from "../src/pty.js";

const origin = "http://127.0.0.1:5173";
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("Agent Platform browser API", () => {
  it("is absent unless the core is supplied", async () => {
    const fixture = await createFixture(false);
    const login = await fixture.login();
    const response = await fixture.app.inject({
      method: "GET",
      url: "/api/agent/overview",
      headers: { cookie: login.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("requires a session for reads and the human device lease for writes", async () => {
    const fixture = await createFixture(true);
    expect(
      (await fixture.app.inject({ method: "GET", url: "/api/agent/overview" })).statusCode,
    ).toBe(401);
    const login = await fixture.login();
    const overview = await fixture.app.inject({
      method: "GET",
      url: "/api/agent/overview",
      headers: { cookie: login.cookie },
    });
    expect(overview.statusCode).toBe(200);

    const payload = {
      scope: { kind: "project", projectId: fixture.projectId },
      verbatim: "로그인은 passkey로 해 줘.",
      idempotencyKey: "90000000-0000-4000-8000-000000000001",
    };
    const withoutLease = await fixture.app.inject({
      method: "POST",
      url: "/api/agent/instructions",
      headers: { origin, cookie: login.cookie, "x-csrf-token": login.csrfToken },
      payload,
    });
    expect(withoutLease.statusCode).toBe(409);
    expect(withoutLease.json()).toMatchObject({ code: "LEASE_REQUIRED" });

    const controller = await fixture.controller(login);
    const created = await fixture.app.inject({
      method: "POST",
      url: "/api/agent/instructions",
      headers: controller,
      payload,
    });
    expect(created.statusCode).toBe(201);
    const replay = await fixture.app.inject({
      method: "POST",
      url: "/api/agent/instructions",
      headers: controller,
      payload,
    });
    expect(replay.json<Instruction>().id).toBe(created.json<Instruction>().id);

    const state = await fixture.app.inject({
      method: "GET",
      url: `/api/agent/projects/${fixture.projectId}`,
      headers: { cookie: login.cookie },
    });
    expect(state.json<{ instructions: Instruction[] }>().instructions).toHaveLength(1);

    // Events reference the instruction but never carry its text (AP-D002).
    const events = await fixture.app.inject({
      method: "GET",
      url: "/api/agent/events?after=0",
      headers: { cookie: login.cookie },
    });
    expect(events.statusCode).toBe(200);
    expect(events.body).not.toContain("passkey로");
  });

  it("resolves handoffs once and holds an agent against orchestrator messages", async () => {
    const fixture = await createFixture(true);
    const login = await fixture.login();
    const controller = await fixture.controller(login);
    const core = fixture.core!;
    let ordinal = 100;
    const ctx = (actor: Actor) => ({
      actor,
      idempotencyKey: `90000000-0000-4000-8000-${String(++ordinal).padStart(12, "0")}`,
    });
    const register = (role: "project-orchestrator" | "worker") =>
      core.registerAgentSession(ctx({ kind: "human" }), {
        projectId: fixture.projectId,
        role,
        runtime: "codex",
        native: false,
        observation: "pty",
        conversationWriter: "orchestrator",
      }).id;
    const orchestrator = register("project-orchestrator");
    const worker = register("worker");
    const goal = core.createHumanInstruction(ctx({ kind: "human" }), {
      scope: { kind: "project", projectId: fixture.projectId },
      verbatim: "goal",
    }).id;
    const handoff = core.requestHandoff(ctx({ kind: "agent", agentSessionId: worker }), {
      projectId: fixture.projectId,
      kind: "manual-test",
      payload: {
        reason: "로그인 흐름 확인",
        blockingTaskIds: [],
        independentWorkToContinue: ["문서"],
        options: [],
        recommendation: "dev server에서 로그인해 보기",
        risks: [],
        preparedEnvironment: ["http://127.0.0.1:5173"],
        resumeCondition: "승인",
      },
    });

    const inbox = await fixture.app.inject({
      method: "GET",
      url: `/api/agent/handoffs?projectId=${fixture.projectId}`,
      headers: { cookie: login.cookie },
    });
    expect(inbox.json<Handoff[]>().map((item) => item.id)).toEqual([handoff.id]);

    const resolve = (key: string) =>
      fixture.app.inject({
        method: "POST",
        url: `/api/agent/handoffs/${handoff.id}/resolve`,
        headers: controller,
        payload: { decision: "통과", chosenOption: "pass", idempotencyKey: key },
      });
    expect((await resolve("90000000-0000-4000-8000-000000000201")).statusCode).toBe(200);
    const again = await resolve("90000000-0000-4000-8000-000000000202");
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "AGENT_INVALID_STATE" });

    const hold = await fixture.app.inject({
      method: "POST",
      url: `/api/agent/agents/${worker}/hold`,
      headers: controller,
      payload: { held: true, idempotencyKey: "90000000-0000-4000-8000-000000000203" },
    });
    expect(hold.statusCode).toBe(200);
    expect(() =>
      core.delegate(ctx({ kind: "agent", agentSessionId: orchestrator }), {
        scope: { kind: "agent", projectId: fixture.projectId, agentSessionId: worker },
        verbatim: "continue",
        originUserInstructionId: goal,
      }),
    ).toThrow(AgentPlatformError);
  });
});

class NoopPty implements PtyProcess {
  readonly pid = 4242;
  onData(): { dispose(): void } {
    return { dispose: () => undefined };
  }
  onExit(): { dispose(): void } {
    return { dispose: () => undefined };
  }
  write(): void {}
  resize(): void {}
  kill(): void {}
}

async function createFixture(withAgentPlatform: boolean) {
  const base = await mkdtemp(join(tmpdir(), "naru-agent-api-"));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "coding");
  await mkdir(join(root, "project"), { recursive: true });
  const realRoot = await realpath(root);
  const config: AppConfig = {
    authMode: "app-managed",
    environment: "test",
    host: "127.0.0.1",
    port: 4174,
    allowedOrigins: new Set([origin]),
    projectRoots: [realRoot],
    passwordHash: await hashPassword("naru-test-password", { N: 1024, salt: Buffer.alloc(16, 4) }),
    sessionSecret: "naru-test-session-secret-that-is-long-enough",
    sessionCookieName: "naru_test_session",
    appBasePath: "/",
    dataDir: base,
    secureCookie: false,
    sessionRuntime: { owner: "legacy" },
  };
  const repository = new NaruRepository(":memory:");
  const project = repository.createProject(join(realRoot, "project"), "project");
  const core = withAgentPlatform ? new AgentPlatformCore(repository.agentPlatform) : undefined;
  const supervisor = new PtySupervisor(repository, () => new NoopPty(), {
    resolve: () => ({ file: "/bin/zsh", args: ["-l"], environment: {} }),
  });
  const app = await buildApp(config, {
    repository,
    pathPolicy: await ProjectPathPolicy.create([realRoot]),
    supervisor,
    ...(core === undefined ? {} : { agentPlatform: core }),
  });
  cleanups.push(async () => {
    await app.close();
    await supervisor.shutdown();
    repository.close();
  });
  return {
    app,
    core,
    projectId: project.id,
    async login(): Promise<{ cookie: string; csrfToken: string }> {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { password: "naru-test-password" },
      });
      const header = response.headers["set-cookie"];
      const cookie = (Array.isArray(header) ? header[0] : header)?.split(";")[0] ?? "";
      return { cookie, csrfToken: response.json<{ csrfToken: string }>().csrfToken };
    },
    async controller(login: { cookie: string; csrfToken: string }) {
      const socket = await app.injectWS("/api/terminal", {
        headers: { cookie: login.cookie, origin },
      });
      cleanups.push(() => {
        socket.terminate();
        return Promise.resolve();
      });
      const state = await new Promise<{ connectionId: string; generation: number }>((resolve) => {
        socket.on("message", (data: { toString(): string }) => {
          const frame = JSON.parse(data.toString()) as Record<string, unknown>;
          if (
            frame.type === "surface.state" &&
            typeof frame.connectionId === "string" &&
            typeof frame.generation === "number"
          ) {
            resolve({ connectionId: frame.connectionId, generation: frame.generation });
          }
        });
        socket.send(
          JSON.stringify({
            type: "lease.acquire",
            clientId: "11111111-1111-4111-8111-111111111111",
          }),
        );
      });
      return {
        origin,
        cookie: login.cookie,
        "x-csrf-token": login.csrfToken,
        [NARU_SURFACE_CONNECTION_HEADER]: state.connectionId,
        [NARU_SURFACE_GENERATION_HEADER]: String(state.generation),
      };
    },
  };
}
