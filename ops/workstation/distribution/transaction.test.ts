import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { verifyDistributionArtifact } from "./artifact.js";
import { createInstanceLayout, parseInstallationIntent } from "./model.js";
import {
  executeMaintenanceRequest,
  planDistribution,
  readCurrentReceipt,
  stageMaintenanceHandoff,
} from "./transaction.js";
import {
  createArtifactFixture,
  createDistributionFixture,
  FakeWorkstationRuntime,
} from "./test-support.js";

describe("T14 deterministic maintenance transactions", () => {
  it("installs the packaged Node runtime and normalizes the receipt to its immutable release path", async () => {
    const fixture = createDistributionFixture({ packagedNodeRuntime: true });
    const runtime = new FakeWorkstationRuntime();
    const plan = await planDistribution(fixture.intent, "install", runtime, {
      probePorts: false,
    });

    expect(plan.checks.find((check) => check.id === "runtime.target-user-node24")).toMatchObject({
      status: "ok",
      actual: `artifact:${fixture.nodeExecutable}; codesign=strict`,
    });
    const request = stageMaintenanceHandoff(plan, plan.planDigest, runtime);
    const maintenancePlist = readFileSync(plan.layout.launchAgentFiles.maintenance, "utf8");
    expect(maintenancePlist).toContain(plan.layout.runtime.nodeExecutable);
    expect(maintenancePlist).not.toContain(fixture.artifactRoot);
    expect(request.intent.artifactRoot).toBe(plan.layout.releaseRoot);
    expect(request.intent.nodeExecutable).toBe(plan.layout.runtime.nodeExecutable);
    const result = await executeMaintenanceRequest(request, runtime, {
      inspectNative: () => [],
    });

    expect(result.status).toBe("completed");
    const receipt = readCurrentReceipt(plan.layout);
    expect(receipt?.intent.nodeExecutable).toBe(plan.layout.runtime.nodeExecutable);
    expect(receipt?.artifact.nodeRuntime?.nodeVersion).toBe("v24.20.0");
    for (const service of ["host", "gateway", "naru", "maintenance"] as const) {
      expect(readFileSync(plan.layout.launchAgentFiles[service], "utf8")).toContain(
        plan.layout.runtime.nodeExecutable,
      );
    }
  });

  it("stages a Documents artifact before launchd and preserves the approved digest", async () => {
    const fixture = createDistributionFixture({ packagedNodeRuntime: true });
    const protectedParent = join(fixture.home, "Documents", "Codex");
    mkdirSync(protectedParent, { recursive: true, mode: 0o700 });
    const sourceArtifactRoot = createArtifactFixture(protectedParent, "fixture-build-documents", {
      packagedNodeRuntime: true,
    });
    const sourceIntent = parseInstallationIntent({
      ...fixture.intent,
      artifactRoot: sourceArtifactRoot,
      nodeExecutable: join(sourceArtifactRoot, "runtime", "node", "bin", "node"),
    });
    const runtime = new FakeWorkstationRuntime();
    const plan = await planDistribution(sourceIntent, "install", runtime, { probePorts: false });
    expect(plan.actions.slice(0, 2).map((action) => action.id)).toEqual([
      "artifact.bootstrap-stage",
      "maintenance.handoff",
    ]);

    const changedOriginPlan = await planDistribution(
      parseInstallationIntent({
        ...sourceIntent,
        canonicalBrowserOrigin: "https://changed.fixture.test:8443",
      }),
      "install",
      runtime,
      { probePorts: false },
    );
    expect(changedOriginPlan.planDigest).not.toBe(plan.planDigest);

    const changedArtifactRoot = createArtifactFixture(
      protectedParent,
      "fixture-build-documents-v2",
      { packagedNodeRuntime: true },
    );
    const changedArtifactPlan = await planDistribution(
      parseInstallationIntent({
        ...sourceIntent,
        artifactRoot: changedArtifactRoot,
        nodeExecutable: join(changedArtifactRoot, "runtime", "node", "bin", "node"),
      }),
      "install",
      runtime,
      { probePorts: false },
    );
    expect(changedArtifactPlan.planDigest).not.toBe(plan.planDigest);

    const request = stageMaintenanceHandoff(plan, plan.planDigest, runtime);
    const maintenancePlist = readFileSync(plan.layout.launchAgentFiles.maintenance, "utf8");
    const requestJson = readFileSync(plan.layout.files.maintenanceRequest, "utf8");
    expect(maintenancePlist).not.toContain(sourceArtifactRoot);
    expect(requestJson).not.toContain(sourceArtifactRoot);
    expect(verifyDistributionArtifact(plan.layout.releaseRoot).summary.manifestDigest).toBe(
      plan.artifact.manifestDigest,
    );

    const workerPlan = await planDistribution(request.intent, "install", runtime, {
      probePorts: false,
    });
    expect(workerPlan.planDigest).toBe(plan.planDigest);
  });

  it("rejects source artifact tampering before maintenance is handed to launchd", async () => {
    const fixture = createDistributionFixture({ packagedNodeRuntime: true });
    const runtime = new FakeWorkstationRuntime();
    const plan = await planDistribution(fixture.intent, "install", runtime, {
      probePorts: false,
    });
    writeFileSync(join(fixture.artifactRoot, "web-base", "LICENSE"), "tampered\n");

    expect(() => stageMaintenanceHandoff(plan, plan.planDigest, runtime)).toThrow(
      /payload does not match/,
    );
    expect(existsSync(plan.layout.releaseRoot)).toBe(false);
    expect(existsSync(plan.layout.launchAgentFiles.maintenance)).toBe(false);
    expect(existsSync(plan.layout.files.maintenanceRequest)).toBe(false);
    expect(runtime.operations).toHaveLength(0);
  });

  it("creates a missing target-user LaunchAgents directory before maintenance handoff", async () => {
    const fixture = createDistributionFixture();
    const runtime = new FakeWorkstationRuntime();
    const plan = await planDistribution(fixture.intent, "install", runtime, {
      probePorts: false,
    });
    rmSync(plan.layout.directories.launchAgents, { recursive: true });

    stageMaintenanceHandoff(plan, plan.planDigest, runtime);

    const metadata = lstatSync(plan.layout.directories.launchAgents);
    expect(metadata.isDirectory()).toBe(true);
    expect(metadata.uid).toBe(plan.layout.uid);
    expect(metadata.mode & 0o777).toBe(0o700);
    expect(existsSync(plan.layout.launchAgentFiles.maintenance)).toBe(true);
  });

  it("plans, hands off and installs through the independent maintenance job", async () => {
    const fixture = createDistributionFixture();
    const runtime = new FakeWorkstationRuntime();
    const plan = await planDistribution(fixture.intent, "install", runtime, {
      probePorts: false,
    });

    expect(plan.status).toBe("needs-input");
    expect(plan.checks.find((check) => check.id === "transaction.install")?.status).toBe("ok");
    expect(plan.layout.labels.maintenance).toMatch(
      /^kr\.hurdoo\.naru\.workstation\..*\.maintenance$/,
    );
    expect(JSON.stringify(plan.actions)).not.toMatch(/pnpm|npm install|source build/);
    expect(JSON.stringify(plan)).not.toContain("/Users/example/projects/my-app");

    const request = stageMaintenanceHandoff(plan, plan.planDigest, runtime);
    expect(runtime.operations.at(-1)).toBe(`kickstart:${plan.layout.labels.maintenance}`);
    expect(readFileSync(plan.layout.files.maintenanceRequest, "utf8")).not.toContain(
      "NARU_VAPID_PRIVATE_KEY",
    );

    const result = await executeMaintenanceRequest(request, runtime, {
      now: () => new Date("2026-08-25T10:00:00.000Z"),
      inspectNative: () => [],
    });
    expect(result).toMatchObject({ status: "completed", operation: "install" });

    const receipt = readCurrentReceipt(plan.layout);
    expect(receipt).toMatchObject({
      sequence: 1,
      operation: "install",
      planDigest: plan.planDigest,
      artifact: { buildId: "fixture-build-0001" },
    });
    expect(receipt?.supersedesReceiptId).toBeUndefined();
    expect(runtime.operations).toContain(`kickstart:${plan.layout.labels.host}`);
    expect(runtime.operations).toContain(`kickstart:${plan.layout.labels.gateway}`);
    expect(runtime.operations).toContain(`kickstart:${plan.layout.labels.naru}`);

    const duplicate = await planDistribution(fixture.intent, "install", runtime, {
      probePorts: false,
    });
    expect(duplicate.status).toBe("blocked");
    expect(() => stageMaintenanceHandoff(duplicate, duplicate.planDigest, runtime)).toThrow(
      /Blocked/,
    );
  });

  it("upgrades to a verified new artifact while preserving approved settings", async () => {
    const fixture = createDistributionFixture();
    const runtime = new FakeWorkstationRuntime();
    const installPlan = await planDistribution(fixture.intent, "install", runtime, {
      probePorts: false,
    });
    await executeMaintenanceRequest(
      stageMaintenanceHandoff(installPlan, installPlan.planDigest, runtime),
      runtime,
      { inspectNative: () => [] },
    );
    const first = readCurrentReceipt(installPlan.layout);
    if (first === undefined) throw new Error("Fixture install receipt is missing.");
    const firstNaruCredential = readFileSync(installPlan.layout.files.hostCredential, "utf8");
    const firstCliCredential = readFileSync(
      installPlan.layout.files.localSessionCliCredential,
      "utf8",
    );
    expect(firstCliCredential).not.toBe(firstNaruCredential);

    const upgradeIntent = parseInstallationIntent({
      ...fixture.intent,
      artifactRoot: createArtifactFixture(fixture.root, "fixture-build-0002"),
    });
    const plan = await planDistribution(upgradeIntent, "upgrade", runtime, {
      probePorts: false,
    });
    expect(plan.checks.find((check) => check.id === "transaction.upgrade")?.status).toBe("ok");
    const result = await executeMaintenanceRequest(
      stageMaintenanceHandoff(plan, plan.planDigest, runtime),
      runtime,
      { inspectNative: () => [] },
    );

    expect(result.status).toBe("completed");
    expect(readCurrentReceipt(plan.layout)).toMatchObject({
      sequence: 2,
      operation: "upgrade",
      supersedesReceiptId: first.receiptId,
      artifact: { buildId: "fixture-build-0002" },
    });
    expect(readFileSync(plan.layout.files.hostCredential, "utf8")).toBe(firstNaruCredential);
    expect(readFileSync(plan.layout.files.localSessionCliCredential, "utf8")).toBe(
      firstCliCredential,
    );
  });

  it("reconciles a terminal pre-private-ingress v1 request before the next handoff", async () => {
    const fixture = createDistributionFixture();
    const runtime = new FakeWorkstationRuntime();
    const installPlan = await planDistribution(fixture.intent, "install", runtime, {
      probePorts: false,
    });
    const installRequest = stageMaintenanceHandoff(installPlan, installPlan.planDigest, runtime);
    await executeMaintenanceRequest(installRequest, runtime, { inspectNative: () => [] });

    const legacyRequest = JSON.parse(
      readFileSync(installPlan.layout.files.maintenanceRequest, "utf8"),
    ) as Record<string, unknown>;
    delete legacyRequest.listenerPreflight;
    writeFileSync(
      installPlan.layout.files.maintenanceRequest,
      `${JSON.stringify(legacyRequest)}\n`,
      { mode: 0o600 },
    );

    const upgradeIntent = parseInstallationIntent({
      ...fixture.intent,
      artifactRoot: createArtifactFixture(fixture.root, "fixture-build-legacy-request-upgrade"),
    });
    const plan = await planDistribution(upgradeIntent, "upgrade", runtime, {
      probePorts: false,
    });
    const request = stageMaintenanceHandoff(plan, plan.planDigest, runtime);

    expect(request.listenerPreflight).toBe("skipped-test");
    expect(JSON.parse(readFileSync(plan.layout.files.maintenanceRequest, "utf8"))).toMatchObject({
      requestId: request.requestId,
      listenerPreflight: "skipped-test",
    });
  });

  it("does not execute or replace an unterminated legacy v1 request", async () => {
    const fixture = createDistributionFixture();
    const runtime = new FakeWorkstationRuntime();
    const installPlan = await planDistribution(fixture.intent, "install", runtime, {
      probePorts: false,
    });
    const installRequest = stageMaintenanceHandoff(installPlan, installPlan.planDigest, runtime);
    await executeMaintenanceRequest(installRequest, runtime, { inspectNative: () => [] });

    const legacyRequest = JSON.parse(
      readFileSync(installPlan.layout.files.maintenanceRequest, "utf8"),
    ) as Record<string, unknown>;
    delete legacyRequest.listenerPreflight;
    writeFileSync(
      installPlan.layout.files.maintenanceRequest,
      `${JSON.stringify(legacyRequest)}\n`,
      { mode: 0o600 },
    );
    rmSync(installPlan.layout.files.maintenanceResult);

    const upgradeIntent = parseInstallationIntent({
      ...fixture.intent,
      artifactRoot: createArtifactFixture(fixture.root, "fixture-build-legacy-request-blocked"),
    });
    const plan = await planDistribution(upgradeIntent, "upgrade", runtime, {
      probePorts: false,
    });

    expect(() => stageMaintenanceHandoff(plan, plan.planDigest, runtime)).toThrow(
      /has no terminal result/,
    );
    await expect(
      executeMaintenanceRequest(legacyRequest as never, runtime, { inspectNative: () => [] }),
    ).rejects.toThrow(/Maintenance request metadata is invalid/);
  });

  it("upgrades packaged artifacts without treating their release-local Node paths as settings", async () => {
    const fixture = createDistributionFixture({ packagedNodeRuntime: true });
    const runtime = new FakeWorkstationRuntime();
    const installPlan = await planDistribution(fixture.intent, "install", runtime, {
      probePorts: false,
    });
    await executeMaintenanceRequest(
      stageMaintenanceHandoff(installPlan, installPlan.planDigest, runtime),
      runtime,
      { inspectNative: () => [] },
    );

    const artifactRoot = createArtifactFixture(fixture.root, "fixture-packaged-build-0002", {
      packagedNodeRuntime: true,
    });
    const plan = await planDistribution(
      parseInstallationIntent({
        ...fixture.intent,
        artifactRoot,
        nodeExecutable: join(artifactRoot, "runtime", "node", "bin", "node"),
      }),
      "upgrade",
      runtime,
      { probePorts: false },
    );

    const upgradeCheck = plan.checks.find((check) => check.id === "transaction.upgrade");
    expect(upgradeCheck).toMatchObject({ status: "ok" });
    expect(upgradeCheck?.actual).toContain("approved settings unchanged");
  });

  it("permits only a settings-preserving legacy external-to-packaged runtime upgrade", async () => {
    const fixture = createDistributionFixture({ localSessionCliFeature: false });
    const runtime = new FakeWorkstationRuntime();
    const installPlan = await planDistribution(fixture.intent, "install", runtime, {
      probePorts: false,
    });
    await executeMaintenanceRequest(
      stageMaintenanceHandoff(installPlan, installPlan.planDigest, runtime),
      runtime,
      { inspectNative: () => [] },
    );
    expect(existsSync(installPlan.layout.files.localSessionCliCredential)).toBe(false);

    const artifactRoot = createArtifactFixture(fixture.root, "fixture-packaged-migration", {
      packagedNodeRuntime: true,
    });
    const packagedIntent = parseInstallationIntent({
      ...fixture.intent,
      artifactRoot,
      nodeExecutable: join(artifactRoot, "runtime", "node", "bin", "node"),
    });
    const plan = await planDistribution(packagedIntent, "upgrade", runtime, {
      probePorts: false,
    });
    const migrationCheck = plan.checks.find((check) => check.id === "transaction.upgrade");
    expect(migrationCheck).toMatchObject({ status: "ok" });
    expect(migrationCheck?.actual).toContain("runtime external -> artifact");

    const changedSettingsPlan = await planDistribution(
      parseInstallationIntent({
        ...packagedIntent,
        canonicalBrowserOrigin: "https://changed.fixture.test:8443",
      }),
      "upgrade",
      runtime,
      { probePorts: false },
    );
    const blockedCheck = changedSettingsPlan.checks.find(
      (check) => check.id === "transaction.upgrade",
    );
    expect(blockedCheck).toMatchObject({ status: "blocked" });
    expect(blockedCheck?.actual).toContain("approved settings changed");

    const result = await executeMaintenanceRequest(
      stageMaintenanceHandoff(plan, plan.planDigest, runtime),
      runtime,
      { inspectNative: () => [] },
    );
    expect(result).toMatchObject({ status: "completed", buildId: "fixture-packaged-migration" });
    expect(readCurrentReceipt(plan.layout)).toMatchObject({
      sequence: 2,
      operation: "upgrade",
      artifact: {
        buildId: "fixture-packaged-migration",
        nodeRuntime: { nodeVersion: "v24.20.0" },
      },
      intent: { nodeExecutable: plan.layout.runtime.nodeExecutable },
    });
    expect(existsSync(plan.layout.files.localSessionCliCredential)).toBe(true);
  });

  it("reconfigures Origin with an immutable superseding receipt and preserved VAPID keypair", async () => {
    const fixture = createDistributionFixture();
    const runtime = new FakeWorkstationRuntime();
    const installPlan = await planDistribution(fixture.intent, "install", runtime, {
      probePorts: false,
    });
    const installRequest = stageMaintenanceHandoff(installPlan, installPlan.planDigest, runtime);
    await executeMaintenanceRequest(installRequest, runtime, { inspectNative: () => [] });
    const first = readCurrentReceipt(installPlan.layout);
    if (first === undefined) throw new Error("Fixture install receipt is missing.");
    const firstVapid = parseEnv(
      readFileSync(installPlan.layout.files.naruEnvironment, "utf8"),
    ).NARU_VAPID_PUBLIC_KEY;
    const operationStart = runtime.operations.length;

    const changedIntent = parseInstallationIntent({
      ...fixture.intent,
      canonicalBrowserOrigin: "https://naru.fixture.test:9443",
    });
    const plan = await planDistribution(changedIntent, "reconfigure", runtime, {
      probePorts: false,
    });
    expect(plan.originTransition).toMatchObject({
      changed: true,
      portChanged: true,
      hostnameChanged: false,
      passkeyBootstrapRequired: false,
      pushResubscribeRequired: true,
    });
    expect(plan.checks.find((check) => check.id === "transaction.reconfigure")?.status).toBe("ok");
    const request = stageMaintenanceHandoff(plan, plan.planDigest, runtime);
    const result = await executeMaintenanceRequest(request, runtime, { inspectNative: () => [] });
    expect(result.status).toBe("completed");

    const current = readCurrentReceipt(plan.layout);
    expect(current).toMatchObject({
      sequence: 2,
      operation: "reconfigure",
      supersedesReceiptId: first.receiptId,
      intent: { canonicalBrowserOrigin: "https://naru.fixture.test:9443" },
    });
    expect(
      parseEnv(readFileSync(plan.layout.files.naruEnvironment, "utf8")).NARU_VAPID_PUBLIC_KEY,
    ).toBe(firstVapid);
    expect(readdirSync(plan.layout.directories.receipts)).toHaveLength(2);
    const reconfigureOperations = runtime.operations.slice(operationStart);
    expect(reconfigureOperations).not.toContain(`bootout:${plan.layout.labels.host}`);
    expect(reconfigureOperations).toContain(`bootout:${plan.layout.labels.maintenance}`);
    expect(reconfigureOperations).toContain(`bootstrap:${plan.layout.labels.maintenance}`);
    expect(reconfigureOperations).toContain(`bootout:${plan.layout.labels.gateway}`);
    expect(reconfigureOperations).toContain(`bootout:${plan.layout.labels.naru}`);
  });

  it("cleans fresh runtime jobs and RunAtLoad plists after a readiness failure", async () => {
    const fixture = createDistributionFixture();
    const runtime = new FailingNaruRuntime();
    const plan = await planDistribution(fixture.intent, "install", runtime, {
      probePorts: false,
    });
    const result = await executeMaintenanceRequest(
      stageMaintenanceHandoff(plan, plan.planDigest, runtime),
      runtime,
      { inspectNative: () => [] },
    );

    expect(result).toMatchObject({
      status: "failed",
      recovery: "cleaned-fresh-install",
    });
    expect(readCurrentReceipt(plan.layout)).toBeUndefined();
    for (const service of ["host", "gateway", "naru"] as const) {
      expect(runtime.operations).toContain(`bootout:${plan.layout.labels[service]}`);
      expect(existsSync(plan.layout.launchAgentFiles[service])).toBe(false);
    }
  });

  it("restores the previous receipt configuration after a reconfigure readiness failure", async () => {
    const fixture = createDistributionFixture();
    const runtime = new RecoveringFailureRuntime();
    const installPlan = await planDistribution(fixture.intent, "install", runtime, {
      probePorts: false,
    });
    await executeMaintenanceRequest(
      stageMaintenanceHandoff(installPlan, installPlan.planDigest, runtime),
      runtime,
      { inspectNative: () => [] },
    );
    const first = readCurrentReceipt(installPlan.layout);
    if (first === undefined) throw new Error("Fixture install receipt is missing.");

    const changedIntent = parseInstallationIntent({
      ...fixture.intent,
      canonicalBrowserOrigin: "https://recovery.fixture.test:9443",
    });
    const plan = await planDistribution(changedIntent, "reconfigure", runtime, {
      probePorts: false,
    });
    runtime.failNextNaruReadiness();
    const result = await executeMaintenanceRequest(
      stageMaintenanceHandoff(plan, plan.planDigest, runtime),
      runtime,
      { inspectNative: () => [] },
    );

    expect(result).toMatchObject({ status: "failed", recovery: "restored-previous" });
    expect(readCurrentReceipt(plan.layout)?.receiptId).toBe(first.receiptId);
    expect(
      parseEnv(readFileSync(plan.layout.files.naruEnvironment, "utf8")).NARU_ALLOWED_ORIGINS,
    ).toBe(fixture.intent.canonicalBrowserOrigin);
  });

  it("rolls back by superseding current state with an earlier immutable receipt", async () => {
    const fixture = createDistributionFixture();
    const runtime = new FakeWorkstationRuntime();
    const installPlan = await planDistribution(fixture.intent, "install", runtime, {
      probePorts: false,
    });
    await executeMaintenanceRequest(
      stageMaintenanceHandoff(installPlan, installPlan.planDigest, runtime),
      runtime,
      { inspectNative: () => [] },
    );
    const first = readCurrentReceipt(installPlan.layout);
    if (first === undefined) throw new Error("Fixture install receipt is missing.");

    const changedIntent = parseInstallationIntent({
      ...fixture.intent,
      canonicalBrowserOrigin: "https://other.fixture.test:9443",
    });
    const reconfigurePlan = await planDistribution(changedIntent, "reconfigure", runtime, {
      probePorts: false,
    });
    await executeMaintenanceRequest(
      stageMaintenanceHandoff(reconfigurePlan, reconfigurePlan.planDigest, runtime),
      runtime,
      { inspectNative: () => [] },
    );
    const second = readCurrentReceipt(reconfigurePlan.layout);
    if (second === undefined) throw new Error("Fixture reconfigure receipt is missing.");

    const rollbackPlan = await planDistribution(changedIntent, "rollback", runtime, {
      targetReceiptId: first.receiptId,
      probePorts: false,
    });
    expect(rollbackPlan.targetIntent.canonicalBrowserOrigin).toBe(
      fixture.intent.canonicalBrowserOrigin,
    );
    expect(rollbackPlan.checks.find((check) => check.id === "transaction.rollback")?.status).toBe(
      "ok",
    );
    await executeMaintenanceRequest(
      stageMaintenanceHandoff(rollbackPlan, rollbackPlan.planDigest, runtime),
      runtime,
      { inspectNative: () => [] },
    );

    const artifact = verifyDistributionArtifact(fixture.artifactRoot);
    const originalLayout = createInstanceLayout(fixture.intent, artifact.summary);
    expect(readCurrentReceipt(originalLayout)).toMatchObject({
      sequence: 3,
      operation: "rollback",
      supersedesReceiptId: second.receiptId,
      intent: { canonicalBrowserOrigin: fixture.intent.canonicalBrowserOrigin },
    });
    expect(readdirSync(originalLayout.directories.receipts)).toHaveLength(3);
  });
});

class FailingNaruRuntime extends FakeWorkstationRuntime {
  override async waitForHttpReady(): Promise<void> {
    await Promise.resolve();
    throw new Error("fixture Naru readiness failure");
  }
}

class RecoveringFailureRuntime extends FakeWorkstationRuntime {
  #failNext = false;

  failNextNaruReadiness(): void {
    this.#failNext = true;
  }

  override async waitForHttpReady(): Promise<void> {
    await Promise.resolve();
    if (!this.#failNext) return;
    this.#failNext = false;
    throw new Error("fixture one-shot Naru readiness failure");
  }
}
