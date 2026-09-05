import { spawn } from "node:child_process";
import { mkdtemp, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_CODEX_HOOK_INPUT_BYTES,
  parseCodexHookInput,
  parseCodexSessionStartInput,
  readCodexSessionHookEnvironment,
  sendCodexHookEvent,
  sendCodexSessionStart,
} from "../src/codex-session-hook-client.js";
import {
  CODEX_SESSION_HOOK_COMMAND,
  CodexSessionHookServer,
  type CodexHookEvent,
} from "../src/codex-session-hook.js";

const paneId = "11111111-1111-4111-8111-111111111111";
const runtimeId = "22222222-2222-4222-8222-222222222222";
const sessionId = "01a01743-622d-7882-ae50-acafe3ddbcbe";
const cwd = "/tmp/naru-hook-project";

describe("Codex session hook", () => {
  it("accepts bounded official SessionStart input and rejects unrelated lifecycle data", () => {
    expect(
      parseCodexSessionStartInput(
        JSON.stringify({
          session_id: sessionId,
          transcript_path: "/must/not/be-forwarded.jsonl",
          cwd,
          hook_event_name: "SessionStart",
          source: "clear",
          model: "gpt-5.6-sol",
        }),
      ),
    ).toEqual({ sessionId, cwd, source: "clear" });
    expect(
      parseCodexSessionStartInput(
        JSON.stringify({
          session_id: sessionId,
          cwd,
          hook_event_name: "SessionStart",
          source: "compact",
        }),
      ),
    ).toBeNull();
    expect(
      parseCodexSessionStartInput(
        JSON.stringify({ session_id: "not-a-uuid", cwd, hook_event_name: "SessionStart" }),
      ),
    ).toBeNull();
    expect(
      parseCodexHookInput(
        JSON.stringify({
          session_id: sessionId,
          cwd,
          turn_id: "turn-1",
          hook_event_name: "PermissionRequest",
          tool_name: "shell",
          tool_input: { command: "must not be forwarded" },
        }),
      ),
    ).toEqual({
      type: "interaction-required",
      sessionId,
      cwd,
      turnId: "turn-1",
    });

    const largePostToolUse = JSON.stringify({
      session_id: sessionId,
      cwd,
      turn_id: "turn-large",
      hook_event_name: "PostToolUse",
      tool_name: "shell",
      tool_input: { command: "must not be forwarded" },
      tool_response: { output: "x".repeat(64 * 1024) },
    });
    expect(Buffer.byteLength(largePostToolUse)).toBeGreaterThan(16 * 1024);
    expect(parseCodexHookInput(largePostToolUse)).toEqual({
      type: "turn-running",
      sessionId,
      cwd,
      turnId: "turn-large",
    });
    expect(parseCodexHookInput("x".repeat(MAX_CODEX_HOOK_INPUT_BYTES + 1))).toBeNull();
  });

  it("delivers startup, resume, and clear IDs over a private pane-scoped Unix socket", async () => {
    const base = await mkdtemp(join(tmpdir(), "naru-codex-hook-"));
    const server = new CodexSessionHookServer({
      dataDirectory: base,
      runner: "/test/bin/node",
      entrypoint: "/test/dist/codex-session-hook-cli.js",
    });
    const events: CodexHookEvent[] = [];
    await server.start();
    try {
      const socketMetadata = await stat(server.socketPath);
      expect(socketMetadata.isSocket()).toBe(true);
      expect(socketMetadata.mode & 0o777).toBe(0o600);
      const registration = server.register({
        paneId,
        runtimeId,
        cwd,
        onEvent: (event) => events.push(event),
      });
      const environment = readCodexSessionHookEnvironment(registration.environment);
      expect(environment).not.toBeNull();
      if (environment === null) throw new Error("hook environment missing");

      for (const source of ["startup", "resume", "clear"] as const) {
        expect(await sendCodexSessionStart({ sessionId, cwd, source }, environment)).toBe(true);
      }
      expect(events).toEqual([
        { type: "session-start", sessionId, cwd, source: "startup" },
        { type: "session-start", sessionId, cwd, source: "resume" },
        { type: "session-start", sessionId, cwd, source: "clear" },
      ]);
      expect(
        await sendCodexHookEvent(
          { type: "turn-start", sessionId, cwd, turnId: "turn-1" },
          environment,
        ),
      ).toBe(true);
      expect(events.at(-1)).toEqual({
        type: "turn-start",
        sessionId,
        cwd,
        turnId: "turn-1",
      });
      if (!("token" in environment)) throw new Error("Expected a legacy hook registration.");

      expect(
        await sendCodexSessionStart(
          { sessionId, cwd, source: "startup" },
          { ...environment, token: `${environment.token}wrong` },
        ),
      ).toBe(false);
      expect(
        await sendCodexSessionStart(
          { sessionId, cwd: "/tmp/other-project", source: "startup" },
          environment,
        ),
      ).toBe(false);

      registration.dispose();
      expect(await sendCodexSessionStart({ sessionId, cwd, source: "startup" }, environment)).toBe(
        false,
      );
      expect(events).toHaveLength(4);
    } finally {
      await server.close();
    }
  });

  it("runs the exact trusted shell command without emitting hook input", async () => {
    const base = await mkdtemp(join(tmpdir(), "naru-codex-hook-command-"));
    const server = new CodexSessionHookServer({
      dataDirectory: base,
      runner: join(process.cwd(), "node_modules/.bin/tsx"),
      entrypoint: fileURLToPath(new URL("../src/codex-session-hook-cli.ts", import.meta.url)),
    });
    const onEvent = vi.fn<(event: CodexHookEvent) => void>();
    await server.start();
    try {
      const registration = server.register({ paneId, runtimeId, cwd, onEvent });
      const result = await runHookCommand(
        JSON.stringify({
          session_id: sessionId,
          transcript_path: "/must/not-be-emitted.jsonl",
          cwd,
          hook_event_name: "SessionStart",
          source: "startup",
        }),
        registration.environment,
      );
      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(onEvent).toHaveBeenCalledWith({
        type: "session-start",
        sessionId,
        cwd,
        source: "startup",
      });
      const postToolUse = await runHookCommand(
        JSON.stringify({
          session_id: sessionId,
          cwd,
          hook_event_name: "PostToolUse",
          turn_id: "turn-1",
          tool_name: "shell",
          tool_input: { command: "must not be emitted" },
          tool_response: { output: "x".repeat(64 * 1024) },
        }),
        registration.environment,
      );
      expect(postToolUse).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(onEvent).toHaveBeenLastCalledWith({
        type: "turn-running",
        sessionId,
        cwd,
        turnId: "turn-1",
      });
      const stop = await runHookCommand(
        JSON.stringify({
          session_id: sessionId,
          cwd,
          hook_event_name: "Stop",
          turn_id: "turn-1",
          last_assistant_message: "must not be emitted",
        }),
        registration.environment,
      );
      expect(stop).toEqual({ exitCode: 0, stdout: "{}\n", stderr: "" });
      expect(onEvent).toHaveBeenLastCalledWith({
        type: "turn-completed",
        sessionId,
        cwd,
        turnId: "turn-1",
      });
      registration.dispose();
    } finally {
      await server.close();
    }
  });

  it("reports safe failure codes while keeping missing and non-executable hooks fatal", async () => {
    const base = await mkdtemp(join(tmpdir(), "naru-codex-hook-failures-"));
    const server = new CodexSessionHookServer({
      dataDirectory: base,
      runner: join(process.cwd(), "node_modules/.bin/tsx"),
      entrypoint: fileURLToPath(new URL("../src/codex-session-hook-cli.ts", import.meta.url)),
    });
    await server.start();
    try {
      const registration = server.register({ paneId, runtimeId, cwd, onEvent: () => undefined });
      const validInput = JSON.stringify({
        session_id: sessionId,
        cwd,
        hook_event_name: "PostToolUse",
        turn_id: "turn-failure",
      });

      expect(await runHookCommand("{not-json", registration.environment)).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: "NARU_CODEX_HOOK_INPUT_INVALID\n",
      });
      expect(
        await runHookCommand("x".repeat(MAX_CODEX_HOOK_INPUT_BYTES + 1), registration.environment),
      ).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: "NARU_CODEX_HOOK_INPUT_TOO_LARGE\n",
      });
      expect(
        await runHookCommand(validInput, {
          ...registration.environment,
          NARU_CODEX_HOOK_TOKEN: "short",
        }),
      ).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: "NARU_CODEX_HOOK_ENVIRONMENT_INVALID\n",
      });
      expect(
        await runHookCommand(validInput, {
          ...registration.environment,
          NARU_CODEX_HOOK_TOKEN: "a".repeat(43),
        }),
      ).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: "NARU_CODEX_HOOK_DELIVERY_FAILED\n",
      });

      const missing = await runHookCommand(validInput, {
        ...registration.environment,
        NARU_CODEX_HOOK_RUNNER: join(base, "missing-runner"),
      });
      expect(missing.exitCode).not.toBe(0);
      expect(missing.stdout).toBe("");
      expect(missing.stderr.length).toBeGreaterThan(0);

      const nonExecutableRunner = join(base, "non-executable-runner");
      await writeFile(nonExecutableRunner, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
      const denied = await runHookCommand(validInput, {
        ...registration.environment,
        NARU_CODEX_HOOK_RUNNER: nonExecutableRunner,
      });
      expect(denied.exitCode).not.toBe(0);
      expect(denied.stdout).toBe("");
      expect(denied.stderr.length).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  it("keeps a durable Codex hook observational during a Naru socket outage", async () => {
    const base = await mkdtemp(join(tmpdir(), "naru-durable-hook-outage-"));
    const result = await runHookCommand(
      JSON.stringify({
        session_id: sessionId,
        cwd,
        hook_event_name: "PermissionRequest",
        turn_id: "turn-during-naru-restart",
      }),
      {
        NARU_CODEX_HOOK_RUNNER: join(process.cwd(), "node_modules/.bin/tsx"),
        NARU_CODEX_HOOK_ENTRY: fileURLToPath(
          new URL("../src/codex-session-hook-cli.ts", import.meta.url),
        ),
        NARU_CODEX_HOOK_SOCKET: join(base, "unavailable.sock"),
        NARU_CODEX_HOOK_BOOTSTRAP: "b".repeat(64),
      },
    );

    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("keeps the fake Codex completion lifecycle through a large PostToolUse payload", async () => {
    const base = await mkdtemp(join(tmpdir(), "naru-codex-hook-fake-"));
    const projectDirectory = join(base, "project");
    await mkdir(projectDirectory);
    const fakeCwd = await realpath(projectDirectory);
    const server = new CodexSessionHookServer({
      dataDirectory: base,
      runner: join(process.cwd(), "node_modules/.bin/tsx"),
      entrypoint: fileURLToPath(new URL("../src/codex-session-hook-cli.ts", import.meta.url)),
    });
    const events: CodexHookEvent[] = [];
    await server.start();
    const registration = server.register({
      paneId,
      runtimeId,
      cwd: fakeCwd,
      onEvent: (event) => events.push(event),
    });
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../../../tests/fixtures/fake-codex.mjs", import.meta.url))],
      {
        cwd: fakeCwd,
        env: { ...process.env, ...registration.environment },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    try {
      await vi.waitFor(() => expect(stdout).toContain("FAKE_CODEX_READY"));
      expect(stdout).not.toContain("FAKE_CODEX_HOOK_FAILED");
      child.stdin.write("/naru-e2e-complete\n");
      await vi.waitFor(() =>
        expect(events.map((event) => event.type)).toEqual([
          "session-start",
          "turn-start",
          "turn-running",
          "turn-completed",
        ]),
      );
      expect(stdout).not.toContain("FAKE_CODEX_HOOK_FAILED");
      expect(events.at(-2)).toEqual({
        type: "turn-running",
        sessionId: "11111111-1111-4111-8111-111111111111",
        cwd: fakeCwd,
        turnId: "naru-e2e-completed-turn-1",
      });
    } finally {
      registration.dispose();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await waitForChildExit(child);
      await server.close();
    }
  });

  it("does not replace an active or non-socket runtime path", async () => {
    const activeBase = await mkdtemp(join(tmpdir(), "naru-codex-hook-active-"));
    const active = new CodexSessionHookServer({
      dataDirectory: activeBase,
      runner: "/test/bin/node",
      entrypoint: "/test/hook.js",
    });
    const competing = new CodexSessionHookServer({
      dataDirectory: activeBase,
      runner: "/test/bin/node",
      entrypoint: "/test/hook.js",
    });
    await active.start();
    try {
      await expect(competing.start()).rejects.toThrow(/already running/);
    } finally {
      await active.close();
    }

    const fileBase = await mkdtemp(join(tmpdir(), "naru-codex-hook-file-"));
    const runtimeDirectory = join(fileBase, "runtime");
    await mkdir(runtimeDirectory, { mode: 0o700 });
    const collision = join(runtimeDirectory, "codex-hook.sock");
    await writeFile(collision, "keep", { mode: 0o600 });
    const blocked = new CodexSessionHookServer({
      dataDirectory: fileBase,
      runner: "/test/bin/node",
      entrypoint: "/test/hook.js",
    });
    await expect(blocked.start()).rejects.toThrow(/non-socket/);
    expect(await stat(collision)).toEqual(expect.objectContaining({ size: 4 }));
  });

  it("requires all pane capability environment values", () => {
    const environment = {
      NARU_CODEX_HOOK_SOCKET: "/tmp/naru.sock",
      NARU_CODEX_HOOK_PANE_ID: paneId,
      NARU_CODEX_HOOK_RUNTIME_ID: runtimeId,
      NARU_CODEX_HOOK_TOKEN: "a".repeat(43),
    };
    expect(readCodexSessionHookEnvironment(environment)).toEqual({
      socketPath: "/tmp/naru.sock",
      paneId,
      runtimeId,
      token: "a".repeat(43),
    });
    expect(
      readCodexSessionHookEnvironment({ ...environment, NARU_CODEX_HOOK_TOKEN: undefined }),
    ).toBeNull();
  });
});

function runHookCommand(
  input: string,
  environment: Readonly<Record<string, string>>,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.SHELL ?? "/bin/zsh", ["-lc", CODEX_SESSION_HOOK_COMMAND], {
      env: { ...process.env, ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve({ exitCode, stdout, stderr }));
    child.stdin.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin.end(input);
  });
}

function waitForChildExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}
