/**
 * AP-T14 boot acceptance: the real Naru server entry (`apps/server/src/index.ts`) with
 * NARU_AGENT_PLATFORM=1 against an isolated DurableSession Host. A scripted SDK and a stand-in
 * Claude TUI replace the model, so no account or network is used. Everything lives in a temp
 * directory that is removed afterwards; nothing touches the operating instance.
 *
 * Run (Node 24) after `pnpm --filter @naru/server build`:
 *   node --import tsx tests/spikes/agent-platform/naru-managed-agent-boot.ts
 * The server, launcher, runner and hook bins run from `apps/server/dist` with plain Node, as in
 * production. SPIKE_SOURCE=1 runs them from source through tsx instead.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DurableSessionHostConfigSchema } from "../../../apps/durable-session-host/src/config.js";
import { startDurableSessionHost } from "../../../apps/durable-session-host/src/host.js";
import { silentHostLogger } from "../../../apps/durable-session-host/src/logging.js";
import { createHostFixture } from "../../../apps/durable-session-host/test/support.js";
import { hashPassword } from "../../../apps/server/src/password.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const requireFromServer = createRequire(join(repositoryRoot, "apps/server/package.json"));
/** The slice of the server's `ws` client used here (the spike has no `ws` types of its own). */
interface LeaseSocket {
  on(event: "open", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "message", listener: (data: Buffer) => void): void;
  send(data: string): void;
  terminate(): void;
}
const WebSocket = requireFromServer("ws") as new (
  url: string,
  options: { headers: Record<string, string> },
) => LeaseSocket;
const tsxLoader = pathToFileURL(join(repositoryRoot, "node_modules/tsx/dist/loader.mjs")).href;
const SESSION = "11111111-2222-4333-8444-555555555555";
const fromSource = process.env.SPIKE_SOURCE === "1";
/** Node command line for a server bin: built (production layout) or from source via tsx. */
const bin = (name: string): string[] =>
  fromSource
    ? ["--import", tsxLoader, join(repositoryRoot, `apps/server/src/${name}.ts`)]
    : [join(repositoryRoot, `apps/server/dist/${name}.js`)];
const results: Record<string, string> = {};
type Api = <T>(method: string, path: string, body?: unknown) => Promise<T>;
const sockets: LeaseSocket[] = [];
const record = (step: string, outcome: "PASS" | "FAIL", detail = ""): void => {
  results[step] = detail === "" ? outcome : `${outcome} (${detail})`;
};

if (process.versions.node.split(".")[0] !== "24") throw new Error("Node 24 required");
const fixture = createHostFixture();
const node = process.execPath;
const projectRoot = fixture.config.roots[0]!.path;
const sdkEntry = join(fixture.root, "fake-sdk.mjs");
writeFileSync(
  sdkEntry,
  `export function query({ prompt, options }) {
  async function* run() {
    yield { type: "system", subtype: "init", session_id: options.resume ?? "${SESSION}" };
    for await (const message of prompt) yield { type: "result", subtype: "success", is_error: false };
  }
  const iterator = run();
  iterator.interrupt = async () => {};
  return iterator;
}
export async function getSessionMessages(sessionId) {
  return [{ type: "user", session_id: sessionId }, { type: "assistant", session_id: sessionId }];
}
`,
  { mode: 0o600 },
);
const claude = join(fixture.root, "claude");
writeFileSync(
  claude,
  `#!${node}
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "auth") { process.stdout.write('{"loggedIn":true}'); process.exit(0); }
const resume = args[args.indexOf("--resume") + 1];
const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
for (const matcher of settings.hooks.SessionStart ?? []) for (const hook of matcher.hooks) {
  spawnSync("/bin/sh", ["-c", hook.command], {
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: resume, cwd: process.cwd(), source: "resume" }),
    stdio: ["pipe", "ignore", "ignore"],
  });
}
setInterval(() => {}, 1000);
process.on("SIGTERM", () => process.exit(0));
`,
  { mode: 0o700 },
);
chmodSync(claude, 0o700);

const integrationSocket = join(fixture.root, "ci.sock");
const host = await startDurableSessionHost(
  DurableSessionHostConfigSchema.parse({
    ...fixture.config,
    profiles: [
      {
        profileId: "claude-code",
        executable: node,
        args: bin("claude-integration-launcher"),
        envPolicyId: "safe-env",
        resourcePolicyId: "fixture-resource",
      },
    ],
    environmentPolicies: [
      {
        envPolicyId: "safe-env",
        inherit: [],
        values: {
          PATH: `${dirname(node)}:/usr/bin:/bin`,
          HOME: fixture.root,
          NARU_CODEX_INTEGRATION_SOCKET: integrationSocket,
          NARU_CLAUDE_HOOK_RUNNER: fromSource
            ? join(repositoryRoot, "node_modules/.bin/tsx")
            : node,
          NARU_CLAUDE_HOOK_ENTRY: join(
            repositoryRoot,
            fromSource
              ? "apps/server/src/claude-integration-hook-cli.ts"
              : "apps/server/dist/claude-integration-hook-cli.js",
          ),
        },
      },
    ],
    resourcePolicies: [
      { ...fixture.config.resourcePolicies[0], allowedExecutables: [node], stopTimeoutMs: 5_000 },
    ],
    integrationPolicies: [
      {
        policyRef: "naru-claude-v0",
        appId: "fixture-app",
        integrationKind: "claude",
        profileIds: ["claude-code"],
        configKeys: ["policyRef", "bindingId"],
      },
    ],
  }),
  { logger: silentHostLogger, hostEnvironment: {} },
);

const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const password = randomUUID();
const environmentFile = join(fixture.root, "naru.env");
writeFileSync(
  environmentFile,
  Object.entries({
    NODE_ENV: fromSource ? "development" : "production",
    NARU_AUTH_MODE: "app-managed",
    NARU_PORT: String(port),
    NARU_ALLOWED_ORIGINS: origin,
    NARU_PROJECT_ROOTS: projectRoot,
    NARU_DATA_DIR: join(fixture.root, "naru-data"),
    NARU_PASSWORD_HASH: await hashPassword(password),
    NARU_SESSION_SECRET: `${randomUUID()}${randomUUID()}`,
    NARU_SESSION_OWNER: "durable-host",
    NARU_DURABLE_SESSION_SOCKET_PATH: fixture.config.socketPath,
    NARU_DURABLE_SESSION_CREDENTIAL_FILE: fixture.credentialFile,
    NARU_DURABLE_SESSION_APP_ID: "fixture-app",
    NARU_DURABLE_SESSION_SUBJECT: "fixture-owner",
    NARU_DURABLE_SESSION_IDEMPOTENCY_TTL_MS: "30000",
    NARU_DURABLE_SESSION_PROFILE_IDS: JSON.stringify(["claude-code"]),
    NARU_DURABLE_SESSION_ROOTS: JSON.stringify({ projects: projectRoot }),
    NARU_CODEX_INTEGRATION_SOCKET_PATH: integrationSocket,
    NARU_CLAUDE_PATH: claude,
    NARU_CLAUDE_AGENT_SDK_PATH: sdkEntry,
    NARU_AGENT_PLATFORM: "1",
  })
    .map(([key, value]) => `${key}='${value}'`)
    .join("\n"),
  { mode: 0o600 },
);

let server: ChildProcess | null = null;
const serverLog: string[] = [];
const serverLogFiles: string[] = [];
async function startNaru(): Promise<void> {
  // Like launchd, the server writes to a regular file: with a pipe for stdout, Node 24's CJS
  // realpath cache can mis-resolve later lazy requires of pnpm-symlinked packages.
  const logFile = join(fixture.root, `naru-${serverLog.length}.log`);
  const logDescriptor = openSync(logFile, "a", 0o600);
  server = spawn(node, bin("index"), {
    cwd: repositoryRoot,
    env: {
      PATH: `${dirname(node)}:/usr/bin:/bin`,
      HOME: fixture.root,
      NARU_ENV_FILE: environmentFile,
    },
    stdio: ["ignore", logDescriptor, logDescriptor],
  });
  closeSync(logDescriptor);
  serverLogFiles.push(logFile);
  const generation = serverLog.length === 0 ? "first" : "next";
  serverLog.push(`--- ${generation} Naru process ---\n`);
  server.once("exit", (code, signal) => serverLog.push(`--- exited ${code} ${signal} ---\n`));
  await until(async () => {
    if (server?.exitCode !== null) throw new Error("Naru exited during startup");
    return (await fetch(`${origin}/healthz`).catch(() => null))?.ok === true;
  }, "listen");
}
async function stopNaru(): Promise<void> {
  const current = server;
  if (current === null || current.exitCode !== null) return;
  await new Promise<void>((done) => {
    current.once("exit", () => done());
    current.kill("SIGTERM");
  });
}

let failure: unknown = null;
try {
  await startNaru();
  record("server boots with the agent runtime", "PASS");
  let api = await connect();
  const projects = await api<{ id: string; path: string }[]>("GET", "/api/projects");
  let project = projects.find((candidate) => candidate.path === join(projectRoot, "sample"));
  project ??= (await api<{ id: string }>("POST", "/api/projects", {
    path: join(projectRoot, "sample"),
    name: "boot",
  })) as { id: string; path: string };
  const agent = await api<{ id: string }>("POST", "/api/agent/agents", {
    projectId: project.id,
    role: "worker",
    runtime: "claude",
    idempotencyKey: randomUUID(),
  });
  type Runtime = { connected: boolean; writer: string; generation: number; launchMode: string };
  const runtime = () => api<Runtime>("GET", `/api/agent/agents/${agent.id}/runtime`);
  const session = async () =>
    (
      await api<{ agents: { id: string; status: string; paneId: string | null }[] }>(
        "GET",
        `/api/agent/projects/${project.id}`,
      )
    ).agents.find((candidate) => candidate.id === agent.id)!;
  await until(
    async () => (await runtime()).connected && (await session()).status === "active",
    "runner",
  );
  const workspace = await api<{ layout: unknown; panes: { id: string; launchProfile: string }[] }>(
    "GET",
    `/api/projects/${project.id}/workspace`,
  );
  const paneId = (await session()).paneId;
  const pane = workspace.panes.find((candidate) => candidate.id === paneId);
  record(
    "agent created over HTTP runs in a collapsed Host PTY Pane",
    pane?.launchProfile === "claude-agent" &&
      JSON.stringify(workspace.layout).includes(`"paneId":"${pane.id}","collapsed":true`)
      ? "PASS"
      : "FAIL",
  );

  await api("POST", `/api/agent/agents/${agent.id}/hold`, {
    held: true,
    surface: "chat",
    idempotencyKey: randomUUID(),
  });
  const chat = await runtime();
  await api("POST", `/api/agent/agents/${agent.id}/turns`, {
    text: "boot spike turn",
    generation: chat.generation,
    idempotencyKey: randomUUID(),
  });
  await until(async () => (await session()).status === "idle", "chat turn");
  const history = await api<{ items: unknown[] }>("GET", `/api/agent/agents/${agent.id}/history`);
  record(
    "Chat takeover, turn and history",
    chat.writer === "gui" && history.items.length === 2 ? "PASS" : "FAIL",
  );

  await api("POST", `/api/agent/agents/${agent.id}/hold`, {
    held: false,
    idempotencyKey: randomUUID(),
  });
  await api("POST", `/api/agent/agents/${agent.id}/hold`, {
    held: true,
    surface: "tui",
    idempotencyKey: randomUUID(),
  });
  const tui = await runtime();
  await api("POST", `/api/agent/agents/${agent.id}/hold`, {
    held: false,
    idempotencyKey: randomUUID(),
  });
  await until(async () => (await runtime()).connected, "runner back after TUI");
  const back = await runtime();
  record(
    "TUI intervention and release (stop-resume)",
    tui.writer === "tui" && tui.launchMode === "tui" && back.writer === "orchestrator"
      ? "PASS"
      : "FAIL",
    `generations ${chat.generation}→${tui.generation}→${back.generation}`,
  );

  const runnersBefore = runnerProcesses();
  await stopNaru();
  await new Promise((done) => setTimeout(done, 1_000));
  record(
    "idle runner outlives the Naru process",
    runnersBefore === 1 && runnerProcesses() === 1 ? "PASS" : "FAIL",
  );
  await startNaru();
  api = await connect();
  await until(async () => (await runtime()).connected, "runner reconnects to the restarted Naru");
  record("runner survives a Naru restart and reconnects", "PASS");

  await api("POST", `/api/agent/agents/${agent.id}/stop`, {});
  await until(async () => (await session()).status === "stopped", "stopped");
  record("stop", "PASS");
} catch (error) {
  failure = error;
} finally {
  for (const socket of sockets) socket.terminate();
  await stopNaru();
  await host.close();
  for (const file of serverLogFiles) serverLog.push(`--- log ---\n`, readFileSync(file, "utf8"));
  if (process.env.SPIKE_KEEP === "1") process.stdout.write(`kept ${fixture.root}\n`);
  else rmSync(fixture.root, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
if (failure !== null) {
  process.stdout.write(`FAILED: ${failure instanceof Error ? failure.message : "non-error"}\n`);
  process.stdout.write(
    serverLog
      .join("")
      .split("\n")
      .filter((line) => !line.includes('"level":30'))
      .slice(-80)
      .join("\n"),
  );
  process.exitCode = 1;
}

/** Logs in and takes the human device lease, as the browser does. */
async function connect(): Promise<Api> {
  const login = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const { csrfToken } = (await login.json()) as { csrfToken: string };
  const lease = await acquireLease(cookie);
  const headers = {
    origin,
    cookie,
    "x-csrf-token": csrfToken,
    "content-type": "application/json",
    ...lease,
  };
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: method === "GET" ? { cookie } : headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text}`);
    return (text === "" ? null : JSON.parse(text)) as T;
  };
}

/** Runner processes started by this spike's Host (matched by this fixture's data path). */
function runnerProcesses(): number {
  const listing = spawnSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout;
  return listing
    .split("\n")
    .filter((line) => line.includes("claude-agent-runner") && line.includes(repositoryRoot)).length;
}

async function until(check: () => Promise<boolean>, label: string, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (
      await check().catch((error: unknown) => {
        if (error instanceof Error && error.message.includes("exited")) throw error;
        return false;
      })
    )
      return;
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`timed out: ${label}`);
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => done(typeof address === "object" && address !== null ? address.port : 0));
    });
  });
}

async function acquireLease(cookie: string): Promise<Record<string, string>> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/terminal`, {
    headers: { cookie, origin },
  });
  sockets.push(socket);
  return new Promise((done, fail) => {
    socket.on("error", fail);
    socket.on("open", () =>
      socket.send(JSON.stringify({ type: "lease.acquire", clientId: randomUUID() })),
    );
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data)) as Record<string, unknown>;
      if (frame.type === "surface.state" && typeof frame.connectionId === "string") {
        done({
          "x-naru-surface-connection": frame.connectionId,
          "x-naru-surface-generation": String(frame.generation),
        });
      }
    });
  });
}
