import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkstationGatewayConfigSchema } from "../../../apps/workstation-gateway/src/config.js";
import { verifyDistributionArtifact } from "./artifact.js";
import { createInstanceConfiguration } from "./configuration.js";
import { doctorDistribution } from "./doctor.js";
import { createInstanceLayout, parseInstallationIntent } from "./model.js";
import { inspectPrivateIngressPreflight } from "./private-ingress-preflight.js";
import { redactDistributionPlan, redactDoctorReport, redactPublicError } from "./redaction.js";
import { statusDistribution } from "./status.js";
import {
  createDistributionFixture,
  createPrivateIngressDistributionFixture,
  FakeWorkstationRuntime,
} from "./test-support.js";
import {
  executeMaintenanceRequest,
  planDistribution,
  readCurrentReceipt,
  stageMaintenanceHandoff,
} from "./transaction.js";

describe("PI-05 private ingress distribution", () => {
  it("binds strict private intent, artifact/config identity and external state into the plan", async () => {
    const fixture = createPrivateIngressDistributionFixture();
    const runtime = new FakeWorkstationRuntime();
    const plan = await planDistribution(fixture.intent, "install", runtime, {
      probeListenerTargets: fixture.privateIngressListenerProbe,
      privateIngressPreflight: fixture.privateIngressPreflight,
    });
    const artifact = verifyDistributionArtifact(fixture.artifactRoot);
    const configuration = createInstanceConfiguration(
      fixture.intent,
      artifact.summary,
      createInstanceLayout(fixture.intent, artifact.summary),
    );

    expect(() => WorkstationGatewayConfigSchema.parse(configuration.gateway)).not.toThrow();
    expect(plan).toMatchObject({
      version: 2,
      taskId: "private-ingress-v0/PI-05",
      sourceTransition: {
        mutation: "none",
        requiresSeparateOperatorApproval: true,
        exactTarget: { sourceCommit: "a".repeat(40) },
      },
    });
    expect(plan.privateIngressIntentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.checks.find((check) => check.id === "private-ingress.private-dns")).toMatchObject({
      status: "ok",
    });
    expect(plan.checks.find((check) => check.id === "private-ingress.tls-material")).toMatchObject({
      status: "ok",
    });

    const publicPlan = JSON.stringify(redactDistributionPlan(plan));
    expect(publicPlan).not.toContain(fixture.intent.canonicalBrowserOrigin);
    expect(publicPlan).not.toContain(fixture.intent.ingress.listener.host);
    expect(publicPlan).not.toContain(fixture.intent.ingress.tls.approvedRoot);
    expect(publicPlan).not.toContain(fixture.intent.ingress.tls.certificateFile);
  });

  it("blocks missing private DNS and invalid TLS without mutating operator-owned state", async () => {
    const fixture = createPrivateIngressDistributionFixture();
    const dnsBlocked = await inspectPrivateIngressPreflight(fixture.intent, {
      ...fixture.privateIngressPreflight,
      resolveHostname: () => Promise.resolve([{ address: "203.0.113.10", family: 4 }]),
    });
    expect(
      dnsBlocked.checks.find((check) => check.id === "private-ingress.private-dns"),
    ).toMatchObject({
      status: "blocked",
    });

    const wrongTls = fixture.tlsState.createGeneration(
      "generation-wrong-host",
      "wrong.fixture.test",
    );
    const invalidIntent = parseInstallationIntent({
      ...fixture.intent,
      ingress: {
        ...fixture.intent.ingress,
        tls: {
          ...fixture.intent.ingress.tls,
          certificateFile: wrongTls.certificateFile,
          privateKeyFile: wrongTls.privateKeyFile,
        },
      },
    });
    if (invalidIntent.version !== 2) throw new Error("Expected private ingress intent.");
    const tlsBlocked = await inspectPrivateIngressPreflight(invalidIntent, {
      ...fixture.privateIngressPreflight,
    });
    expect(
      tlsBlocked.checks.find((check) => check.id === "private-ingress.tls-material"),
    ).toMatchObject({
      status: "blocked",
    });
  });

  it("redacts private topology from public CLI errors", () => {
    const publicError = redactPublicError(
      new Error(
        "Failed https://private.fixture.test:8443 for 10.42.0.2 at '/private/tmp/private-tls/cert.pem'.",
      ),
    );
    expect(publicError).not.toContain("private.fixture.test");
    expect(publicError).not.toContain("10.42.0.2");
    expect(publicError).not.toContain("/private/tmp/private-tls/cert.pem");
  });

  it("blocks an occupied exact listener before maintenance handoff", async () => {
    const fixture = createPrivateIngressDistributionFixture();
    const plan = await planDistribution(fixture.intent, "install", new FakeWorkstationRuntime(), {
      privateIngressPreflight: fixture.privateIngressPreflight,
      probeListenerTargets: () => Promise.resolve({ available: false, detail: "fixture conflict" }),
    });
    expect(plan.status).toBe("blocked");
    expect(
      plan.checks.find((check) => check.id === "private-ingress.listener-allocation"),
    ).toMatchObject({ status: "blocked", actual: "an exact listener target is unavailable" });
  });

  it("rejects a stale approval after TLS material changes", async () => {
    const fixture = createPrivateIngressDistributionFixture();
    const runtime = new FakeWorkstationRuntime();
    const plan = await planDistribution(fixture.intent, "install", runtime, {
      probeListenerTargets: fixture.privateIngressListenerProbe,
      privateIngressPreflight: fixture.privateIngressPreflight,
    });
    const next = fixture.tlsState.createGeneration("generation-b");
    copyFileSync(next.privateKeyFile, fixture.intent.ingress.tls.privateKeyFile);
    copyFileSync(next.certificateFile, fixture.intent.ingress.tls.certificateFile);

    const result = await executeMaintenanceRequest(
      stageMaintenanceHandoff(plan, plan.planDigest, runtime),
      runtime,
      {
        inspectNative: () => [],
        privateIngressPreflight: fixture.privateIngressPreflight,
        probeListenerTargets: fixture.privateIngressListenerProbe,
      },
    );
    expect(result).toMatchObject({ status: "failed", stage: "failed" });
    expect(readCurrentReceipt(plan.layout)).toBeUndefined();
  });

  it("installs through maintenance and reports redacted status and doctor results", async () => {
    const fixture = createPrivateIngressDistributionFixture();
    const runtime = new FakeWorkstationRuntime();
    const plan = await planDistribution(fixture.intent, "install", runtime, {
      probeListenerTargets: fixture.privateIngressListenerProbe,
      privateIngressPreflight: fixture.privateIngressPreflight,
    });
    const result = await executeMaintenanceRequest(
      stageMaintenanceHandoff(plan, plan.planDigest, runtime),
      runtime,
      {
        inspectNative: () => [],
        privateIngressPreflight: fixture.privateIngressPreflight,
        probeListenerTargets: fixture.privateIngressListenerProbe,
      },
    );
    expect(result.status).toBe("completed");
    expect(readCurrentReceipt(plan.layout)).toMatchObject({
      version: 2,
      taskId: "private-ingress-v0/PI-05",
      sourceCommit: "a".repeat(40),
      privateIngressIntentDigest: plan.privateIngressIntentDigest,
    });

    const status = await statusDistribution(fixture.intent, runtime);
    expect(status).toMatchObject({ status: "healthy", ingress: { kind: "direct-private-tls" } });
    const statusSource = JSON.stringify(status);
    expect(statusSource).not.toContain(fixture.intent.canonicalBrowserOrigin);
    expect(statusSource).not.toContain(fixture.intent.ingress.listener.host);
    const statusWithoutTransport = await statusDistribution(
      parseInstallationIntent({
        ...fixture.intent,
        artifactRoot: join(fixture.root, "source-transport-no-longer-present"),
      }),
      runtime,
    );
    expect(statusWithoutTransport.status).toBe("healthy");

    const doctor = await doctorDistribution(fixture.intent, runtime, {
      codexDoctorReport: {
        checks: {
          installation: { status: "ok" },
          "auth.credentials": { status: "ok" },
          "config.load": { status: "ok" },
        },
      },
      privateIngressPreflight: fixture.privateIngressPreflight,
      probePrivateIngressHttps: () => Promise.resolve({ status: "ready" }),
    });
    expect(doctor.status).toBe("healthy");
    const publicDoctor = JSON.stringify(redactDoctorReport(doctor));
    expect(publicDoctor).not.toContain(fixture.intent.canonicalBrowserOrigin);
    expect(publicDoctor).not.toContain(fixture.intent.ingress.listener.host);
    expect(publicDoctor).not.toContain(fixture.intent.ingress.tls.approvedRoot);
  });

  it("reports an external-client gate when the server address is not source-admitted", async () => {
    const fixture = createPrivateIngressDistributionFixture();
    const runtime = new FakeWorkstationRuntime();
    const plan = await planDistribution(fixture.intent, "install", runtime, {
      probeListenerTargets: fixture.privateIngressListenerProbe,
      privateIngressPreflight: fixture.privateIngressPreflight,
    });
    await executeMaintenanceRequest(
      stageMaintenanceHandoff(plan, plan.planDigest, runtime),
      runtime,
      {
        inspectNative: () => [],
        privateIngressPreflight: fixture.privateIngressPreflight,
        probeListenerTargets: fixture.privateIngressListenerProbe,
      },
    );
    const doctor = await doctorDistribution(fixture.intent, runtime, {
      codexDoctorReport: {
        checks: {
          installation: { status: "ok" },
          "auth.credentials": { status: "ok" },
          "config.load": { status: "ok" },
        },
      },
      privateIngressPreflight: fixture.privateIngressPreflight,
    });
    expect(doctor.status).toBe("degraded");
    expect(doctor.checks.find((check) => check.id === "private-ingress.https-chain")).toMatchObject(
      {
        status: "warning",
        owner: "browser",
      },
    );
  });

  it("reconfigures a legacy receipt to v2 and rolls back without rewriting the v1 contract", async () => {
    const legacy = createDistributionFixture();
    const runtime = new FakeWorkstationRuntime();
    const legacyPlan = await planDistribution(legacy.intent, "install", runtime, {
      probePorts: false,
    });
    await executeMaintenanceRequest(
      stageMaintenanceHandoff(legacyPlan, legacyPlan.planDigest, runtime),
      runtime,
      { inspectNative: () => [] },
    );
    const legacyReceipt = readCurrentReceipt(legacyPlan.layout);
    if (legacyReceipt === undefined) throw new Error("Legacy receipt is missing.");

    const privateFixture = createPrivateIngressDistributionFixture();
    const privateIntent = parseInstallationIntent({
      ...privateFixture.intent,
      installationId: legacy.intent.installationId,
      slug: legacy.intent.slug,
      targetUid: legacy.intent.targetUid,
      homeDirectory: legacy.intent.homeDirectory,
      artifactRoot: legacy.intent.artifactRoot,
      allowedProjectRoots: legacy.intent.allowedProjectRoots,
      nodeExecutable: legacy.intent.nodeExecutable,
      shellExecutable: legacy.intent.shellExecutable,
      codexExecutable: legacy.intent.codexExecutable,
    });
    if (privateIntent.version !== 2) throw new Error("Expected private ingress intent.");
    const reconfigure = await planDistribution(privateIntent, "reconfigure", runtime, {
      privateIngressPreflight: privateFixture.privateIngressPreflight,
      probeListenerTargets: privateFixture.privateIngressListenerProbe,
    });
    expect(
      reconfigure.checks.find((check) => check.id === "transaction.reconfigure"),
    ).toMatchObject({
      status: "ok",
    });
    await executeMaintenanceRequest(
      stageMaintenanceHandoff(reconfigure, reconfigure.planDigest, runtime),
      runtime,
      {
        inspectNative: () => [],
        privateIngressPreflight: privateFixture.privateIngressPreflight,
        probeListenerTargets: privateFixture.privateIngressListenerProbe,
      },
    );
    expect(readCurrentReceipt(reconfigure.layout)?.version).toBe(2);

    let rollbackProbeTargets: readonly { readonly host: string; readonly port: number }[] = [];
    const rollback = await planDistribution(privateIntent, "rollback", runtime, {
      targetReceiptId: legacyReceipt.receiptId,
      privateIngressPreflight: privateFixture.privateIngressPreflight,
      probeListenerTargets: (targets) => {
        rollbackProbeTargets = targets;
        return Promise.resolve({ available: true, detail: "fixture available" });
      },
    });
    expect(rollback).toMatchObject({ version: 1, taskId: "workstation-v0/T14" });
    expect(rollback.sourceTransition).toBeUndefined();
    expect(rollbackProbeTargets).toEqual([
      { host: "127.0.0.1", port: rollback.layout.ports.gateway },
    ]);
    await executeMaintenanceRequest(
      stageMaintenanceHandoff(rollback, rollback.planDigest, runtime),
      runtime,
      {
        inspectNative: () => [],
        privateIngressPreflight: privateFixture.privateIngressPreflight,
        probeListenerTargets: privateFixture.privateIngressListenerProbe,
      },
    );
    expect(readCurrentReceipt(legacyPlan.layout)).toMatchObject({
      version: 1,
      taskId: "workstation-v0/T14",
      operation: "rollback",
      intent: { version: 1 },
    });
    await expect(statusDistribution(privateIntent, runtime)).resolves.toMatchObject({
      version: 1,
      taskId: "workstation-v0/T14",
    });
  });
});
