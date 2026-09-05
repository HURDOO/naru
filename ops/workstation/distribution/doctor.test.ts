import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { doctorDistribution } from "./doctor.js";
import {
  executeMaintenanceRequest,
  planDistribution,
  stageMaintenanceHandoff,
} from "./transaction.js";
import { createDistributionFixture, FakeWorkstationRuntime } from "./test-support.js";

const CODEX_OK = {
  checks: {
    installation: { status: "ok" },
    "auth.credentials": { status: "ok" },
    "config.load": { status: "ok" },
  },
};

describe("T14 distribution doctor", () => {
  it("reports a fully installed private topology without exposing credentials", async () => {
    const fixture = createDistributionFixture();
    const runtime = new FakeWorkstationRuntime();
    const plan = await planDistribution(fixture.intent, "install", runtime, {
      probePorts: false,
    });
    await executeMaintenanceRequest(
      stageMaintenanceHandoff(plan, plan.planDigest, runtime),
      runtime,
      { inspectNative: () => [] },
    );

    const report = await doctorDistribution(fixture.intent, runtime, {
      codexDoctorReport: CODEX_OK,
    });
    expect(report.checks.filter((check) => check.status !== "ok")).toEqual([]);
    expect(report.status).toBe("healthy");
    expect(report.canonicalBrowserOrigin).toBe(fixture.intent.canonicalBrowserOrigin);
    expect(report.browserOwnedChecks).toHaveLength(4);
    expect(report.checks.find((check) => check.id === "runtime.local-session-cli")?.status).toBe(
      "ok",
    );
    expect(report.checks.find((check) => check.id === "credential.local-session-cli")?.status).toBe(
      "ok",
    );
    expect(JSON.stringify(report)).not.toMatch(/VAPID_PRIVATE|BEGIN PRIVATE|credential-file-value/);
  });

  it("fails closed when the rendered web Origin content drifts from its receipt", async () => {
    const fixture = createDistributionFixture();
    const runtime = new FakeWorkstationRuntime();
    const plan = await planDistribution(fixture.intent, "install", runtime, {
      probePorts: false,
    });
    await executeMaintenanceRequest(
      stageMaintenanceHandoff(plan, plan.planDigest, runtime),
      runtime,
      { inspectNative: () => [] },
    );
    const indexPath = `${plan.layout.webReleaseRoot}/index.html`;
    writeFileSync(
      indexPath,
      readFileSync(indexPath, "utf8").replace(
        fixture.intent.canonicalBrowserOrigin,
        "https://drift.fixture.test:8443",
      ),
    );

    const report = await doctorDistribution(fixture.intent, runtime, {
      codexDoctorReport: CODEX_OK,
    });
    expect(report.status).toBe("blocked");
    expect(report.checks.find((check) => check.id === "pwa.instance-web-release")?.status).toBe(
      "blocked",
    );
  });

  it("fails closed when the local CLI credential is replaced with Naru's credential", async () => {
    const fixture = createDistributionFixture();
    const runtime = new FakeWorkstationRuntime();
    const plan = await planDistribution(fixture.intent, "install", runtime, {
      probePorts: false,
    });
    await executeMaintenanceRequest(
      stageMaintenanceHandoff(plan, plan.planDigest, runtime),
      runtime,
      { inspectNative: () => [] },
    );
    writeFileSync(
      plan.layout.files.localSessionCliCredential,
      readFileSync(plan.layout.files.hostCredential, "utf8"),
    );

    const report = await doctorDistribution(fixture.intent, runtime, {
      codexDoctorReport: CODEX_OK,
    });
    expect(report.status).toBe("blocked");
    expect(
      report.checks.find((check) => check.id === "credential.local-session-cli"),
    ).toMatchObject({
      status: "blocked",
      actual: "Naru and local CLI credentials must be distinct.",
    });
  });
});
