import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import type { TLSSocket } from "node:tls";
import { validateTlsMaterial } from "../../../packages/tls-material/src/index.js";
import type { WorkstationInstallationIntentV2 } from "./model.js";

export type PrivateIngressHttpsProbeResult =
  | { readonly status: "ready" }
  | { readonly status: "external-client-required" }
  | { readonly status: "failed" };

export async function probePrivateIngressHttps(
  intent: WorkstationInstallationIntentV2,
): Promise<PrivateIngressHttpsProbeResult> {
  const ingress = intent.ingress;
  if (!sourcePolicyAllows(ingress.listener.host, ingress.sourcePolicy)) {
    return { status: "external-client-required" };
  }
  try {
    const expectedMaterial = validateTlsMaterial(
      {
        approvedRoot: ingress.tls.approvedRoot,
        certificateFile: ingress.tls.certificateFile,
        privateKeyFile: ingress.tls.privateKeyFile,
        serverNames: [new URL(ingress.browserOrigin).hostname],
        allowSymlinkReferences: true,
      },
      { ownerUid: intent.targetUid },
    );
    const origin = new URL(ingress.browserOrigin);
    const response = await requestReady({
      host: ingress.listener.host,
      port: ingress.listener.port,
      servername: origin.hostname,
      hostHeader: origin.host,
      localAddress: ingress.listener.host,
    });
    const socket = response.socket as TLSSocket;
    const certificate = socket.getPeerCertificate();
    if (
      response.statusCode !== 200 ||
      certificate.fingerprint256 !== expectedMaterial.fingerprint256
    ) {
      response.resume();
      return { status: "failed" };
    }
    const body = await readBoundedBody(response);
    const value = JSON.parse(body) as unknown;
    if (
      typeof value !== "object" ||
      value === null ||
      !("status" in value) ||
      value.status !== "ready"
    ) {
      return { status: "failed" };
    }
    return { status: "ready" };
  } catch {
    return { status: "failed" };
  }
}

function requestReady(input: {
  readonly host: string;
  readonly port: number;
  readonly servername: string;
  readonly hostHeader: string;
  readonly localAddress: string;
}): Promise<IncomingMessage> {
  return new Promise((resolvePromise, reject) => {
    const request = httpsRequest(
      {
        host: input.host,
        port: input.port,
        servername: input.servername,
        localAddress: input.localAddress,
        path: "/_gateway/readyz",
        method: "GET",
        rejectUnauthorized: false,
        headers: { accept: "application/json", host: input.hostHeader },
      },
      resolvePromise,
    );
    request.setTimeout(3_000, () => request.destroy(new Error("Direct HTTPS probe timed out.")));
    request.once("error", reject);
    request.end();
  });
}

function readBoundedBody(response: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    response.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 64 * 1024) {
        response.destroy(new Error("Direct HTTPS response exceeded its limit."));
        return;
      }
      chunks.push(chunk);
    });
    response.once("error", reject);
    response.once("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
  });
}

function sourcePolicyAllows(
  address: string,
  policy: WorkstationInstallationIntentV2["ingress"]["sourcePolicy"],
): boolean {
  const numeric = ipv4Number(address);
  if (numeric === undefined) return false;
  if (policy.allowedAddresses.includes(address)) return true;
  return policy.allowedCidrs.some((cidr) => {
    const [networkSource, prefixSource] = cidr.split("/");
    const network = networkSource === undefined ? undefined : ipv4Number(networkSource);
    const prefix = Number(prefixSource);
    if (network === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
      return false;
    }
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (numeric & mask) >>> 0 === (network & mask) >>> 0;
  });
}

function ipv4Number(value: string): number | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  let output = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined;
    output = (output * 256 + octet) >>> 0;
  }
  return output;
}
