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
import {
  LastKnownGoodTlsMaterialManager,
  TlsMaterialError,
  tlsMaterialServerOptions,
  validateTlsMaterial,
  type TlsMaterialLifecycleEvent,
  type TlsMaterialSource,
  type TlsMaterialWatcher,
  type ValidatedTlsMaterial,
} from "@naru/tls-material";
import type { TlsConfig } from "./config.js";

const TLS_POINTER_FILENAME = "current.json";
const TLS_PRIVATE_KEY_FILENAME = "private-key.pem";
const TLS_CERTIFICATE_CHAIN_FILENAME = "full-chain.pem";
const TLS_POINTER_MAX_BYTES = 4 * 1024;
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

export interface TlsCertificateService {
  loadInitial(): ServerOptions;
  start(server: unknown): void;
  stop(): void;
  status(): TlsCertificateStatus;
  setEventSink(eventSink: (event: TlsCertificateEvent) => void): void;
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
  return tlsMaterialServerOptions({ ...material, revision: material.generation });
}

export class TlsCertificateManager {
  readonly #source: NaruTlsGenerationSource;
  readonly #manager: LastKnownGoodTlsMaterialManager;
  #eventSink: ((event: TlsCertificateEvent) => void) | undefined;

  constructor(
    readonly config: TlsConfig,
    options: {
      now?: () => number;
      eventSink?: (event: TlsCertificateEvent) => void;
    } = {},
  ) {
    this.#source = new NaruTlsGenerationSource(config);
    this.#eventSink = options.eventSink;
    this.#manager = new LastKnownGoodTlsMaterialManager(this.#source, {
      ...(options.now === undefined ? {} : { now: options.now }),
      errorCode: tlsCertificateErrorCode,
      rejectionSignature: (_error, code) =>
        `${this.#source.lastCandidateGeneration ?? "unknown"}:${code}`,
      eventSink: (event) => this.#emit(event),
    });
  }

  setEventSink(eventSink: (event: TlsCertificateEvent) => void): void {
    this.#eventSink = eventSink;
  }

  loadInitial(): ServerOptions {
    return this.#run(() => this.#manager.loadInitial());
  }

  start(server: unknown): void {
    this.#run(() => this.#manager.start(server));
  }

  stop(): void {
    this.#manager.stop();
  }

  reloadNow(): TlsReloadResult {
    return this.#run(() => this.#manager.reloadNow());
  }

  status(): TlsCertificateStatus {
    const { lastReloadErrorCode, ...status } = this.#manager.status();
    const generation = this.#manager.currentRevision();
    return {
      ...status,
      ...(generation === undefined ? {} : { generation }),
      ...(lastReloadErrorCode === undefined
        ? {}
        : { lastReloadErrorCode: lastReloadErrorCode as TlsCertificateErrorCode }),
    };
  }

  #emit(event: TlsMaterialLifecycleEvent): void {
    if (event.event === "tls.material.reloaded") {
      this.#eventSink?.({
        level: event.level,
        event: "tls.certificate.reloaded",
        fields: {
          generation: this.#manager.currentRevision(),
          expiresAt: event.expiresAt,
        },
      });
      return;
    }
    this.#eventSink?.({
      level: event.level,
      event: "tls.certificate.reload_rejected",
      fields: {
        errorCode: event.errorCode,
        ...(this.#source.lastCandidateGeneration === undefined
          ? {}
          : { generation: this.#source.lastCandidateGeneration }),
      },
    });
  }

  #run<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof TlsCertificateError) throw error;
      throw new TlsCertificateError(tlsCertificateErrorCode(error));
    }
  }
}

class NaruTlsGenerationSource implements TlsMaterialSource {
  lastCandidateGeneration: string | undefined;

  constructor(private readonly config: TlsConfig) {}

  load(now: number): ValidatedTlsMaterial {
    this.lastCandidateGeneration = undefined;
    const stateDirectory = validateStateDirectory(this.config.stateDirectory);
    const generation = readTlsGenerationPointerFromDirectory(stateDirectory).generation;
    this.lastCandidateGeneration = generation;
    const material = readTlsCertificateGenerationFromDirectory(
      stateDirectory,
      generation,
      this.config,
      now,
    );
    return { ...material, revision: generation };
  }

  watch(onChange: () => void): TlsMaterialWatcher {
    const timer = setInterval(onChange, this.config.reloadIntervalMs);
    timer.unref();
    return { close: () => clearInterval(timer) };
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
  try {
    const material = validateTlsMaterial(
      {
        approvedRoot: generationDirectory,
        privateKeyFile: join(generationDirectory, TLS_PRIVATE_KEY_FILENAME),
        certificateFile: join(generationDirectory, TLS_CERTIFICATE_CHAIN_FILENAME),
        serverNames: config.serverNames,
      },
      { now },
    );
    return {
      generation,
      privateKey: material.privateKey,
      certificateChain: material.certificateChain,
      expiresAt: material.expiresAt,
      fingerprint256: material.fingerprint256,
    };
  } catch (error) {
    if (error instanceof TlsCertificateError) throw error;
    throw new TlsCertificateError(tlsCertificateErrorCode(error));
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tlsCertificateErrorCode(error: unknown): TlsCertificateErrorCode {
  if (error instanceof TlsCertificateError) return error.code;
  if (error instanceof TlsMaterialError) {
    switch (error.code) {
      case "TLS_APPROVED_ROOT_INVALID":
        return "TLS_GENERATION_INVALID";
      case "TLS_LIFECYCLE_INVALID":
        return "TLS_STATE_INVALID";
      default:
        return error.code;
    }
  }
  return "TLS_RELOAD_FAILED";
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
