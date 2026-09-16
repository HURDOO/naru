import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ClientWsFrame,
  Project,
  ServerWsFrame,
  Workspace,
} from "../../packages/contracts/src/index.js";
import {
  NARU_SURFACE_CONNECTION_HEADER,
  NARU_SURFACE_GENERATION_HEADER,
  ServerWsFrameSchema,
} from "../../packages/contracts/src/index.js";
import { buildApp } from "../../apps/server/src/app.js";
import type { AppConfig, AppManagedConfig } from "../../apps/server/src/config.js";
import { NaruRepository } from "../../apps/server/src/database.js";
import type { PaneLaunchResolver } from "../../apps/server/src/launch-profiles.js";
import { ProjectPathPolicy } from "../../apps/server/src/path-policy.js";
import { hashPassword } from "../../apps/server/src/password.js";
import type { PasskeyService } from "../../apps/server/src/passkeys.js";
import { PtySupervisor, type PtyProcess } from "../../apps/server/src/pty.js";

export const CURRENT_NARU_ORIGIN = "http://127.0.0.1:5173";

export type CurrentNaruApp = Awaited<ReturnType<typeof buildApp>>;

export interface CurrentNaruSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  terminate(): void;
  once(event: "message", listener: (data: { toString(): string }) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: () => void): void;
  on(event: "message", listener: (data: { toString(): string }) => void): void;
  off(event: "message", listener: (data: { toString(): string }) => void): void;
}

export interface CurrentNaruSurface {
  readonly socket: CurrentNaruSocket;
  readonly connectionId: string;
  readonly generation: number;
}

export interface CurrentNaruAuth {
  readonly cookie: string;
  readonly csrfToken: string;
  surface?: CurrentNaruSurface;
}

export interface CurrentNaruLaunch {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly process: CharacterizationPty;
}

export class CharacterizationPty implements PtyProcess {
  readonly pid: number;
  readonly writes: string[] = [];
  readonly sizes: Array<readonly [number, number]> = [];
  readonly killSignals: Array<string | undefined> = [];
  readonly #dataListeners = new Set<(data: string) => void>();
  readonly #exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  #exited = false;

  constructor(pid: number) {
    this.pid = pid;
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.#dataListeners.add(listener);
    return { dispose: () => this.#dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.#exitListeners.add(listener);
    return { dispose: () => this.#exitListeners.delete(listener) };
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(columns: number, rows: number): void {
    this.sizes.push([columns, rows]);
  }

  kill(signal?: string): void {
    this.killSignals.push(signal);
    this.emitExit(0);
  }

  emitData(data: string): void {
    if (this.#exited) return;
    for (const listener of this.#dataListeners) listener(data);
  }

  emitExit(exitCode: number, signal?: number): void {
    if (this.#exited) return;
    this.#exited = true;
    const event = { exitCode, ...(signal === undefined ? {} : { signal }) };
    for (const listener of this.#exitListeners) listener(event);
  }
}

export interface CurrentNaruFixture {
  readonly app: CurrentNaruApp;
  readonly rootPath: string;
  readonly projectPath: string;
  readonly repository: NaruRepository;
  readonly supervisor: PtySupervisor;
  readonly launches: CurrentNaruLaunch[];
  writeProjectFile(relativePath: string, source: string): Promise<void>;
  closeApp(): Promise<void>;
  dispose(): Promise<void>;
}

export async function createCurrentNaruFixture(
  options: {
    readonly passkeys?: PasskeyService;
    readonly configPatch?: Partial<AppManagedConfig>;
  } = {},
): Promise<CurrentNaruFixture> {
  const basePath = await mkdtemp(join(tmpdir(), "naru-characterization-"));
  const rootPath = join(basePath, "coding");
  const projectPath = join(rootPath, "project");
  await mkdir(projectPath, { recursive: true });
  await writeFile(join(projectPath, "keep.txt"), "current Naru fixture\n");

  const canonicalRoot = await realpath(rootPath);
  const canonicalProject = await realpath(projectPath);
  const passwordHash = await hashPassword("naru-test-password", {
    N: 1024,
    salt: Buffer.alloc(16, 7),
  });
  const config: AppConfig = {
    authMode: "app-managed",
    environment: "test",
    host: "127.0.0.1",
    port: 4174,
    allowedOrigins: new Set([CURRENT_NARU_ORIGIN]),
    projectRoots: [canonicalRoot],
    passwordHash,
    sessionSecret: "naru-characterization-session-secret-is-test-only",
    sessionCookieName: "naru_test_session",
    dataDir: basePath,
    secureCookie: false,
    appBasePath: "/",
    ...options.configPatch,
  };
  const repository = new NaruRepository(":memory:");
  const pathPolicy = await ProjectPathPolicy.create([canonicalRoot]);
  const launches: CurrentNaruLaunch[] = [];
  let nextPid = 7000;
  const launchProfiles: PaneLaunchResolver = {
    resolve(context) {
      return context.pane.kind === "codex"
        ? {
            file: "/test/bin/codex",
            args: ["--profile-id", context.pane.launchProfile],
            environment: { TERM: "xterm-256color" },
          }
        : {
            file: "/bin/zsh",
            args: ["-l"],
            environment: { TERM: "xterm-256color" },
          };
    },
  };
  const supervisor = new PtySupervisor(
    repository,
    (file, args, spawnOptions) => {
      const process = new CharacterizationPty(nextPid++);
      launches.push({ file, args: [...args], cwd: spawnOptions.cwd, process });
      return process;
    },
    launchProfiles,
  );
  const app = await buildApp(config, {
    repository,
    pathPolicy,
    supervisor,
    ...(options.passkeys === undefined ? {} : { passkeys: options.passkeys }),
  });
  let closed = false;

  const closeApp = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await app.close();
  };

  return {
    app,
    rootPath: canonicalRoot,
    projectPath: canonicalProject,
    repository,
    supervisor,
    launches,
    async writeProjectFile(relativePath, source) {
      const target = join(canonicalProject, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, source);
    },
    closeApp,
    async dispose() {
      await closeApp();
      await rm(basePath, { recursive: true, force: true });
    },
  };
}

export async function loginWithPassword(app: CurrentNaruApp): Promise<CurrentNaruAuth> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: CURRENT_NARU_ORIGIN },
    payload: { password: "naru-test-password" },
  });
  if (response.statusCode !== 200) {
    throw new Error(`Current Naru login failed with ${response.statusCode}.`);
  }
  const setCookie = response.headers["set-cookie"];
  const serialized = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const cookie = serialized?.split(";")[0];
  const csrfToken = response.json<{ csrfToken: string }>().csrfToken;
  if (!cookie || !csrfToken) throw new Error("Current Naru login did not return auth state.");
  return { cookie, csrfToken };
}

export async function registerProject(
  fixture: CurrentNaruFixture,
  auth: CurrentNaruAuth,
  path = fixture.projectPath,
  name = "Characterization project",
): Promise<Project> {
  await ensureControllerSurface(fixture, auth);
  const response = await fixture.app.inject({
    method: "POST",
    url: "/api/projects",
    headers: unsafeHeaders(auth),
    payload: { path, name },
  });
  if (response.statusCode !== 201) {
    throw new Error(`Current Naru project registration failed with ${response.statusCode}.`);
  }
  return response.json<Project>();
}

export async function ensureControllerSurface(
  fixture: CurrentNaruFixture,
  auth: CurrentNaruAuth,
  clientId = "11111111-1111-4111-8111-111111111111",
): Promise<CurrentNaruSurface> {
  if (auth.surface !== undefined) return auth.surface;
  const socket = await fixture.app.injectWS("/api/terminal", {
    headers: { cookie: auth.cookie, origin: CURRENT_NARU_ORIGIN },
  });
  const frames = nextServerFrames(socket, 2);
  sendClientFrame(socket, { type: "lease.acquire", clientId });
  const state = (await frames).find((frame) => frame.type === "surface.state");
  if (state?.type !== "surface.state" || state.role !== "controller") {
    throw new Error("Current Naru controller surface was not acquired.");
  }
  const surface = {
    socket,
    connectionId: state.connectionId,
    generation: state.generation,
  };
  auth.surface = surface;
  return surface;
}

export function unsafeHeaders(auth: CurrentNaruAuth): Record<string, string> {
  const headers: Record<string, string> = {
    origin: CURRENT_NARU_ORIGIN,
    cookie: auth.cookie,
    "x-csrf-token": auth.csrfToken,
  };
  if (auth.surface !== undefined) {
    headers[NARU_SURFACE_CONNECTION_HEADER] = auth.surface.connectionId;
    headers[NARU_SURFACE_GENERATION_HEADER] = String(auth.surface.generation);
  }
  return headers;
}

export function workspace(fixture: CurrentNaruFixture, projectId: string): Workspace {
  return fixture.repository.getWorkspace(projectId);
}

export function sendClientFrame(socket: CurrentNaruSocket, frame: ClientWsFrame): void {
  socket.send(JSON.stringify(frame));
}

export function nextServerFrame(socket: CurrentNaruSocket): Promise<ServerWsFrame> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for a current Naru server frame.")),
      1_000,
    );
    timeout.unref();
    socket.once("message", (data) => {
      try {
        clearTimeout(timeout);
        resolve(ServerWsFrameSchema.parse(JSON.parse(data.toString()) as unknown));
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Invalid current Naru server frame."));
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

export function nextServerFrames(
  socket: CurrentNaruSocket,
  count: number,
): Promise<ServerWsFrame[]> {
  return new Promise((resolve, reject) => {
    const frames: ServerWsFrame[] = [];
    const timeout = setTimeout(() => {
      socket.off("message", listener);
      reject(
        new Error(
          `Timed out waiting for ${count} current Naru server frames after receiving ${frames.length}: ${frames.map(({ type }) => type).join(", ")}.`,
        ),
      );
    }, 1_000);
    timeout.unref();
    const listener = (data: { toString(): string }): void => {
      try {
        frames.push(ServerWsFrameSchema.parse(JSON.parse(data.toString()) as unknown));
      } catch (error) {
        clearTimeout(timeout);
        socket.off("message", listener);
        reject(error instanceof Error ? error : new Error("Invalid current Naru server frame."));
        return;
      }
      if (frames.length < count) return;
      clearTimeout(timeout);
      socket.off("message", listener);
      resolve(frames);
    };
    socket.on("message", listener);
  });
}

export async function closeSocket(socket: CurrentNaruSocket): Promise<void> {
  if (socket.readyState === 3) return;
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.terminate();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Timed out closing current Naru socket.")),
          1_000,
        );
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for current Naru behavior.");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
