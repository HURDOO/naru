import type { ServerWsFrame } from "@naru/contracts";
import { stripVTControlCharacters } from "node:util";
import { createRequire } from "node:module";
import type { Terminal } from "@xterm/headless";
import { describe, expect, it } from "vitest";
import { startCodexAcceptanceFixture } from "./codex-acceptance-fixture.js";

const executable = process.env.NARU_ACTUAL_CODEX;
const HeadlessTerminal = (
  createRequire(import.meta.url)("@xterm/headless") as {
    Terminal: new (options: { cols: number; rows: number; allowProposedApi: boolean }) => Terminal;
  }
).Terminal;
describe.skipIf(executable === undefined)("actual Codex socket compatibility", () => {
  it("starts two panes, completes a model turn, reconnects and resumes without stopping its sibling", async () => {
    const server = await startCodexAcceptanceFixture(executable!);
    const terminals = new Map<string, Terminal>();
    try {
      const panes = server.repository
        .getWorkspace(server.project.id)
        .panes.filter((pane) => pane.kind === "codex");
      const main = panes[0]!;
      const quick = panes[1]!;
      const frames: ServerWsFrame[] = [];
      const receive =
        (paneId: string, target: ServerWsFrame[]) =>
        (frame: ServerWsFrame): void => {
          target.push(frame);
          let terminal = terminals.get(paneId);
          if (!terminal) {
            terminal = new HeadlessTerminal({ cols: 120, rows: 40, allowProposedApi: true });
            terminal.onData((data) => {
              void server.supervisor.write(paneId, data);
            });
            terminals.set(paneId, terminal);
          }
          if (frame.type === "terminal.output") terminal.write(frame.data);
          else if (frame.type === "pane.snapshot") terminal.write(frame.serializedState);
        };
      await server.supervisor.start(main.id, 120, 40);
      let detach = await server.supervisor.attach(main.id, 120, 40, receive(main.id, frames));
      await ready(main.id).catch(() => {
        const output = text(frames);
        throw new Error(
          JSON.stringify({
            stage: "initial-ui",
            frameCount: frames.length,
            errors: output.match(/NARU_CODEX_[A-Z_]+/g),
            onboarding: /Welcome|sign in|log in|API key/i.test(output),
            trust: /trust|Trust/.test(output),
            cursorQuery: output.includes("\u001b[6n"),
            hasError: /error|Error/.test(output),
            paneStatus: server.repository.getPaneContext(main.id)?.pane.status,
          }),
        );
      });
      await delay(1_000);
      for (const character of "Reply with a short greeting.") {
        await server.supervisor.write(main.id, character);
        await delay(30);
      }
      await delay(1_000);
      await server.supervisor.write(main.id, "\r");
      await waitUntil(() => screen(main.id).includes("NARU_T59_READY")).catch(() => {
        throw new Error(
          JSON.stringify({
            stage: "turn",
            requests: server.modelRequests,
            greetingRequests: server.greetingRequests,
            promptVisible: text(frames).includes("Reply with"),
            screenPrompt: screen(main.id).includes("Reply with"),
            screenReady: screen(main.id).includes("Ask Codex"),
            screenMigration: screen(main.id).includes("Use existing"),
            screenError: /error|Error/.test(screen(main.id)),
            codes: text(frames).match(/NARU_CODEX_[A-Z_]+/g),
            running: server.supervisor.isRunning(main.id),
          }),
        );
      });
      await waitUntil(
        () => server.repository.getPaneContext(main.id)?.pane.codexSessionResumable === true,
      );
      if (process.env.NARU_ACTUAL_CODEX_MCP === "1") {
        await waitUntil(
          () => server.repository.getPaneContext(main.id)?.pane.activity.state === "completed",
        );
        for (const character of "Request fixture confirmation.") {
          await server.supervisor.write(main.id, character);
          await delay(30);
        }
        await delay(500);
        await server.supervisor.write(main.id, "\r");
        await waitUntil(
          () =>
            server.repository.getPaneContext(main.id)?.pane.activity.state ===
            "interaction-required",
        ).catch(() => {
          throw new Error(
            JSON.stringify({
              stage: "mcp",
              requests: server.modelRequests,
              mcpRequests: server.mcpRequests,
              advertised: server.mcpAdvertised,
              toolOutputFlags: server.toolOutputFlags,
              state: server.repository.getPaneContext(main.id)?.pane.activity.state,
              prompt: screen(main.id).includes("Request fixture confirmation."),
              error: /error|failed/i.test(screen(main.id)),
            }),
          );
        });
        // The redacted protocol state is authoritative; TUI wording differs by CLI version.
        await delay(500);
        await server.supervisor.write(main.id, "\r");
        await delay(300);
        if (
          server.repository.getPaneContext(main.id)?.pane.activity.state === "interaction-required"
        )
          await server.supervisor.write(main.id, "\r");
        await waitUntil(
          () => server.repository.getPaneContext(main.id)?.pane.activity.state === "completed",
        );
      }
      const sessionId = server.repository.getPaneContext(main.id)!.pane.codexSessionId;
      await server.supervisor.start(quick.id, 120, 40);
      expect(server.supervisor.isRunning(quick.id), "sibling started").toBe(true);
      const quickFrames: ServerWsFrame[] = [];
      const detachQuick = await server.supervisor.attach(
        quick.id,
        120,
        40,
        receive(quick.id, quickFrames),
      );
      await ready(quick.id);
      detach();
      detach = await server.supervisor.attach(main.id, 120, 40, receive(main.id, frames));
      expect(server.supervisor.isRunning(main.id)).toBe(true);
      detach();
      await server.supervisor.stop(main.id);
      await waitUntil(async () => {
        await server.supervisor.reconcile();
        return server.repository.getPaneContext(main.id)?.pane.status === "stopped";
      });
      expect(server.supervisor.isRunning(quick.id)).toBe(true);
      await server.supervisor.start(main.id, 120, 40);
      expect(server.supervisor.isRunning(main.id), "main resumed").toBe(true);
      frames.length = 0;
      detach = await server.supervisor.attach(main.id, 120, 40, receive(main.id, frames));
      await waitUntil(() => text(frames).includes("NARU_T59_READY"));
      expect(server.repository.getPaneContext(main.id)!.pane.codexSessionId).toBe(sessionId);
      expect(server.modelRequests).toBeGreaterThan(0);
      detach();
      detachQuick();
      function screen(paneId: string): string {
        const buffer = terminals.get(paneId)!.buffer.active;
        return Array.from(
          { length: buffer.length },
          (_, index) => buffer.getLine(index)?.translateToString(true) ?? "",
        ).join("\n");
      }
      async function ready(paneId: string): Promise<void> {
        await waitUntil(() => /Use existing model|Ask Codex/i.test(screen(paneId)));
        if (screen(paneId).includes("Use existing model")) {
          await server.supervisor.write(paneId, "\u001b[B\r");
        }
        await waitUntil(() => screen(paneId).includes("Ask Codex"));
      }
    } finally {
      for (const terminal of terminals.values()) terminal.dispose();
      await server.close();
    }
  }, 90_000);
});
function text(frames: readonly ServerWsFrame[]): string {
  return stripVTControlCharacters(
    frames
      .map((frame) =>
        frame.type === "terminal.output"
          ? frame.data
          : frame.type === "pane.snapshot"
            ? frame.serializedState
            : "",
      )
      .join(""),
  );
}
async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline)
      throw new Error("Actual Codex acceptance condition timed out (terminal content withheld).");
    await delay(50);
  }
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
