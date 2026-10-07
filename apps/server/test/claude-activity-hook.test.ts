import { spawn } from "node:child_process";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  claudeActivityHookSettings,
  MAX_CLAUDE_HOOK_INPUT_BYTES,
  parseClaudeActivityHookInput,
  type ClaudeActivityEvent,
} from "../src/claude-activity-events.js";
import {
  CLAUDE_ACTIVITY_HOOK_COMMAND,
  readClaudeHookEnvironment,
  sendClaudeActivityEvent,
} from "../src/claude-activity-hook-client.js";
import { CodexSessionHookServer } from "../src/codex-session-hook.js";

const paneId = "11111111-1111-4111-8111-111111111111";
const runtimeId = "22222222-2222-4222-8222-222222222222";
const cwd = "/tmp/naru-claude-hook-project";

describe("Claude activity hook", () => {
  it("maps official main-agent events to redacted lifecycle signals", () => {
    const base = { session_id: "session-1", cwd, transcript_path: "/must-not-forward" };
    const cases = [
      ["SessionStart", "session-start"],
      ["UserPromptSubmit", "turn-start"],
      ["PermissionRequest", "interaction-required"],
      ["PostToolUse", "turn-running"],
      ["PostToolUseFailure", "turn-running"],
      ["PermissionDenied", "turn-running"],
      ["Elicitation", "interaction-required"],
      ["ElicitationResult", "turn-running"],
      ["Stop", "turn-completed"],
      ["StopFailure", "turn-failed"],
      ["SessionEnd", "session-end"],
    ] as const;
    for (const [hook_event_name, type] of cases) {
      expect(
        parseClaudeActivityHookInput(
          JSON.stringify({
            ...base,
            hook_event_name,
            prompt: "private prompt",
            tool_input: { command: "private command" },
            tool_response: "private result",
            last_assistant_message: "private response",
          }),
        ),
      ).toEqual({ type, sessionId: "session-1", cwd });
    }
    expect(
      parseClaudeActivityHookInput(
        JSON.stringify({
          ...base,
          hook_event_name: "Notification",
          notification_type: "permission_prompt",
        }),
      )?.type,
    ).toBe("interaction-required");
    expect(
      parseClaudeActivityHookInput(
        JSON.stringify({
          ...base,
          hook_event_name: "Notification",
          notification_type: "idle_prompt",
        }),
      ),
    ).toBeNull();
    expect(
      parseClaudeActivityHookInput(
        JSON.stringify({ ...base, hook_event_name: "Stop", agent_id: "subagent" }),
      ),
    ).toBeNull();
    expect(parseClaudeActivityHookInput("{")).toBeNull();
    expect(parseClaudeActivityHookInput("x".repeat(MAX_CLAUDE_HOOK_INPUT_BYTES + 1))).toBeNull();
  });

  it("generates side-effect-only handlers for every observed event", () => {
    const settings = JSON.parse(claudeActivityHookSettings(CLAUDE_ACTIVITY_HOOK_COMMAND)) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; type: string }> }>>;
    };
    expect(Object.keys(settings.hooks)).toEqual(
      expect.arrayContaining(["SessionStart", "UserPromptSubmit", "PermissionRequest", "Stop"]),
    );
    expect(Object.keys(settings.hooks)).toHaveLength(12);
    for (const entries of Object.values(settings.hooks)) {
      expect(entries[0]?.hooks[0]).toMatchObject({
        type: "command",
        command: CLAUDE_ACTIVITY_HOOK_COMMAND,
      });
    }
  });

  it("accepts only a current pane capability on the private socket", async () => {
    const base = await mkdtemp(join(tmpdir(), "naru-claude-hook-"));
    const server = new CodexSessionHookServer({
      dataDirectory: base,
      runner: process.execPath,
      entrypoint: "/test/codex-hook.js",
      claudeEntrypoint: "/test/claude-hook.js",
    });
    const received: ClaudeActivityEvent[] = [];
    await server.start();
    try {
      const socket = await stat(server.socketPath);
      expect(socket.isSocket()).toBe(true);
      expect(socket.mode & 0o777).toBe(0o600);
      const registration = server.registerClaude({
        paneId,
        runtimeId,
        cwd,
        onEvent: (event) => received.push(event),
      });
      const environment = readClaudeHookEnvironment(registration.environment);
      if (environment === null) throw new Error("Claude hook environment is missing.");
      const event: ClaudeActivityEvent = { type: "turn-start", sessionId: "session-1", cwd };
      expect(await sendClaudeActivityEvent(event, environment)).toBe(true);
      expect(received).toEqual([event]);
      expect(
        await sendClaudeActivityEvent(event, {
          ...environment,
          token: `${environment.token}wrong`,
        }),
      ).toBe(false);
      expect(await sendClaudeActivityEvent({ ...event, cwd: "/tmp/other" }, environment)).toBe(
        false,
      );
      expect(
        await sendClaudeActivityEvent(event, {
          ...environment,
          runtimeId: "33333333-3333-4333-8333-333333333333",
        }),
      ).toBe(false);
      registration.dispose();
      expect(await sendClaudeActivityEvent(event, environment)).toBe(false);
      expect(received).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("runs the CLI without echoing sensitive hook fields", async () => {
    const base = await mkdtemp(join(tmpdir(), "naru-claude-hook-cli-"));
    const server = new CodexSessionHookServer({
      dataDirectory: base,
      runner: join(process.cwd(), "node_modules/.bin/tsx"),
      entrypoint: "/test/codex-hook.js",
      claudeEntrypoint: fileURLToPath(
        new URL("../src/claude-activity-hook-cli.ts", import.meta.url),
      ),
    });
    const received: ClaudeActivityEvent[] = [];
    await server.start();
    try {
      const registration = server.registerClaude({
        paneId,
        runtimeId,
        cwd,
        onEvent: (event) => received.push(event),
      });
      const result = await runHook(
        JSON.stringify({
          session_id: "session-1",
          cwd,
          hook_event_name: "UserPromptSubmit",
          prompt: "private prompt",
          transcript_path: "/must/not/be-emitted.jsonl",
        }),
        registration.environment,
      );
      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(received).toEqual([{ type: "turn-start", sessionId: "session-1", cwd }]);
      registration.dispose();
    } finally {
      await server.close();
    }
  });
});

function runHook(
  input: string,
  environment: Readonly<Record<string, string>>,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      environment.NARU_CLAUDE_HOOK_RUNNER ?? process.execPath,
      [environment.NARU_CLAUDE_HOOK_ENTRY ?? ""],
      { env: { ...process.env, ...environment }, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    child.stdin.end(input);
  });
}
