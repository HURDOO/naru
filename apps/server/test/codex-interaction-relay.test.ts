import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { chmod } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appServerArguments,
  remoteTuiArguments,
  runCodexInteractionRelay,
} from "../src/codex-interaction-relay.js";
import type { CodexInteractionSnapshot } from "../src/integrations/codex/events.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const CWD = process.cwd();

describe("Host-owned Codex interaction relay", () => {
  it("preserves launch profile settings on the app-server side", () => {
    expect(
      appServerArguments(
        [
          "--model",
          "gpt-5.6-sol",
          "--config",
          'model_reasoning_effort="xhigh"',
          "--sandbox",
          "workspace-write",
          "--ask-for-approval",
          "on-request",
          "resume",
          SESSION,
        ],
        "unix:///fixture/app.sock",
      ),
    ).toEqual([
      "--config",
      'model="gpt-5.6-sol"',
      "--config",
      'model_reasoning_effort="xhigh"',
      "--config",
      'sandbox_mode="workspace-write"',
      "--config",
      'approval_policy="on-request"',
      "app-server",
      "--listen",
      "unix:///fixture/app.sock",
    ]);
  });

  it("keeps model and resume target on remote TUI while leaving permission policy on the server", () => {
    expect(
      remoteTuiArguments([
        "--model",
        "gpt-5.6-sol",
        "--config",
        'model_reasoning_effort="xhigh"',
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "on-request",
        "resume",
        SESSION,
      ]),
    ).toEqual([
      "--model",
      "gpt-5.6-sol",
      "--config",
      'model_reasoning_effort="xhigh"',
      "resume",
      SESSION,
    ]);
  });

  it("forwards early TUI frames and emits a resolved snapshot before item completion", async () => {
    const directory = mkdtempSync(join(tmpdir(), "naru-codex-relay-test-"));
    const executable = join(directory, "fake-codex.cjs");
    const guardianEntry = join(directory, "guardian.mjs");
    const ipcPath = join(directory, "integration.sock");
    writeFileSync(executable, fakeCodexScript(), { mode: 0o700 });
    writeFileSync(
      guardianEntry,
      `import { runCodexInteractionGuardianMode } from ${JSON.stringify(new URL("../src/codex-interaction-guardian.ts", import.meta.url).href)};\nawait runCodexInteractionGuardianMode();\n`,
    );
    chmodSync(executable, 0o700);
    const snapshots: CodexInteractionSnapshot[] = [];
    const integration = createServer((socket) => {
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString("utf8");
        const newline = data.indexOf("\n");
        if (newline === -1) return;
        const request = JSON.parse(data.slice(0, newline)) as {
          type: string;
          snapshot: CodexInteractionSnapshot;
        };
        if (request.type === "interaction") snapshots.push(request.snapshot);
        socket.end(JSON.stringify({ version: 1, ok: true, type: "interaction" }) + "\n");
      });
    });
    await new Promise<void>((resolve, reject) => {
      integration.once("error", reject);
      integration.listen(ipcPath, resolve);
    });
    await chmod(ipcPath, 0o600);
    try {
      const result = await runCodexInteractionRelay({
        executable,
        args: [
          "--model",
          "gpt-5.6-sol",
          "--sandbox",
          "workspace-write",
          "--ask-for-approval",
          "on-request",
        ],
        environment: {
          ...process.env,
          NARU_FIXTURE_WS_MODULE: resolve("apps/server/node_modules/ws"),
          NARU_FIXTURE_SESSION: SESSION,
          NARU_FIXTURE_CWD: CWD,
          NARU_FIXTURE_PICKER: "1",
        },
        bootstrap: "x".repeat(64),
        integrationSocketPath: ipcPath,
        cwd: process.cwd(),
        guardianEntry,
        guardianExecArgv: ["--import", "tsx"],
      });
      expect(result).toBe(0);
      const relevant = snapshots.filter((snapshot) => snapshot.sessionId === SESSION);
      const pendingIndex = relevant.findIndex(
        (snapshot) => snapshot.phase === "running" && snapshot.pending.length === 1,
      );
      const resolvedIndex = relevant.findIndex(
        (snapshot, index) =>
          index > pendingIndex && snapshot.phase === "running" && snapshot.pending.length === 0,
      );
      expect(pendingIndex).toBeGreaterThanOrEqual(0);
      expect(resolvedIndex).toBeGreaterThan(pendingIndex);
      expect(
        relevant
          .slice(pendingIndex, resolvedIndex)
          .every((snapshot) => snapshot.pending.length === 1),
      ).toBe(true);
      expect(
        relevant.every((snapshot) =>
          snapshot.pending.every((pending) => pending.kind === "command"),
        ),
      ).toBe(true);
      expect(JSON.stringify(snapshots)).not.toContain("private command content");
    } finally {
      await new Promise<void>((resolve) => integration.close(() => resolve()));
    }
  }, 20_000);

  it("reaps both Codex children when the Host hard-kills its wrapper PID", async () => {
    const directory = mkdtempSync(join(tmpdir(), "naru-codex-hard-stop-test-"));
    const executable = join(directory, "fake-codex.cjs");
    const script = join(directory, "wrapper.mjs");
    const pidFile = join(directory, "children.txt");
    const ipcPath = join(directory, "integration.sock");
    writeFileSync(executable, fakeCodexScript(), { mode: 0o700 });
    chmodSync(executable, 0o700);
    writeFileSync(
      script,
      `import { runCodexInteractionGuardianMode } from ${JSON.stringify(new URL("../src/codex-interaction-guardian.ts", import.meta.url).href)};
import { runCodexInteractionRelay } from ${JSON.stringify(new URL("../src/codex-interaction-relay.ts", import.meta.url).href)};
if (process.argv[2] === '--guardian') await runCodexInteractionGuardianMode();
else await runCodexInteractionRelay({
  executable: process.env.NARU_FIXTURE_CODEX,
  args: [], environment: process.env,
  bootstrap: "x".repeat(64),
  integrationSocketPath: process.env.NARU_FIXTURE_IPC,
  cwd: process.cwd(),
});\n`,
    );
    const integration = createServer((socket) => {
      socket.once("data", () =>
        socket.end(JSON.stringify({ version: 1, ok: true, type: "interaction" }) + "\n"),
      );
    });
    await new Promise<void>((resolve, reject) => {
      integration.once("error", reject);
      integration.listen(ipcPath, resolve);
    });
    await chmod(ipcPath, 0o600);
    const wrapper = spawn(process.execPath, ["--import", "tsx", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NARU_FIXTURE_CODEX: executable,
        NARU_FIXTURE_IPC: ipcPath,
        NARU_FIXTURE_WS_MODULE: resolve("apps/server/node_modules/ws"),
        NARU_FIXTURE_SESSION: SESSION,
        NARU_FIXTURE_CWD: CWD,
        NARU_FIXTURE_PID_FILE: pidFile,
        NARU_FIXTURE_HOLD: "1",
      },
      stdio: "ignore",
    });
    try {
      await waitUntil(() => {
        try {
          return readFileSync(pidFile, "utf8").trim().split("\n").length >= 2;
        } catch {
          return false;
        }
      }, 10_000);
      const pids = readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
      expect(pids).toHaveLength(2);
      wrapper.kill("SIGKILL");
      await waitUntil(() => pids.every((pid) => !isProcessAlive(pid)), 5_000);
      expect(pids.every((pid) => !isProcessAlive(pid))).toBe(true);
    } finally {
      wrapper.kill("SIGKILL");
      await new Promise<void>((resolve) => integration.close(() => resolve()));
    }
  }, 20_000);
});

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!predicate()) throw new Error("Timed out waiting for a fixture process state.");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

function fakeCodexScript(): string {
  return `#!/usr/bin/env node
const net = require('node:net');
const http = require('node:http');
const WS = require(process.env.NARU_FIXTURE_WS_MODULE);
const args = process.argv.slice(2);
const isServer = args.includes('app-server');
if (!isServer && (args.includes('--sandbox') || args.includes('--ask-for-approval'))) process.exit(3);
if (process.env.NARU_FIXTURE_PID_FILE) {
  require('node:fs').appendFileSync(process.env.NARU_FIXTURE_PID_FILE, String(process.pid) + '\\n');
}
const url = args[args.indexOf(isServer ? '--listen' : '--remote') + 1];
const path = url.slice('unix://'.length);
if (isServer) {
  const server = http.createServer();
  const wss = new WS.WebSocketServer({ server });
  wss.on('connection', (ws) => ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.method === 'thread/start') {
      ws.send(JSON.stringify({ id: message.id, result: { thread: {
        id: process.env.NARU_FIXTURE_SESSION,
        cwd: process.env.NARU_FIXTURE_CWD,
        parentThreadId: null,
        status: { type: 'idle' },
      } } }));
    } else if (message.method === 'turn/start') {
      ws.send(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-1' } } }));
      ws.send(JSON.stringify({ method: 'turn/started', params: {
        threadId: process.env.NARU_FIXTURE_SESSION,
        turn: { id: 'turn-1' },
      } }));
      ws.send(JSON.stringify({ id: 7, method: 'item/commandExecution/requestApproval', params: {
        threadId: process.env.NARU_FIXTURE_SESSION,
        turnId: 'turn-1',
        command: 'private command content',
      } }));
    } else if (message.method === 'thread/list') {
      ws.send(JSON.stringify({ id: message.id, result: { data: [] } }));
    } else if (message.id === 7 && message.result) {
      ws.send(JSON.stringify({ method: 'serverRequest/resolved', params: {
        threadId: process.env.NARU_FIXTURE_SESSION,
        requestId: 7,
      } }));
      setTimeout(() => ws.send(JSON.stringify({ method: 'item/completed', params: {
        threadId: process.env.NARU_FIXTURE_SESSION,
        item: { id: 'item-1' },
      } })), 1200);
    }
  }));
  server.listen(path, () => require('node:fs').chmodSync(path, 0o600));
} else {
  const ws = new WS('ws://localhost/', { createConnection: () => net.createConnection(path) });
  ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'thread/start', params: {} })));
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.id === 1) ws.send(JSON.stringify({ id: 2, method: 'turn/start', params: {
      threadId: process.env.NARU_FIXTURE_SESSION,
    } }));
    if (message.id === 7) {
      const answer = () => {
        ws.send(JSON.stringify({ id: 7, result: { decision: 'accept' } }));
        if (process.env.NARU_FIXTURE_HOLD !== '1') {
          setTimeout(() => { ws.close(); process.exit(0); }, 600);
        }
      };
      if (process.env.NARU_FIXTURE_PICKER === '1') {
        const picker = new WS('ws://localhost/rpc', { createConnection: () => net.createConnection(path) });
        picker.on('open', () => picker.send(JSON.stringify({ id: 1, method: 'thread/list', params: {} })));
        picker.on('message', (pickerRaw) => {
          if (JSON.parse(pickerRaw.toString()).id === 1) {
            picker.close();
            answer();
          }
        });
      } else answer();
    }
  });
}
`;
}
