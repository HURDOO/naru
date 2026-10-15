/**
 * A stand-in `codex` executable for managed-agent tests (AP-T13): `app-server --listen unix://…`
 * speaks the JSON-RPC subset Naru uses, and `--remote unix://… resume <id>` behaves like the TUI,
 * turning each PTY input line into `turn/start` and accepting any approval like a person would.
 * It records what it saw (never secrets) as JSON lines in FAKE_CODEX_LOG.
 */
export function fakeCodexScript(node: string, wsModule: string): string {
  return `#!${node}
const { appendFileSync, chmodSync } = require("node:fs");
const { createServer } = require("node:http");
const { createConnection } = require("node:net");
const { randomUUID } = require("node:crypto");
const readline = require("node:readline");
const WebSocket = require(${JSON.stringify(wsModule)});
const log = (entry) => appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(entry) + "\\n");
const args = process.argv.slice(2);
if (args[0] === "doctor") {
  const ok = { status: "ok" };
  process.stdout.write(JSON.stringify({ checks: { installation: ok, "auth.credentials": ok, "config.load": ok } }));
  process.exit(0);
}

if (args.includes("app-server")) {
  const path = args[args.indexOf("--listen") + 1].replace("unix://", "");
  const threads = new Map();
  const sockets = new Set();
  let active = null;
  let nextRequest = 0;
  const pendingRequests = new Map();
  const broadcast = (frame) => { for (const ws of sockets) ws.send(JSON.stringify(frame)); };
  // Like the real app-server, a thread carries its cwd, parent and status (Naru verifies them).
  const thread = (id) => ({ id, cwd: process.cwd(), parentThreadId: null, status: { type: active?.threadId === id ? "active" : "idle" } });
  const finish = (threadId, turn, status) => {
    active = null;
    threads.get(threadId).turns.push({ id: turn, status });
    broadcast({ method: "turn/completed", params: { threadId, turn: { id: turn, status } } });
  };
  const http = createServer();
  const wss = new WebSocket.WebSocketServer({ noServer: true });
  http.on("upgrade", (request, socket, head) => wss.handleUpgrade(request, socket, head, (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    ws.on("message", async (data) => {
      const frame = JSON.parse(String(data));
      const reply = (result) => ws.send(JSON.stringify({ id: frame.id, result }));
      const error = (message) => ws.send(JSON.stringify({ id: frame.id, error: { code: -32600, message } }));
      if (frame.method === undefined) {
        pendingRequests.get(String(frame.id))?.(frame.result);
        return;
      }
      const p = frame.params ?? {};
      switch (frame.method) {
        case "initialize": return reply({ userAgent: "fake" });
        case "thread/start": {
          const id = randomUUID();
          threads.set(id, { turns: [] });
          const naru = p.config?.["mcp_servers.naru"];
          log({ event: "thread/start", model: p.model, guidance: String(p.developerInstructions ?? "").includes("## Role:"),
            mcpCommand: Boolean(naru?.command), mcpCapability: typeof naru?.env?.NARU_AGENT_CAPABILITY === "string" });
          return reply({ thread: thread(id) });
        }
        case "thread/resume": {
          if (!threads.has(p.threadId)) return error("no such thread");
          log({ event: "thread/resume", threadId: p.threadId, injected: p.config?.["mcp_servers.naru"] !== undefined });
          return reply({ thread: { ...thread(p.threadId), turns: [] } });
        }
        case "turn/start": {
          if (!threads.has(p.threadId)) return error("no such thread");
          const text = (p.input ?? []).map((item) => item.text ?? "").join("");
          const turn = randomUUID();
          log({ event: "turn" });
          active = { threadId: p.threadId, turn, interrupted: false };
          const mine = active;
          reply({ turn: { id: turn, status: "inProgress" } });
          broadcast({ method: "turn/started", params: { threadId: p.threadId, turn: { id: turn, status: "inProgress" } } });
          if (text.includes("CHILD")) {
            const item = (kind) => ({ type: "subAgentActivity", id: "activity-" + kind, kind, agentThreadId: "child-1", agentPath: "x" });
            broadcast({ method: "item/started", params: { threadId: p.threadId, turnId: turn, item: item("started") } });
            await new Promise((done) => setTimeout(done, 300));
            broadcast({ method: "item/completed", params: { threadId: p.threadId, turnId: turn, item: item("completed") } });
          }
          if (text.includes("APPROVE")) {
            const id = "approval-" + ++nextRequest;
            const answered = new Promise((resolve) => pendingRequests.set(id, resolve));
            broadcast({ id, method: "item/commandExecution/requestApproval", params: { threadId: p.threadId, turnId: turn, itemId: "cmd" } });
            const result = await answered;
            log({ event: "approval", decision: result?.decision });
            broadcast({ method: "serverRequest/resolved", params: { threadId: p.threadId, requestId: id } });
          }
          if (text.includes("SLOW")) {
            for (let waited = 0; waited < 5000 && !mine.interrupted; waited += 50) {
              await new Promise((done) => setTimeout(done, 50));
            }
          }
          return finish(p.threadId, turn, mine.interrupted ? "interrupted" : "completed");
        }
        case "turn/interrupt": {
          if (active === null || active.turn !== p.turnId) return error("no active turn");
          active.interrupted = true;
          return reply({});
        }
        case "thread/turns/list": {
          const turns = threads.get(p.threadId)?.turns ?? [];
          const start = p.cursor === undefined ? 0 : Number(p.cursor);
          const page = turns.slice(start, start + 2);
          return reply({ data: page, nextCursor: start + 2 < turns.length ? String(start + 2) : null });
        }
        default: return reply({});
      }
    });
  }));
  http.listen(path, () => chmodSync(path, 0o600));
  process.on("SIGTERM", () => process.exit(0));
} else {
  const path = args[args.indexOf("--remote") + 1].replace("unix://", "");
  const threadId = args[args.indexOf("resume") + 1];
  const ws = new WebSocket("ws://localhost/", { createConnection: () => createConnection(path) });
  let next = 0;
  const pending = new Map();
  const call = (method, params) => new Promise((resolve) => {
    const id = "tui-" + ++next;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.on("message", (data) => {
    const frame = JSON.parse(String(data));
    if (frame.method !== undefined && frame.id !== undefined) {
      // A person pressing "yes" in the TUI; Naru's relay decides whether it may count.
      ws.send(JSON.stringify({ id: frame.id, result: { decision: "accept" } }));
      log({ event: "tui-approval-answered" });
      return;
    }
    if (frame.id !== undefined) pending.get(frame.id)?.(frame);
  });
  ws.on("open", async () => {
    await call("initialize", { clientInfo: { name: "fake-tui", version: "0" }, capabilities: null });
    ws.send(JSON.stringify({ method: "initialized" }));
    const resumed = await call("thread/resume", { threadId });
    log({ event: "tui-resumed", threadId, ok: resumed.error === undefined });
    readline.createInterface({ input: process.stdin }).on("line", async (line) => {
      if (line.trim() === "") return;
      const started = await call("turn/start", { threadId, input: [{ type: "text", text: line, text_elements: [] }] });
      log({ event: "tui-turn", accepted: started.error === undefined, code: started.error?.code ?? null });
    });
  });
  process.on("SIGTERM", () => process.exit(0));
}
`;
}
