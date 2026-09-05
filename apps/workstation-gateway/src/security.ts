import { timingSafeEqual } from "node:crypto";
import {
  closeSync,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export function currentUid(): number {
  if (typeof process.getuid !== "function") {
    throw new Error("Workstation Gateway requires an operating-system user identity.");
  }
  return process.getuid();
}

export function ensurePrivateDirectory(path: string): void {
  if (!isAbsolute(path)) throw new Error("Gateway private directory path must be absolute.");
  assertNoSymlinkComponents(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(path);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Gateway private path is not a real directory: ${path}`);
  }
  if (stat.uid !== currentUid()) {
    throw new Error(`Gateway private directory has the wrong owner: ${path}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`Gateway private directory must not allow group or other access: ${path}`);
  }
}

export function assertPrivateRegularFile(path: string): void {
  if (!isAbsolute(path)) throw new Error("Gateway private file path must be absolute.");
  assertNoSymlinkComponents(path);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Gateway private path is not a regular file: ${path}`);
  }
  if (stat.uid !== currentUid()) {
    throw new Error(`Gateway private file has the wrong owner: ${path}`);
  }
  if ((stat.mode & 0o177) !== 0) {
    throw new Error(`Gateway private file must have mode 0600 or stricter: ${path}`);
  }
}

export function assertPrivateUnixSocket(path: string): void {
  if (!isAbsolute(path)) throw new Error("Gateway private socket path must be absolute.");
  assertNoSymlinkComponents(path);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isSocket()) {
    throw new Error(`Gateway private path is not a Unix socket: ${path}`);
  }
  if (stat.uid !== currentUid()) {
    throw new Error(`Gateway private socket has the wrong owner: ${path}`);
  }
  if ((stat.mode & 0o177) !== 0) {
    throw new Error(`Gateway private socket must have mode 0600 or stricter: ${path}`);
  }
}

export function readPrivateFile(path: string): Buffer {
  assertPrivateRegularFile(path);
  return readFileSync(path);
}

export function writePrivateFileExclusive(path: string, contents: string | Buffer): void {
  ensurePrivateDirectory(dirname(path));
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, contents);
    fchmodSync(descriptor, 0o600);
  } finally {
    closeSync(descriptor);
  }
  assertPrivateRegularFile(path);
}

export function privateFileExists(path: string): boolean {
  if (!existsSync(path)) return false;
  assertPrivateRegularFile(path);
  return true;
}

export function secretEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

export function assertNoSymlinkComponents(path: string): void {
  if (!isAbsolute(path)) throw new Error("Gateway managed path must be absolute.");
  const normalized = resolve(path);
  const root = parse(normalized).root;
  const components = relative(root, normalized).split(sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error("Gateway managed path contains a symbolic link.");
    }
  }
}
