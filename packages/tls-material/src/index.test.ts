import { X509Certificate } from "node:crypto";
import { chmodSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTestTlsState } from "../test/support.js";
import {
  LastKnownGoodTlsMaterialManager,
  TlsMaterialError,
  validateTlsMaterial,
  type TlsMaterialLifecycleEvent,
  type TlsMaterialSource,
  type ValidatedTlsMaterial,
} from "./index.js";

const serverName = "material.example.test";

describe("shared TLS material validation", () => {
  it("validates private canonical material, its SAN, lifetime, and matching key", () => {
    const state = createTestTlsState(serverName);
    const generation = state.createGeneration("valid");

    const material = validateTlsMaterial(reference(generation.directory));

    expect(material.fingerprint256).toBe(generation.fingerprint256);
    expect(material.privateKey.toString("utf8")).toContain("PRIVATE KEY");
    expect(material.certificateChain.toString("utf8")).toContain("CERTIFICATE");
    expect(material.revision).toMatch(/^[0-9a-f]{64}$/);
  });

  it("allows an in-root symlink reference but rejects a final target outside the approved root", () => {
    const state = createTestTlsState(serverName);
    const generation = state.createGeneration("inside");
    const certificateReference = join(state.stateDirectory, "certificate.pem");
    const privateKeyReference = join(state.stateDirectory, "private-key.pem");
    symlinkSync(generation.certificateFile, certificateReference);
    symlinkSync(generation.privateKeyFile, privateKeyReference);

    expect(
      validateTlsMaterial({
        approvedRoot: state.stateDirectory,
        certificateFile: certificateReference,
        privateKeyFile: privateKeyReference,
        serverNames: [serverName],
        allowSymlinkReferences: true,
      }).fingerprint256,
    ).toBe(generation.fingerprint256);
    expectTlsError(
      () =>
        validateTlsMaterial({
          approvedRoot: state.stateDirectory,
          certificateFile: certificateReference,
          privateKeyFile: privateKeyReference,
          serverNames: [serverName],
        }),
      "TLS_PRIVATE_KEY_INVALID",
    );

    const outside = createTestTlsState(serverName).createGeneration("outside");
    const outsideReference = join(state.stateDirectory, "outside-certificate.pem");
    symlinkSync(outside.certificateFile, outsideReference);
    expectTlsError(
      () =>
        validateTlsMaterial({
          approvedRoot: state.stateDirectory,
          certificateFile: outsideReference,
          privateKeyFile: privateKeyReference,
          serverNames: [serverName],
          allowSymlinkReferences: true,
        }),
      "TLS_CERTIFICATE_INVALID",
    );
  });

  it("rejects unsafe ownership, modes, hostname, key pair, and certificate time", () => {
    const modeState = createTestTlsState(serverName);
    const modeGeneration = modeState.createGeneration("mode");
    chmodSync(modeGeneration.certificateFile, 0o640);
    expectTlsError(
      () => validateTlsMaterial(reference(modeGeneration.directory)),
      "TLS_CERTIFICATE_INVALID",
    );

    const ownerState = createTestTlsState(serverName);
    const ownerGeneration = ownerState.createGeneration("owner");
    const currentUid = process.getuid?.();
    if (currentUid === undefined) throw new Error("TLS tests require a current uid.");
    expectTlsError(
      () =>
        validateTlsMaterial(reference(ownerGeneration.directory), {
          ownerUid: currentUid + 1,
        }),
      "TLS_APPROVED_ROOT_INVALID",
    );

    const hostnameState = createTestTlsState(serverName);
    const hostnameGeneration = hostnameState.createGeneration("hostname");
    expectTlsError(
      () =>
        validateTlsMaterial({
          ...reference(hostnameGeneration.directory),
          serverNames: ["other.example.test"],
        }),
      "TLS_CERTIFICATE_HOSTNAME_MISMATCH",
    );

    const keyState = createTestTlsState(serverName);
    const keyA = keyState.createGeneration("key-a");
    const keyB = keyState.createGeneration("key-b");
    expectTlsError(
      () =>
        validateTlsMaterial({
          approvedRoot: keyState.stateDirectory,
          certificateFile: keyA.certificateFile,
          privateKeyFile: keyB.privateKeyFile,
          serverNames: [serverName],
        }),
      "TLS_KEY_MISMATCH",
    );

    const timeState = createTestTlsState(serverName);
    const timeGeneration = timeState.createGeneration("time");
    const certificate = new X509Certificate(readFileSync(timeGeneration.certificateFile));
    expectTlsError(
      () =>
        validateTlsMaterial(reference(timeGeneration.directory), {
          now: Date.parse(certificate.validFrom) - 1,
        }),
      "TLS_CERTIFICATE_NOT_YET_VALID",
    );
    expectTlsError(
      () =>
        validateTlsMaterial(reference(timeGeneration.directory), {
          now: Date.parse(certificate.validTo),
        }),
      "TLS_CERTIFICATE_EXPIRED",
    );
  });
});

describe("shared last-known-good TLS lifecycle", () => {
  it("atomically applies a valid candidate and retains it after a rejected reload", () => {
    const state = createTestTlsState(serverName);
    const materialA = validateTlsMaterial(reference(state.createGeneration("a").directory));
    const materialB = validateTlsMaterial(reference(state.createGeneration("b").directory));
    let candidate: ValidatedTlsMaterial | Error = materialA;
    let trigger: (() => void) | undefined;
    const source: TlsMaterialSource = {
      load: () => {
        if (candidate instanceof Error) throw candidate;
        return candidate;
      },
      watch: (onChange) => {
        trigger = onChange;
        return { close: vi.fn() };
      },
    };
    const events: TlsMaterialLifecycleEvent[] = [];
    const contexts: unknown[] = [];
    const manager = new LastKnownGoodTlsMaterialManager(source, {
      eventSink: (event) => events.push(event),
    });

    manager.loadInitial();
    manager.start({ setSecureContext: (options: unknown) => contexts.push(options) });
    candidate = materialB;
    trigger?.();
    expect(contexts).toHaveLength(1);
    expect(manager.status()).toMatchObject({
      status: "ok",
      fingerprint256: materialB.fingerprint256,
      lastReload: "reloaded",
    });

    candidate = new TlsMaterialError("TLS_CERTIFICATE_INVALID");
    trigger?.();
    trigger?.();
    expect(contexts).toHaveLength(1);
    expect(manager.status()).toMatchObject({
      status: "ok",
      fingerprint256: materialB.fingerprint256,
      lastReload: "rejected",
      lastReloadErrorCode: "TLS_CERTIFICATE_INVALID",
    });
    expect(events.map((event) => event.event)).toEqual([
      "tls.material.reloaded",
      "tls.material.reload_rejected",
    ]);
  });

  it("marks an expired last-known-good context unavailable for new connections", () => {
    const state = createTestTlsState(serverName);
    const material = validateTlsMaterial(reference(state.createGeneration("expiry").directory));
    let now = Date.parse(material.expiresAt) - 1;
    const manager = new LastKnownGoodTlsMaterialManager(fixedSource(material), { now: () => now });
    manager.loadInitial();

    expect(manager.acceptsNewConnections()).toBe(true);
    now += 1;
    expect(manager.acceptsNewConnections()).toBe(false);
    expect(manager.status().status).toBe("failed");
  });
});

function reference(approvedRoot: string) {
  return {
    approvedRoot,
    certificateFile: join(approvedRoot, "full-chain.pem"),
    privateKeyFile: join(approvedRoot, "private-key.pem"),
    serverNames: [serverName],
  };
}

function fixedSource(material: ValidatedTlsMaterial): TlsMaterialSource {
  return {
    load: () => material,
    watch: () => ({ close: () => undefined }),
  };
}

function expectTlsError(action: () => unknown, code: TlsMaterialError["code"]): void {
  expect(action).toThrow(expect.objectContaining({ name: "TlsMaterialError", code }));
}
