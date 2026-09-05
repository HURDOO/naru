import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { DISTRIBUTION_SCHEMA_VERSION, WORKSTATION_PACKAGE_ID } from "./constants.js";
import { createInstanceShortRuntimeRoot, type WorkstationInstallationIntentV1 } from "./model.js";
import { assertPrivateSocket } from "./security.js";

const AUTH_RESPONSE_BYTES = 64 * 1024;
const AUTH_REQUEST_TIMEOUT_MS = 5_000;
const INTENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BOOTSTRAP_CODE_PATTERN = /^[A-Za-z0-9_-]{20,256}$/;

export type WorkstationAuthOperation = "bootstrap" | "recover";

export interface WorkstationAuthIntentResult {
  readonly version: typeof DISTRIBUTION_SCHEMA_VERSION;
  readonly packageId: typeof WORKSTATION_PACKAGE_ID;
  readonly status: "created";
  readonly operation: WorkstationAuthOperation;
  readonly intentId: string;
  readonly origin: string;
  readonly expiresAt: number;
  readonly code: string;
}

interface GatewayAuthIntent {
  readonly intentId: string;
  readonly kind: WorkstationAuthOperation;
  readonly code: string;
  readonly origin: string;
  readonly expiresAt: number;
}

export async function createWorkstationAuthIntent(
  intent: WorkstationInstallationIntentV1,
  operation: WorkstationAuthOperation,
): Promise<WorkstationAuthIntentResult> {
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && currentUid !== intent.targetUid) {
    throw new Error("Auth bootstrap must run inside the target user's login session.");
  }
  const socketPath = gatewayAdminSocketPath(intent);
  assertPrivateSocket(socketPath, intent.targetUid);
  const createdAt = Date.now();
  const response = await requestAuthIntent(socketPath, operation);
  const parsed = parseGatewayAuthIntent(response, intent, operation, createdAt, Date.now());
  return {
    version: DISTRIBUTION_SCHEMA_VERSION,
    packageId: WORKSTATION_PACKAGE_ID,
    status: "created",
    operation,
    intentId: parsed.intentId,
    origin: parsed.origin,
    expiresAt: parsed.expiresAt,
    code: parsed.code,
  };
}

export function gatewayAdminSocketPath(intent: WorkstationInstallationIntentV1): string {
  return join(createInstanceShortRuntimeRoot(intent), "gateway-admin.sock");
}

async function requestAuthIntent(
  socketPath: string,
  operation: WorkstationAuthOperation,
): Promise<unknown> {
  const payload = Buffer.from("{}", "utf8");
  return await new Promise<unknown>((resolvePromise, reject) => {
    const request = httpRequest(
      {
        socketPath,
        path: `/v1/auth/${operation === "bootstrap" ? "bootstrap" : "recover"}`,
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "content-length": String(payload.byteLength),
          host: "localhost",
        },
        timeout: AUTH_REQUEST_TIMEOUT_MS,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > AUTH_RESPONSE_BYTES) response.destroy(new Error("response too large"));
          else chunks.push(chunk);
        });
        response.once("end", () => {
          const contentType = response.headers["content-type"]
            ?.split(";", 1)[0]
            ?.trim()
            .toLowerCase();
          if (response.statusCode !== 201 || contentType !== "application/json") {
            reject(new Error("Gateway refused the local auth intent request."));
            return;
          }
          try {
            resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
          } catch (error) {
            reject(new Error("Gateway auth response was not valid JSON.", { cause: error }));
          }
        });
        response.once("error", () => {
          reject(new Error("Gateway auth response failed."));
        });
      },
    );
    request.once("timeout", () => request.destroy(new Error("request timeout")));
    request.once("error", () => {
      reject(new Error("Gateway admin socket auth request failed."));
    });
    request.end(payload);
  });
}

function parseGatewayAuthIntent(
  value: unknown,
  expectedIntent: WorkstationInstallationIntentV1,
  expectedOperation: WorkstationAuthOperation,
  createdAt: number,
  receivedAt: number,
): GatewayAuthIntent {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "intent"]) || value.version !== 1) {
    throw new Error("Gateway auth response envelope is invalid.");
  }
  const intent = value.intent;
  if (
    !isRecord(intent) ||
    !hasExactKeys(intent, ["intentId", "kind", "code", "origin", "expiresAt"]) ||
    typeof intent.intentId !== "string" ||
    !INTENT_ID_PATTERN.test(intent.intentId) ||
    intent.kind !== expectedOperation ||
    typeof intent.code !== "string" ||
    !BOOTSTRAP_CODE_PATTERN.test(intent.code) ||
    intent.origin !== expectedIntent.canonicalBrowserOrigin ||
    !Number.isSafeInteger(intent.expiresAt) ||
    (intent.expiresAt as number) <= createdAt ||
    (intent.expiresAt as number) > receivedAt + 30 * 60_000
  ) {
    throw new Error("Gateway auth intent does not match the installed Workstation identity.");
  }
  return {
    intentId: intent.intentId,
    kind: expectedOperation,
    code: intent.code,
    origin: intent.origin,
    expiresAt: intent.expiresAt as number,
  };
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
