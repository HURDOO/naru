import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

type Role = "app-server" | "tui";
type GuardianMessage =
  | { readonly type: "started"; readonly role: Role }
  | { readonly type: "spawn-error"; readonly role: Role }
  | {
      readonly type: "exit";
      readonly role: Role;
      readonly code: number | null;
      readonly signal: string | null;
    };

const STOP_TIMEOUT_MS = 3_000;

/** The guardian owns the actual child handles and reaps them on parent IPC EOF. */
export class CodexInteractionGuardian {
  readonly #process: ChildProcess;
  readonly #started = new Map<Role, { resolve: () => void; reject: () => void }>();
  readonly #exitListeners = new Map<Role, (code: number | null, signal: string | null) => void>();
  #stopped = false;
  #stopPromise: Promise<void> | null = null;

  constructor(
    onFailure: () => void,
    launcherEntry = process.argv[1],
    execArgv: readonly string[] = process.execArgv,
  ) {
    if (launcherEntry === undefined) throw new Error("Codex guardian entry is unavailable.");
    this.#process = spawn(process.execPath, [...execArgv, launcherEntry, "--guardian"], {
      detached: false,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: { NARU_CODEX_GUARDIAN_MODE: "1" },
    });
    this.#process.on("message", (unknownMessage: unknown) => {
      const message = parseMessage(unknownMessage);
      if (message === null) return;
      if (message.type === "started" || message.type === "spawn-error") {
        const pending = this.#started.get(message.role);
        if (pending === undefined) return;
        this.#started.delete(message.role);
        if (message.type === "started") pending.resolve();
        else pending.reject();
      } else {
        this.#exitListeners.get(message.role)?.(message.code, message.signal);
      }
    });
    this.#process.once("error", () => {
      this.#rejectStarts();
      if (!this.#stopped) onFailure();
    });
    this.#process.once("exit", () => {
      this.#rejectStarts();
      if (!this.#stopped) onFailure();
    });
  }

  async start(
    role: Role,
    executable: string,
    args: readonly string[],
    cwd: string,
    environment: NodeJS.ProcessEnv,
  ): Promise<void> {
    if (this.#stopped || !this.#process.connected || this.#started.has(role)) {
      throw new Error("Codex guardian is unavailable.");
    }
    const started = new Promise<void>((resolve, reject) => {
      this.#started.set(role, { resolve, reject });
    });
    this.#process.send({ type: "spawn", role, executable, args, cwd, environment }, (error) => {
      if (error) {
        this.#started.get(role)?.reject();
        this.#started.delete(role);
      }
    });
    await started;
  }

  onExit(role: Role, listener: (code: number | null, signal: string | null) => void): void {
    this.#exitListeners.set(role, listener);
  }

  async stop(): Promise<void> {
    if (this.#stopPromise !== null) return this.#stopPromise;
    this.#stopPromise = this.#stop();
    return this.#stopPromise;
  }

  async #stop(): Promise<void> {
    this.#stopped = true;
    this.#rejectStarts();
    if (this.#process.exitCode !== null || this.#process.signalCode !== null) return;
    if (this.#process.connected) {
      try {
        this.#process.send({ type: "stop" }, () => undefined);
      } catch {
        /* The IPC EOF also makes the guardian stop its children. */
      }
    }
    await Promise.race([
      new Promise<void>((resolve) => this.#process.once("exit", () => resolve())),
      delay(STOP_TIMEOUT_MS),
    ]);
    if (this.#process.exitCode === null && this.#process.signalCode === null) {
      this.#process.kill("SIGKILL");
    }
  }

  #rejectStarts(): void {
    for (const pending of this.#started.values()) pending.reject();
    this.#started.clear();
  }
}

function parseMessage(value: unknown): GuardianMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const message = value as Record<string, unknown>;
  if (message.role !== "app-server" && message.role !== "tui") return null;
  if (message.type === "started" || message.type === "spawn-error") {
    return { type: message.type, role: message.role };
  }
  if (
    message.type === "exit" &&
    (typeof message.code === "number" || message.code === null) &&
    (typeof message.signal === "string" || message.signal === null)
  ) {
    return { type: "exit", role: message.role, code: message.code, signal: message.signal };
  }
  return null;
}

interface SpawnCommand {
  readonly type: "spawn";
  readonly role: Role;
  readonly executable: string;
  readonly args: string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

/** Runs only inside the existing bundled launcher with --guardian. */
export async function runCodexInteractionGuardianMode(): Promise<void> {
  const children = new Map<Role, ChildProcess>();
  let stopping = false;
  const send = (message: GuardianMessage): void => {
    if (!process.connected) return;
    try {
      process.send?.(message, () => undefined);
    } catch {
      // Parent IPC closed; the disconnect handler is already reaping children.
    }
  };
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    for (const child of children.values()) child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => {
        const check = (): void => {
          if (children.size === 0) resolve();
        };
        for (const child of children.values()) child.once("exit", check);
        check();
      }),
      delay(2_000),
    ]);
    for (const child of children.values()) child.kill("SIGKILL");
    await Promise.race([
      new Promise<void>((resolve) => {
        const check = (): void => {
          if (children.size === 0) resolve();
        };
        for (const child of children.values()) child.once("exit", check);
        check();
      }),
      delay(500),
    ]);
    process.exit(0);
  };
  process.on("message", (unknownMessage: unknown) => {
    if (isRecord(unknownMessage) && unknownMessage.type === "stop") {
      void shutdown();
      return;
    }
    const message = parseSpawnCommand(unknownMessage);
    if (stopping || message === null || children.has(message.role)) return;
    try {
      const child = spawn(message.executable, message.args, {
        cwd: message.cwd,
        env: message.environment,
        detached: false,
        stdio: message.role === "tui" ? "inherit" : "ignore",
      });
      children.set(message.role, child);
      child.once("error", () => {
        send({ type: "spawn-error", role: message.role });
        void shutdown();
      });
      child.once("exit", (code, signal) => {
        children.delete(message.role);
        send({ type: "exit", role: message.role, code, signal });
      });
      send({ type: "started", role: message.role });
    } catch {
      send({ type: "spawn-error", role: message.role });
      void shutdown();
    }
  });
  process.on("disconnect", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGHUP", () => {
    void shutdown();
  });
  process.on("SIGINT", () => undefined);
  await new Promise<void>(() => undefined);
}

function parseSpawnCommand(value: unknown): SpawnCommand | null {
  if (
    !isRecord(value) ||
    value.type !== "spawn" ||
    (value.role !== "app-server" && value.role !== "tui") ||
    typeof value.executable !== "string" ||
    typeof value.cwd !== "string" ||
    !Array.isArray(value.args) ||
    !value.args.every((arg) => typeof arg === "string") ||
    !isRecord(value.environment)
  )
    return null;
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, item] of Object.entries(value.environment)) {
    if (typeof item !== "string") return null;
    environment[key] = item;
  }
  return {
    type: "spawn",
    role: value.role,
    executable: value.executable,
    args: value.args,
    cwd: value.cwd,
    environment,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
