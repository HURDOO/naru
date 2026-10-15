import { createHash } from "node:crypto";
import { lstatSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { dirname, join } from "node:path";

export class CodexEndpointError extends Error {
  constructor() {
    super("NARU_CODEX_ENDPOINT_REJECTED");
  }
}

export interface CodexAppServerEndpoint {
  readonly advertisedPath: string;
  readonly connectPath: string;
  readonly identity: string;
}

/** Codex 0.156.1's protected_socket_path, independent of the advertised link. */
export function codexProtectedSocketPath(advertisedPath: string): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new CodexEndpointError();
  return join(
    realpathSync("/tmp"),
    `codex-daemon-${uid}`,
    createHash("sha256").update(advertisedPath, "utf8").digest("hex"),
  );
}

/** Only the single, deterministic Codex alias is allowed; no general link traversal. */
export function inspectCodexAppServerEndpoint(advertisedPath: string): CodexAppServerEndpoint {
  const uid = process.getuid?.();
  if (uid === undefined) throw new CodexEndpointError();
  const temporaryRoot = realpathSync("/tmp");
  const parent = dirname(advertisedPath);
  const identities: string[] = [];
  const remember = (stat: Stats): void => {
    identities.push(`${stat.dev}:${stat.ino}:${stat.uid}:${stat.mode}:${stat.ctimeMs}`);
  };
  const temporaryStat = lstatSync(temporaryRoot);
  if (
    temporaryStat.uid !== 0 ||
    !temporaryStat.isDirectory() ||
    ((temporaryStat.mode & 0o022) !== 0 && (temporaryStat.mode & 0o1000) === 0) ||
    dirname(parent) !== temporaryRoot
  )
    throw new CodexEndpointError();
  const privateDirectory = (path: string): void => {
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      stat.uid !== uid ||
      (stat.mode & 0o777) !== 0o700 ||
      realpathSync(path) !== path
    )
      throw new CodexEndpointError();
    // Sibling socket creation changes directory ctime, not its security identity.
    identities.push(`${stat.dev}:${stat.ino}:${stat.uid}:${stat.mode}`);
  };
  privateDirectory(parent);
  const advertised = lstatSync(advertisedPath);
  remember(advertised);
  let connectPath = advertisedPath;
  if (advertised.isSymbolicLink()) {
    connectPath = codexProtectedSocketPath(advertisedPath);
    if (advertised.uid !== uid || readlinkSync(advertisedPath) !== connectPath)
      throw new CodexEndpointError();
    privateDirectory(dirname(connectPath));
  }
  const socket = lstatSync(connectPath);
  if (
    !socket.isSocket() ||
    socket.uid !== uid ||
    (socket.mode & 0o777) !== 0o600 ||
    realpathSync(connectPath) !== connectPath
  )
    throw new CodexEndpointError();
  remember(socket);
  // Never leave Node's process-wide stat buffer on a socket (see lstatSocketSync in
  // @naru/durable-session-client): a later lazy require() could mis-resolve a pnpm symlink.
  lstatSync(dirname(connectPath));
  return { advertisedPath, connectPath, identity: identities.join("|") };
}

export function connectCodexAppServer(endpoint: CodexAppServerEndpoint): Socket {
  const verify = (): void => {
    const current = inspectCodexAppServerEndpoint(endpoint.advertisedPath);
    if (current.identity !== endpoint.identity || current.connectPath !== endpoint.connectPath)
      throw new CodexEndpointError();
  };
  verify();
  // Connect to the validated physical path, never through the mutable alias.
  const socket = createConnection(endpoint.connectPath);
  socket.once("connect", () => {
    try {
      verify();
    } catch {
      socket.destroy(new CodexEndpointError());
    }
  });
  return socket;
}
