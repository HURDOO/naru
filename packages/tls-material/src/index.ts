import {
  createHash,
  createPrivateKey,
  createPublicKey,
  timingSafeEqual,
  X509Certificate,
} from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import type { ServerOptions } from "node:https";
import { isAbsolute, relative } from "node:path";
import { createSecureContext, type SecureContextOptions } from "node:tls";

const TLS_PRIVATE_KEY_MAX_BYTES = 128 * 1024;
const TLS_CERTIFICATE_CHAIN_MAX_BYTES = 512 * 1024;

export type TlsMaterialErrorCode =
  | "TLS_APPROVED_ROOT_INVALID"
  | "TLS_PRIVATE_KEY_INVALID"
  | "TLS_CERTIFICATE_INVALID"
  | "TLS_CERTIFICATE_NOT_YET_VALID"
  | "TLS_CERTIFICATE_EXPIRED"
  | "TLS_CERTIFICATE_HOSTNAME_MISMATCH"
  | "TLS_KEY_MISMATCH"
  | "TLS_LIFECYCLE_INVALID"
  | "TLS_SERVER_UNSUPPORTED"
  | "TLS_RELOAD_FAILED";

export class TlsMaterialError extends Error {
  override readonly name = "TlsMaterialError";

  constructor(readonly code: TlsMaterialErrorCode) {
    super(tlsMaterialErrorMessage(code));
  }
}

export interface TlsMaterialReference {
  readonly approvedRoot: string;
  readonly certificateFile: string;
  readonly privateKeyFile: string;
  readonly serverNames: readonly string[];
  readonly allowSymlinkReferences?: boolean;
}

export interface TlsMaterialValidationOptions {
  readonly now?: number;
  readonly ownerUid?: number;
}

export interface ValidatedTlsMaterial {
  readonly revision: string;
  readonly privateKey: Buffer;
  readonly certificateChain: Buffer;
  readonly expiresAt: string;
  readonly fingerprint256: string;
}

export interface TlsMaterialSource {
  load(now: number): ValidatedTlsMaterial;
  watch(onChange: () => void): TlsMaterialWatcher;
}

export interface TlsMaterialWatcher {
  close(): void;
}

export interface TlsMaterialLifecycleStatus {
  readonly status: "ok" | "failed";
  readonly expiresAt?: string;
  readonly fingerprint256?: string;
  readonly lastReload: "not_loaded" | "initial" | "reloaded" | "rejected";
  readonly lastReloadAt?: string;
  readonly lastReloadErrorCode?: string;
}

export type TlsMaterialReloadResult = "unchanged" | "reloaded" | "rejected";

export interface TlsMaterialLifecycleEvent {
  readonly level: "info" | "warn";
  readonly event: "tls.material.reloaded" | "tls.material.reload_rejected";
  readonly expiresAt?: string;
  readonly fingerprint256?: string;
  readonly errorCode?: string;
}

export interface TlsSecureContextServer {
  setSecureContext(options: SecureContextOptions): void;
}

export function validateTlsMaterial(
  reference: TlsMaterialReference,
  options: TlsMaterialValidationOptions = {},
): ValidatedTlsMaterial {
  const now = options.now ?? Date.now();
  const ownerUid = options.ownerUid ?? currentUid();
  const approvedRoot = validateApprovedRoot(reference.approvedRoot, ownerUid);
  const privateKey = readOwnedRegularFile(
    reference.privateKeyFile,
    approvedRoot,
    TLS_PRIVATE_KEY_MAX_BYTES,
    "TLS_PRIVATE_KEY_INVALID",
    ownerUid,
    reference.allowSymlinkReferences ?? false,
  );
  const certificate = readOwnedRegularFile(
    reference.certificateFile,
    approvedRoot,
    TLS_CERTIFICATE_CHAIN_MAX_BYTES,
    "TLS_CERTIFICATE_INVALID",
    ownerUid,
    reference.allowSymlinkReferences ?? false,
  );
  if (privateKey.canonicalPath === certificate.canonicalPath) {
    throw new TlsMaterialError("TLS_PRIVATE_KEY_INVALID");
  }

  let leaf: X509Certificate;
  try {
    leaf = new X509Certificate(certificate.contents);
  } catch {
    throw new TlsMaterialError("TLS_CERTIFICATE_INVALID");
  }

  const validFrom = Date.parse(leaf.validFrom);
  const validTo = Date.parse(leaf.validTo);
  if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || validTo <= validFrom) {
    throw new TlsMaterialError("TLS_CERTIFICATE_INVALID");
  }
  if (now < validFrom) throw new TlsMaterialError("TLS_CERTIFICATE_NOT_YET_VALID");
  if (now >= validTo) throw new TlsMaterialError("TLS_CERTIFICATE_EXPIRED");

  if (reference.serverNames.length === 0) {
    throw new TlsMaterialError("TLS_CERTIFICATE_HOSTNAME_MISMATCH");
  }
  for (const serverName of reference.serverNames) {
    try {
      if (leaf.checkHost(serverName, { subject: "never" }) === undefined) {
        throw new TlsMaterialError("TLS_CERTIFICATE_HOSTNAME_MISMATCH");
      }
    } catch (error) {
      if (error instanceof TlsMaterialError) throw error;
      throw new TlsMaterialError("TLS_CERTIFICATE_HOSTNAME_MISMATCH");
    }
  }

  try {
    const privateKeyObject = createPrivateKey(privateKey.contents);
    const privatePublicKey = Buffer.from(
      createPublicKey(privateKeyObject).export({ format: "der", type: "spki" }),
    );
    const certificatePublicKey = Buffer.from(
      leaf.publicKey.export({ format: "der", type: "spki" }),
    );
    if (
      privatePublicKey.byteLength !== certificatePublicKey.byteLength ||
      !timingSafeEqual(privatePublicKey, certificatePublicKey)
    ) {
      throw new TlsMaterialError("TLS_KEY_MISMATCH");
    }
  } catch (error) {
    if (error instanceof TlsMaterialError) throw error;
    throw new TlsMaterialError("TLS_PRIVATE_KEY_INVALID");
  }

  try {
    createSecureContext({
      key: privateKey.contents,
      cert: certificate.contents,
      minVersion: "TLSv1.2",
    });
  } catch {
    throw new TlsMaterialError("TLS_CERTIFICATE_INVALID");
  }

  return {
    revision: materialRevision(privateKey.contents, certificate.contents),
    privateKey: privateKey.contents,
    certificateChain: certificate.contents,
    expiresAt: new Date(validTo).toISOString(),
    fingerprint256: leaf.fingerprint256,
  };
}

export function tlsMaterialServerOptions(material: ValidatedTlsMaterial): ServerOptions {
  return {
    key: material.privateKey,
    cert: material.certificateChain,
    minVersion: "TLSv1.2",
  };
}

export class LastKnownGoodTlsMaterialManager {
  readonly #source: TlsMaterialSource;
  readonly #now: () => number;
  readonly #errorCode: (error: unknown) => string;
  readonly #rejectionSignature: (error: unknown, code: string) => string;
  #current: ValidatedTlsMaterial | undefined;
  #server: TlsSecureContextServer | undefined;
  #watcher: TlsMaterialWatcher | undefined;
  #eventSink: ((event: TlsMaterialLifecycleEvent) => void) | undefined;
  #lastReload: TlsMaterialLifecycleStatus["lastReload"] = "not_loaded";
  #lastReloadAt: string | undefined;
  #lastReloadErrorCode: string | undefined;
  #lastRejectedSignature: string | undefined;

  constructor(
    source: TlsMaterialSource,
    options: {
      readonly now?: () => number;
      readonly errorCode?: (error: unknown) => string;
      readonly rejectionSignature?: (error: unknown, code: string) => string;
      readonly eventSink?: (event: TlsMaterialLifecycleEvent) => void;
    } = {},
  ) {
    this.#source = source;
    this.#now = options.now ?? Date.now;
    this.#errorCode = options.errorCode ?? defaultTlsMaterialErrorCode;
    this.#rejectionSignature = options.rejectionSignature ?? ((_error, code) => code);
    this.#eventSink = options.eventSink;
  }

  setEventSink(eventSink: (event: TlsMaterialLifecycleEvent) => void): void {
    this.#eventSink = eventSink;
  }

  loadInitial(): ServerOptions {
    if (this.#current !== undefined) return tlsMaterialServerOptions(this.#current);
    const material = this.#source.load(this.#now());
    this.#current = material;
    this.#lastReload = "initial";
    this.#lastReloadAt = new Date(this.#now()).toISOString();
    this.#lastReloadErrorCode = undefined;
    return tlsMaterialServerOptions(material);
  }

  start(server: unknown): void {
    if (this.#watcher !== undefined) return;
    if (this.#current === undefined) throw new TlsMaterialError("TLS_LIFECYCLE_INVALID");
    if (!isTlsSecureContextServer(server)) {
      throw new TlsMaterialError("TLS_SERVER_UNSUPPORTED");
    }
    this.#server = server;
    try {
      this.#watcher = this.#source.watch(() => {
        this.reloadNow();
      });
    } catch (error) {
      this.#server = undefined;
      throw error;
    }
  }

  stop(): void {
    this.#watcher?.close();
    this.#watcher = undefined;
    this.#server = undefined;
  }

  reloadNow(): TlsMaterialReloadResult {
    const current = this.#current;
    const server = this.#server;
    if (current === undefined || server === undefined) {
      throw new TlsMaterialError("TLS_LIFECYCLE_INVALID");
    }

    try {
      const candidate = this.#source.load(this.#now());
      if (candidate.revision === current.revision) return "unchanged";
      server.setSecureContext(tlsMaterialServerOptions(candidate));
      this.#current = candidate;
      this.#lastReload = "reloaded";
      this.#lastReloadAt = new Date(this.#now()).toISOString();
      this.#lastReloadErrorCode = undefined;
      this.#lastRejectedSignature = undefined;
      this.#eventSink?.({
        level: "info",
        event: "tls.material.reloaded",
        expiresAt: candidate.expiresAt,
        fingerprint256: candidate.fingerprint256,
      });
      return "reloaded";
    } catch (error) {
      const code = this.#errorCode(error);
      this.#lastReload = "rejected";
      this.#lastReloadAt = new Date(this.#now()).toISOString();
      this.#lastReloadErrorCode = code;
      const signature = this.#rejectionSignature(error, code);
      if (this.#lastRejectedSignature !== signature) {
        this.#lastRejectedSignature = signature;
        this.#eventSink?.({
          level: "warn",
          event: "tls.material.reload_rejected",
          errorCode: code,
        });
      }
      return "rejected";
    }
  }

  status(): TlsMaterialLifecycleStatus {
    const current = this.#current;
    if (current === undefined) {
      return {
        status: "failed",
        lastReload: this.#lastReload,
        ...(this.#lastReloadAt === undefined ? {} : { lastReloadAt: this.#lastReloadAt }),
        ...(this.#lastReloadErrorCode === undefined
          ? {}
          : { lastReloadErrorCode: this.#lastReloadErrorCode }),
      };
    }
    return {
      status: this.acceptsNewConnections() ? "ok" : "failed",
      expiresAt: current.expiresAt,
      fingerprint256: current.fingerprint256,
      lastReload: this.#lastReload,
      ...(this.#lastReloadAt === undefined ? {} : { lastReloadAt: this.#lastReloadAt }),
      ...(this.#lastReloadErrorCode === undefined
        ? {}
        : { lastReloadErrorCode: this.#lastReloadErrorCode }),
    };
  }

  acceptsNewConnections(): boolean {
    return this.#current !== undefined && this.#now() < Date.parse(this.#current.expiresAt);
  }

  currentRevision(): string | undefined {
    return this.#current?.revision;
  }
}

interface OwnedRegularFile {
  readonly canonicalPath: string;
  readonly contents: Buffer;
}

function validateApprovedRoot(directory: string, ownerUid: number): string {
  try {
    if (!isAbsolute(directory) || directory === "/") {
      throw new TlsMaterialError("TLS_APPROVED_ROOT_INVALID");
    }
    const metadata = lstatSync(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new TlsMaterialError("TLS_APPROVED_ROOT_INVALID");
    }
    if (metadata.uid !== ownerUid || (metadata.mode & 0o077) !== 0) {
      throw new TlsMaterialError("TLS_APPROVED_ROOT_INVALID");
    }
    if ((metadata.mode & 0o500) !== 0o500) {
      throw new TlsMaterialError("TLS_APPROVED_ROOT_INVALID");
    }
    const canonical = realpathSync(directory);
    if (canonical !== directory) {
      throw new TlsMaterialError("TLS_APPROVED_ROOT_INVALID");
    }
    return canonical;
  } catch (error) {
    if (error instanceof TlsMaterialError) throw error;
    throw new TlsMaterialError("TLS_APPROVED_ROOT_INVALID");
  }
}

function readOwnedRegularFile(
  referencePath: string,
  approvedRoot: string,
  maximumBytes: number,
  code: Extract<TlsMaterialErrorCode, "TLS_PRIVATE_KEY_INVALID" | "TLS_CERTIFICATE_INVALID">,
  ownerUid: number,
  allowSymlinkReferences: boolean,
): OwnedRegularFile {
  let descriptor: number | undefined;
  try {
    if (!isAbsolute(referencePath)) throw new TlsMaterialError(code);
    if (!allowSymlinkReferences && lstatSync(referencePath).isSymbolicLink()) {
      throw new TlsMaterialError(code);
    }
    const canonicalPath = realpathSync(referencePath);
    if (!isStrictPathChild(approvedRoot, canonicalPath)) throw new TlsMaterialError(code);
    if (!allowSymlinkReferences && canonicalPath !== referencePath) {
      throw new TlsMaterialError(code);
    }
    const metadata = lstatSync(canonicalPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new TlsMaterialError(code);
    if (
      metadata.uid !== ownerUid ||
      (metadata.mode & 0o077) !== 0 ||
      (metadata.mode & 0o400) !== 0o400 ||
      metadata.size < 1 ||
      metadata.size > maximumBytes
    ) {
      throw new TlsMaterialError(code);
    }

    descriptor = openSync(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.uid !== ownerUid ||
      (opened.mode & 0o077) !== 0 ||
      (opened.mode & 0o400) !== 0o400 ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      opened.size !== metadata.size ||
      realpathSync(referencePath) !== canonicalPath
    ) {
      throw new TlsMaterialError(code);
    }
    return { canonicalPath, contents: readFileSync(descriptor) };
  } catch (error) {
    if (error instanceof TlsMaterialError) throw error;
    throw new TlsMaterialError(code);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function materialRevision(privateKey: Buffer, certificateChain: Buffer): string {
  const hash = createHash("sha256");
  const size = Buffer.allocUnsafe(8);
  size.writeBigUInt64BE(BigInt(privateKey.byteLength));
  hash.update(size);
  hash.update(privateKey);
  size.writeBigUInt64BE(BigInt(certificateChain.byteLength));
  hash.update(size);
  hash.update(certificateChain);
  return hash.digest("hex");
}

function isStrictPathChild(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith("../") && !isAbsolute(path);
}

function currentUid(): number {
  if (typeof process.getuid !== "function") {
    throw new TlsMaterialError("TLS_APPROVED_ROOT_INVALID");
  }
  return process.getuid();
}

function isTlsSecureContextServer(value: unknown): value is TlsSecureContextServer {
  return (
    typeof value === "object" &&
    value !== null &&
    "setSecureContext" in value &&
    typeof value.setSecureContext === "function"
  );
}

function defaultTlsMaterialErrorCode(error: unknown): string {
  return error instanceof TlsMaterialError ? error.code : "TLS_RELOAD_FAILED";
}

function tlsMaterialErrorMessage(code: TlsMaterialErrorCode): string {
  switch (code) {
    case "TLS_CERTIFICATE_NOT_YET_VALID":
      return "TLS certificate is not valid yet.";
    case "TLS_CERTIFICATE_EXPIRED":
      return "TLS certificate has expired.";
    case "TLS_CERTIFICATE_HOSTNAME_MISMATCH":
      return "TLS certificate does not cover the configured server name.";
    case "TLS_KEY_MISMATCH":
      return "TLS private key does not match the certificate.";
    case "TLS_SERVER_UNSUPPORTED":
      return "TLS hot reload requires an HTTPS server.";
    case "TLS_RELOAD_FAILED":
      return "TLS material reload failed.";
    default:
      return "TLS material is invalid.";
  }
}
