import { lstatSync, readFileSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { DurableSessionClientError } from "./errors.js";

export function readPrivateCredentialFile(path: string): string {
  try {
    assertPrivateRegularFile(path, 2_048);
    const credential = readFileSync(path, "utf8").trim();
    if (credential.length < 32 || credential.length > 1_024 || /\s/.test(credential)) {
      throw new Error("invalid private credential value");
    }
    return credential;
  } catch (error) {
    throw new DurableSessionClientError(
      "CREDENTIAL_FILE_INVALID",
      "Host app credential file must be an owner-only regular file with a valid credential.",
      { cause: error },
    );
  }
}

export function readPrivateJsonFile(path: string, maximumBytes = 256 * 1_024): unknown {
  try {
    assertPrivateRegularFile(path, maximumBytes);
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new DurableSessionClientError(
      "PRIVATE_INPUT_INVALID",
      "Sensitive JSON input must be an owner-only regular file containing valid JSON.",
      { cause: error },
    );
  }
}

/**
 * Node's JavaScript realpath, which the CommonJS loader uses with its cache, reads the process-wide
 * stat buffer for cached path components and stops resolving when the last stat was a socket or
 * FIFO. A lazy `require()` right after a socket `lstat` can then resolve a pnpm symlink to a path
 * whose dependencies are missing (reproduced on Node 24.19 and 26.4). Stat the parent directory
 * afterwards so the buffer never ends on a socket.
 */
export function lstatSocketSync(path: string): Stats {
  const metadata = lstatSync(path);
  lstatSync(dirname(path));
  return metadata;
}

export function assertPrivateSocket(path: string): void {
  try {
    assertAbsolutePathWithoutSymlinks(path);
    const metadata = lstatSocketSync(path);
    if (
      !metadata.isSocket() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== currentUid() ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new Error("invalid private socket metadata");
    }
  } catch (error) {
    throw new DurableSessionClientError(
      "PRIVATE_ENDPOINT_INVALID",
      "DurableSession endpoint must be an owner-only Unix socket without symlinks.",
      { cause: error },
    );
  }
}

function assertAbsolutePathWithoutSymlinks(path: string): void {
  if (!isAbsolute(path)) throw new Error("private path is not absolute");
  const normalized = resolve(path);
  const root = parse(normalized).root;
  const components = relative(root, normalized).split(sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    let metadata;
    try {
      metadata = lstatSync(current);
    } catch {
      continue;
    }
    if (metadata.isSymbolicLink()) throw new Error("private path contains a symlink");
  }
}

function assertPrivateRegularFile(path: string, maximumBytes: number): void {
  assertAbsolutePathWithoutSymlinks(path);
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== currentUid() ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size > maximumBytes
  ) {
    throw new Error("invalid private file metadata");
  }
}

function currentUid(): number {
  return process.getuid?.() ?? 0;
}
