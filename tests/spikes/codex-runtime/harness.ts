import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  connectCodexAppServer,
  inspectCodexAppServerEndpoint,
} from "../../../apps/server/src/codex-app-server-endpoint.js";
import type WS from "../../../apps/server/node_modules/@types/ws/index.js";
import type * as PtyModule from "node-pty";
import type * as XtermModule from "@xterm/headless";
import type { IPty } from "node-pty";

const require = createRequire(new URL("../../../apps/server/package.json", import.meta.url));
export const ws = require("ws") as typeof WS;
const pty = require("node-pty") as typeof PtyModule;
const xterm = require("@xterm/headless") as typeof XtermModule;
export function frameText(data: WS.RawData): string {
  return (
    Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
  ).toString("utf8");
}
export type Obj = Record<string, unknown>;
export interface Frame {
  id?: string | number;
  method?: string;
  params?: Obj;
  result?: Obj;
  error?: { code: number; message: string };
}
export const obj = (value: unknown): Obj =>
  value !== null && typeof value === "object" ? (value as Obj) : {};
export const arr = (value: unknown): unknown[] =>
  Array.isArray(value) ? (value as unknown[]) : [];
export const str = (value: unknown): string => (typeof value === "string" ? value : "");
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const logs = resolve(
  repositoryRoot,
  "../../experiments/naru-agent-spikes/codex-runtime/logs",
);
export const workspace = resolve(
  repositoryRoot,
  "../../experiments/naru-agent-spikes/codex-runtime/workspace",
);
// Launch the native binary directly: killing the npm JS shim can orphan its child.
function executable(): string {
  const entry = realpathSync(
    process.env.NARU_SPIKE_CODEX ?? execFileSync("which", ["codex"], { encoding: "utf8" }).trim(),
  );
  if (!entry.endsWith(".js")) return entry;
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Set NARU_SPIKE_CODEX to the native executable");
  const packageJson = createRequire(entry).resolve("@openai/codex-darwin-arm64/package.json");
  return realpathSync(join(dirname(packageJson), "vendor/aarch64-apple-darwin/bin/codex"));
}
export const codex = executable();
export function setup(label: string): string {
  if (process.versions.node.split(".")[0] !== "24") throw new Error("Node 24 required");
  process.umask(0o077);
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  chmodSync(logs, 0o700);
  const directory = join(logs, `${label}-${new Date().toISOString().replaceAll(":", "-")}`);
  mkdirSync(directory, { mode: 0o700 });
  return directory;
}
export function raw(directory: string, name: string, value: unknown): void {
  appendFileSync(
    join(directory, name),
    `${typeof value === "string" ? value : JSON.stringify(value)}\n`,
    { mode: 0o600 },
  );
}
export function summary(directory: string, value: Obj): void {
  writeFileSync(join(directory, "summary.json"), JSON.stringify(value, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(value));
}
export async function until<T>(
  read: () => T | undefined | false,
  label: string,
  timeout = 20_000,
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = read();
    if (result !== undefined && result !== false) return result;
    await delay(40);
  }
  throw new Error(`Timeout: ${label}`);
}
export async function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  await until(
    () => child.exitCode !== null || child.signalCode !== null,
    "owned child exit",
    5000,
  ).catch(async () => {
    child.kill("SIGKILL");
    await until(
      () => child.exitCode !== null || child.signalCode !== null,
      "owned child forced exit",
      5000,
    );
  });
}
export interface FakeEnvironment {
  env: Record<string, string>;
  home: string;
  close(): Promise<void>;
  requests: Obj[];
}
export async function fakeEnvironment(
  directory: string,
  extraConfig = "",
): Promise<FakeEnvironment> {
  const home = join(directory, "home");
  mkdirSync(home, { mode: 0o700 });
  const requests: Obj[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      if (!request.url?.endsWith("/responses")) {
        response.end('{"data":[]}');
        return;
      }
      const input = JSON.parse(body) as Obj;
      requests.push(input);
      raw(directory, "model.jsonl", input);
      const items = arr(input.input).map(obj);
      const lastUser = items.findLastIndex((item) => item.role === "user");
      const text = JSON.stringify(items[lastUser] ?? {});
      const tail = items.slice(lastUser + 1);
      const toolDone = tail.some((item) => item.type === "function_call_output");
      const number = requests.length;
      const spawnProbe = text.includes("SPIKE_SPAWN_CHECK") && !toolDone;
      const crossTarget = text.match(/SPIKE_CROSS_THREAD=([0-9a-f-]+)/)?.[1];
      const tool =
        (text.includes("SPIKE_ELICIT") || spawnProbe || Boolean(crossTarget)) && !toolDone;
      const message = tool
        ? {
            type: "function_call",
            id: `fc_${number}`,
            call_id: `call_${number}`,
            namespace: spawnProbe || crossTarget ? "collaboration" : "mcp__naru_stub",
            name: spawnProbe ? "spawn_agent" : crossTarget ? "send_message" : "inbox",
            arguments: spawnProbe
              ? JSON.stringify({
                  task_name: "bounded_child",
                  message: text.includes("SPIKE_CHILD_TUI")
                    ? "SPIKE_CHILD_HOLD"
                    : "SPIKE_CHILD_ONLY",
                  fork_turns: "none",
                })
              : crossTarget
                ? JSON.stringify({ target: crossTarget, message: "SPIKE_CROSS_MESSAGE" })
                : "{}",
            status: "completed",
          }
        : {
            type: "message",
            id: `msg_${number}`,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: `SPIKE_REPLY_${number}`, annotations: [] }],
          };
      response.writeHead(200, { "content-type": "text/event-stream" });
      const emit = (event: Obj): void => {
        if (!response.destroyed)
          response.write(`event: ${str(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      emit({
        type: "response.created",
        response: { id: `resp_${number}`, status: "in_progress", output: [] },
      });
      if (!tool) {
        emit({
          type: "response.output_item.added",
          output_index: 0,
          item: { ...message, status: "in_progress", content: [] },
        });
        emit({
          type: "response.content_part.added",
          item_id: `msg_${number}`,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
        emit({
          type: "response.output_text.delta",
          item_id: `msg_${number}`,
          output_index: 0,
          content_index: 0,
          delta: `SPIKE_REPLY_${number}`,
        });
      }
      const finish = (): void => {
        emit({ type: "response.output_item.done", output_index: 0, item: message });
        emit({
          type: "response.completed",
          response: {
            id: `resp_${number}`,
            status: "completed",
            output: [message],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        });
        response.end();
      };
      const timer = setTimeout(
        finish,
        text.includes("SPIKE_CHILD_HOLD") ? 8000 : text.includes("SPIKE_SLOW") ? 2500 : 100,
      );
      response.on("close", () => clearTimeout(timer));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture bind failed");
  writeFileSync(
    join(home, "config.toml"),
    [
      'model = "gpt-6-sol"',
      'model_provider = "fixture"',
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      "[model_providers.fixture]",
      'name = "Synthetic spike"',
      `base_url = "http://127.0.0.1:${address.port}/v1"`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "supports_websockets = false",
      "[features]",
      "shell_snapshot = false",
      "enable_request_compression = false",
      "[notice.model_migrations]",
      '"gpt-5.6-sol" = "gpt-6-sol"',
      '"gpt-5.6-luna" = "gpt-6-luna"',
      `[projects.${JSON.stringify(workspace)}]`,
      'trust_level = "trusted"',
      extraConfig,
    ].join("\n"),
    { mode: 0o600 },
  );
  const env = {
    HOME: home,
    CODEX_HOME: home,
    PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin`,
    LANG: "en_US.UTF-8",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    SHELL: "/bin/zsh",
  };
  return {
    home,
    env,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((done, fail) =>
        server.close((error) => (error ? fail(error) : done())),
      );
    },
  };
}
export async function appServer(directory: string, env: NodeJS.ProcessEnv, args: string[] = []) {
  const socketRoot = realpathSync(mkdtempSync("/private/tmp/naru-spike-"));
  const socket = join(socketRoot, "app.sock");
  const child = spawn(codex, [...args, "app-server", "--listen", `unix://${socket}`], {
    cwd: workspace,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  raw(directory, "owned-pids.jsonl", { kind: "app-server", pid: child.pid, socket });
  child.stdout?.on("data", (data: Buffer) => raw(directory, "app.stdout", data.toString()));
  child.stderr?.on("data", (data: Buffer) => raw(directory, "app.stderr", data.toString()));
  let spawnError = false;
  child.on("error", (error) => {
    spawnError = true;
    raw(directory, "app.stderr", String(error));
  });
  await until(() => {
    if (spawnError || child.exitCode !== null)
      throw new Error("Owned app-server exited during startup");
    try {
      return inspectCodexAppServerEndpoint(socket);
    } catch {
      return false;
    }
  }, "app-server socket");
  return { child, socket, close: () => stop(child) };
}
export class Rpc {
  readonly frames: Frame[] = [];
  private nextId = 1;
  private readonly pending = new Map<string | number, (frame: Frame) => void>();
  private constructor(
    readonly socket: WS,
    readonly directory: string,
    readonly channel: string,
  ) {
    socket.on("error", (error) => raw(directory, "transport-errors.jsonl", String(error)));
    socket.on("message", (data) => {
      const frame = JSON.parse(frameText(data)) as Frame;
      raw(directory, `${channel}.jsonl`, { direction: "receive", frame });
      this.frames.push(frame);
      if (frame.id !== undefined && !frame.method) this.pending.get(frame.id)?.(frame);
    });
  }
  static async connect(
    socketPath: string,
    directory: string,
    channel: string,
    proxy = false,
  ): Promise<Rpc> {
    const endpoint = proxy ? undefined : inspectCodexAppServerEndpoint(socketPath);
    const socket = new ws("ws://localhost/", {
      createConnection: () =>
        endpoint ? connectCodexAppServer(endpoint) : createConnection(socketPath),
      headers: { "x-naru-spike": channel },
      perMessageDeflate: false,
    });
    const rpc = new Rpc(socket, directory, channel);
    await new Promise<void>((done, fail) => {
      socket.once("open", done);
      socket.once("error", fail);
    });
    await rpc.call("initialize", {
      clientInfo: { name: `naru_spike_${channel}`, version: "0.1" },
      capabilities: { experimentalApi: true },
    });
    rpc.send({ method: "initialized" });
    return rpc;
  }
  send(frame: Frame): void {
    raw(this.directory, `${this.channel}.jsonl`, { direction: "send", frame });
    this.socket.send(JSON.stringify(frame));
  }
  async request(method: string, params: Obj = {}, timeout = 20_000): Promise<Frame> {
    const id = this.nextId++;
    const reply = new Promise<Frame>((done, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new Error(`RPC timeout: ${method}`));
      }, timeout);
      this.pending.set(id, (frame) => {
        clearTimeout(timer);
        this.pending.delete(id);
        done(frame);
      });
    });
    this.send({ id, method, params });
    return reply;
  }
  async call(method: string, params: Obj = {}): Promise<Obj> {
    const reply = await this.request(method, params);
    if (reply.error) throw new Error(`${method}: ${reply.error.code}`);
    return reply.result ?? {};
  }
  event(
    method: string,
    from = 0,
    predicate: (params: Obj) => boolean = () => true,
    timeout = 20_000,
  ): Promise<Frame> {
    return until(
      () =>
        this.frames
          .slice(from)
          .find((frame) => frame.method === method && predicate(frame.params ?? {})),
      method,
      timeout,
    );
  }
  close(): void {
    this.socket.close();
  }
}
export async function startThread(rpc: Rpc, overrides: Obj = {}): Promise<string> {
  const result = await rpc.call("thread/start", {
    cwd: workspace,
    model: "gpt-6-sol",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    ...overrides,
  });
  return str(obj(result.thread).id);
}
export async function turn(
  rpc: Rpc,
  threadId: string,
  text: string,
  timeout = 30_000,
): Promise<Frame> {
  const from = rpc.frames.length;
  await rpc.call("turn/start", { threadId, input: [{ type: "text", text }] });
  return rpc.event("turn/completed", from, (params) => params.threadId === threadId, timeout);
}
export class Tui {
  readonly process: IPty;
  readonly terminal = new xterm.Terminal({
    cols: 140,
    rows: 42,
    scrollback: 10_000,
    allowProposedApi: true,
  });
  exited = false;
  constructor(directory: string, env: Record<string, string>, args: string[]) {
    this.process = pty.spawn(
      codex,
      ["--no-alt-screen", ...(args.includes("--remote") ? [] : ["--no-daemon"]), ...args],
      { cwd: workspace, env, cols: 140, rows: 42, name: "xterm-256color" },
    );
    raw(directory, "owned-pids.jsonl", { kind: "tui", pid: this.process.pid });
    this.process.onExit(() => {
      this.exited = true;
    });
    this.process.onData((data) => {
      raw(directory, "tui.raw", data);
      this.terminal.write(data);
      if (data.includes("\x1b[6n")) this.process.write("\x1b[1;1R");
      if (data.includes("\x1b[c")) this.process.write("\x1b[?1;2c");
      if (data.includes("\x1b[>c")) this.process.write("\x1b[>0;0;0c");
      if (data.includes("\x1b]11;?")) this.process.write("\x1b]11;rgb:0000/0000/0000\x1b\\");
    });
  }
  screen(): string {
    const buffer = this.terminal.buffer.active;
    return Array.from(
      { length: buffer.length },
      (_, index) => buffer.getLine(index)?.translateToString(true) ?? "",
    ).join("\n");
  }
  async input(text: string): Promise<void> {
    this.process.write(text);
    await delay(150);
    this.process.write("\r");
  }
  async close(kill = false): Promise<void> {
    if (!this.exited) {
      if (kill) this.process.kill("SIGKILL");
      else {
        this.process.write("\x03");
        await delay(200);
        this.process.write("\x03");
      }
      await until(() => this.exited, "TUI exit", 10_000).catch(() => {
        if (!this.exited) this.process.kill("SIGTERM");
      });
    }
    this.terminal.dispose();
  }
}
