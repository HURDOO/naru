import { describe, expect, it } from "vitest";
import { parseEnv } from "node:util";
import { DurableSessionHostConfigSchema } from "../../../apps/durable-session-host/src/config.js";
import { verifyDistributionArtifact } from "./artifact.js";
import { createInstanceConfiguration, renderEnvironmentFile } from "./configuration.js";
import {
  createInstanceLayout,
  createInstanceNamespace,
  describeOriginTransition,
  parseInstallationIntent,
} from "./model.js";
import { createDistributionFixture } from "./test-support.js";

describe("T14 distribution identity and configuration", () => {
  it("derives a private namespace and four package-owned labels without user data", () => {
    const fixture = createDistributionFixture();
    const artifact = verifyDistributionArtifact(fixture.artifactRoot);
    const layout = createInstanceLayout(fixture.intent, artifact.summary);

    expect(createInstanceNamespace(fixture.intent)).toBe(layout.namespace);
    expect(layout.namespace).toMatch(/^w-u\d+-[a-f0-9]{12}$/);
    expect(layout.namespace).not.toContain("hurdoo");
    expect(layout.namespace).not.toContain("fixture.test");
    expect(Object.keys(layout.labels).sort()).toEqual(["gateway", "host", "maintenance", "naru"]);
    for (const label of Object.values(layout.labels)) {
      expect(label).toMatch(/^kr\.hurdoo\.naru\.workstation\./);
      expect(label).not.toBe("com.naru.agent");
      expect(label).not.toBe("com.naru.maintenance");
    }
    expect(Buffer.byteLength(layout.sockets.host)).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(layout.sockets.gatewayAdmin)).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(layout.sockets.naruIntegration)).toBeLessThanOrEqual(100);
  });

  it("generates three restartable runtime jobs and a non-persistent maintenance job", () => {
    const fixture = createDistributionFixture();
    const artifact = verifyDistributionArtifact(fixture.artifactRoot);
    const layout = createInstanceLayout(fixture.intent, artifact.summary);
    const generated = createInstanceConfiguration(fixture.intent, artifact.summary, layout);
    expect(() => DurableSessionHostConfigSchema.parse(generated.host)).not.toThrow();

    for (const service of ["host", "gateway", "naru"] as const) {
      expect(generated.launchAgents[service]).toContain("<key>RunAtLoad</key>");
      expect(generated.launchAgents[service]).toContain("<key>KeepAlive</key>");
      expect(generated.launchAgents[service]).toContain("<key>SuccessfulExit</key>");
      expect(generated.launchAgents[service]).toContain("<false/>");
    }
    expect(generated.launchAgents.maintenance).not.toContain("<key>RunAtLoad</key>");
    expect(generated.launchAgents.maintenance).not.toContain("<key>KeepAlive</key>");
    for (const plist of Object.values(generated.launchAgents)) {
      expect(plist).toContain(fixture.nodeExecutable);
      expect(plist).not.toContain("NARU_VAPID_PRIVATE_KEY");
      expect(plist).not.toContain("NARU_SESSION_SECRET");
      expect(plist).not.toContain("<key>PATH</key>");
      expect(plist).not.toContain("/opt/homebrew/bin:/");
    }
  });

  it("runs every launchd job from the managed immutable release Node", () => {
    const fixture = createDistributionFixture({ packagedNodeRuntime: true });
    const artifact = verifyDistributionArtifact(fixture.artifactRoot);
    const layout = createInstanceLayout(fixture.intent, artifact.summary);
    const generated = createInstanceConfiguration(fixture.intent, artifact.summary, layout);

    expect(layout.runtime).toEqual({
      nodeExecutable: `${layout.releaseRoot}/runtime/node/bin/node`,
      nodeSource: "artifact",
    });
    for (const plist of Object.values(generated.launchAgents)) {
      expect(plist).toContain(layout.runtime.nodeExecutable);
      expect(plist).not.toContain(fixture.nodeExecutable);
    }

    expect(generated.launchAgents.maintenance).toContain(layout.entrypoints.maintenance);
    expect(generated.launchAgents.maintenance).toContain(layout.releaseRoot);
  });

  it("drives Gateway, Naru, PWA, Push and RP identity from one canonical Origin", () => {
    const fixture = createDistributionFixture({ origin: "https://custom.tailnet.ts.net" });
    const artifact = verifyDistributionArtifact(fixture.artifactRoot);
    const layout = createInstanceLayout(fixture.intent, artifact.summary);
    const generated = createInstanceConfiguration(fixture.intent, artifact.summary, layout);

    expect(layout.browser).toMatchObject({
      origin: "https://custom.tailnet.ts.net",
      rpId: "custom.tailnet.ts.net",
      manifestId: "https://custom.tailnet.ts.net/",
      manifestStartUrl: "https://custom.tailnet.ts.net/?source=pwa",
      manifestScope: "https://custom.tailnet.ts.net/",
      vapidSubject: "https://custom.tailnet.ts.net",
    });
    expect(generated.gateway.browserOrigin).toBe(layout.browser.origin);
    expect(generated.naruEnvironment.NARU_ALLOWED_ORIGINS).toBe(layout.browser.origin);
    expect(generated.naruEnvironment.NARU_CODEX_INTEGRATION_SOCKET_PATH).toBe(
      layout.sockets.naruIntegration,
    );
    expect(generated.naruEnvironment.NARU_DURABLE_SESSION_PROFILE_IDS).toBe(
      '["shell","codex-main","codex-quick"]',
    );
    const registrations = generated.host.appRegistrations as readonly Record<string, unknown>[];
    expect(registrations).toHaveLength(2);
    expect(registrations.map((registration) => registration.appId)).toEqual([
      "naru",
      "local-session-cli",
    ]);
    expect(registrations[0]).toMatchObject({
      profileScope: {
        kind: "ids",
        ids: ["shell", "codex-main", "codex-quick"],
      },
    });
    expect(registrations[1]).toMatchObject({
      credentialFile: layout.files.localSessionCliCredential,
      capabilities: [
        "session:observe",
        "control:request",
        "control:preempt",
        "session:create:profile",
        "session:start",
        "session:stop",
        "profile:use",
      ],
      profileScope: { kind: "all" },
      rootScope: { kind: "all" },
    });
    expect(registrations[1]?.capabilities).not.toContain("session:create:arbitrary");
    expect(registrations[1]?.capabilities).not.toContain("session:forget");
    expect(generated.localSessionCli).toEqual({
      executable: layout.runtime.nodeExecutable,
      entrypoint: layout.entrypoints.sessionCli,
      socketPath: layout.sockets.host,
      appId: layout.localSessionCliAppId,
      credentialFile: layout.files.localSessionCliCredential,
      subject: layout.ownerSubject,
      callerTtlMs: 60_000,
    });
    expect(generated.instance.localSessionCli).toEqual(generated.localSessionCli);
    expect(JSON.stringify(generated)).not.toContain("/Users/example/projects/my-app");
  });

  it("models port and hostname replacement without accumulating an allowlist", () => {
    expect(
      describeOriginTransition("https://naru.example.test:8443", "https://naru.example.test:9443"),
    ).toMatchObject({
      changed: true,
      portChanged: true,
      hostnameChanged: false,
      pwaReinstallRequired: true,
      pushResubscribeRequired: true,
      passkeyBootstrapRequired: false,
      preserveVapidKeyPair: true,
      browserCleanupIsUserOwned: true,
    });
    expect(
      describeOriginTransition("https://naru.example.test:8443", "https://other.example.test:8443")
        .passkeyBootstrapRequired,
    ).toBe(true);
  });

  it("round-trips JSON and special characters through the private Node environment file", () => {
    const values = {
      NARU_DURABLE_SESSION_ROOTS: '{"root-a":"/private/tmp/path with space"}',
      NARU_HASH_VALUE: "value#fragment",
      NARU_APOSTROPHE_VALUE: "target-user's-path",
    };
    expect(parseEnv(renderEnvironmentFile(values))).toEqual(values);
  });

  it.each([
    "http://naru.example.test",
    "https://10.23.45.10:8443",
    "https://naru.example.test/path",
    "https://naru.example.test:8443/",
  ])("rejects unsafe or non-exact browser Origin %s", (origin) => {
    const fixture = createDistributionFixture();
    expect(() =>
      parseInstallationIntent({ ...fixture.intent, canonicalBrowserOrigin: origin }),
    ).toThrow(/Origin/);
  });
});
