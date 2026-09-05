import { spawn as spawnChild } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as spawnPty, type IPty } from "node-pty";
import { describe, expect, it } from "vitest";
import { DurableSessionHostConfigSchema } from "../../durable-session-host/src/config.js";
import {
  startDurableSessionHost,
  type RunningDurableSessionHost,
} from "../../durable-session-host/src/host.js";
import { silentHostLogger } from "../../durable-session-host/src/logging.js";
import { createHostFixture, TEST_CREDENTIAL } from "../../durable-session-host/test/support.js";

const actualDescribe = describe.skipIf(process.env.DURABLE_SESSION_ACTUAL_CLI !== "1");

actualDescribe("Session CLI actual Node 24 PTY acceptance", () => {
  it("uses two local CLIs to observe, transfer, release and explicitly preempt a generic TUI", async () => {
    expect(process.versions.node.split(".")[0]).toBe("24");
    const fixture = createHostFixture();
    const tuiPath = realpathSync(
      fileURLToPath(new URL("./fixtures/generic-tui.mjs", import.meta.url)),
    );
    const profile = fixture.config.profiles[0];
    if (profile === undefined) throw new Error("Fixture profile is missing.");
    const config = DurableSessionHostConfigSchema.parse({
      ...fixture.config,
      profiles: [{ ...profile, args: [tuiPath] }],
    });
    let host: RunningDurableSessionHost | null = null;
    const terminals: TestPty[] = [];

    try {
      host = await startDurableSessionHost(config, {
        logger: silentHostLogger,
        hostEnvironment: {},
      });
      const created = await runJsonCli(config.socketPath, fixture.credentialFile, [
        "run",
        "--profile",
        "fixture",
        "--root",
        "projects",
      ]);
      const sessionId = createdSessionId(created.stdout);

      const first = startInteractiveCli(
        config.socketPath,
        fixture.credentialFile,
        sessionId,
        90,
        25,
      );
      terminals.push(first);
      await first.waitFor("durable-session generic TUI");
      await first.waitFor("controller runtime=");
      expect((await host.service.terminalSnapshot(sessionId)).terminal).toEqual({
        cols: 90,
        rows: 25,
      });

      const second = startInteractiveCli(
        config.socketPath,
        fixture.credentialFile,
        sessionId,
        120,
        40,
      );
      terminals.push(second);
      await second.waitFor("durable-session generic TUI");
      await second.waitFor("control request sent; waiting for controller approval");
      await first.waitFor("control requested; press Ctrl+] then a to approve or x to reject");

      first.write("\u001da");
      await second.waitFor("control offered; press Ctrl+] then a to accept");
      second.write("\u001da");
      await second.waitFor("controller runtime=");
      await second.waitFor("generation=2");
      await first.waitFor("observer runtime=");
      await first.waitFor("generation=2");
      expect((await host.service.terminalSnapshot(sessionId)).terminal).toEqual({
        cols: 120,
        rows: 40,
      });

      second.write("\u001dl");
      await second.waitFor("generation=3");
      await first.waitFor("generation=3");
      expect((await host.service.terminalSnapshot(sessionId)).terminal).toEqual({
        cols: 120,
        rows: 40,
      });

      first.write("\u001dp\u001dp");
      await first.waitFor("explicit takeover: press Ctrl+] then p again to confirm");
      await first.waitFor("generation=4");
      await second.waitFor("generation=4");
      expect((await host.service.terminalSnapshot(sessionId)).terminal).toEqual({
        cols: 90,
        rows: 25,
      });

      expect(first.output).not.toContain(TEST_CREDENTIAL);
      expect(second.output).not.toContain(TEST_CREDENTIAL);
      expect(first.output).not.toContain("attachmentResumeToken");
      expect(second.output).not.toContain("attachmentResumeToken");

      first.write("\u001dq");
      second.write("\u001dq");
      await expect(first.waitForExit()).resolves.toBe(0);
      await expect(second.waitForExit()).resolves.toBe(0);
      expect((await host.service.terminalSnapshot(sessionId)).serializedState).toContain(
        "durable-session generic TUI",
      );
    } finally {
      for (const terminal of terminals) terminal.kill();
      await host?.close();
    }
  }, 30_000);
});

interface JsonCliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runJsonCli(
  socketPath: string,
  credentialFile: string,
  command: readonly string[],
): Promise<JsonCliResult> {
  return new Promise<JsonCliResult>((resolvePromise, reject) => {
    const child = spawnChild(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve("apps/cli/src/main.ts"),
        "--json",
        ...connectionArguments(socketPath, credentialFile),
        ...command,
      ],
      { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Spawned JSON Session CLI timed out."));
    }, 10_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  }).then((result) => {
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(TEST_CREDENTIAL);
    return result;
  });
}

function startInteractiveCli(
  socketPath: string,
  credentialFile: string,
  sessionId: string,
  cols: number,
  rows: number,
): TestPty {
  const terminal = spawnPty(
    process.execPath,
    [
      "--import",
      "tsx",
      resolve("apps/cli/src/main.ts"),
      ...connectionArguments(socketPath, credentialFile),
      "control",
      sessionId,
    ],
    {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.cwd(),
      env: stringEnvironment(process.env),
    },
  );
  return new TestPty(terminal);
}

function connectionArguments(socketPath: string, credentialFile: string): string[] {
  return [
    "--socket",
    socketPath,
    "--app-id",
    "fixture-app",
    "--credential-file",
    credentialFile,
    "--subject",
    "fixture-owner",
  ];
}

function createdSessionId(stdout: string): string {
  const parsed = JSON.parse(stdout) as {
    readonly ok?: unknown;
    readonly result?: { readonly session?: { readonly sessionId?: unknown } };
  };
  const sessionId = parsed.result?.session?.sessionId;
  if (parsed.ok !== true || typeof sessionId !== "string") {
    throw new Error("Spawned run CLI did not return a Session ID.");
  }
  return sessionId;
}

class TestPty {
  #output = "";
  #exitCode: number | null = null;
  readonly #exit: Promise<number>;

  constructor(readonly terminal: IPty) {
    terminal.onData((data) => {
      this.#output += data;
    });
    this.#exit = new Promise((resolvePromise) => {
      terminal.onExit(({ exitCode }) => {
        this.#exitCode = exitCode;
        resolvePromise(exitCode);
      });
    });
  }

  get output(): string {
    return this.#output;
  }

  write(data: string): void {
    this.terminal.write(data);
  }

  async waitFor(marker: string, timeoutMs = 8_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.#output.includes(marker)) return;
      if (this.#exitCode !== null) {
        throw new Error(`Interactive CLI exited before marker ${JSON.stringify(marker)}.`);
      }
      await delay(20);
    }
    throw new Error(
      `Timed out waiting for ${JSON.stringify(marker)} in CLI output: ${this.#output.slice(-2_000)}`,
    );
  }

  async waitForExit(timeoutMs = 8_000): Promise<number> {
    if (this.#exitCode !== null) return this.#exitCode;
    return await Promise.race([
      this.#exit,
      delay(timeoutMs).then(() => {
        throw new Error("Interactive CLI did not exit.");
      }),
    ]);
  }

  kill(): void {
    if (this.#exitCode !== null) return;
    try {
      this.terminal.kill();
    } catch {
      // The PTY may have exited between the state check and kill.
    }
  }
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
