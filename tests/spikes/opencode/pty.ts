import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type * as NodePty from "node-pty";
import type { IPty } from "node-pty";
import type { Terminal } from "@xterm/headless";

// node-pty and @xterm/headless are dependencies of apps/server; resolve them from there so the
// spike adds no root dependency.
const serverRequire = createRequire(
  fileURLToPath(new URL("../../../apps/server/package.json", import.meta.url)),
);
const { spawn } = serverRequire("node-pty") as typeof NodePty;
const { Terminal: HeadlessTerminal } = serverRequire("@xterm/headless") as {
  Terminal: new (options: { cols: number; rows: number; allowProposedApi: boolean }) => Terminal;
};

export interface SpikePty {
  readonly pty: IPty;
  readonly terminal: Terminal;
  screen(): string;
  type(text: string): void;
  waitForScreen(
    predicate: (screen: string) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<string>;
  close(): void;
}

export function startPty(
  file: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string>; cols?: number; rows?: number },
): SpikePty {
  const cols = options.cols ?? 140;
  const rows = options.rows ?? 45;
  const terminal = new HeadlessTerminal({ cols, rows, allowProposedApi: true });
  const pty = spawn(file, [...args], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: options.cwd,
    env: options.env,
  });
  pty.onData((data) => terminal.write(data));
  // Answer terminal queries the TUI may emit (cursor position, device attributes).
  terminal.onData((data) => pty.write(data));
  const screen = (): string => {
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  };
  return {
    pty,
    terminal,
    screen,
    type: (text) => pty.write(text),
    async waitForScreen(predicate, timeoutMs, label) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const current = screen();
        if (predicate(current)) return current;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for screen: ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    },
    close: () => {
      try {
        pty.kill();
      } catch {
        // already exited
      }
    },
  };
}
