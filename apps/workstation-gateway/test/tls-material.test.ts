import { readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestTlsState } from "../../../packages/tls-material/test/support.js";
import { GatewayDirectTlsMaterialProvider } from "../src/listeners/tls-material.js";
import type { GatewayLogRecord } from "../src/logging.js";
import { createDirectGatewayTestFixture } from "./support.js";

const serverName = "gateway.fixture.invalid";

describe("Gateway direct TLS material provider", () => {
  it("reloads valid material, preserves last-known-good on rejection, and redacts logs", () => {
    const state = createTestTlsState(serverName);
    const generationA = state.createGeneration("direct-a");
    const generationB = state.createGeneration("direct-b");
    const certificateFile = join(state.stateDirectory, "current-certificate.pem");
    const privateKeyFile = join(state.stateDirectory, "current-private-key.pem");
    pointMaterial(certificateFile, privateKeyFile, generationA);
    const fixture = createDirectGatewayTestFixture({
      tls: {
        approvedRoot: state.stateDirectory,
        certificateFile,
        privateKeyFile,
        reload: "watch-last-known-good",
        materialOwner: "user",
        renewalOwner: "external",
        terminationOwner: "gateway",
      },
    });
    const logs: GatewayLogRecord[] = [];
    const contexts: unknown[] = [];
    const provider = new GatewayDirectTlsMaterialProvider(fixture.config.browserIngress, {
      logger: { write: (record) => logs.push(record) },
      reloadIntervalMs: 300_000,
    });

    provider.loadInitial(fixture.config.browserIngress);
    provider.start({ setSecureContext: (options: unknown) => contexts.push(options) });
    pointMaterial(certificateFile, privateKeyFile, generationB);
    expect(provider.reloadNow()).toBe("reloaded");
    expect(contexts).toHaveLength(1);
    expect(provider.status()).toMatchObject({
      status: "ok",
      fingerprint256: generationB.fingerprint256,
      lastReload: "reloaded",
    });

    pointMaterial(certificateFile, privateKeyFile, {
      certificateFile: generationA.certificateFile,
      privateKeyFile: generationB.privateKeyFile,
    });
    expect(provider.reloadNow()).toBe("rejected");
    expect(provider.reloadNow()).toBe("rejected");
    expect(contexts).toHaveLength(1);
    expect(provider.status()).toMatchObject({
      status: "ok",
      fingerprint256: generationB.fingerprint256,
      lastReload: "rejected",
      lastReloadErrorCode: "TLS_KEY_MISMATCH",
    });
    expect(logs).toEqual([
      { level: "info", event: "tls.material.reloaded" },
      {
        level: "warn",
        event: "tls.material.reload-rejected",
        code: "TLS_KEY_MISMATCH",
      },
    ]);
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(state.root);
    expect(serialized).not.toContain(serverName);
    expect(serialized).not.toContain(readFileSync(generationB.privateKeyFile, "utf8"));
    provider.stop();
  });

  it("fails readiness at last-known-good expiry and recovers after a valid rotation", () => {
    const state = createTestTlsState(serverName);
    const generationA = state.createGeneration("short", serverName, 2);
    const generationB = state.createGeneration("long", serverName, 10);
    const certificateFile = join(state.stateDirectory, "current-certificate.pem");
    const privateKeyFile = join(state.stateDirectory, "current-private-key.pem");
    pointMaterial(certificateFile, privateKeyFile, generationA);
    const fixture = createDirectGatewayTestFixture({
      tls: {
        approvedRoot: state.stateDirectory,
        certificateFile,
        privateKeyFile,
        reload: "watch-last-known-good",
        materialOwner: "user",
        renewalOwner: "external",
        terminationOwner: "gateway",
      },
    });
    let now = Date.now();
    const provider = new GatewayDirectTlsMaterialProvider(fixture.config.browserIngress, {
      now: () => now,
      reloadIntervalMs: 300_000,
    });
    provider.loadInitial(fixture.config.browserIngress);
    provider.start({ setSecureContext: () => undefined });

    now = Date.parse(provider.status().expiresAt ?? "");
    expect(provider.status().status).toBe("failed");
    expect(provider.acceptsNewConnections()).toBe(false);

    pointMaterial(certificateFile, privateKeyFile, generationB);
    expect(provider.reloadNow()).toBe("reloaded");
    expect(provider.status().status).toBe("ok");
    expect(provider.acceptsNewConnections()).toBe(true);
    provider.stop();
  });
});

function pointMaterial(
  certificateReference: string,
  privateKeyReference: string,
  material: { readonly certificateFile: string; readonly privateKeyFile: string },
): void {
  for (const reference of [certificateReference, privateKeyReference]) {
    try {
      unlinkSync(reference);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
  symlinkSync(material.certificateFile, certificateReference);
  symlinkSync(material.privateKeyFile, privateKeyReference);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
