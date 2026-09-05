import { chmodSync, existsSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NetworkManifestStore } from "../src/ingress/manifest-store.js";
import type { NetworkOwnershipManifest } from "../src/ingress/model.js";
import { createGatewayTestFixture } from "./support.js";

describe("network ownership manifest store", () => {
  it("keeps read-only missing-state inspection non-mutating", () => {
    const { root } = createGatewayTestFixture();
    const directory = join(root, "missing-ownership");
    const store = new NetworkManifestStore(directory, "fixture");
    expect(store.read("tailscale-main")).toBeUndefined();
    expect(existsSync(directory)).toBe(false);
  });

  it("writes private atomic receipts and preserves rolled-back history", () => {
    const { root } = createGatewayTestFixture();
    const directory = join(root, "ownership");
    const store = new NetworkManifestStore(directory, "fixture");
    const active = manifestFixture("active");
    store.write(active);
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(store.path("tailscale-main")).mode & 0o777).toBe(0o600);
    expect(store.read("tailscale-main")).toEqual(active);

    const rolledBack = {
      ...active,
      state: "rolled-back" as const,
      updatedAt: "2026-08-24T00:01:00.000Z",
    };
    store.write(rolledBack);
    expect(store.read("tailscale-main")).toEqual(rolledBack);
  });

  it("rejects symlinked ownership directories", () => {
    const { root } = createGatewayTestFixture();
    const target = join(root, "target");
    const linked = join(root, "linked");
    mkdirSync(target, { mode: 0o700 });
    chmodSync(target, 0o700);
    symlinkSync(target, linked);
    const store = new NetworkManifestStore(linked, "fixture");
    expect(() => store.write(manifestFixture("active"))).toThrow(/symbolic link/);
  });
});

function manifestFixture(state: NetworkOwnershipManifest["state"]): NetworkOwnershipManifest {
  return {
    schemaVersion: 1,
    taskId: "workstation-v0/T10",
    packageId: "@naru/workstation-gateway",
    instanceId: "fixture",
    profileId: "tailscale-main",
    planDigest: "a".repeat(64),
    applyStateFingerprint: "b".repeat(64),
    unrelatedStateFingerprint: "c".repeat(64),
    resource: {
      profileId: "tailscale-main",
      hostPort: "gateway.fixture.ts.net:443",
      httpsPort: 443,
      mountPath: "/",
      proxy: "http://127.0.0.1:49120",
    },
    state,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
}
