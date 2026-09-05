import { createPrivateKey, createPublicKey, timingSafeEqual, X509Certificate } from "node:crypto";
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
import { dirname, isAbsolute, join } from "node:path";
import { createSecureContext, type SecureContextOptions } from "node:tls";
import type { TlsConfig } from "./config.js";

const TLS_POINTER_FILENAME = "current.json";
const TLS_PRIVATE_KEY_FILENAME = "private-key.pem";
const TLS_CERTIFICATE_CHAIN_FILENAME = "full-chain.pem";
const TLS_POINTER_MAX_BYTES = 4 * 1024;
const TLS_PRIVATE_KEY_MAX_BYTES = 128 * 1024;
const TLS_CERTIFICATE_CHAIN_MAX_BYTES = 512 * 1024;
const TLS_GENERATION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export type TlsCertificateErrorCode =
  | "TLS_STATE_INVALID"
  | "TLS_POINTER_INVALID"
  | "TLS_GENERATION_INVALID"
  | "TLS_PRIVATE_KEY_INVALID"
  | "TLS_CERTIFICATE_INVALID"
  | "TLS_CERTIFICATE_NOT_YET_VALID"
  | "TLS_CERTIFICATE_EXPIRED"
  | "TLS_CERTIFICATE_HOSTNAME_MISMATCH"
  | "TLS_KEY_MISMATCH"
  | "TLS_SERVER_UNSUPPORTED"
  | "TLS_RELOAD_FAILED";

export class TlsCertificateError extends Error {
  override readonly name = "TlsCertificateError";

  constructor(readonly code: TlsCertificateErrorCode) {
    super(tlsErrorMessage(code));
  }
}

export interface TlsCertificateMaterial {
  readonly generation: string;
  readonly privateKey: Buffer;
  readonly certificateChain: Buffer;
  readonly expiresAt: string;
  readonly fingerprint256: string;
}

export interface TlsCertificateStatus {
  readonly status: "ok" | "failed";
  readonly generation?: string;
  readonly expiresAt?: string;
  readonly fingerprint256?: string;
  readonly lastReload: "not_loaded" | "initial" | "reloaded" | "rejected";
  readonly lastReloadAt?: string;
  readonly lastReloadErrorCode?: TlsCertificateErrorCode;
}

export type TlsReloadResult = "unchanged" | "reloaded" | "rejected";

export interface TlsCertificateEvent {
  readonly level: "info" | "warn";
  readonly event: "tls.certificate.reloaded" | "tls.certificate.reload_rejected";
  readonly fields: Readonly<Record<string, unknown>>;
}

interface TlsSecureContextServer {
  setSecureContext(options: SecureContextOptions): void;
}

interface TlsGenerationPointer {
  readonly formatVersion: 1;
  readonly generation: string;
}

export function readTlsCertificateGeneration(
  config: TlsConfig,
  now = Date.now(),
): TlsCertificateMaterial {
  const stateDirectory = validateStateDirectory(config.stateDirectory);
  const pointer = readTlsGenerationPointerFromDirectory(stateDirectory);
  return readTlsCertificateGenerationFromDirectory(stateDirectory, pointer.generation, config, now);
}

export function readTlsCertificateGenerationById(
  config: TlsConfig,
  generation: string,
  now = Date.now(),
): TlsCertificateMaterial {
  const stateDirectory = validateStateDirectory(config.stateDirectory);
  return readTlsCertificateGenerationFromDirectory(stateDirectory, generation, config, now);
}

export function tlsServerOptions(material: TlsCertificateMaterial): ServerOptions {
  return {
    key: material.privateKey,
    cert: material.certificateChain,
    minVersion: "TLSv1.2",
  };
}

export class TlsCertificateManager {
  readonly #now: () => number;
  #current: TlsCertificateMaterial | undefined;
  #server: TlsSecureContextServer | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #eventSink: ((event: TlsCertificateEvent) => void) | undefined;
  #lastReload: TlsCertificateStatus["lastReload"] = "not_loaded";
  #lastReloadAt: string | undefined;
  #lastReloadErrorCode: TlsCertificateErrorCode | undefined;
  #lastRejectedSignature: string | undefined;

  constructor(
    readonly config: TlsConfig,
    options: {
      now?: () => number;
      eventSink?: (event: TlsCertificateEvent) => void;
    } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#eventSink = options.eventSink;
  }

  setEventSink(eventSink: (event: TlsCertificateEvent) => void): void {
    this.#eventSink = eventSink;
  }

  loadInitial(): ServerOptions {
    if (this.#current !== undefined) return tlsServerOptions(this.#current);
    const material = readTlsCertificateGeneration(this.config, this.#now());
    this.#current = material;
    this.#lastReload = "initial";
    this.#lastReloadAt = new Date(this.#now()).toISOString();
    this.#lastReloadErrorCode = undefined;
    return tlsServerOptions(material);
  }

  start(server: unknown): void {
    if (this.#timer !== undefined) return;
    if (this.#current === undefined) throw new TlsCertificateError("TLS_STATE_INVALID");
    if (!isTlsSecureContextServer(server)) {
      throw new TlsCertificateError("TLS_SERVER_UNSUPPORTED");
    }
    this.#server = server;
    this.#timer = setInterval(() => this.reloadNow(), this.config.reloadIntervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#server = undefined;
  }

  reloadNow(): TlsReloadResult {
    const current = this.#current;
    const server = this.#server;
    if (current === undefined || server === undefined) {
      throw new TlsCertificateError("TLS_STATE_INVALID");
    }

    let candidateGeneration: string | undefined;
    try {
      const stateDirectory = validateStateDirectory(this.config.stateDirectory);
      candidateGeneration = readTlsGenerationPointerFromDirectory(stateDirectory).generation;
      if (candidateGeneration === current.generation) return "unchanged";

      const candidate = readTlsCertificateGenerationFromDirectory(
        stateDirectory,
        candidateGeneration,
        this.config,
        this.#now(),
      );
      server.setSecureContext(tlsServerOptions(candidate));
      this.#current = candidate;
      this.#lastReload = "reloaded";
      this.#lastReloadAt = new Date(this.#now()).toISOString();
      this.#lastReloadErrorCode = undefined;
      this.#lastRejectedSignature = undefined;
      this.#eventSink?.({
        level: "info",
        event: "tls.certificate.reloaded",
        fields: { generation: candidate.generation, expiresAt: candidate.expiresAt },
      });
      return "reloaded";
    } catch (error) {
      const code =
        error instanceof TlsCertificateError ? error.code : ("TLS_RELOAD_FAILED" as const);
      this.#lastReload = "rejected";
      this.#lastReloadAt = new Date(this.#now()).toISOString();
      this.#lastReloadErrorCode = code;
      const signature = `${candidateGeneration ?? "unknown"}:${code}`;
      if (this.#lastRejectedSignature !== signature) {
        this.#lastRejectedSignature = signature;
        this.#eventSink?.({
          level: "warn",
          event: "tls.certificate.reload_rejected",
          fields: {
            errorCode: code,
            ...(candidateGeneration === undefined ? {} : { generation: candidateGeneration }),
          },
        });
      }
      return "rejected";
    }
  }

  status(): TlsCertificateStatus {
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
      status: this.#now() < Date.parse(current.expiresAt) ? "ok" : "failed",
      generation: current.generation,
      expiresAt: current.expiresAt,
      fingerprint256: current.fingerprint256,
      lastReload: this.#lastReload,
      ...(this.#lastReloadAt === undefined ? {} : { lastReloadAt: this.#lastReloadAt }),
      ...(this.#lastReloadErrorCode === undefined
        ? {}
        : { lastReloadErrorCode: this.#lastReloadErrorCode }),
    };
  }
}

function readTlsCertificateGenerationFromDirectory(
  stateDirectory: string,
  generation: string,
  config: TlsConfig,
  now: number,
): TlsCertificateMaterial {
  assertSafeGeneration(generation);
  const generationDirectory = join(stateDirectory, "generations", generation);
  validatePrivateDirectory(generationDirectory, "TLS_GENERATION_INVALID");
  if (
    dirname(realpathWithoutDetails(generationDirectory, "TLS_GENERATION_INVALID")) !==
    join(stateDirectory, "generations")
  ) {
    throw new TlsCertificateError("TLS_GENERATION_INVALID");
  }

  const privateKey = readPrivateRegularFile(
    join(generationDirectory, TLS_PRIVATE_KEY_FILENAME),
    TLS_PRIVATE_KEY_MAX_BYTES,
    "TLS_PRIVATE_KEY_INVALID",
  );
  const certificateChain = readPrivateRegularFile(
    join(generationDirectory, TLS_CERTIFICATE_CHAIN_FILENAME),
    TLS_CERTIFICATE_CHAIN_MAX_BYTES,
    "TLS_CERTIFICATE_INVALID",
  );

  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certificateChain);
  } catch {
    throw new TlsCertificateError("TLS_CERTIFICATE_INVALID");
  }

  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || validTo <= validFrom) {
    throw new TlsCertificateError("TLS_CERTIFICATE_INVALID");
  }
  if (now < validFrom) throw new TlsCertificateError("TLS_CERTIFICATE_NOT_YET_VALID");
  if (now >= validTo) throw new TlsCertificateError("TLS_CERTIFICATE_EXPIRED");

  for (const serverName of config.serverNames) {
    try {
      if (certificate.checkHost(serverName, { subject: "never" }) === undefined) {
        throw new TlsCertificateError("TLS_CERTIFICATE_HOSTNAME_MISMATCH");
      }
    } catch (error) {
      if (error instanceof TlsCertificateError) throw error;
      throw new TlsCertificateError("TLS_CERTIFICATE_HOSTNAME_MISMATCH");
    }
  }

  try {
    const privateKeyObject = createPrivateKey(privateKey);
    const privatePublicKey = Buffer.from(
      createPublicKey(privateKeyObject).export({ format: "der", type: "spki" }),
    );
    const certificatePublicKey = Buffer.from(
      certificate.publicKey.export({ format: "der", type: "spki" }),
    );
    if (
      privatePublicKey.byteLength !== certificatePublicKey.byteLength ||
      !timingSafeEqual(privatePublicKey, certificatePublicKey)
    ) {
      throw new TlsCertificateError("TLS_KEY_MISMATCH");
    }
  } catch (error) {
    if (error instanceof TlsCertificateError) throw error;
    throw new TlsCertificateError("TLS_PRIVATE_KEY_INVALID");
  }

  try {
    createSecureContext({ key: privateKey, cert: certificateChain, minVersion: "TLSv1.2" });
  } catch {
    throw new TlsCertificateError("TLS_CERTIFICATE_INVALID");
  }

  return {
    generation,
    privateKey,
    certificateChain,
    expiresAt: new Date(validTo).toISOString(),
    fingerprint256: certificate.fingerprint256,
  };
}

function validateStateDirectory(directory: string): string {
  if (!isAbsolute(directory)) throw new TlsCertificateError("TLS_STATE_INVALID");
  validatePrivateDirectory(directory, "TLS_STATE_INVALID");
  const canonical = realpathWithoutDetails(directory, "TLS_STATE_INVALID");
  if (canonical !== directory) throw new TlsCertificateError("TLS_STATE_INVALID");
  validatePrivateDirectory(join(canonical, "generations"), "TLS_STATE_INVALID");
  return canonical;
}

function readTlsGenerationPointerFromDirectory(stateDirectory: string): TlsGenerationPointer {
  const contents = readPrivateRegularFile(
    join(stateDirectory, TLS_POINTER_FILENAME),
    TLS_POINTER_MAX_BYTES,
    "TLS_POINTER_INVALID",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8"));
  } catch {
    throw new TlsCertificateError("TLS_POINTER_INVALID");
  }
  if (!isRecord(parsed) || parsed.formatVersion !== 1 || typeof parsed.generation !== "string") {
    throw new TlsCertificateError("TLS_POINTER_INVALID");
  }
  if (Object.keys(parsed).sort().join(",") !== "formatVersion,generation") {
    throw new TlsCertificateError("TLS_POINTER_INVALID");
  }
  assertSafeGeneration(parsed.generation);
  return { formatVersion: 1, generation: parsed.generation };
}

function validatePrivateDirectory(
  directory: string,
  code: Extract<TlsCertificateErrorCode, "TLS_STATE_INVALID" | "TLS_GENERATION_INVALID">,
): void {
  try {
    const metadata = lstatSync(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new TlsCertificateError(code);
    if ((metadata.mode & 0o077) !== 0 || (metadata.mode & 0o500) !== 0o500) {
      throw new TlsCertificateError(code);
    }
    assertServiceUserOwner(metadata.uid, code);
  } catch (error) {
    if (error instanceof TlsCertificateError) throw error;
    throw new TlsCertificateError(code);
  }
}

function readPrivateRegularFile(
  filename: string,
  maximumBytes: number,
  code: Extract<
    TlsCertificateErrorCode,
    "TLS_POINTER_INVALID" | "TLS_PRIVATE_KEY_INVALID" | "TLS_CERTIFICATE_INVALID"
  >,
): Buffer {
  let descriptor: number | undefined;
  try {
    if (!isAbsolute(filename)) throw new TlsCertificateError(code);
    const metadata = lstatSync(filename);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new TlsCertificateError(code);
    if ((metadata.mode & 0o077) !== 0 || (metadata.mode & 0o400) !== 0o400) {
      throw new TlsCertificateError(code);
    }
    assertServiceUserOwner(metadata.uid, code);
    if (metadata.size < 1 || metadata.size > maximumBytes) throw new TlsCertificateError(code);
    if (realpathSync(filename) !== filename) throw new TlsCertificateError(code);

    descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      opened.size < 1 ||
      opened.size > maximumBytes
    ) {
      throw new TlsCertificateError(code);
    }
    return readFileSync(descriptor);
  } catch (error) {
    if (error instanceof TlsCertificateError) throw error;
    throw new TlsCertificateError(code);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertServiceUserOwner(uid: number, code: TlsCertificateErrorCode): void {
  if (typeof process.getuid === "function" && uid !== process.getuid()) {
    throw new TlsCertificateError(code);
  }
}

function realpathWithoutDetails(path: string, code: TlsCertificateErrorCode): string {
  try {
    return realpathSync(path);
  } catch {
    throw new TlsCertificateError(code);
  }
}

function assertSafeGeneration(generation: string): void {
  if (!TLS_GENERATION_PATTERN.test(generation)) {
    throw new TlsCertificateError("TLS_POINTER_INVALID");
  }
}

function isTlsSecureContextServer(value: unknown): value is TlsSecureContextServer {
  return (
    typeof value === "object" &&
    value !== null &&
    "setSecureContext" in value &&
    typeof value.setSecureContext === "function"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tlsErrorMessage(code: TlsCertificateErrorCode): string {
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
      return "TLS certificate reload failed.";
    default:
      return "TLS certificate state is invalid.";
  }
}
