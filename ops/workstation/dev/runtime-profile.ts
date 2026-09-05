import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const PROFILE_SCHEMA_VERSION = 1;
const PROFILE_PORT_BASE = 42_000;
const PROFILE_PORT_STRIDE = 4;
const PROFILE_SLOT_COUNT = 1_000;
const MAX_UNIX_SOCKET_BYTES = 103;
const DEFAULT_RUNTIME_PARENT = "/private/tmp";

export const RESERVED_RUNTIME = {
  ports: [4_174, 4_990, 4_991, 4_992, 5_173, 8_443],
  cookies: ["naru_session", "naru_dev_session", "naru_test_session"],
  labels: ["com.naru.agent", "com.naru.maintenance"],
} as const;

export interface WorkstationRuntimeProfile {
  readonly schemaVersion: number;
  readonly profileId: string;
  readonly repositoryRoot: string;
  readonly ownerUid: number;
  readonly digest: string;
  readonly stateRoot: string;
  readonly runtimeRoot: string;
  readonly data: {
    readonly host: string;
    readonly gateway: string;
    readonly naru: string;
  };
  readonly credentials: {
    readonly host: string;
    readonly gateway: string;
  };
  readonly sockets: {
    readonly host: string;
    readonly gatewayAdmin: string;
  };
  readonly ports: {
    readonly gateway: number;
    readonly naruApi: number;
    readonly naruWeb: number;
  };
  readonly origins: {
    readonly gateway: string;
    readonly naruApi: string;
    readonly naruWeb: string;
  };
  readonly cookies: {
    readonly gateway: string;
    readonly naru: string;
  };
  readonly labels: {
    readonly host: string;
    readonly gateway: string;
    readonly naru: string;
  };
  readonly markerPath: string;
}

export interface RuntimeProfileOptions {
  readonly ownerUid?: number;
  readonly runtimeParent?: string;
}

export function discoverRepositoryRoot(startDirectory = process.cwd()): string {
  const start = realpathSync(startDirectory);
  let current = statSync(start).isDirectory() ? start : dirname(start);

  while (true) {
    if (existsSync(join(current, ".git")) && existsSync(join(current, "package.json"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`No Git repository root found above ${start}.`);
    }
    current = parent;
  }
}

export function createRuntimeProfile(
  repositoryRoot: string,
  options: RuntimeProfileOptions = {},
): WorkstationRuntimeProfile {
  const canonicalRoot = realpathSync(repositoryRoot);
  if (!statSync(canonicalRoot).isDirectory()) {
    throw new Error(`Repository root is not a directory: ${canonicalRoot}`);
  }

  const ownerUid = options.ownerUid ?? process.getuid?.() ?? 0;
  const runtimeParent = resolve(options.runtimeParent ?? DEFAULT_RUNTIME_PARENT);
  if (!isAbsolute(runtimeParent)) {
    throw new Error("Runtime parent must be an absolute path.");
  }

  const digestBytes = createHash("sha256").update(canonicalRoot).digest();
  const digest = digestBytes.toString("hex");
  const shortDigest = digest.slice(0, 12);
  const slug = sanitizeProfileSlug(basename(canonicalRoot));
  const profileId = `${slug}-${shortDigest}`;
  const portSlot = digestBytes.readUInt16BE(0) % PROFILE_SLOT_COUNT;
  const portBase = PROFILE_PORT_BASE + portSlot * PROFILE_PORT_STRIDE;
  const stateRoot = join(canonicalRoot, ".local", "workstation-dev", profileId);
  const runtimeRoot = join(runtimeParent, `naru-workstation-${ownerUid}`, shortDigest);
  const labelPrefix = `com.naru.workstation.dev.${shortDigest}`;

  const profile: WorkstationRuntimeProfile = {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    profileId,
    repositoryRoot: canonicalRoot,
    ownerUid,
    digest,
    stateRoot,
    runtimeRoot,
    data: {
      host: join(stateRoot, "data", "host"),
      gateway: join(stateRoot, "data", "gateway"),
      naru: join(stateRoot, "data", "naru"),
    },
    credentials: {
      host: join(stateRoot, "credentials", "host"),
      gateway: join(stateRoot, "credentials", "gateway"),
    },
    sockets: {
      host: join(runtimeRoot, "host.sock"),
      gatewayAdmin: join(runtimeRoot, "gateway-admin.sock"),
    },
    ports: {
      gateway: portBase,
      naruApi: portBase + 1,
      naruWeb: portBase + 2,
    },
    origins: {
      gateway: `http://127.0.0.1:${portBase}`,
      naruApi: `http://127.0.0.1:${portBase + 1}`,
      naruWeb: `http://127.0.0.1:${portBase + 2}`,
    },
    cookies: {
      gateway: `workstation_dev_${shortDigest}_session`,
      naru: `naru_dev_${shortDigest}_session`,
    },
    labels: {
      host: `${labelPrefix}.host`,
      gateway: `${labelPrefix}.gateway`,
      naru: `${labelPrefix}.naru`,
    },
    markerPath: join(stateRoot, "playwright-mcp.json"),
  };

  assertRuntimeProfileIsolation(profile);
  return profile;
}

export function createNaruDevelopmentEnvironment(
  profile: WorkstationRuntimeProfile,
): Readonly<Record<string, string>> {
  assertRuntimeProfileIsolation(profile);
  return {
    NODE_ENV: "development",
    NARU_AUTH_MODE: "app-managed",
    NARU_HOST: "127.0.0.1",
    NARU_PORT: String(profile.ports.naruApi),
    NARU_WEB_PORT: String(profile.ports.naruWeb),
    NARU_API_PORT: String(profile.ports.naruApi),
    NARU_ALLOWED_ORIGINS: `${profile.origins.naruWeb},${profile.origins.naruApi}`,
    NARU_PROJECT_ROOTS: profile.repositoryRoot,
    NARU_DATA_DIR: profile.data.naru,
    NARU_SESSION_COOKIE_NAME: profile.cookies.naru,
  };
}

export function assertRuntimeProfileIsolation(profile: WorkstationRuntimeProfile): void {
  if (profile.schemaVersion !== PROFILE_SCHEMA_VERSION) {
    throw new Error(`Unsupported runtime profile schema: ${profile.schemaVersion}`);
  }
  if (!isAbsolute(profile.repositoryRoot) || !isAbsolute(profile.stateRoot)) {
    throw new Error("Repository and state roots must be absolute paths.");
  }
  if (!isPathInside(profile.repositoryRoot, profile.stateRoot)) {
    throw new Error("Development state must remain inside the current worktree.");
  }

  const ports = Object.values(profile.ports);
  if (new Set(ports).size !== ports.length) {
    throw new Error("Development listeners must use distinct ports.");
  }
  for (const port of ports) {
    if (!Number.isInteger(port) || port < PROFILE_PORT_BASE || port > 45_999) {
      throw new Error(`Development listener is outside the allocated range: ${port}`);
    }
    if ((RESERVED_RUNTIME.ports as readonly number[]).includes(port)) {
      throw new Error(`Development listener collides with a reserved Naru port: ${port}`);
    }
  }

  assertExactLoopbackOrigin(profile.origins.gateway, profile.ports.gateway);
  assertExactLoopbackOrigin(profile.origins.naruApi, profile.ports.naruApi);
  assertExactLoopbackOrigin(profile.origins.naruWeb, profile.ports.naruWeb);

  const cookies = Object.values(profile.cookies);
  for (const cookie of cookies) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(cookie)) {
      throw new Error(`Invalid development cookie token: ${cookie}`);
    }
    if ((RESERVED_RUNTIME.cookies as readonly string[]).includes(cookie)) {
      throw new Error(`Development cookie collides with a shared Naru cookie: ${cookie}`);
    }
  }

  const labels = Object.values(profile.labels);
  if (new Set(labels).size !== labels.length) {
    throw new Error("Development services must use distinct labels.");
  }
  for (const label of labels) {
    if (!/^com\.naru\.workstation\.dev\.[a-f0-9]{12}\.[a-z]+$/.test(label)) {
      throw new Error(`Invalid development service label: ${label}`);
    }
    if ((RESERVED_RUNTIME.labels as readonly string[]).includes(label)) {
      throw new Error(`Development label collides with production Naru: ${label}`);
    }
  }

  const privateStatePaths = [...Object.values(profile.data), ...Object.values(profile.credentials)];
  for (const path of privateStatePaths) {
    if (!isPathInside(profile.stateRoot, path)) {
      throw new Error(`Private state escaped the worktree profile root: ${path}`);
    }
    if (path.includes(`${sep}Library${sep}Application Support${sep}Naru${sep}`)) {
      throw new Error(`Development state overlaps the production Naru data boundary: ${path}`);
    }
  }

  for (const socket of Object.values(profile.sockets)) {
    if (!isPathInside(profile.runtimeRoot, socket)) {
      throw new Error(`Socket escaped its private runtime root: ${socket}`);
    }
    if (Buffer.byteLength(socket) > MAX_UNIX_SOCKET_BYTES) {
      throw new Error(`Unix socket path exceeds the macOS limit: ${socket}`);
    }
  }
}

export function prepareRuntimeDirectories(profile: WorkstationRuntimeProfile): void {
  assertRuntimeProfileIsolation(profile);

  const stateDirectories = [
    profile.stateRoot,
    ...Object.values(profile.data),
    ...Object.values(profile.credentials),
  ];
  const runtimeParent = dirname(profile.runtimeRoot);
  const runtimeDirectories = [runtimeParent, profile.runtimeRoot];

  assertNoExistingSymlink(profile.repositoryRoot, profile.stateRoot);
  for (const directory of stateDirectories) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertPrivateDirectory(directory, profile.ownerUid);
  }

  const temporaryBoundary = dirname(runtimeParent);
  assertNoExistingSymlink(temporaryBoundary, profile.runtimeRoot);
  for (const directory of runtimeDirectories) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertPrivateDirectory(directory, profile.ownerUid);
  }

  if (!isPathInside(profile.repositoryRoot, realpathSync(profile.stateRoot))) {
    throw new Error("Prepared development state resolved outside the current worktree.");
  }
  if (!isPathInside(runtimeParent, realpathSync(profile.runtimeRoot))) {
    throw new Error("Prepared socket directory resolved outside its private runtime parent.");
  }
}

export async function assertProfilePortsAvailable(
  profile: WorkstationRuntimeProfile,
): Promise<void> {
  assertRuntimeProfileIsolation(profile);
  const heldServers: Server[] = [];
  try {
    for (const [name, port] of Object.entries(profile.ports)) {
      try {
        heldServers.push(await holdLoopbackPort(port));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Development listener ${name} (${port}) is unavailable: ${detail}`, {
          cause: error,
        });
      }
    }
  } finally {
    await Promise.all(heldServers.map(closeServer));
  }
}

function sanitizeProfileSlug(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  return slug || "worktree";
}

function isPathInside(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return pathFromParent !== "" && pathFromParent !== ".." && !pathFromParent.startsWith(`..${sep}`);
}

function assertExactLoopbackOrigin(originValue: string, expectedPort: number): void {
  const origin = new URL(originValue);
  if (
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    Number(origin.port) !== expectedPort ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    origin.origin !== originValue
  ) {
    throw new Error(`Development Origin must be an exact loopback Origin: ${originValue}`);
  }
}

function assertNoExistingSymlink(boundary: string, target: string): void {
  const canonicalBoundary = realpathSync(boundary);
  const pathFromBoundary = relative(canonicalBoundary, resolve(target));
  if (pathFromBoundary === ".." || pathFromBoundary.startsWith(`..${sep}`)) {
    throw new Error(`Managed path escaped its boundary: ${target}`);
  }

  let current = canonicalBoundary;
  for (const component of pathFromBoundary.split(sep).filter(Boolean)) {
    current = join(current, component);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`Managed path contains a symbolic link: ${current}`);
    }
  }
}

function assertPrivateDirectory(path: string, expectedUid: number): void {
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Private runtime path is not a real directory: ${path}`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`Private runtime directory must be mode 0700 or stricter: ${path}`);
  }
  if (typeof metadata.uid === "number" && metadata.uid !== expectedUid) {
    throw new Error(`Private runtime directory has the wrong owner: ${path}`);
  }
}

function holdLoopbackPort(port: number): Promise<Server> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.off("error", onError);
      server.unref();
      resolvePromise(server);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolvePromise();
    });
  });
}
