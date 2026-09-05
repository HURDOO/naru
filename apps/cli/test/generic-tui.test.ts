import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("generic full-screen TUI fixture", () => {
  it("uses alternate screen, accepts structured key input, and exits cleanly", async () => {
    const result = await runFixture();

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("\u001b[?1049h");
    expect(result.output).toContain("durable-session generic TUI");
    expect(result.output).toContain("counter=1");
    expect(result.output).toContain("\u001b[?1049l");
  });
});

function runFixture(): Promise<{ readonly exitCode: number; readonly output: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve("apps/cli/test/fixtures/generic-tui.mjs")], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    let sentIncrement = false;
    let sentQuit = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("generic TUI fixture timed out"));
    }, 5_000);
    child.stdout.on("data", (chunk: Buffer) => {
      output.push(chunk);
      const accumulated = Buffer.concat(output);
      if (!sentIncrement && accumulated.includes(Buffer.from("durable-session generic TUI"))) {
        sentIncrement = true;
        child.stdin.write("+");
      } else if (!sentQuit && accumulated.includes(Buffer.from("counter=1"))) {
        sentQuit = true;
        child.stdin.end("q");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    child.once("error", reject);
    child.once("exit", (exitCode) => {
      clearTimeout(timeout);
      resolvePromise({ exitCode: exitCode ?? 1, output: Buffer.concat(output).toString("utf8") });
    });
  });
}
