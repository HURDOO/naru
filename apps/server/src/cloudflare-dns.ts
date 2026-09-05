import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute } from "node:path";

const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";
const TOKEN_FILE_MAX_BYTES = 4 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{20,512}$/;
const RECORD_ID_PATTERN = /^[a-f0-9]{32}$/i;
const DNS_01_VALUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_VARIABLES = new Set([
  "CF_API_TOKEN",
  "CF_DNS_API_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_DNS_API_TOKEN",
]);

export type CloudflareDnsErrorCode =
  | "CLOUDFLARE_TOKEN_FILE_INVALID"
  | "CLOUDFLARE_TOKEN_REJECTED"
  | "CLOUDFLARE_TOKEN_SCOPE_INSUFFICIENT"
  | "CLOUDFLARE_ZONE_NOT_FOUND"
  | "CLOUDFLARE_API_UNAVAILABLE"
  | "CLOUDFLARE_API_RESPONSE_INVALID"
  | "CLOUDFLARE_RECORD_INVALID"
  | "CLOUDFLARE_RECORD_CREATE_FAILED"
  | "CLOUDFLARE_RECORD_DELETE_FAILED";

export class CloudflareDnsError extends Error {
  override readonly name = "CloudflareDnsError";

  constructor(readonly code: CloudflareDnsErrorCode) {
    super(cloudflareDnsErrorMessage(code));
  }
}

export interface CloudflareTxtRecord {
  readonly id: string;
  readonly name: string;
}

interface CloudflareZone {
  readonly id: string;
  readonly name: string;
}

interface CloudflareDnsClientOptions {
  readonly token: string;
  readonly zoneName: string;
  readonly challengeName: string;
  readonly fetchImplementation?: typeof fetch;
  readonly requestTimeoutMs?: number;
}

export function readCloudflareDnsTokenFile(filename: string): string {
  const contents = readPrivateTokenFile(filename).toString("utf8");
  const lines = contents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (lines.length !== 1) throw new CloudflareDnsError("CLOUDFLARE_TOKEN_FILE_INVALID");

  const line = lines[0];
  if (line === undefined) throw new CloudflareDnsError("CLOUDFLARE_TOKEN_FILE_INVALID");
  const assignment = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.+)$/u.exec(line);
  const token = assignment === null ? line : parseTokenAssignment(assignment[1], assignment[2]);
  if (!TOKEN_PATTERN.test(token)) {
    throw new CloudflareDnsError("CLOUDFLARE_TOKEN_FILE_INVALID");
  }
  return token;
}

export class CloudflareDnsClient {
  readonly #token: string;
  readonly #zoneName: string;
  readonly #challengeName: string;
  readonly #fetch: typeof fetch;
  readonly #requestTimeoutMs: number;
  readonly #createdRecords = new Map<string, CloudflareTxtRecord>();
  #zone: CloudflareZone | undefined;

  constructor(options: CloudflareDnsClientOptions) {
    if (!TOKEN_PATTERN.test(options.token)) {
      throw new CloudflareDnsError("CLOUDFLARE_TOKEN_FILE_INVALID");
    }
    this.#token = options.token;
    this.#zoneName = normalizeDnsName(options.zoneName);
    this.#challengeName = normalizeAcmeChallengeName(options.challengeName);
    if (
      !this.#challengeName.startsWith("_acme-challenge.") ||
      !this.#challengeName.endsWith(`.${this.#zoneName}`)
    ) {
      throw new CloudflareDnsError("CLOUDFLARE_RECORD_INVALID");
    }
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  async verifyAccess(): Promise<void> {
    const verification = await this.#request("/user/tokens/verify", "GET");
    if (!isRecord(verification) || verification.status !== "active") {
      throw new CloudflareDnsError("CLOUDFLARE_TOKEN_REJECTED");
    }
    await this.#resolveZone();
  }

  async createTxtRecord(value: string): Promise<CloudflareTxtRecord> {
    if (!DNS_01_VALUE_PATTERN.test(value)) {
      throw new CloudflareDnsError("CLOUDFLARE_RECORD_INVALID");
    }
    const zone = await this.#resolveZone();
    let result: unknown;
    try {
      result = await this.#request(`/zones/${zone.id}/dns_records`, "POST", {
        type: "TXT",
        name: this.#challengeName,
        content: value,
        ttl: 60,
        comment: "Naru ACME DNS-01 temporary challenge",
      });
    } catch (error) {
      if (error instanceof CloudflareDnsError) {
        if (error.code === "CLOUDFLARE_TOKEN_SCOPE_INSUFFICIENT") throw error;
        throw new CloudflareDnsError("CLOUDFLARE_RECORD_CREATE_FAILED");
      }
      throw new CloudflareDnsError("CLOUDFLARE_RECORD_CREATE_FAILED");
    }
    if (!isRecord(result) || !isRecordId(result.id) || result.name !== this.#challengeName) {
      throw new CloudflareDnsError("CLOUDFLARE_API_RESPONSE_INVALID");
    }
    const record = { id: result.id, name: this.#challengeName } as const;
    this.#createdRecords.set(record.id, record);
    return record;
  }

  async deleteCreatedTxtRecord(record: CloudflareTxtRecord): Promise<void> {
    const owned = this.#createdRecords.get(record.id);
    if (owned === undefined || owned.name !== this.#challengeName || record.name !== owned.name) {
      throw new CloudflareDnsError("CLOUDFLARE_RECORD_INVALID");
    }
    const zone = await this.#resolveZone();
    try {
      const result = await this.#request(`/zones/${zone.id}/dns_records/${record.id}`, "DELETE");
      if (!isRecord(result) || result.id !== record.id) {
        throw new CloudflareDnsError("CLOUDFLARE_API_RESPONSE_INVALID");
      }
      this.#createdRecords.delete(record.id);
    } catch (error) {
      if (
        error instanceof CloudflareDnsError &&
        error.code === "CLOUDFLARE_TOKEN_SCOPE_INSUFFICIENT"
      ) {
        throw error;
      }
      throw new CloudflareDnsError("CLOUDFLARE_RECORD_DELETE_FAILED");
    }
  }

  async cleanupCreatedTxtRecords(): Promise<void> {
    let failed = false;
    for (const record of [...this.#createdRecords.values()]) {
      try {
        await this.deleteCreatedTxtRecord(record);
      } catch {
        failed = true;
      }
    }
    if (failed) throw new CloudflareDnsError("CLOUDFLARE_RECORD_DELETE_FAILED");
  }

  async #resolveZone(): Promise<CloudflareZone> {
    if (this.#zone !== undefined) return this.#zone;
    const result = await this.#request(
      `/zones?name=${encodeURIComponent(this.#zoneName)}&status=active&page=1&per_page=20`,
      "GET",
    );
    if (!Array.isArray(result)) {
      throw new CloudflareDnsError("CLOUDFLARE_API_RESPONSE_INVALID");
    }
    const matching = result.filter(
      (candidate): candidate is Record<string, unknown> =>
        isRecord(candidate) &&
        candidate.name === this.#zoneName &&
        isRecordId(candidate.id) &&
        (candidate.status === undefined || candidate.status === "active"),
    );
    if (matching.length !== 1) {
      throw new CloudflareDnsError("CLOUDFLARE_ZONE_NOT_FOUND");
    }
    const candidate = matching[0];
    if (candidate === undefined || !isRecordId(candidate.id)) {
      throw new CloudflareDnsError("CLOUDFLARE_API_RESPONSE_INVALID");
    }
    this.#zone = { id: candidate.id, name: this.#zoneName };
    return this.#zone;
  }

  async #request(
    path: string,
    method: "DELETE" | "GET" | "POST",
    body?: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(`${CLOUDFLARE_API_BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new CloudflareDnsError("CLOUDFLARE_API_UNAVAILABLE");
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401) {
      throw new CloudflareDnsError("CLOUDFLARE_TOKEN_REJECTED");
    }
    if (response.status === 403) {
      throw new CloudflareDnsError("CLOUDFLARE_TOKEN_SCOPE_INSUFFICIENT");
    }
    if (!response.ok) throw new CloudflareDnsError("CLOUDFLARE_API_UNAVAILABLE");

    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch {
      throw new CloudflareDnsError("CLOUDFLARE_API_RESPONSE_INVALID");
    }
    if (!isRecord(envelope) || envelope.success !== true || !("result" in envelope)) {
      throw new CloudflareDnsError("CLOUDFLARE_API_RESPONSE_INVALID");
    }
    return envelope.result;
  }
}

function readPrivateTokenFile(filename: string): Buffer {
  let descriptor: number | undefined;
  try {
    if (!isAbsolute(filename)) throw new CloudflareDnsError("CLOUDFLARE_TOKEN_FILE_INVALID");
    const metadata = lstatSync(filename);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new CloudflareDnsError("CLOUDFLARE_TOKEN_FILE_INVALID");
    }
    if (
      (metadata.mode & 0o077) !== 0 ||
      (metadata.mode & 0o400) !== 0o400 ||
      metadata.size < 1 ||
      metadata.size > TOKEN_FILE_MAX_BYTES ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid()) ||
      realpathSync(filename) !== filename
    ) {
      throw new CloudflareDnsError("CLOUDFLARE_TOKEN_FILE_INVALID");
    }
    descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      opened.size !== metadata.size
    ) {
      throw new CloudflareDnsError("CLOUDFLARE_TOKEN_FILE_INVALID");
    }
    return readFileSync(descriptor);
  } catch (error) {
    if (error instanceof CloudflareDnsError) throw error;
    throw new CloudflareDnsError("CLOUDFLARE_TOKEN_FILE_INVALID");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseTokenAssignment(key: string | undefined, rawValue: string | undefined): string {
  if (key === undefined || rawValue === undefined || !TOKEN_VARIABLES.has(key)) {
    throw new CloudflareDnsError("CLOUDFLARE_TOKEN_FILE_INVALID");
  }
  const value = rawValue.trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeDnsName(value: string): string {
  const normalized = value.toLowerCase().replace(/\.$/u, "");
  if (
    normalized.length < 1 ||
    normalized.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
      normalized,
    )
  ) {
    throw new CloudflareDnsError("CLOUDFLARE_RECORD_INVALID");
  }
  return normalized;
}

function normalizeAcmeChallengeName(value: string): string {
  const normalized = value.toLowerCase().replace(/\.$/u, "");
  const prefix = "_acme-challenge.";
  if (!normalized.startsWith(prefix)) {
    throw new CloudflareDnsError("CLOUDFLARE_RECORD_INVALID");
  }
  normalizeDnsName(normalized.slice(prefix.length));
  return normalized;
}

function isRecordId(value: unknown): value is string {
  return typeof value === "string" && RECORD_ID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloudflareDnsErrorMessage(code: CloudflareDnsErrorCode): string {
  switch (code) {
    case "CLOUDFLARE_TOKEN_FILE_INVALID":
      return "Cloudflare token file is invalid.";
    case "CLOUDFLARE_TOKEN_REJECTED":
      return "Cloudflare rejected the API token.";
    case "CLOUDFLARE_TOKEN_SCOPE_INSUFFICIENT":
      return "Cloudflare token permissions are insufficient.";
    case "CLOUDFLARE_ZONE_NOT_FOUND":
      return "The exact active Cloudflare zone was not found.";
    case "CLOUDFLARE_RECORD_CREATE_FAILED":
      return "Cloudflare DNS challenge record creation failed.";
    case "CLOUDFLARE_RECORD_DELETE_FAILED":
      return "Cloudflare DNS challenge record cleanup failed.";
    case "CLOUDFLARE_RECORD_INVALID":
      return "Cloudflare DNS challenge record is invalid.";
    case "CLOUDFLARE_API_RESPONSE_INVALID":
      return "Cloudflare returned an invalid API response.";
    default:
      return "Cloudflare API is unavailable.";
  }
}
