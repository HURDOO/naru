import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  ClaudeSessionIdSchema,
  CodexSessionIdSchema,
  type CodexLaunchProfile,
} from "@naru/contracts";
import type { PaneContext } from "./database.js";
import { claudeActivityHookSettings } from "./claude-activity-events.js";
import { AppError } from "./errors.js";

const CODEX_CHECK_TTL_MS = 30_000;
const DOCTOR_TIMEOUT_MS = 15_000;
const DOCTOR_MAX_BUFFER = 2 * 1024 * 1024;
const NARU_PTY_HOSTED_ENVIRONMENT_KEY = "NARU_PTY_HOSTED";

interface CodexProfileDefinition {
  readonly id: CodexLaunchProfile;
  readonly model: "gpt-5.6-sol" | "gpt-5.6-luna";
  readonly reasoningEffort: "xhigh" | "medium";
  readonly serviceTier: "default";
}

const CODEX_PROFILES: Readonly<Record<CodexLaunchProfile, CodexProfileDefinition>> = {
  "codex-main": {
    id: "codex-main",
    model: "gpt-5.6-sol",
    reasoningEffort: "xhigh",
    serviceTier: "default",
  },
  "codex-quick": {
    id: "codex-quick",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    serviceTier: "default",
  },
};

export interface PaneLaunchCommand {
  readonly file: string;
  readonly args: string[];
  readonly environment: Record<string, string>;
}

export interface PaneLaunchResolver {
  resolve(context: PaneContext): PaneLaunchCommand;
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
  readonly error?: Error;
}

export type CommandRunner = (
  file: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string> },
) => CommandResult;

export interface LaunchProfileRegistryOptions {
  readonly codexExecutable?: string;
  readonly claudeExecutable?: string;
  readonly claudeActivityHookCommand?: string;
  readonly codexSessionHookCommand?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly commandRunner?: CommandRunner;
  readonly now?: () => number;
}

export class LaunchProfileRegistry implements PaneLaunchResolver {
  readonly #codexExecutable: string | undefined;
  readonly #claudeExecutable: string | undefined;
  readonly #claudeActivityHookCommand: string | undefined;
  readonly #codexSessionHookCommand: string | undefined;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #commandRunner: CommandRunner;
  readonly #now: () => number;
  #codexCheckedAt = 0;

  constructor(options: LaunchProfileRegistryOptions = {}) {
    this.#codexExecutable = options.codexExecutable;
    this.#claudeExecutable = options.claudeExecutable;
    this.#claudeActivityHookCommand = options.claudeActivityHookCommand;
    this.#codexSessionHookCommand = options.codexSessionHookCommand;
    this.#environment = options.environment ?? process.env;
    this.#commandRunner = options.commandRunner ?? runCommand;
    this.#now = options.now ?? Date.now;
  }

  resolve(context: PaneContext): PaneLaunchCommand {
    const environment = childEnvironment(this.#environment);
    if (context.pane.kind === "terminal") {
      if (context.pane.launchProfile !== "shell") {
        throw new AppError("REQUEST_INVALID", 409, "허용되지 않은 터미널 실행 프로필입니다.");
      }
      return { file: resolveShell(this.#environment), args: ["-l"], environment };
    }

    if (context.pane.kind === "claude") {
      if (context.pane.launchProfile !== "claude-code") {
        throw new AppError("REQUEST_INVALID", 409, "허용되지 않은 Claude Code 실행 프로필입니다.");
      }
      const executable = resolveClaudeExecutable(this.#claudeExecutable, this.#environment);
      const status = this.#commandRunner(executable, ["auth", "status"], {
        cwd: context.projectPath,
        env: environment,
      });
      if (status.error || status.status !== 0 || !isClaudeAuthenticated(status.stdout)) {
        throw new AppError(
          "CLAUDE_AUTH_REQUIRED",
          503,
          "Claude Code 인증이 필요합니다. Mac mini에서 claude auth login을 완료해 주세요.",
        );
      }
      const args =
        this.#claudeActivityHookCommand === undefined
          ? []
          : ["--settings", claudeActivityHookSettings(this.#claudeActivityHookCommand)];
      const sessionId = ClaudeSessionIdSchema.safeParse(context.pane.claudeSessionId);
      if (sessionId.success) args.push("--resume", sessionId.data);
      return { file: executable, args, environment };
    }

    if (context.pane.kind !== "codex") {
      throw new AppError("REQUEST_INVALID", 400, "읽기 전용 Pane은 프로세스를 실행하지 않습니다.");
    }

    const profile = codexProfile(context.pane.launchProfile);
    const executable = resolveCodexExecutable(this.#codexExecutable, this.#environment);
    this.#ensureCodexAvailable(executable, context.projectPath, environment);
    return {
      file: executable,
      args: codexArguments(
        profile,
        context.pane.codexSessionResumable ? context.pane.codexSessionId : null,
        this.#codexSessionHookCommand,
      ),
      environment,
    };
  }

  #ensureCodexAvailable(
    executable: string,
    cwd: string,
    environment: Record<string, string>,
  ): void {
    const now = this.#now();
    if (this.#codexCheckedAt > 0 && now - this.#codexCheckedAt < CODEX_CHECK_TTL_MS) return;

    const result = this.#commandRunner(executable, ["doctor", "--json"], {
      cwd,
      env: environment,
    });
    if (isMissingExecutableError(result.error)) throwCodexExecutableMissing();
    if (result.error) {
      throw new AppError(
        "CODEX_CONFIG_INVALID",
        503,
        "Codex 설정 상태를 확인하지 못했습니다. Mac mini에서 codex doctor를 실행해 주세요.",
      );
    }

    const report = parseDoctorReport(result.stdout);
    if (checkStatus(report, "installation") !== "ok") throwCodexExecutableMissing();
    if (checkStatus(report, "auth.credentials") !== "ok") {
      throw new AppError(
        "CODEX_AUTH_REQUIRED",
        503,
        "Codex 인증이 필요합니다. Mac mini에서 codex login을 완료해 주세요.",
      );
    }
    if (checkStatus(report, "config.load") !== "ok") {
      throw new AppError(
        "CODEX_CONFIG_INVALID",
        503,
        "Codex 설정을 읽지 못했습니다. Mac mini에서 codex doctor를 실행해 주세요.",
      );
    }
    this.#codexCheckedAt = now;
  }
}

function resolveClaudeExecutable(
  configured: string | undefined,
  environment: NodeJS.ProcessEnv,
): string {
  if (configured !== undefined && isAbsolute(configured) && isExecutableFile(configured))
    return configured;
  if (configured === undefined) {
    for (const directory of (environment.PATH ?? "").split(":")) {
      if (!directory) continue;
      const candidate = join(directory, "claude");
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  throw new AppError(
    "CLAUDE_EXECUTABLE_MISSING",
    503,
    "Claude Code CLI 설치 경로를 확인해 주세요.",
  );
}

function isClaudeAuthenticated(output: string): boolean {
  try {
    const value: unknown = JSON.parse(output);
    return (
      typeof value === "object" && value !== null && "loggedIn" in value && value.loggedIn === true
    );
  } catch {
    return false;
  }
}

function codexProfile(profileId: string): CodexProfileDefinition {
  if (profileId === "codex-main" || profileId === "codex-quick") {
    return CODEX_PROFILES[profileId];
  }
  throw new AppError("CODEX_CONFIG_INVALID", 409, "허용된 Codex 실행 프로필을 찾을 수 없습니다.");
}

function codexArguments(
  profile: CodexProfileDefinition,
  codexSessionId: string | null,
  sessionHookCommand: string | undefined,
): string[] {
  const args: string[] = [
    "--model",
    profile.model,
    "--config",
    `model_reasoning_effort="${profile.reasoningEffort}"`,
    "--config",
    `service_tier="${profile.serviceTier}"`,
    "--sandbox",
    "workspace-write",
    "--ask-for-approval",
    "on-request",
  ];
  if (sessionHookCommand !== undefined) {
    for (const override of codexHookOverrides(sessionHookCommand)) {
      args.push("--config", override);
    }
  }
  if (codexSessionId !== null) {
    const parsedSessionId = CodexSessionIdSchema.safeParse(codexSessionId);
    if (!parsedSessionId.success) {
      throw new AppError(
        "CODEX_CONFIG_INVALID",
        409,
        "저장된 Codex session ID가 올바르지 않습니다.",
      );
    }
    args.push("resume", parsedSessionId.data);
  }
  return args;
}

function codexHookOverrides(command: string): string[] {
  if (command.length === 0 || command.length > 1_024 || /[\r\n\0]/.test(command)) {
    throw new AppError("CODEX_CONFIG_INVALID", 500, "Codex session hook 설정이 올바르지 않습니다.");
  }
  const escapedCommand = command.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const commandHook = `hooks=[{type="command",command="${escapedCommand}",timeout=3}]`;
  return [
    `hooks.SessionStart=[{matcher="^(startup|resume|clear)$",${commandHook}}]`,
    `hooks.UserPromptSubmit=[{${commandHook}}]`,
    `hooks.PermissionRequest=[{matcher=".*",${commandHook}}]`,
    `hooks.PostToolUse=[{matcher=".*",${commandHook}}]`,
    `hooks.Stop=[{${commandHook}}]`,
  ];
}

function resolveCodexExecutable(
  configured: string | undefined,
  environment: NodeJS.ProcessEnv,
): string {
  if (configured !== undefined) {
    if (!isAbsolute(configured) || !isExecutableFile(configured)) throwCodexExecutableMissing();
    return configured;
  }

  for (const directory of (environment.PATH ?? "").split(":")) {
    if (!directory) continue;
    const candidate = join(directory, "codex");
    if (isExecutableFile(candidate)) return candidate;
  }
  return throwCodexExecutableMissing();
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function throwCodexExecutableMissing(): never {
  throw new AppError(
    "CODEX_EXECUTABLE_MISSING",
    503,
    "Codex CLI를 찾을 수 없습니다. Mac mini의 설치 상태를 확인해 주세요.",
  );
}

function isMissingExecutableError(error: Error | undefined): boolean {
  return error !== undefined && "code" in error && error.code === "ENOENT";
}

function parseDoctorReport(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new AppError(
      "CODEX_CONFIG_INVALID",
      503,
      "Codex 진단 결과를 읽지 못했습니다. Codex CLI를 업데이트해 주세요.",
    );
  }
}

function checkStatus(report: unknown, checkId: string): string | undefined {
  if (!isRecord(report) || !isRecord(report.checks)) return undefined;
  const check = report.checks[checkId];
  if (!isRecord(check) || typeof check.status !== "string") return undefined;
  return check.status;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveShell(environment: NodeJS.ProcessEnv): string {
  const configured = environment.SHELL;
  return configured?.startsWith("/") ? configured : "/bin/zsh";
}

function childEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !key.startsWith("NARU_")) environment[key] = value;
  }
  environment.TERM = "xterm-256color";
  environment.COLORTERM = "truecolor";
  environment[NARU_PTY_HOSTED_ENVIRONMENT_KEY] = "1";
  delete environment.NO_COLOR;
  return environment;
}

function runCommand(
  file: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string> },
): CommandResult {
  const result = spawnSync(file, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: DOCTOR_TIMEOUT_MS,
    maxBuffer: DOCTOR_MAX_BUFFER,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}
