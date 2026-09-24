import { spawnSync } from "node:child_process";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import type { ServiceName } from "./constants.js";
import type { WorkstationInstanceLayout } from "./model.js";

const COMMAND_TIMEOUT_MS = 30_000;
const COMMAND_MAX_BUFFER = 512 * 1024;
const READINESS_TIMEOUT_MS = 30_000;
const READINESS_INTERVAL_MS = 250;
const SERVICE_STOP_TIMEOUT_MS = 30_000;
const SERVICE_STOP_INTERVAL_MS = 100;

export type ServiceRuntimeState = "unloaded" | "loaded" | "running" | "unknown";

// Preserve uncertainty across transaction recovery even after launchd forgets the label.
export class RuntimeStopUnconfirmedError extends Error {
  constructor(cause: unknown) {
    super("Runtime stop could not be confirmed; manual recovery required.", { cause });
    this.name = "RuntimeStopUnconfirmedError";
  }
}

async function stopConfirmed(
  runtime: WorkstationRuntimeController,
  uid: number,
  label: string,
): Promise<void> {
  try {
    await runtime.stopAndWait(uid, label);
  } catch (error) {
    throw new RuntimeStopUnconfirmedError(error);
  }
}

export interface GatewayVerifierKeySetV1 {
  readonly version: 1;
  readonly keys: readonly {
    readonly keyId: string;
    readonly algorithm: "Ed25519";
    readonly publicKeyPem: string;
  }[];
}

export interface WorkstationRuntimeController {
  serviceState(uid: number, label: string): ServiceRuntimeState;
  bootstrap(uid: number, plistPath: string): void;
  bootout(uid: number, label: string): void;
  stopAndWait(uid: number, label: string): Promise<void>;
  kickstart(uid: number, label: string): void;
  waitForUdsReady(socketPath: string, path: "/readyz"): Promise<void>;
  waitForHttpReady(origin: string, path: "/readyz"): Promise<void>;
  readGatewayVerifierKeys(socketPath: string): Promise<GatewayVerifierKeySetV1>;
}

export class MacOsLaunchctlRuntimeController implements WorkstationRuntimeController {
  serviceState(uid: number, label: string): ServiceRuntimeState {
    return inspectLaunchctlService(uid, label).state;
  }

  bootstrap(uid: number, plistPath: string): void {
    const result = runLaunchctl(["bootstrap", `gui/${uid}`, plistPath]);
    if (result.status !== 0) throw launchctlFailure("bootstrap", result.stderr);
  }

  bootout(uid: number, label: string): void {
    const result = runLaunchctl(["bootout", serviceTarget(uid, label)], true);
    if (result.status === 0 || isServiceNotFound(result.stderr)) return;
    throw launchctlFailure("bootout", result.stderr);
  }

  async stopAndWait(uid: number, label: string): Promise<void> {
    const previous = inspectLaunchctlService(uid, label);
    if (previous.state === "unknown") {
      throw new Error("launchd service state is unknown; refusing stop.");
    }
    if (previous.state === "running" && previous.pid === undefined) {
      throw new Error("launchd running service PID is unavailable; refusing stop.");
    }
    this.bootout(uid, label);
    const deadline = Date.now() + SERVICE_STOP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const current = inspectLaunchctlService(uid, label);
      if (
        current.state === "unloaded" &&
        (previous.pid === undefined || !processExists(previous.pid))
      )
        return;
      await delay(SERVICE_STOP_INTERVAL_MS);
    }
    throw new Error("launchd service did not fully stop before timeout.");
  }

  kickstart(uid: number, label: string): void {
    const result = runLaunchctl(["kickstart", "-k", serviceTarget(uid, label)]);
    if (result.status !== 0) throw launchctlFailure("kickstart", result.stderr);
  }

  async waitForUdsReady(socketPath: string, path: "/readyz"): Promise<void> {
    await waitForReady(() => requestJson({ socketPath, path }));
  }

  async waitForHttpReady(origin: string, path: "/readyz"): Promise<void> {
    const url = new URL(path, origin);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
      throw new Error("Runtime readiness probe only permits exact loopback HTTP.");
    }
    await waitForReady(() => requestJson({ origin: url.origin, path: url.pathname }));
  }

  async readGatewayVerifierKeys(socketPath: string): Promise<GatewayVerifierKeySetV1> {
    const response = await requestJson({ socketPath, path: "/v1/verifier-keys" });
    if (response.statusCode !== 200)
      throw new Error("Gateway verifier-key endpoint is unavailable.");
    return parseVerifierKeys(response.value);
  }
}

export async function startRuntimeTopology(
  runtime: WorkstationRuntimeController,
  layout: WorkstationInstanceLayout,
  writeVerifierKeys: (keys: GatewayVerifierKeySetV1) => void,
  services: readonly ServiceName[] = ["host", "gateway", "naru"],
): Promise<void> {
  if (services.includes("host")) {
    await replaceAndStart(runtime, layout, "host");
    await runtime.waitForUdsReady(layout.sockets.host, "/readyz");
  } else {
    await runtime.waitForUdsReady(layout.sockets.host, "/readyz");
  }

  if (services.includes("gateway")) await replaceAndStart(runtime, layout, "gateway");
  await runtime.waitForUdsReady(layout.sockets.gatewayAdmin, "/readyz");
  writeVerifierKeys(await runtime.readGatewayVerifierKeys(layout.sockets.gatewayAdmin));

  if (services.includes("naru")) await replaceAndStart(runtime, layout, "naru");
  await runtime.waitForHttpReady(layout.loopback.naruOrigin, "/readyz");
}

export async function stopRuntimeTopology(
  runtime: WorkstationRuntimeController,
  layout: WorkstationInstanceLayout,
  services: readonly ServiceName[] = ["naru", "gateway", "host"],
): Promise<void> {
  for (const service of services) {
    if (service === "maintenance") continue;
    await stopConfirmed(runtime, layout.uid, layout.labels[service]);
  }
}

export function handoffMaintenanceRequest(
  runtime: WorkstationRuntimeController,
  layout: WorkstationInstanceLayout,
): void {
  const state = runtime.serviceState(layout.uid, layout.labels.maintenance);
  if (state === "unknown") {
    throw new Error("Maintenance launchd state is unknown; refusing handoff.");
  }
  if (state !== "unloaded") runtime.bootout(layout.uid, layout.labels.maintenance);
  runtime.bootstrap(layout.uid, layout.launchAgentFiles.maintenance);
  runtime.kickstart(layout.uid, layout.labels.maintenance);
}

export function parseVerifierKeys(value: unknown): GatewayVerifierKeySetV1 {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.keys)) {
    throw new Error("Gateway verifier-key response is invalid.");
  }
  if (value.keys.length === 0 || value.keys.length > 2) {
    throw new Error("Gateway verifier-key response must contain current/previous keys only.");
  }
  const keys = value.keys.map((key) => {
    if (
      !isRecord(key) ||
      typeof key.keyId !== "string" ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(key.keyId) ||
      key.algorithm !== "Ed25519" ||
      typeof key.publicKeyPem !== "string" ||
      !key.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----\n") ||
      !key.publicKeyPem.endsWith("-----END PUBLIC KEY-----\n") ||
      key.publicKeyPem.includes("PRIVATE")
    ) {
      throw new Error("Gateway verifier key contains invalid or private material.");
    }
    return {
      keyId: key.keyId,
      algorithm: "Ed25519" as const,
      publicKeyPem: key.publicKeyPem,
    };
  });
  if (new Set(keys.map((key) => key.keyId)).size !== keys.length) {
    throw new Error("Gateway verifier key IDs must be unique.");
  }
  return { version: 1, keys };
}

async function replaceAndStart(
  runtime: WorkstationRuntimeController,
  layout: WorkstationInstanceLayout,
  service: "host" | "gateway" | "naru",
): Promise<void> {
  const state = runtime.serviceState(layout.uid, layout.labels[service]);
  if (state === "unknown") throw new Error(`launchd state is unknown for ${service}.`);
  if (state !== "unloaded") await stopConfirmed(runtime, layout.uid, layout.labels[service]);
  runtime.bootstrap(layout.uid, layout.launchAgentFiles[service]);
}

function inspectLaunchctlService(
  uid: number,
  label: string,
): { readonly state: ServiceRuntimeState; readonly pid?: number } {
  const result = runLaunchctl(["print", serviceTarget(uid, label)], true);
  if (result.status === 0) {
    const pidMatch = /\bpid\s*=\s*(\d+)\b/.exec(result.stdout);
    const pid = pidMatch?.[1] === undefined ? undefined : Number.parseInt(pidMatch[1], 10);
    return {
      state: /\bstate\s*=\s*running\b/.test(result.stdout) ? "running" : "loaded",
      ...(pid === undefined || pid < 1 ? {} : { pid }),
    };
  }
  return { state: isServiceNotFound(result.stderr) ? "unloaded" : "unknown" };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  }
}

function runLaunchctl(arguments_: readonly string[], tolerateFailure = false) {
  const result = spawnSync("/bin/launchctl", [...arguments_], {
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: COMMAND_MAX_BUFFER,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  if (result.error !== undefined && !tolerateFailure) {
    throw new Error("launchctl could not be executed.");
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function serviceTarget(uid: number, label: string): string {
  return `gui/${uid}/${label}`;
}

function isServiceNotFound(stderr: string): boolean {
  return /could not find service|no such process|service not found/i.test(stderr);
}

function launchctlFailure(operation: string, stderr: string): Error {
  const detail = stderr.replace(/\s+/g, " ").trim().slice(0, 400);
  return new Error(`launchctl ${operation} failed${detail === "" ? "." : `: ${detail}`}`);
}

async function waitForReady(
  probe: () => Promise<{ readonly statusCode: number; readonly value: unknown }>,
): Promise<void> {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  let lastStatus: number | undefined;
  while (Date.now() < deadline) {
    try {
      const response = await probe();
      lastStatus = response.statusCode;
      if (response.statusCode === 200) return;
    } catch {
      // A service can refuse the connection while launchd is starting it.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, READINESS_INTERVAL_MS));
  }
  throw new Error(
    `Service readiness timed out${lastStatus === undefined ? "." : ` at HTTP ${lastStatus}.`}`,
  );
}

function requestJson(input: {
  readonly socketPath?: string;
  readonly origin?: string;
  readonly path: string;
}): Promise<{ readonly statusCode: number; readonly value: unknown }> {
  return new Promise((resolvePromise, reject) => {
    const handleResponse = (response: IncomingMessage): void => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > 256 * 1024) {
          request.destroy(new Error("Runtime JSON response exceeded its size limit."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const source = Buffer.concat(chunks).toString("utf8");
          resolvePromise({
            statusCode: response.statusCode ?? 0,
            value: source === "" ? null : (JSON.parse(source) as unknown),
          });
        } catch (error) {
          reject(error instanceof Error ? error : new Error("Runtime response is invalid."));
        }
      });
    };
    const request: ClientRequest =
      input.socketPath === undefined
        ? httpRequest(
            new URL(input.path, input.origin),
            { method: "GET", headers: { accept: "application/json" } },
            handleResponse,
          )
        : httpRequest(
            {
              socketPath: input.socketPath,
              path: input.path,
              method: "GET",
              headers: { accept: "application/json" },
            },
            handleResponse,
          );
    request.setTimeout(2_000, () => request.destroy(new Error("Runtime probe timed out.")));
    request.once("error", reject);
    request.end();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
