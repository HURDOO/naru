import { createPrivateKey, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import * as acme from "acme-client";
import {
  AuthoritativeDnsError,
  waitForAuthoritativeTxt,
  type WaitForAuthoritativeTxtOptions,
} from "./authoritative-dns.js";
import {
  CloudflareDnsClient,
  CloudflareDnsError,
  readCloudflareDnsTokenFile,
  type CloudflareTxtRecord,
} from "./cloudflare-dns.js";
import type { TlsConfig } from "./config.js";
import {
  readTlsCertificateGeneration,
  readTlsCertificateGenerationById,
  type TlsCertificateMaterial,
} from "./tls-certificate.js";

export const NARU_ACME_RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1_000;

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_KEY_MAX_BYTES = 128 * 1024;
const CERTIFICATE_MAX_BYTES = 512 * 1024;

export type AcmeEnvironment = "production" | "staging";
export type AcmeRenewalErrorCode =
  | "ACME_ROOT_FORBIDDEN"
  | "ACME_STATE_INVALID"
  | "ACME_ACCOUNT_KEY_INVALID"
  | "ACME_CHALLENGE_INVALID"
  | "ACME_ISSUANCE_FAILED"
  | "ACME_CHALLENGE_CLEANUP_FAILED"
  | "ACME_GENERATION_PUBLISH_FAILED";

export class AcmeRenewalError extends Error {
  override readonly name = "AcmeRenewalError";

  constructor(readonly code: AcmeRenewalErrorCode) {
    super(acmeRenewalErrorMessage(code));
  }
}

export interface AcmeRenewalConfig {
  readonly tokenFile: string;
  readonly stateDirectory: string;
  readonly repositoryDirectory: string;
  readonly hostname: string;
  readonly zoneName: string;
  readonly challengeName: string;
  readonly renewBeforeMs?: number;
  readonly propagationTimeoutMs?: number;
}

export interface AcmeVerificationResult {
  readonly status: "ok";
  readonly hostname: string;
  readonly zoneName: string;
  readonly token: "active";
}

export interface AcmeIssuanceResult {
  readonly status: "ok";
  readonly action: "issued" | "skipped";
  readonly environment: AcmeEnvironment;
  readonly hostname: string;
  readonly generation?: string;
  readonly expiresAt?: string;
  readonly fingerprint256?: string;
  readonly authoritativeNameServers?: number;
}

interface AcmeDnsAdapter {
  verifyAccess(): Promise<void>;
  createTxtRecord(value: string): Promise<CloudflareTxtRecord>;
  deleteCreatedTxtRecord(record: CloudflareTxtRecord): Promise<void>;
  cleanupCreatedTxtRecords(): Promise<void>;
}

interface AcmeChallenge {
  readonly identifier: string;
  readonly type: string;
  readonly id: string;
  readonly keyAuthorization: string;
}

interface AcmeChallengeHooks {
  create(challenge: AcmeChallenge): Promise<void>;
  remove(challenge: AcmeChallenge): Promise<void>;
}

interface AcmeIssuer {
  createAccountKey(): Promise<Buffer>;
  createCertificateKeyAndCsr(hostname: string): Promise<readonly [Buffer, Buffer]>;
  issue(
    environment: AcmeEnvironment,
    accountKey: Buffer,
    csr: Buffer,
    hooks: AcmeChallengeHooks,
  ): Promise<string>;
}

interface AcmeRenewalDependencies {
  readonly createDnsAdapter?: (token: string) => AcmeDnsAdapter;
  readonly issuer?: AcmeIssuer;
  readonly waitForTxt?: (
    options: WaitForAuthoritativeTxtOptions,
  ) => Promise<{ readonly nameServerCount: number }>;
  readonly now?: () => number;
  readonly generationSuffix?: () => string;
}

export async function verifyAcmeDnsAccess(
  config: AcmeRenewalConfig,
  dependencies: AcmeRenewalDependencies = {},
): Promise<AcmeVerificationResult> {
  assertNonRoot();
  const resolved = resolveConfig(config);
  const token = readCloudflareDnsTokenFile(resolved.tokenFile);
  const dns = createDnsAdapter(resolved, token, dependencies);
  await dns.verifyAccess();
  return {
    status: "ok",
    hostname: resolved.hostname,
    zoneName: resolved.zoneName,
    token: "active",
  };
}

export async function issueAcmeCertificate(
  environment: AcmeEnvironment,
  config: AcmeRenewalConfig,
  options: { readonly force?: boolean } = {},
  dependencies: AcmeRenewalDependencies = {},
): Promise<AcmeIssuanceResult> {
  assertNonRoot();
  const resolved = resolveConfig(config);
  const now = dependencies.now ?? Date.now;
  const issuer = dependencies.issuer ?? new LetsEncryptAcmeIssuer();
  const previousUmask = process.umask(0o077);
  let generationDirectory: string | undefined;
  try {
    ensureAcmeState(resolved.stateDirectory, resolved.repositoryDirectory);
    cleanupInterruptedStagingGenerations(resolved.stateDirectory);

    if (environment === "production" && options.force !== true) {
      const current = currentCertificateIfPresent(resolved, now());
      if (current !== undefined && Date.parse(current.expiresAt) - now() > resolved.renewBeforeMs) {
        return {
          status: "ok",
          action: "skipped",
          environment,
          hostname: resolved.hostname,
          generation: current.generation,
          expiresAt: current.expiresAt,
          fingerprint256: current.fingerprint256,
        };
      }
    }

    const token = readCloudflareDnsTokenFile(resolved.tokenFile);
    const dns = createDnsAdapter(resolved, token, dependencies);
    await dns.verifyAccess();
    const accountKey = await readOrCreateAccountKey(resolved.stateDirectory, issuer);
    const [certificateKey, csr] = await issuer.createCertificateKeyAndCsr(resolved.hostname);
    assertPrivateKey(certificateKey, "ACME_ISSUANCE_FAILED");

    const challengeRecords = new Map<string, CloudflareTxtRecord>();
    let authoritativeNameServers = 0;
    let certificate: string | undefined;
    let issuanceFailure: unknown;
    try {
      certificate = await issuer.issue(environment, accountKey, csr, {
        create: async (challenge) => {
          assertExactChallenge(challenge, resolved);
          const record = await dns.createTxtRecord(challenge.keyAuthorization);
          challengeRecords.set(challenge.id, record);
          const propagation = await (dependencies.waitForTxt ?? waitForAuthoritativeTxt)({
            zoneName: resolved.zoneName,
            recordName: resolved.challengeName,
            expectedValue: challenge.keyAuthorization,
            timeoutMs: resolved.propagationTimeoutMs,
          });
          authoritativeNameServers = Math.max(
            authoritativeNameServers,
            propagation.nameServerCount,
          );
        },
        remove: async (challenge) => {
          assertExactChallenge(challenge, resolved);
          const record = challengeRecords.get(challenge.id);
          if (record === undefined) return;
          await dns.deleteCreatedTxtRecord(record);
          challengeRecords.delete(challenge.id);
        },
      });
    } catch (error) {
      issuanceFailure = error;
    }

    let cleanupFailure = false;
    try {
      await dns.cleanupCreatedTxtRecords();
    } catch {
      cleanupFailure = true;
    }
    if (cleanupFailure) {
      throw new AcmeRenewalError("ACME_CHALLENGE_CLEANUP_FAILED");
    }
    if (issuanceFailure !== undefined) throwKnownIssuanceFailure(issuanceFailure);
    if (certificate === undefined || !certificate.includes("BEGIN CERTIFICATE")) {
      throw new AcmeRenewalError("ACME_ISSUANCE_FAILED");
    }

    const generation = createGenerationId(
      environment,
      now(),
      dependencies.generationSuffix ?? defaultGenerationSuffix,
    );
    generationDirectory = join(resolved.stateDirectory, "generations", generation);
    mkdirSync(generationDirectory, { mode: PRIVATE_DIRECTORY_MODE });
    writeFileSync(join(generationDirectory, "private-key.pem"), certificateKey, {
      flag: "wx",
      mode: PRIVATE_FILE_MODE,
    });
    writeFileSync(join(generationDirectory, "full-chain.pem"), certificate, {
      encoding: "utf8",
      flag: "wx",
      mode: PRIVATE_FILE_MODE,
    });

    const material = readTlsCertificateGenerationById(tlsConfig(resolved), generation, now());
    if (environment === "staging") {
      rmSync(generationDirectory, { recursive: true, force: false });
      generationDirectory = undefined;
      return {
        status: "ok",
        action: "issued",
        environment,
        hostname: resolved.hostname,
        expiresAt: material.expiresAt,
        fingerprint256: material.fingerprint256,
        authoritativeNameServers,
      };
    }

    publishGenerationPointer(resolved.stateDirectory, generation);
    generationDirectory = undefined;
    return {
      status: "ok",
      action: "issued",
      environment,
      hostname: resolved.hostname,
      generation,
      expiresAt: material.expiresAt,
      fingerprint256: material.fingerprint256,
      authoritativeNameServers,
    };
  } catch (error) {
    if (generationDirectory !== undefined) {
      rmSync(generationDirectory, { recursive: true, force: true });
    }
    throw error;
  } finally {
    process.umask(previousUmask);
  }
}

export function safeAcmeErrorCode(error: unknown): string {
  if (
    error instanceof AcmeRenewalError ||
    error instanceof CloudflareDnsError ||
    error instanceof AuthoritativeDnsError
  ) {
    return error.code;
  }
  return "ACME_ISSUANCE_FAILED";
}

class LetsEncryptAcmeIssuer implements AcmeIssuer {
  async createAccountKey(): Promise<Buffer> {
    return acme.crypto.createPrivateRsaKey(2048);
  }

  async createCertificateKeyAndCsr(hostname: string): Promise<readonly [Buffer, Buffer]> {
    return acme.crypto.createCsr({ commonName: hostname, altNames: [hostname], keySize: 2048 });
  }

  async issue(
    environment: AcmeEnvironment,
    accountKey: Buffer,
    csr: Buffer,
    hooks: AcmeChallengeHooks,
  ): Promise<string> {
    acme.setLogger(() => undefined);
    const client = new acme.Client({
      directoryUrl: acme.directory.letsencrypt[environment],
      accountKey,
    });
    return client.auto({
      csr,
      termsOfServiceAgreed: true,
      challengePriority: ["dns-01"],
      skipChallengeVerification: true,
      challengeCreateFn: async (authorization, challenge, keyAuthorization) => {
        await hooks.create({
          identifier: authorization.identifier.value,
          type: challenge.type,
          id: challenge.url,
          keyAuthorization,
        });
      },
      challengeRemoveFn: async (authorization, challenge, keyAuthorization) => {
        await hooks.remove({
          identifier: authorization.identifier.value,
          type: challenge.type,
          id: challenge.url,
          keyAuthorization,
        });
      },
    });
  }
}

interface ResolvedAcmeRenewalConfig {
  readonly tokenFile: string;
  readonly stateDirectory: string;
  readonly repositoryDirectory: string;
  readonly hostname: string;
  readonly zoneName: string;
  readonly challengeName: string;
  readonly renewBeforeMs: number;
  readonly propagationTimeoutMs: number;
}

function resolveConfig(config: AcmeRenewalConfig): ResolvedAcmeRenewalConfig {
  const hostname = canonicalDnsName(config.hostname);
  const zoneName = canonicalDnsName(config.zoneName);
  const challengeName = canonicalAcmeChallengeName(config.challengeName);
  if (
    (hostname !== zoneName && !hostname.endsWith(`.${zoneName}`)) ||
    challengeName !== `_acme-challenge.${hostname}` ||
    !isAbsolute(config.tokenFile) ||
    !isAbsolute(config.stateDirectory) ||
    !isAbsolute(config.repositoryDirectory)
  ) {
    throw new AcmeRenewalError("ACME_STATE_INVALID");
  }
  return {
    tokenFile: config.tokenFile,
    stateDirectory: config.stateDirectory,
    repositoryDirectory: config.repositoryDirectory,
    hostname,
    zoneName,
    challengeName,
    renewBeforeMs: config.renewBeforeMs ?? NARU_ACME_RENEW_BEFORE_MS,
    propagationTimeoutMs: config.propagationTimeoutMs ?? 120_000,
  };
}

function canonicalDnsName(value: string): string {
  if (
    value.length < 1 ||
    value.length > 253 ||
    value !== value.toLowerCase() ||
    value.endsWith(".") ||
    !value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
  ) {
    throw new AcmeRenewalError("ACME_STATE_INVALID");
  }
  return value;
}

function canonicalAcmeChallengeName(value: string): string {
  const prefix = "_acme-challenge.";
  if (!value.startsWith(prefix)) {
    throw new AcmeRenewalError("ACME_STATE_INVALID");
  }
  canonicalDnsName(value.slice(prefix.length));
  return value;
}

function createDnsAdapter(
  config: ResolvedAcmeRenewalConfig,
  token: string,
  dependencies: AcmeRenewalDependencies,
): AcmeDnsAdapter {
  return dependencies.createDnsAdapter === undefined
    ? new CloudflareDnsClient({
        token,
        zoneName: config.zoneName,
        challengeName: config.challengeName,
      })
    : dependencies.createDnsAdapter(token);
}

function ensureAcmeState(stateDirectory: string, repositoryDirectory: string): void {
  const repository = resolve(repositoryDirectory);
  const state = resolve(stateDirectory);
  const stateRelativeToRepository = relative(repository, state);
  if (
    stateRelativeToRepository === "" ||
    (stateRelativeToRepository !== ".." &&
      !stateRelativeToRepository.startsWith(`..${sep}`) &&
      !isAbsolute(stateRelativeToRepository))
  ) {
    throw new AcmeRenewalError("ACME_STATE_INVALID");
  }
  ensurePrivateDirectory(state);
  ensurePrivateDirectory(join(state, "acme"));
  ensurePrivateDirectory(join(state, "generations"));
}

function ensurePrivateDirectory(directory: string): void {
  try {
    mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const metadata = lstatSync(directory);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      (metadata.mode & 0o077) !== 0 ||
      (metadata.mode & 0o700) !== 0o700 ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid()) ||
      realpathSync(directory) !== directory
    ) {
      throw new AcmeRenewalError("ACME_STATE_INVALID");
    }
  } catch (error) {
    if (error instanceof AcmeRenewalError) throw error;
    throw new AcmeRenewalError("ACME_STATE_INVALID");
  }
}

async function readOrCreateAccountKey(stateDirectory: string, issuer: AcmeIssuer): Promise<Buffer> {
  const filename = join(stateDirectory, "acme", "account.key");
  if (existsSync(filename)) {
    const key = readPrivateFile(filename, PRIVATE_KEY_MAX_BYTES, "ACME_ACCOUNT_KEY_INVALID");
    assertPrivateKey(key, "ACME_ACCOUNT_KEY_INVALID");
    return key;
  }
  const key = await issuer.createAccountKey();
  assertPrivateKey(key, "ACME_ACCOUNT_KEY_INVALID");
  try {
    writeFileSync(filename, key, { flag: "wx", mode: PRIVATE_FILE_MODE });
  } catch {
    throw new AcmeRenewalError("ACME_ACCOUNT_KEY_INVALID");
  }
  return key;
}

function readPrivateFile(
  filename: string,
  maximumBytes: number,
  code: Extract<AcmeRenewalErrorCode, "ACME_ACCOUNT_KEY_INVALID">,
): Buffer {
  let descriptor: number | undefined;
  try {
    const metadata = lstatSync(filename);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      (metadata.mode & 0o077) !== 0 ||
      (metadata.mode & 0o400) !== 0o400 ||
      metadata.size < 1 ||
      metadata.size > maximumBytes ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid()) ||
      realpathSync(filename) !== filename
    ) {
      throw new AcmeRenewalError(code);
    }
    descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      opened.size !== metadata.size
    ) {
      throw new AcmeRenewalError(code);
    }
    return readFileSync(descriptor);
  } catch (error) {
    if (error instanceof AcmeRenewalError) throw error;
    throw new AcmeRenewalError(code);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertPrivateKey(key: Buffer, code: AcmeRenewalErrorCode): void {
  try {
    if (key.byteLength < 1 || key.byteLength > PRIVATE_KEY_MAX_BYTES) {
      throw new AcmeRenewalError(code);
    }
    createPrivateKey(key);
  } catch (error) {
    if (error instanceof AcmeRenewalError) throw error;
    throw new AcmeRenewalError(code);
  }
}

function currentCertificateIfPresent(
  config: ResolvedAcmeRenewalConfig,
  now: number,
): TlsCertificateMaterial | undefined {
  if (!existsSync(join(config.stateDirectory, "current.json"))) return undefined;
  return readTlsCertificateGeneration(tlsConfig(config), now);
}

function publishGenerationPointer(stateDirectory: string, generation: string): void {
  const pointer = join(stateDirectory, "current.json");
  const temporary = join(stateDirectory, `.current-${randomUUID()}.json`);
  try {
    if (existsSync(pointer)) validatePrivatePointer(pointer);
    writeFileSync(temporary, `${JSON.stringify({ formatVersion: 1, generation }, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: PRIVATE_FILE_MODE,
    });
    renameSync(temporary, pointer);
  } catch (error) {
    rmSync(temporary, { force: true });
    if (error instanceof AcmeRenewalError) throw error;
    throw new AcmeRenewalError("ACME_GENERATION_PUBLISH_FAILED");
  }
}

function validatePrivatePointer(filename: string): void {
  try {
    const metadata = lstatSync(filename);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      (metadata.mode & 0o077) !== 0 ||
      (metadata.mode & 0o400) !== 0o400 ||
      metadata.size < 1 ||
      metadata.size > CERTIFICATE_MAX_BYTES ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid()) ||
      realpathSync(filename) !== filename
    ) {
      throw new AcmeRenewalError("ACME_GENERATION_PUBLISH_FAILED");
    }
  } catch (error) {
    if (error instanceof AcmeRenewalError) throw error;
    throw new AcmeRenewalError("ACME_GENERATION_PUBLISH_FAILED");
  }
}

function cleanupInterruptedStagingGenerations(stateDirectory: string): void {
  const generationsDirectory = join(stateDirectory, "generations");
  // Staging generations are never published. Their names are known only to this
  // component, so removing leftovers avoids retaining test private keys after a crash.
  for (const entry of readdirSync(generationsDirectory, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith("staging-")) {
      rmSync(join(generationsDirectory, entry.name), { recursive: true, force: true });
    }
  }
}

function assertExactChallenge(challenge: AcmeChallenge, config: ResolvedAcmeRenewalConfig): void {
  if (
    challenge.identifier !== config.hostname ||
    challenge.type !== "dns-01" ||
    challenge.id.length < 1 ||
    !/^[A-Za-z0-9_-]{43}$/u.test(challenge.keyAuthorization)
  ) {
    throw new AcmeRenewalError("ACME_CHALLENGE_INVALID");
  }
}

function createGenerationId(
  environment: AcmeEnvironment,
  now: number,
  suffix: () => string,
): string {
  const timestamp = new Date(now)
    .toISOString()
    .replace(/\.\d{3}Z$/u, "Z")
    .replaceAll(/[-:]/gu, "");
  const value = `${environment}-${timestamp}-${suffix()}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value)) {
    throw new AcmeRenewalError("ACME_STATE_INVALID");
  }
  return value;
}

function defaultGenerationSuffix(): string {
  return randomUUID().slice(0, 8);
}

function tlsConfig(config: ResolvedAcmeRenewalConfig): TlsConfig {
  return {
    stateDirectory: config.stateDirectory,
    serverNames: [config.hostname],
    reloadIntervalMs: 10_000,
  };
}

function throwKnownIssuanceFailure(error: unknown): never {
  if (
    error instanceof AcmeRenewalError ||
    error instanceof CloudflareDnsError ||
    error instanceof AuthoritativeDnsError
  ) {
    throw error;
  }
  throw new AcmeRenewalError("ACME_ISSUANCE_FAILED");
}

function assertNonRoot(): void {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    throw new AcmeRenewalError("ACME_ROOT_FORBIDDEN");
  }
}

function acmeRenewalErrorMessage(code: AcmeRenewalErrorCode): string {
  switch (code) {
    case "ACME_ROOT_FORBIDDEN":
      return "Naru certificate renewal must not run as root.";
    case "ACME_STATE_INVALID":
      return "Naru ACME state is invalid.";
    case "ACME_ACCOUNT_KEY_INVALID":
      return "Naru ACME account key is invalid.";
    case "ACME_CHALLENGE_INVALID":
      return "Naru ACME challenge is invalid.";
    case "ACME_CHALLENGE_CLEANUP_FAILED":
      return "Naru ACME challenge cleanup failed.";
    case "ACME_GENERATION_PUBLISH_FAILED":
      return "Naru certificate generation publication failed.";
    default:
      return "Naru ACME certificate issuance failed.";
  }
}
