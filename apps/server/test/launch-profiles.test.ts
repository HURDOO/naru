import { describe, expect, it, vi } from "vitest";
import type { Pane } from "@naru/contracts";
import { CLAUDE_ACTIVITY_HOOK_COMMAND } from "../src/claude-activity-hook-client.js";
import { CODEX_SESSION_HOOK_COMMAND } from "../src/codex-session-hook.js";
import type { PaneContext } from "../src/database.js";
import {
  LaunchProfileRegistry,
  type CommandResult,
  type CommandRunner,
} from "../src/launch-profiles.js";

const projectPath = "/tmp/naru-launch-profile";
const environment: NodeJS.ProcessEnv = {
  PATH: "/bin:/usr/bin",
  SHELL: "/bin/zsh",
  OPENAI_API_KEY: "test-only-api-key",
  NARU_SESSION_SECRET: "must-not-reach-a-child",
  NO_COLOR: "1",
};
const expectedSessionHookOverride =
  'hooks.SessionStart=[{matcher="^(startup|resume|clear)$",hooks=[{type="command",command="\\"$NARU_CODEX_HOOK_RUNNER\\" \\"$NARU_CODEX_HOOK_ENTRY\\"",timeout=3}]}]';
const expectedHookCommand =
  'hooks=[{type="command",command="\\"$NARU_CODEX_HOOK_RUNNER\\" \\"$NARU_CODEX_HOOK_ENTRY\\"",timeout=3}]';
const expectedHookArguments = [
  "--config",
  expectedSessionHookOverride,
  "--config",
  `hooks.UserPromptSubmit=[{${expectedHookCommand}}]`,
  "--config",
  `hooks.PermissionRequest=[{matcher=".*",${expectedHookCommand}}]`,
  "--config",
  `hooks.PostToolUse=[{matcher=".*",${expectedHookCommand}}]`,
  "--config",
  `hooks.Stop=[{${expectedHookCommand}}]`,
];

describe("LaunchProfileRegistry", () => {
  it("launches an authenticated Claude Code pane and rejects missing authentication", () => {
    const runner = vi.fn<CommandRunner>(() => ({
      stdout: '{"loggedIn":true}',
      stderr: "",
      status: 0,
    }));
    const registry = new LaunchProfileRegistry({
      claudeExecutable: "/bin/sh",
      environment,
      commandRunner: runner,
    });
    expect(registry.resolve(context("claude", "claude-code"))).toMatchObject({
      file: "/bin/sh",
      args: [],
    });
    expect(runner).toHaveBeenCalledWith("/bin/sh", ["auth", "status"], expect.any(Object));
    expect(() => registry.resolve(context("claude", "other"))).toThrowError(
      expect.objectContaining({ code: "REQUEST_INVALID" }),
    );
    const loggedOut = new LaunchProfileRegistry({
      claudeExecutable: "/bin/sh",
      environment,
      commandRunner: () => ({ stdout: '{"loggedIn":false}', stderr: "secret", status: 1 }),
    });
    expect(() => loggedOut.resolve(context("claude", "claude-code"))).toThrowError(
      expect.objectContaining({ code: "CLAUDE_AUTH_REQUIRED" }),
    );
    const missing = new LaunchProfileRegistry({
      claudeExecutable: "/tmp/naru-definitely-missing-claude",
      environment,
    });
    expect(() => missing.resolve(context("claude", "claude-code"))).toThrowError(
      expect.objectContaining({ code: "CLAUDE_EXECUTABLE_MISSING" }),
    );
  });
  it("adds observation-only Claude hooks only when explicitly configured", () => {
    const registry = new LaunchProfileRegistry({
      claudeExecutable: "/bin/sh",
      claudeActivityHookCommand: CLAUDE_ACTIVITY_HOOK_COMMAND,
      environment,
      commandRunner: () => ({ stdout: '{"loggedIn":true}', stderr: "", status: 0 }),
    });
    const launch = registry.resolve(context("claude", "claude-code"));
    expect(launch.args[0]).toBe("--settings");
    const settings = JSON.parse(launch.args[1] ?? "") as {
      hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
    };
    expect(Object.keys(settings.hooks)).toHaveLength(12);
    expect(settings.hooks.PermissionRequest?.[0]?.hooks[0]).toEqual(
      expect.objectContaining({ type: "command", command: CLAUDE_ACTIVITY_HOOK_COMMAND }),
    );
    expect(launch.args.join(" ")).not.toContain("test-only-api-key");
  });
  it("reopens the stored Claude conversation and ignores a malformed stored ID", () => {
    const registry = new LaunchProfileRegistry({
      claudeExecutable: "/bin/sh",
      claudeActivityHookCommand: CLAUDE_ACTIVITY_HOOK_COMMAND,
      environment,
      commandRunner: () => ({ stdout: '{"loggedIn":true}', stderr: "", status: 0 }),
    });
    const conversation = "33333333-3333-4333-8333-333333333333";
    const resume = context("claude", "claude-code");
    resume.pane.claudeSessionId = conversation;
    expect(registry.resolve(resume).args.slice(-2)).toEqual(["--resume", conversation]);

    const fresh = context("claude", "claude-code");
    expect(registry.resolve(fresh).args).not.toContain("--resume");
    fresh.pane.claudeSessionId = "--dangerously-skip-permissions";
    expect(registry.resolve(fresh).args).not.toContain("--resume");
    expect(registry.resolve(fresh).args).not.toContain("--dangerously-skip-permissions");
  });
  it("resolves the two approved Codex profiles as structured spawn arguments", () => {
    const runner = vi.fn<CommandRunner>(() => doctorResult());
    let now = 1_000;
    const registry = new LaunchProfileRegistry({
      codexExecutable: "/bin/sh",
      codexSessionHookCommand: CODEX_SESSION_HOOK_COMMAND,
      environment,
      commandRunner: runner,
      now: () => now,
    });

    const main = registry.resolve(context("codex", "codex-main"));
    expect(main).toMatchObject({
      file: "/bin/sh",
      args: [
        "--model",
        "gpt-5.6-sol",
        "--config",
        'model_reasoning_effort="xhigh"',
        "--config",
        'service_tier="default"',
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "on-request",
        ...expectedHookArguments,
      ],
    });
    expect(main.environment.NARU_PTY_HOSTED).toBe("1");
    expect(main.environment.NARU_SESSION_SECRET).toBeUndefined();
    expect(runner).toHaveBeenCalledTimes(1);
    const doctorCall = runner.mock.calls[0];
    expect(doctorCall?.[0]).toBe("/bin/sh");
    expect(doctorCall?.[1]).toEqual(["doctor", "--json"]);
    expect(doctorCall?.[2].cwd).toBe(projectPath);
    expect(doctorCall?.[2].env).toMatchObject({
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      NARU_PTY_HOSTED: "1",
    });

    now += 1;
    const quick = registry.resolve(context("codex", "codex-quick"));
    expect(quick.args).toEqual([
      "--model",
      "gpt-5.6-luna",
      "--config",
      'model_reasoning_effort="medium"',
      "--config",
      'service_tier="default"',
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "on-request",
      ...expectedHookArguments,
    ]);
    expect(runner).toHaveBeenCalledTimes(1);

    const resumed = registry.resolve(
      context("codex", "codex-main", "33333333-3333-4333-8333-333333333333"),
    );
    expect(resumed.args.slice(-2)).toEqual(["resume", "33333333-3333-4333-8333-333333333333"]);

    const identifiedOnly = registry.resolve(
      context("codex", "codex-main", "44444444-4444-4444-8444-444444444444", false),
    );
    expect(identifiedOnly.args).not.toContain("resume");
  });

  it("starts only the allowlisted login shell and strips Naru configuration from children", () => {
    const runner = vi.fn<CommandRunner>();
    const registry = new LaunchProfileRegistry({ environment, commandRunner: runner });

    const launch = registry.resolve(context("terminal", "shell"));

    expect(launch).toMatchObject({ file: "/bin/zsh", args: ["-l"] });
    expect(launch.environment.OPENAI_API_KEY).toBe("test-only-api-key");
    expect(launch.environment.NARU_SESSION_SECRET).toBeUndefined();
    expect(launch.environment.NARU_PTY_HOSTED).toBe("1");
    expect(launch.environment.NO_COLOR).toBeUndefined();
    expect(runner).not.toHaveBeenCalled();
    expect(() => registry.resolve(context("terminal", "not-a-shell"))).toThrowError(
      expect.objectContaining({ code: "REQUEST_INVALID" }),
    );
    expect(() => registry.resolve(context("codex", "from-web-input"))).toThrowError(
      expect.objectContaining({ code: "CODEX_CONFIG_INVALID" }),
    );
  });

  it.each([
    ["installation", "fail", "CODEX_EXECUTABLE_MISSING"],
    ["auth.credentials", "fail", "CODEX_AUTH_REQUIRED"],
    ["config.load", "fail", "CODEX_CONFIG_INVALID"],
  ] as const)(
    "maps a failed %s check to %s without exposing doctor output",
    (check, status, code) => {
      const registry = new LaunchProfileRegistry({
        codexExecutable: "/bin/sh",
        environment,
        commandRunner: () => doctorResult({ [check]: status }, "secret diagnostic detail"),
        now: () => 1_000,
      });

      expect(() => registry.resolve(context("codex", "codex-main"))).toThrowError(
        expect.objectContaining({ code }),
      );
      try {
        registry.resolve(context("codex", "codex-main"));
      } catch (error) {
        expect(String(error)).not.toContain("secret diagnostic detail");
      }
    },
  );

  it("distinguishes a missing executable and an unreadable diagnostic report", () => {
    const missing = new LaunchProfileRegistry({
      codexExecutable: "/tmp/naru-definitely-missing-codex",
      environment,
    });
    expect(() => missing.resolve(context("codex", "codex-main"))).toThrowError(
      expect.objectContaining({ code: "CODEX_EXECUTABLE_MISSING" }),
    );

    const malformed = new LaunchProfileRegistry({
      codexExecutable: "/bin/sh",
      environment,
      commandRunner: () => ({ stdout: "not-json", stderr: "", status: 1 }),
      now: () => 1_000,
    });
    expect(() => malformed.resolve(context("codex", "codex-main"))).toThrowError(
      expect.objectContaining({ code: "CODEX_CONFIG_INVALID" }),
    );
  });
});

function context(
  kind: Pane["kind"],
  launchProfile: string,
  codexSessionId: string | null = null,
  codexSessionResumable = codexSessionId !== null,
): PaneContext {
  const now = "2026-08-17T00:00:00.000Z";
  return {
    projectPath,
    pane: {
      id: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
      kind,
      title: "Test Pane",
      launchProfile,
      status: "stopped",
      exitCode: null,
      codexSessionId,
      codexSessionResumable,
      lastErrorCode: null,
      lastExitedAt: null,
      activity: { state: "idle", eventId: null, runtimeId: null, revision: 0, updatedAt: now },
      viewState: {
        selectedDocumentPath: null,
        navigationOpen: true,
        expandedDirectories: [],
      },
      createdAt: now,
      updatedAt: now,
    },
  };
}

function doctorResult(
  overrides: Readonly<Record<string, string>> = {},
  stderr = "",
): CommandResult {
  const status = (id: string): string => overrides[id] ?? "ok";
  return {
    stdout: JSON.stringify({
      checks: {
        installation: { status: status("installation") },
        "auth.credentials": { status: status("auth.credentials") },
        "config.load": { status: status("config.load") },
      },
    }),
    stderr,
    status: 0,
  };
}
