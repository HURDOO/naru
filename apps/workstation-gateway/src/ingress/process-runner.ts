import { spawn } from "node:child_process";

export interface ExternalCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExternalCommandRunner {
  run(executable: string, args: readonly string[]): Promise<ExternalCommandResult>;
}

export interface NodeExternalCommandRunnerOptions {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export class NodeExternalCommandRunner implements ExternalCommandRunner {
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;

  constructor(options: NodeExternalCommandRunnerOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  }

  run(executable: string, args: readonly string[]): Promise<ExternalCommandResult> {
    if (!executable.startsWith("/") || /[\0\r\n]/.test(executable)) {
      return Promise.reject(new Error("External executable must be an absolute safe path."));
    }
    for (const argument of args) {
      if (/[\0\r\n]/.test(argument)) {
        return Promise.reject(new Error("External command argument contains a control character."));
      }
    }

    return new Promise((resolve, reject) => {
      const child = spawn(executable, [...args], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: minimalEnvironment(),
      });
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let completed = false;
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error("External command timed out."));
      }, this.#timeoutMs);

      const finish = (error?: Error, exitCode?: number): void => {
        if (completed) return;
        completed = true;
        clearTimeout(timeout);
        if (error !== undefined) reject(error);
        else
          resolve({
            exitCode: exitCode ?? 1,
            stdout: stdout.toString("utf8"),
            stderr: stderr.toString("utf8"),
          });
      };
      const append = (
        current: Buffer<ArrayBufferLike>,
        chunk: Buffer<ArrayBufferLike>,
      ): Buffer<ArrayBufferLike> => {
        const next = Buffer.concat([current, chunk]);
        if (stdout.byteLength + stderr.byteLength + chunk.byteLength > this.#maxOutputBytes) {
          child.kill("SIGKILL");
          finish(new Error("External command output exceeded the bounded limit."));
        }
        return next;
      };

      child.stdout.on("data", (chunk: Buffer<ArrayBufferLike>) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer<ArrayBufferLike>) => {
        stderr = append(stderr, chunk);
      });
      child.once("error", (error) => finish(error));
      child.once("exit", (code, signal) => {
        if (signal !== null) finish(new Error(`External command exited by signal ${signal}.`));
        else finish(undefined, code ?? 1);
      });
    });
  }
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  for (const name of ["HOME", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM"] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}
