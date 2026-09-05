import { createHash, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export function ensurePrivateDirectory(path: string, expectedUid = currentUid()): void {
  if (!isAbsolute(path)) throw new Error("Private directory path must be absolute.");
  assertNoSymlinkComponents(path);
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(path);
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Private path must be a real directory.");
  }
  assertOwner(metadata.uid, expectedUid);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("Private directory must be mode 0700 or stricter.");
  }
}

export function assertPrivateRegularFile(path: string, expectedUid = currentUid()): void {
  if (!isAbsolute(path)) throw new Error("Private file path must be absolute.");
  assertNoSymlinkComponents(path);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Private file must be a regular file without symlinks.");
  }
  assertOwner(metadata.uid, expectedUid);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("Private file must be mode 0600 or stricter.");
  }
}

export function ensurePrivateRegularFile(path: string, expectedUid = currentUid()): void {
  chmodSync(path, 0o600);
  assertPrivateRegularFile(path, expectedUid);
}

export function readCredentialFile(path: string): string {
  assertPrivateRegularFile(path);
  const credential = readFileSync(path, "utf8").trim();
  if (credential.length < 32 || credential.length > 1_024 || /\s/.test(credential)) {
    throw new Error("Host app credential has an invalid format.");
  }
  return credential;
}

export function credentialDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function credentialMatches(value: string, expectedDigest: Buffer): boolean {
  const actual = credentialDigest(value);
  return actual.length === expectedDigest.length && timingSafeEqual(actual, expectedDigest);
}

export function canonicalDirectory(path: string): string {
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory()) throw new Error("Configured root is not a directory.");
  return canonical;
}

export function resolveInsideRoot(root: string, relativePath: string): string {
  const candidate = resolve(root, relativePath || ".");
  let canonical: string;
  try {
    canonical = realpathSync(candidate);
  } catch {
    throw new Error("Requested working directory does not exist.");
  }
  if (!statSync(canonical).isDirectory()) {
    throw new Error("Requested working directory is not a directory.");
  }
  const fromRoot = relative(root, canonical);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("Requested working directory escaped its configured root.");
  }
  return canonical;
}

export function canonicalExecutable(path: string): string {
  if (!isAbsolute(path)) throw new Error("Executable must be an absolute path.");
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch {
    throw new Error("Executable does not exist.");
  }
  const metadata = statSync(canonical);
  if (!metadata.isFile() || (metadata.mode & 0o111) === 0) {
    throw new Error("Executable is not an executable regular file.");
  }
  return canonical;
}

export function currentUid(): number {
  return process.getuid?.() ?? 0;
}

export function assertNoSymlinkComponents(path: string): void {
  if (!isAbsolute(path)) throw new Error("Managed path must be absolute.");
  const normalized = resolve(path);
  const root = parse(normalized).root;
  const components = relative(root, normalized).split(sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error("Managed path contains a symbolic link.");
    }
  }
}

function assertOwner(actualUid: number, expectedUid: number): void {
  if (actualUid !== expectedUid) throw new Error("Private path has the wrong owner.");
}
