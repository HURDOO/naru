import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyDistributionArtifact } from "./artifact.js";
import { createInstanceLayout } from "./model.js";
import { createDistributionFixture } from "./test-support.js";
import { renderInstanceWebRelease, verifyInstanceWebRelease } from "./web-release.js";

describe("T14 instance PWA web release", () => {
  it("renders manifest, index metadata and worker revision from one custom Origin", () => {
    const fixture = createDistributionFixture({
      origin: "https://personal-workstation.tailnet.ts.net",
    });
    const artifact = verifyDistributionArtifact(fixture.artifactRoot);
    const layout = createInstanceLayout(fixture.intent, artifact.summary);
    const parent = mkdtempSync("/private/tmp/naru-t14-web-release-");
    const target = join(parent, "release");
    const baseManifest = readFileSync(
      join(fixture.artifactRoot, "web-base", "manifest.webmanifest"),
      "utf8",
    );

    const receipt = renderInstanceWebRelease({
      baseWebRoot: join(fixture.artifactRoot, "web-base"),
      targetWebRoot: target,
      buildId: artifact.summary.buildId,
      basePayloadDigest: artifact.summary.payloadDigest,
      browser: layout.browser,
    });

    expect(receipt.canonicalBrowserOrigin).toBe(layout.browser.origin);
    expect(receipt.rpId).toBe(layout.browser.rpId);
    expect(receipt.serviceWorkerRevision).not.toBe("abcdef1234567890abcd");
    expect(verifyInstanceWebRelease(target)).toEqual(receipt);
    const manifest = JSON.parse(
      readFileSync(join(target, "manifest.webmanifest"), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      id: `${layout.browser.origin}/`,
      start_url: `${layout.browser.origin}/?source=pwa`,
      scope: `${layout.browser.origin}/`,
    });
    expect(readFileSync(join(target, "index.html"), "utf8")).toContain(
      `content="${layout.browser.origin}"`,
    );
    expect(
      readFileSync(join(fixture.artifactRoot, "web-base", "manifest.webmanifest"), "utf8"),
    ).toBe(baseManifest);
  });

  it("refuses to overwrite an immutable web release with another Origin", () => {
    const fixture = createDistributionFixture();
    const artifact = verifyDistributionArtifact(fixture.artifactRoot);
    const layout = createInstanceLayout(fixture.intent, artifact.summary);
    const parent = mkdtempSync("/private/tmp/naru-t14-web-immutable-");
    const target = join(parent, "release");
    renderInstanceWebRelease({
      baseWebRoot: join(fixture.artifactRoot, "web-base"),
      targetWebRoot: target,
      buildId: artifact.summary.buildId,
      basePayloadDigest: artifact.summary.payloadDigest,
      browser: layout.browser,
    });
    const changed = createDistributionFixture({ origin: "https://other.fixture.test:9443" });
    const changedLayout = createInstanceLayout(changed.intent, artifact.summary);

    expect(() =>
      renderInstanceWebRelease({
        baseWebRoot: join(fixture.artifactRoot, "web-base"),
        targetWebRoot: target,
        buildId: artifact.summary.buildId,
        basePayloadDigest: artifact.summary.payloadDigest,
        browser: changedLayout.browser,
      }),
    ).toThrow(/different configuration/);
  });

  it("requires explicit canonical Origin metadata in the base web build", () => {
    const fixture = createDistributionFixture();
    const artifact = verifyDistributionArtifact(fixture.artifactRoot);
    const layout = createInstanceLayout(fixture.intent, artifact.summary);
    const parent = mkdtempSync("/private/tmp/naru-t14-web-missing-meta-");
    const target = join(parent, "release");
    const brokenBase = join(parent, "base");
    mkdirSync(brokenBase, { mode: 0o700 });
    expect(() =>
      renderInstanceWebRelease({
        baseWebRoot: brokenBase,
        targetWebRoot: target,
        buildId: artifact.summary.buildId,
        basePayloadDigest: artifact.summary.payloadDigest,
        browser: layout.browser,
      }),
    ).toThrow();
  });
});
