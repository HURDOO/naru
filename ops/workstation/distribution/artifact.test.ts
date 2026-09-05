import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installVerifiedArtifact, verifyDistributionArtifact } from "./artifact.js";
import { createArtifactFixture } from "./test-support.js";

describe("T14 standalone artifact", () => {
  it("verifies a darwin-arm64 payload with packaged native modules", () => {
    const parent = mkdtempSync("/private/tmp/naru-t14-artifact-test-");
    const root = createArtifactFixture(parent, "artifact-test-0001");
    const verified = verifyDistributionArtifact(root);

    expect(verified.summary).toMatchObject({
      packageId: "kr.hurdoo.naru.workstation",
      buildId: "artifact-test-0001",
    });
    expect(verified.manifest.nodeMajor).toBe(24);
    expect(verified.manifest.platform).toBe("darwin");
    expect(verified.manifest.architecture).toBe("arm64");
    expect(verified.manifest.features).toEqual(["local-session-cli-v1"]);
    expect(verified.summary.features).toEqual(["local-session-cli-v1"]);
    expect(verified.manifest.files.map((file) => file.path)).toEqual(
      verified.manifest.files.map((file) => file.path).sort(),
    );
    expect(verified.manifest.files.some((file) => file.path.endsWith("pty.node"))).toBe(true);
    expect(
      verified.manifest.files.some((file) => file.path === "components/cli/dist/main.js"),
    ).toBe(true);
    expect(verified.manifest.files.some((file) => file.path === "bin/durable-session.mjs")).toBe(
      true,
    );
    expect(
      verified.manifest.files.some((file) => file.path.endsWith("spawn-helper") && file.executable),
    ).toBe(true);
    expect(verified.manifest.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]),
    );
  });

  it("binds the exact packaged Node release and required runtime files into the manifest", () => {
    const parent = mkdtempSync("/private/tmp/naru-t14-node-runtime-test-");
    const root = createArtifactFixture(parent, "artifact-node-0001", {
      packagedNodeRuntime: true,
    });
    const verified = verifyDistributionArtifact(root);

    expect(verified.summary.nodeRuntime).toMatchObject({
      nodeVersion: "v24.20.0",
      architecture: "arm64",
      executableRelativePath: "runtime/node/bin/node",
    });
    expect(verified.manifest.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "runtime/node/bin/node",
        "runtime/node/LICENSE",
        "runtime/node/source.json",
      ]),
    );
  });

  it("installs an immutable private release and accepts only the identical payload", () => {
    const parent = mkdtempSync("/private/tmp/naru-t14-artifact-install-");
    chmodSync(parent, 0o700);
    const source = createArtifactFixture(parent, "artifact-install-0001");
    const releases = join(parent, "releases");
    const target = join(releases, "artifact-install-0001");
    mkdirSync(releases, { mode: 0o700 });
    const verified = verifyDistributionArtifact(source);

    expect(installVerifiedArtifact(verified, target)).toBe("installed");
    expect(installVerifiedArtifact(verified, target)).toBe("already-installed");
    expect(verifyDistributionArtifact(target).summary.payloadDigest).toBe(
      verified.summary.payloadDigest,
    );
  });

  it("rejects payload tampering and symlinked package content", () => {
    const parent = mkdtempSync("/private/tmp/naru-t14-artifact-tamper-");
    const root = createArtifactFixture(parent, "artifact-tamper-0001");
    const entry = join(root, "components", "host", "dist", "main.js");
    writeFileSync(entry, `${readFileSync(entry, "utf8")}tampered\n`);
    expect(() => verifyDistributionArtifact(root)).toThrow(/does not match/);

    const symlinkRoot = createArtifactFixture(parent, "artifact-symlink-0001");
    symlinkSync("/private/tmp", join(symlinkRoot, "unexpected-link"));
    expect(() => verifyDistributionArtifact(symlinkRoot)).toThrow(/symbolic link/);
  });
});
