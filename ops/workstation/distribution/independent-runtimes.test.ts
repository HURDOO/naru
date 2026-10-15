import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { doctorDistribution } from "./doctor.js";
import { parseInstallationIntent } from "./model.js";
import { statusDistribution } from "./status.js";
import {
  executeMaintenanceRequest,
  parseInstallationReceipt,
  planDistribution,
  readCurrentReceipt,
  stageMaintenanceHandoff,
  type DistributionPlan,
} from "./transaction.js";
import {
  createArtifactFixture,
  createDistributionFixture,
  FakeWorkstationRuntime,
} from "./test-support.js";
import type { GatewayVerifierKeySetV1 } from "./runtime.js";

const options = { probePorts: false };
const workerOptions = { inspectNative: () => [] };
const gatewayChange = {
  "components/gateway/dist/main.js": "export const gatewayChanged = true;\n",
};

async function installed(runtime = new FakeWorkstationRuntime()) {
  const fixture = createDistributionFixture({ packagedNodeRuntime: true });
  const plan = await planDistribution(fixture.intent, "install", runtime, options);
  expect(
    (
      await executeMaintenanceRequest(
        stageMaintenanceHandoff(plan, plan.planDigest, runtime),
        runtime,
        workerOptions,
      )
    ).status,
  ).toBe("completed");
  const receipt = readCurrentReceipt(plan.layout)!;
  return { fixture, runtime, plan, receipt };
}

function candidate(
  fixture: ReturnType<typeof createDistributionFixture>,
  buildId: string,
  fileOverrides: Readonly<Record<string, string>> = gatewayChange,
) {
  const artifactRoot = createArtifactFixture(fixture.root, buildId, {
    packagedNodeRuntime: true,
    fileOverrides,
  });
  return parseInstallationIntent({
    ...fixture.intent,
    artifactRoot,
    nodeExecutable: join(artifactRoot, "runtime/node/bin/node"),
  });
}

async function execute(plan: DistributionPlan, runtime: FakeWorkstationRuntime) {
  const request = stageMaintenanceHandoff(plan, plan.planDigest, runtime);
  const workerPlan = await planDistribution(request.intent, request.operation, runtime, {
    ...options,
    ...(request.targetReceiptId === undefined ? {} : { targetReceiptId: request.targetReceiptId }),
  });
  expect(workerPlan.planDigest).toBe(plan.planDigest);
  return executeMaintenanceRequest(request, runtime, workerOptions);
}

function preservedFiles(plan: DistributionPlan) {
  return [
    plan.layout.files.naruEnvironment,
    plan.layout.files.hostConfig,
    plan.layout.launchAgentFiles.host,
    plan.layout.launchAgentFiles.naru,
    plan.layout.files.gatewayVerifierKeys,
    join(plan.layout.webReleaseRoot, "workstation-web-release.json"),
  ];
}

function snapshot(files: readonly string[]) {
  return files.map((file) => ({
    bytes: readFileSync(file),
    inode: statSync(file).ino,
    mtime: statSync(file).mtimeMs,
  }));
}

function expectOnlyRestarted(
  plan: DistributionPlan,
  operations: readonly string[],
  services: readonly string[],
) {
  for (const service of ["host", "gateway", "naru"] as const) {
    if (services.includes(service))
      expect(operations).toContain(`bootstrap:${plan.layout.labels[service]}`);
    else {
      expect(operations).not.toContain(`bootout:${plan.layout.labels[service]}`);
      expect(operations).not.toContain(`bootstrap:${plan.layout.labels[service]}`);
    }
  }
}

describe("T73 independent Gateway and Naru deployment", () => {
  it("rejects a tampered deployment artifact even when every runtime remains on previous pins", async () => {
    const { fixture, runtime } = await installed();
    const intent = candidate(fixture, "fixture-cli-only-tamper", {
      "bin/workstation.mjs": "export const changedCli = true;\n",
    });
    const plan = await planDistribution(intent, "upgrade", runtime, options);
    expect((await execute(plan, runtime)).status).toBe("completed");
    const receipt = readCurrentReceipt(plan.layout)!;
    writeFileSync(join(receipt.artifact.root, "bin/workstation.mjs"), "tampered fixture CLI\n");
    const nextIntent = candidate(fixture, "fixture-after-cli-tamper");
    await expect(planDistribution(nextIntent, "upgrade", runtime, options)).rejects.toThrow(
      /manifest/,
    );
    expect((await statusDistribution(nextIntent, runtime)).status).toBe("degraded");
  });

  it("still restarts all runtimes for a shared packaged Node payload change", async () => {
    const { fixture, runtime } = await installed();
    const intent = candidate(fixture, "fixture-shared-node-change", {
      "runtime/node/LICENSE": "updated fixture Node license\n",
    });
    const plan = await planDistribution(intent, "upgrade", runtime, options);
    expect(plan.restartServices).toEqual(["host", "gateway", "naru"]);
    const before = runtime.operations.length;
    expect((await execute(plan, runtime)).status).toBe("completed");
    expectOnlyRestarted(plan, runtime.operations.slice(before), ["host", "gateway", "naru"]);
    expect((await doctorDistribution(intent, runtime)).status).toBe("healthy");
  });

  it("upgrades Gateway from a legacy receipt while preserving Naru/web/Host files and supports app reconfigure", async () => {
    const { fixture, runtime, plan: install, receipt: first } = await installed();
    const legacy = { ...first };
    delete legacy.runtimePinVersion;
    writeFileSync(install.layout.files.ownership, `${JSON.stringify(legacy)}\n`);
    const files = preservedFiles(install);
    const beforeFiles = snapshot(files);
    const intent = candidate(fixture, "fixture-independent-gateway");
    const plan = await planDistribution(intent, "upgrade", runtime, options);
    expect(plan.restartServices).toEqual(["gateway"]);
    expect(plan.actions.find((action) => action.id === "web.render")?.mutation).toBe("none");
    const before = runtime.operations.length;
    expect((await execute(plan, runtime)).status).toBe("completed");
    expectOnlyRestarted(plan, runtime.operations.slice(before), ["gateway"]);
    expect(snapshot(files)).toEqual(beforeFiles);
    const receipt = readCurrentReceipt(plan.layout)!;
    expect(receipt).toMatchObject({
      runtimePinVersion: 2,
      artifact: { buildId: "fixture-independent-gateway" },
      runtimeReleases: {
        host: { buildId: first.artifact.buildId },
        gateway: { buildId: "fixture-independent-gateway" },
        naru: { buildId: first.artifact.buildId },
      },
      webRelease: first.webRelease,
    });
    const instance = JSON.parse(readFileSync(plan.layout.files.instance, "utf8")) as {
      readonly runtimeServices: { readonly naru: { readonly buildId: string } };
    };
    expect(instance.runtimeServices.naru.buildId).toBe(first.artifact.buildId);
    expect((await statusDistribution(intent, runtime)).receipt?.runtimeBuilds.naru).toBe(
      first.artifact.buildId,
    );
    expect((await doctorDistribution(intent, runtime)).status).toBe("healthy");

    const reconfigureIntent = parseInstallationIntent({
      ...receipt.intent,
      additionalGatewayApps: [
        { appId: "fixture-app", routePrefix: "/fixture-app", upstreamPort: 45999 },
      ],
    });
    const reconfigure = await planDistribution(reconfigureIntent, "reconfigure", runtime, options);
    expect(reconfigure.restartServices).toEqual(["gateway"]);
    const reconfigureBefore = runtime.operations.length;
    expect((await execute(reconfigure, runtime)).status).toBe("completed");
    expectOnlyRestarted(reconfigure, runtime.operations.slice(reconfigureBefore), ["gateway"]);
    expect(snapshot(files)).toEqual(beforeFiles);
    expect((await doctorDistribution(reconfigureIntent, runtime)).status).toBe("healthy");
  });

  it("promotes only Naru after a mixed Gateway release when Naru code changes", async () => {
    const { fixture, runtime, receipt: first } = await installed();
    const gateway = await planDistribution(
      candidate(fixture, "fixture-gateway-mixed"),
      "upgrade",
      runtime,
      options,
    );
    expect((await execute(gateway, runtime)).status).toBe("completed");
    const intent = candidate(fixture, "fixture-naru-followup", {
      ...gatewayChange,
      "components/naru/dist/index.js": "export const naruChanged = true;\n",
    });
    const plan = await planDistribution(intent, "upgrade", runtime, options);
    expect(plan.restartServices).toEqual(["naru"]);
    expect(plan.runtimeReleases.gateway.buildId).toBe(gateway.artifact.buildId);
    expect(plan.runtimeReleases.host.buildId).toBe(first.artifact.buildId);
    const before = runtime.operations.length;
    expect((await execute(plan, runtime)).status).toBe("completed");
    expectOnlyRestarted(plan, runtime.operations.slice(before), ["naru"]);
    expect(readCurrentReceipt(plan.layout)?.webRelease.buildId).toBe(plan.artifact.buildId);
    expect((await doctorDistribution(intent, runtime)).status).toBe("healthy");
  });

  it.each([{}, { "bin/workstation.mjs": "export const cliChanged = true;\n" }])(
    "does not restart runtime services for an identical runtime payload or CLI-only change: %j",
    async (overrides) => {
      const { fixture, runtime, plan: install, receipt: first } = await installed();
      const files = preservedFiles(install);
      const beforeFiles = snapshot(files);
      const intent = candidate(fixture, "fixture-independent-noop", overrides);
      const plan = await planDistribution(intent, "upgrade", runtime, options);
      expect(plan.restartServices).toEqual([]);
      const before = runtime.operations.length;
      expect((await execute(plan, runtime)).status).toBe("completed");
      expectOnlyRestarted(plan, runtime.operations.slice(before), []);
      expect(snapshot(files)).toEqual(beforeFiles);
      expect((await statusDistribution(intent, runtime)).receipt?.runtimeBuilds).toEqual({
        host: first.artifact.buildId,
        gateway: first.artifact.buildId,
        naru: first.artifact.buildId,
      });
      expect((await doctorDistribution(intent, runtime)).status).toBe("healthy");
    },
  );

  it("rolls back only Gateway using the reviewed new maintenance worker, not the old target CLI", async () => {
    const { fixture, runtime, plan: install, receipt: first } = await installed();
    const files = preservedFiles(install);
    const beforeFiles = snapshot(files);
    const intent = candidate(fixture, "fixture-gateway-rollback");
    const gateway = await planDistribution(intent, "upgrade", runtime, options);
    expect((await execute(gateway, runtime)).status).toBe("completed");
    const rollback = await planDistribution(intent, "rollback", runtime, {
      ...options,
      targetReceiptId: first.receiptId,
    });
    expect(rollback.restartServices).toEqual(["gateway"]);
    expect(rollback.maintenanceArtifact.buildId).toBe(gateway.artifact.buildId);
    const before = runtime.operations.length;
    const request = stageMaintenanceHandoff(rollback, rollback.planDigest, runtime);
    expect(request.intent.artifactRoot).toBe(gateway.layout.releaseRoot);
    expect(readFileSync(rollback.layout.launchAgentFiles.maintenance, "utf8")).toContain(
      gateway.layout.releaseRoot,
    );
    const workerPlan = await planDistribution(request.intent, "rollback", runtime, {
      ...options,
      targetReceiptId: first.receiptId,
    });
    expect(workerPlan.planDigest).toBe(rollback.planDigest);
    expect((await executeMaintenanceRequest(request, runtime, workerOptions)).status).toBe(
      "completed",
    );
    expectOnlyRestarted(rollback, runtime.operations.slice(before), ["gateway"]);
    expect(snapshot(files)).toEqual(beforeFiles);
    expect((await doctorDistribution(intent, runtime)).status).toBe("healthy");
  });

  it("restores Gateway readiness failure without restarting retained services", async () => {
    class FailureRuntime extends FakeWorkstationRuntime {
      fail = false;
      override async waitForUdsReady(socket: string, path: "/readyz") {
        if (this.fail && socket.endsWith("gateway-admin.sock")) {
          this.fail = false;
          throw new Error("fixture Gateway readiness failure");
        }
        await super.waitForUdsReady(socket, path);
      }
    }
    const runtime = new FailureRuntime();
    const { fixture, plan: install, receipt: first } = await installed(runtime);
    const files = preservedFiles(install);
    const beforeFiles = snapshot(files);
    const plan = await planDistribution(
      candidate(fixture, "fixture-gateway-failure"),
      "upgrade",
      runtime,
      options,
    );
    runtime.fail = true;
    const before = runtime.operations.length;
    expect(await execute(plan, runtime)).toMatchObject({
      status: "failed",
      recovery: "restored-previous",
    });
    expectOnlyRestarted(plan, runtime.operations.slice(before), ["gateway"]);
    expect(readCurrentReceipt(plan.layout)?.receiptId).toBe(first.receiptId);
    expect(snapshot(files)).toEqual(beforeFiles);
  });

  it.each([false, true])(
    "rejects changed signing keys with retained Naru, persistent=%s",
    async (persistent) => {
      class KeyChangeRuntime extends FakeWorkstationRuntime {
        changed = false;
        override async readGatewayVerifierKeys(socket: string): Promise<GatewayVerifierKeySetV1> {
          const original = await super.readGatewayVerifierKeys(socket);
          if (!this.changed) return original;
          this.changed = persistent;
          return {
            ...original,
            keys: original.keys.map((key) => ({ ...key, keyId: "changed-fixture-key" })),
          };
        }
      }
      const runtime = new KeyChangeRuntime();
      const { fixture, plan: install, receipt: first } = await installed(runtime);
      const files = preservedFiles(install);
      const beforeFiles = snapshot(files);
      const plan = await planDistribution(
        candidate(fixture, "fixture-gateway-key-change"),
        "upgrade",
        runtime,
        options,
      );
      runtime.changed = true;
      const before = runtime.operations.length;
      expect(await execute(plan, runtime)).toMatchObject({
        status: "failed",
        recovery: persistent ? "manual-required" : "restored-previous",
      });
      expectOnlyRestarted(plan, runtime.operations.slice(before), ["gateway"]);
      expect(readCurrentReceipt(plan.layout)?.receiptId).toBe(first.receiptId);
      expect(snapshot(files)).toEqual(beforeFiles);
    },
  );

  it("rejects unversioned independent pins, unsupported pin versions and tampered retained web receipts", async () => {
    const { fixture, runtime, plan: install } = await installed();
    const intent = candidate(fixture, "fixture-gateway-versioned");
    const plan = await planDistribution(intent, "upgrade", runtime, options);
    expect((await execute(plan, runtime)).status).toBe("completed");
    const receipt = readCurrentReceipt(plan.layout)!;
    expect(() => parseInstallationReceipt({ ...receipt, runtimePinVersion: 3 })).toThrow(
      /unsupported/,
    );
    const unversioned = { ...receipt };
    delete unversioned.runtimePinVersion;
    writeFileSync(plan.layout.files.ownership, JSON.stringify(unversioned));
    expect((await statusDistribution(intent, runtime)).status).toBe("degraded");
    await expect(planDistribution(intent, "reconfigure", runtime, options)).rejects.toThrow(
      /Naru runtime release pin/,
    );
    writeFileSync(plan.layout.files.ownership, JSON.stringify(receipt));
    const altered = {
      ...receipt,
      webRelease: { ...receipt.webRelease, contentDigest: "0".repeat(64) },
    };
    writeFileSync(plan.layout.files.ownership, JSON.stringify(altered));
    expect((await statusDistribution(intent, runtime)).status).toBe("degraded");
    expect(
      (await doctorDistribution(intent, runtime)).checks.find(
        (check) => check.id === "pwa.instance-web-release",
      )?.status,
    ).toBe("blocked");
    await expect(planDistribution(intent, "upgrade", runtime, options)).rejects.toThrow(
      /web release/,
    );
    expect(readFileSync(join(install.layout.webReleaseRoot, "index.html"), "utf8")).toContain(
      "fixture.test",
    );
  });
});
