import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyDistributionArtifact } from "./artifact.js";
import { createInstanceLayout } from "./model.js";
import {
  ensureInstanceDirectories,
  evaluateCodexDoctor,
  inspectMacOsLaunchdExecutable,
  inspectManagedInstancePaths,
  inspectNode24,
  inspectPackagedNodeRuntime,
} from "./security.js";
import { createDistributionFixture } from "./test-support.js";

describe("T14 T02 security regressions", () => {
  it("requires exact target-owned Node 24", () => {
    const fixture = createDistributionFixture();
    expect(inspectNode24(fixture.nodeExecutable, process.getuid?.() ?? 501)).toMatchObject({
      major: 24,
      version: "v24.1.0",
    });
    expect(() => inspectNode24(fixture.nodeExecutable, 99_999)).toThrow(/target user/);
  });

  it("requires the packaged Node manifest's exact version and architecture", () => {
    const fixture = createDistributionFixture({ packagedNodeRuntime: true });
    const artifact = verifyDistributionArtifact(fixture.artifactRoot);
    const runtime = artifact.summary.nodeRuntime;
    if (runtime === undefined) throw new Error("Fixture packaged runtime is missing.");
    expect(
      inspectPackagedNodeRuntime(fixture.nodeExecutable, process.getuid?.() ?? 501, runtime),
    ).toMatchObject({ version: "v24.20.0" });

    writeFileSync(
      fixture.nodeExecutable,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo v24.19.0; exit 0; fi\nif [ "$1" = "--print" ]; then echo arm64; exit 0; fi\nexit 0\n',
    );
    chmodSync(fixture.nodeExecutable, 0o700);
    expect(() =>
      inspectPackagedNodeRuntime(fixture.nodeExecutable, process.getuid?.() ?? 501, runtime),
    ).toThrow(/SHA-256/);
  });

  it("allows exact packaged bytes only when the code-signature verifier control is unavailable", () => {
    const fixture = createDistributionFixture({ packagedNodeRuntime: true });
    const artifact = verifyDistributionArtifact(fixture.artifactRoot);
    const runtime = artifact.summary.nodeRuntime;
    if (runtime === undefined) throw new Error("Fixture packaged runtime is missing.");
    const signatureFailure = (): never => {
      throw new Error("fixture code-signature failure");
    };

    expect(
      inspectPackagedNodeRuntime(fixture.nodeExecutable, process.getuid?.() ?? 501, runtime, {
        inspectCodeSignature: signatureFailure,
        codeSignatureVerifierAvailable: () => false,
      }),
    ).toMatchObject({ codeSignatureValidation: "exact-hash-fallback" });
    expect(() =>
      inspectPackagedNodeRuntime(fixture.nodeExecutable, process.getuid?.() ?? 501, runtime, {
        inspectCodeSignature: signatureFailure,
        codeSignatureVerifierAvailable: () => true,
      }),
    ).toThrow(/fixture code-signature failure/);
  });

  it.runIf(process.platform === "darwin")(
    "rejects a Mach-O Node candidate with a damaged embedded signature",
    () => {
      const directory = mkdtempSync("/private/tmp/naru-t14-invalid-signature-");
      const valid = join(directory, "valid");
      const damaged = join(directory, "damaged");
      copyFileSync("/usr/bin/true", valid);
      copyFileSync(valid, damaged);
      const contents = readFileSync(damaged);
      const coveredIndex = Math.min(4096, contents.byteLength - 1);
      contents[coveredIndex] = (contents[coveredIndex] ?? 0) ^ 1;
      writeFileSync(damaged, contents);

      expect(() => inspectMacOsLaunchdExecutable(valid)).not.toThrow();
      expect(() => inspectMacOsLaunchdExecutable(damaged)).toThrow(/invalid macOS code signature/);
    },
  );

  it("blocks an existing 0755 package-managed ancestor instead of silently accepting it", () => {
    const fixture = createDistributionFixture();
    const artifact = verifyDistributionArtifact(fixture.artifactRoot);
    const layout = createInstanceLayout(fixture.intent, artifact.summary);
    const managedRoot = join(fixture.home, "Library", "Application Support", "Naru Workstation");
    mkdirSync(managedRoot, { mode: 0o755 });
    chmodSync(managedRoot, 0o755);

    expect(inspectManagedInstancePaths(layout, layout.uid)).toContainEqual({
      path: managedRoot,
      reason: "wrong-mode",
    });
    expect(() => ensureInstanceDirectories(layout, layout.uid)).toThrow(/exact mode 0700/);
  });

  it("blocks symlinked managed ancestors", () => {
    const fixture = createDistributionFixture();
    const artifact = verifyDistributionArtifact(fixture.artifactRoot);
    const layout = createInstanceLayout(fixture.intent, artifact.summary);
    const applicationSupport = join(fixture.home, "Library", "Application Support");
    symlinkSync(fixture.projectRoot, join(applicationSupport, "Naru Workstation"), "dir");

    expect(inspectManagedInstancePaths(layout, layout.uid)[0]?.reason).toBe("symlink");
    expect(() => ensureInstanceDirectories(layout, layout.uid)).toThrow(/symbolic link/);
  });

  it("ignores unrelated Codex doctor failures but gates installation/auth/config", () => {
    const assessment = evaluateCodexDoctor({
      status: "blocked",
      checks: {
        installation: { status: "ok" },
        "auth.credentials": { status: "ok" },
        "config.load": { status: "ok" },
        "network.optional": { status: "blocked" },
      },
    });
    expect(assessment.status).toBe("ok");
    expect(assessment.ignoredUnrelatedFailures).toEqual(["network.optional"]);

    expect(
      evaluateCodexDoctor({
        checks: {
          installation: { status: "ok" },
          "auth.credentials": { status: "blocked" },
          "config.load": { status: "ok" },
        },
      }).status,
    ).toBe("blocked");
  });
});
