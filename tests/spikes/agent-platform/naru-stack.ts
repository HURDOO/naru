/**
 * The built Naru server with the Agent Platform enabled, against an isolated DurableSession Host,
 * stand-in runtimes (a Claude SDK module given by the caller, a Claude TUI stand-in, a fake Codex)
 * and temp projects. Shared by the UI sandbox and the acceptance run; nothing touches the user's
 * own Naru, Host or accounts.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DurableSessionHostConfigSchema } from "../../../apps/durable-session-host/src/config.js";
import { startDurableSessionHost } from "../../../apps/durable-session-host/src/host.js";
import { silentHostLogger } from "../../../apps/durable-session-host/src/logging.js";
import { createHostFixture } from "../../../apps/durable-session-host/test/support.js";
import { hashPassword } from "../../../apps/server/src/password.js";
import { fakeCodexScript } from "../../../apps/server/test/fake-codex.js";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export interface NaruStack {
  readonly origin: string;
  readonly password: string;
  /** The approved project root; projects are directories under it. */
  readonly projectRoot: string;
  /** The stack's temp directory (Host state, Naru data, logs); removed by stop(). */
  readonly root: string;
  readonly logFile: string;
  /** Stops the Naru server process and starts it again on the same data (runners keep going). */
  restartServer(): Promise<void>;
  stop(): Promise<void>;
}

/** The user's installed runtimes and login, for real-model acceptance (no stand-ins). */
export interface RealRuntimes {
  readonly sdkPath: string;
  readonly claudePath: string;
  readonly home: string;
  readonly user: string;
}

export async function startNaruStack(options: {
  /** Source of the stand-in Claude Agent SDK module (exports query and getSessionMessages). */
  readonly sdkSource?: string;
  /** Real runtimes instead of stand-ins; the projects must then live under `projectRoot`. */
  readonly real?: RealRuntimes;
  /** The approved project root (default: the Host fixture's temp root). */
  readonly projectRoot?: string;
  readonly port?: number;
  /** Extra environment for the Host's agent processes (e.g. a puppet socket path). */
  readonly agentEnvironment?: Readonly<Record<string, string>>;
}): Promise<NaruStack> {
  const node = process.execPath;
  const wsModule = createRequire(join(repositoryRoot, "apps/server/package.json")).resolve("ws");
  const fixture = createHostFixture();
  const projectRoot = options.projectRoot ?? fixture.config.roots[0]!.path;
  mkdirSync(projectRoot, { recursive: true });
  const real = options.real;

  const sdkEntry = real?.sdkPath ?? join(fixture.root, "fake-sdk.mjs");
  if (real === undefined) writeFileSync(sdkEntry, options.sdkSource ?? "", { mode: 0o600 });
  const claude = real?.claudePath ?? join(fixture.root, "claude");
  if (real === undefined) {
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
process.stdout.write("stand-in Claude TUI (resumed)\\r\\n");
setInterval(() => {}, 1000);
process.on("SIGTERM", () => process.exit(0));
`,
      { mode: 0o700 },
    );
    chmodSync(claude, 0o700);
  }
  const codex = join(fixture.root, "codex");
  writeFileSync(codex, fakeCodexScript(node, wsModule), { mode: 0o700 });
  chmodSync(codex, 0o700);
  const codexLog = join(fixture.root, "fake-codex.log");
  writeFileSync(codexLog, "", { mode: 0o600 });

  const integrationSocket = join(fixture.root, "ci.sock");
  const executablePath = `${real === undefined ? "" : `${dirname(claude)}:`}${dirname(node)}:/usr/bin:/bin`;
  // Real Claude reads the user's login from the keychain, which needs the user's identity.
  const identity: Record<string, string> =
    real === undefined
      ? { HOME: fixture.root }
      : { HOME: real.home, USER: real.user, LOGNAME: real.user, LANG: "en_US.UTF-8" };
  const launcher = (name: string) => [join(repositoryRoot, `apps/server/dist/${name}.js`)];
  const host = await startDurableSessionHost(
    DurableSessionHostConfigSchema.parse({
      ...fixture.config,
      roots: [{ rootId: "projects", path: projectRoot }],
      // The fixture's limit of 10 is for unit tests; a team of agents with processes needs more.
      sessionLimit: 100,
      profiles: [
        {
          profileId: "shell",
          executable: "/bin/zsh",
          args: ["-f"],
          envPolicyId: "safe-env",
          resourcePolicyId: "fixture-resource",
        },
        {
          profileId: "claude-code",
          executable: node,
          args: launcher("claude-integration-launcher"),
          envPolicyId: "safe-env",
          resourcePolicyId: "fixture-resource",
        },
        {
          profileId: "codex-main",
          executable: node,
          args: launcher("codex-integration-launcher"),
          envPolicyId: "safe-env",
          resourcePolicyId: "fixture-resource",
        },
      ],
      environmentPolicies: [
        {
          envPolicyId: "safe-env",
          inherit: [],
          values: {
            PATH: executablePath,
            ...identity,
            FAKE_CODEX_LOG: codexLog,
            NARU_CODEX_INTEGRATION_SOCKET: integrationSocket,
            NARU_CLAUDE_HOOK_RUNNER: node,
            NARU_CLAUDE_HOOK_ENTRY: join(
              repositoryRoot,
              "apps/server/dist/claude-integration-hook-cli.js",
            ),
            ...options.agentEnvironment,
          },
        },
      ],
      resourcePolicies: [
        {
          ...fixture.config.resourcePolicies[0],
          allowedExecutables: [node, "/bin/zsh"],
          stopTimeoutMs: 5_000,
        },
      ],
      integrationPolicies: [
        {
          policyRef: "naru-claude-v0",
          appId: "fixture-app",
          integrationKind: "claude",
          profileIds: ["claude-code"],
          configKeys: ["policyRef", "bindingId"],
        },
        {
          policyRef: "naru-codex-v0",
          appId: "fixture-app",
          integrationKind: "codex",
          profileIds: ["codex-main"],
          configKeys: ["policyRef", "bindingId"],
        },
      ],
    }),
    { logger: silentHostLogger, hostEnvironment: {} },
  );

  const port = options.port ?? (await freePort());
  const origin = `http://127.0.0.1:${port}`;
  const password = randomUUID().slice(0, 12);
  const environmentFile = join(fixture.root, "naru.env");
  writeFileSync(
    environmentFile,
    Object.entries({
      NODE_ENV: "production",
      NARU_AUTH_MODE: "app-managed",
      NARU_PORT: String(port),
      NARU_ALLOWED_ORIGINS: origin,
      NARU_PROJECT_ROOTS: projectRoot,
      NARU_DATA_DIR: join(fixture.root, "naru-data"),
      NARU_WEB_DIST: join(repositoryRoot, "apps/web/dist"),
      NARU_PASSWORD_HASH: await hashPassword(password),
      NARU_SESSION_SECRET: `${randomUUID()}${randomUUID()}`,
      NARU_SESSION_OWNER: "durable-host",
      NARU_DURABLE_SESSION_SOCKET_PATH: fixture.config.socketPath,
      NARU_DURABLE_SESSION_CREDENTIAL_FILE: fixture.credentialFile,
      NARU_DURABLE_SESSION_APP_ID: "fixture-app",
      NARU_DURABLE_SESSION_SUBJECT: "fixture-owner",
      NARU_DURABLE_SESSION_IDEMPOTENCY_TTL_MS: "30000",
      NARU_DURABLE_SESSION_PROFILE_IDS: JSON.stringify(["shell", "claude-code", "codex-main"]),
      NARU_DURABLE_SESSION_ROOTS: JSON.stringify({ projects: projectRoot }),
      NARU_CODEX_INTEGRATION_SOCKET_PATH: integrationSocket,
      NARU_CLAUDE_PATH: claude,
      NARU_CODEX_PATH: codex,
      NARU_CLAUDE_AGENT_SDK_PATH: sdkEntry,
      NARU_AGENT_PLATFORM: "1",
    })
      .map(([key, value]) => `${key}='${value}'`)
      .join("\n"),
    { mode: 0o600 },
  );
  const logFile = join(fixture.root, "naru.log");
  let server: ChildProcess | null = null;
  const startServer = async (): Promise<void> => {
    const logDescriptor = openSync(logFile, "a", 0o600);
    server = spawn(node, [join(repositoryRoot, "apps/server/dist/index.js")], {
      cwd: repositoryRoot,
      env: { PATH: executablePath, ...identity, NARU_ENV_FILE: environmentFile },
      stdio: ["ignore", logDescriptor, logDescriptor],
    });
    closeSync(logDescriptor);
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if ((await fetch(`${origin}/healthz`).catch(() => null))?.ok === true) return;
      await new Promise((done) => setTimeout(done, 200));
    }
    // The fixture directory goes away with the stack; show why the server did not come up.
    const tail = readFileSync(logFile, "utf8").trim().split("\n").slice(-12).join("\n");
    throw new Error(`Naru did not become healthy.\n${tail}`);
  };
  const stopServer = async (): Promise<void> => {
    const running = server;
    if (running === null) return;
    server = null;
    await new Promise<void>((done) => {
      running.once("exit", () => done());
      running.kill("SIGTERM");
      setTimeout(() => {
        running.kill("SIGKILL");
        done();
      }, 10_000).unref();
    });
  };
  await startServer();
  return {
    origin,
    password,
    projectRoot,
    root: fixture.root,
    logFile,
    restartServer: async () => {
      await stopServer();
      await startServer();
    },
    stop: async () => {
      await stopServer();
      await host.close();
      rmSync(fixture.root, { recursive: true, force: true });
    },
  };
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
