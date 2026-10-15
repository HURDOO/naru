import { lstat, realpath, unlink } from "node:fs/promises";
import { createConnection, type Server } from "node:net";

/** Owner-only Unix socket helpers shared by Naru's private integration servers. */

export async function requirePrivateRuntimeDirectory(
  path: string,
  requireCanonical: boolean,
  label: string,
): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} runtime path must be a regular directory.`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`${label} runtime directory must be owned by the service user.`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`${label} runtime directory must be private.`);
  }
  if (requireCanonical && (await realpath(path)) !== path) {
    throw new Error(`Configured ${label} runtime path must not contain symbolic links.`);
  }
}

export async function removeStaleSocket(path: string, label: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
  if (!metadata.isSocket() || metadata.isSymbolicLink()) {
    throw new Error(`Refusing to replace a non-socket ${label} path.`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`Refusing to replace a ${label} socket owned by another user.`);
  }
  if (await isAcceptingConnections(path)) {
    throw new Error(`Another Naru ${label} server is already running.`);
  }
  await unlink(path);
}

export async function unlinkOwnedSocket(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (
      metadata.isSocket() &&
      (typeof process.getuid !== "function" || metadata.uid === process.getuid())
    ) {
      await unlink(path);
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

export function listenOnSocket(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(path, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function isAcceptingConnections(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const finish = (result: boolean): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(250);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
