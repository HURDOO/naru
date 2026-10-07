import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEnv } from "node:util";
import { loadConfig } from "../../../apps/server/src/config.js";
import { DurableSessionHostConfigSchema } from "../../../apps/durable-session-host/src/config.js";
import { WorkstationGatewayConfigSchema } from "../../../apps/workstation-gateway/src/config.js";
import { verifyDistributionArtifact } from "./artifact.js";
import { createInstanceConfiguration, renderEnvironmentFile } from "./configuration.js";
import {
  createInstanceLayout,
  createInstanceNamespace,
  describeOriginTransition,
  parseInstallationIntent,
} from "./model.js";
import {
  createDistributionFixture,
  createPrivateIngressDistributionFixture,
} from "./test-support.js";

describe("T14 distribution identity and configuration", () => {
  it("renders opt-in exact roots without widening sibling Project admission", () => {
    const fixture = createDistributionFixture();
    const intent = parseInstallationIntent({
      ...fixture.intent,
      exactProjectRoots: [fixture.projectRoot],
    });
    const artifact = verifyDistributionArtifact(fixture.artifactRoot);
    const layout = createInstanceLayout(intent, artifact.summary);
    const generated = createInstanceConfiguration(intent, artifact.summary, layout);
    expect(generated.naruEnvironment.NARU_EXACT_PROJECT_ROOTS).toBe(
      JSON.stringify([fixture.projectRoot]),
    );
    expect(() =>
      parseInstallationIntent({
        ...fixture.intent,
        exactProjectRoots: [`${fixture.root}/sibling`],
      }),
    ).toThrow(/uniquely name allowed/);
    expect(() =>
      parseInstallationIntent({
        ...fixture.intent,
        exactProjectRoots: [fixture.projectRoot, fixture.projectRoot],
      }),
    ).toThrow(/uniquely name allowed/);
  });

  it("adds a Claude Host profile only when the intent names an executable", () => {
    const fixture = createDistributionFixture();
    const artifact = verifyDistributionArtifact(fixture.artifactRoot);
    const intent = parseInstallationIntent({
      ...fixture.intent,
      claudeExecutable: fixture.codexExecutable,
    });
    const layout = createInstanceLayout(intent, artifact.summary);
    const generated = createInstanceConfiguration(intent, artifact.summary, layout);
    const parsedHost = DurableSessionHostConfigSchema.parse(generated.host);
    expect(generated.naruEnvironment.NARU_DURABLE_SESSION_PROFILE_IDS).toContain("claude-code");
    expect(generated.naruEnvironment.NARU_CLAUDE_PATH).toBe(fixture.codexExecutable);
    expect(
      parsedHost.profiles.some(
        (profile) =>
          profile.profileId === "claude-code" &&
          profile.executable === layout.runtime.nodeExecutable &&
          profile.args[0] === layout.entrypoints.claudeIntegrationLauncher,
      ),
    ).toBe(true);
    expect(parsedHost.integrationPolicies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          policyRef: "naru-claude-v0",
          integrationKind: "claude",
          profileIds: ["claude-code"],
        }),
      ]),
    );
    expect(generated.gateway.appRegistrations).toHaveLength(1);
  });
  it("binds an isolated Claude app to another Gateway while retaining its own Host", () => {
    const fixture = createDistributionFixture();
    const binding = {
      instanceId: "primary-u501-123456789abc",
      appId: "claude-lab",
      ownerSubject: "owner-u501-123456789abc",
      verifierKeysFile: `${fixture.root}/primary-verifier.json`,
    };
    const intent = parseInstallationIntent({
      ...fixture.intent,
      naruAppBasePath: "/claude-lab",
      claudeExecutable: fixture.codexExecutable,
      defaultAgentPaneKind: "claude",
      externalGateway: binding,
    });
    const artifact = verifyDistributionArtifact(fixture.artifactRoot);
    const layout = createInstanceLayout(intent, artifact.summary);
    const generated = createInstanceConfiguration(intent, artifact.summary, layout);
    const { publicKey } = generateKeyPairSync("ed25519");
    writeFileSync(
      binding.verifierKeysFile,
      `${JSON.stringify({
        version: 1,
        keys: [
          {
            keyId: "fixture-key",
            algorithm: "Ed25519",
            publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
          },
        ],
      })}\n`,
      { mode: 0o600 },
    );
    const parsedNaru = loadConfig(generated.naruEnvironment, fixture.root);
    expect(parsedNaru.authMode).toBe("gateway-managed");
    expect(parsedNaru.sessionRuntime).toMatchObject({
      owner: "durable-host",
      appId: binding.appId,
      subject: binding.ownerSubject,
    });
    expect(generated.naruEnvironment).toMatchObject({
      NARU_GATEWAY_INSTANCE_ID: binding.instanceId,
      NARU_GATEWAY_APP_ID: binding.appId,
      NARU_GATEWAY_OWNER_SUBJECT: binding.ownerSubject,
      NARU_GATEWAY_VERIFIER_KEYS_FILE: binding.verifierKeysFile,
      NARU_DURABLE_SESSION_SOCKET_PATH: layout.sockets.host,
      NARU_DURABLE_SESSION_CREDENTIAL_FILE: layout.files.hostCredential,
      NARU_DURABLE_SESSION_APP_ID: binding.appId,
      NARU_DURABLE_SESSION_SUBJECT: binding.ownerSubject,
      NARU_DEFAULT_AGENT_PANE_KIND: "claude",
    });
    expect(generated.host.appRegistrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          appId: binding.appId,
          credentialFile: layout.files.hostCredential,
          subjectScope: { kind: "ids", ids: [binding.ownerSubject] },
        }),
      ]),
    );
    expect(generated.gateway.appRegistrations).toHaveLength(1);
    expect(() =>
      parseInstallationIntent({ ...intent, ingress: { kind: "trusted-lan", profileId: "lan" } }),
    ).toThrow();
    expect(() => parseInstallationIntent({ ...intent, version: 2 })).toThrow();
    expect(() => parseInstallationIntent({ ...intent, naruAppBasePath: "/" })).toThrow();
    expect(() => parseInstallationIntent({ ...intent, additionalGatewayApps: [] })).toThrow();
    expect(() =>
      parseInstallationIntent({ ...intent, externalGateway: { ...binding, extra: true } }),
    ).toThrow();
    for (const appId of ["naru", "local-session-cli", "Invalid ID"]) {
      expect(() =>
        parseInstallationIntent({ ...intent, externalGateway: { ...binding, appId } }),
      ).toThrow();
    }
    expect(() => parseInstallationIntent({ ...intent, claudeExecutable: undefined })).toThrow();
    const selfBound = parseInstallationIntent({
      ...intent,
      externalGateway: { ...binding, instanceId: layout.namespace },
    });
    expect(() => createInstanceLayout(selfBound, artifact.summary)).toThrow();
  });
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
      manifestId: "https://custom.tailnet.ts.net/naru/",
      manifestStartUrl: "https://custom.tailnet.ts.net/naru/?source=pwa",
      manifestScope: "https://custom.tailnet.ts.net/naru/",
      vapidSubject: "https://custom.tailnet.ts.net",
    });
    expect(generated.gateway.browserOrigin).toBe(layout.browser.origin);
    expect(generated.gateway.appRegistrations).toEqual([
      expect.objectContaining({ appId: "naru", routePrefix: "/naru" }),
    ]);
    expect(generated.naruEnvironment.NARU_ALLOWED_ORIGINS).toBe(layout.browser.origin);
    expect(generated.naruEnvironment.NARU_APP_BASE_PATH).toBe("/naru");
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

  it("renders direct private ingress only through versioned Gateway config v2", () => {
    const fixture = createPrivateIngressDistributionFixture();
    const artifact = verifyDistributionArtifact(fixture.artifactRoot);
    const layout = createInstanceLayout(fixture.intent, artifact.summary);
    const generated = createInstanceConfiguration(fixture.intent, artifact.summary, layout);

    expect(fixture.intent.version).toBe(2);
    expect(generated.gateway).toMatchObject({
      version: 2,
      browserOrigin: fixture.intent.ingress.browserOrigin,
      ingressProfileId: fixture.intent.ingress.profileId,
      browserIngress: fixture.intent.ingress,
    });
    expect(generated.gateway).not.toHaveProperty("listenHost");
    expect(generated.gateway).not.toHaveProperty("listenPort");
    expect(() => WorkstationGatewayConfigSchema.parse(generated.gateway)).not.toThrow();
  });

  it("preserves the frozen Tailscale distribution as Gateway config v1", () => {
    const fixture = createDistributionFixture();
    const intent = parseInstallationIntent({
      ...fixture.intent,
      ingress: { kind: "tailscale-serve", profileId: "tailscale-primary" },
    });
    const artifact = verifyDistributionArtifact(fixture.artifactRoot);
    const layout = createInstanceLayout(intent, artifact.summary);
    const generated = createInstanceConfiguration(intent, artifact.summary, layout);

    expect(intent.version).toBe(1);
    expect(generated.gateway).toMatchObject({
      version: 1,
      listenHost: "127.0.0.1",
      listenPort: layout.ports.gateway,
      ingressProfileId: "tailscale-primary",
    });
    expect(generated.gateway).not.toHaveProperty("browserIngress");
    expect(() => WorkstationGatewayConfigSchema.parse(generated.gateway)).not.toThrow();
  });

  it("keeps missing legacy app base paths at root and rejects invalid explicit values", () => {
    const fixture = createDistributionFixture();
    const legacyRaw: Record<string, unknown> = { ...fixture.intent };
    delete legacyRaw.naruAppBasePath;
    const legacy = parseInstallationIntent(legacyRaw);
    const artifact = verifyDistributionArtifact(fixture.artifactRoot);
    const layout = createInstanceLayout(legacy, artifact.summary);
    const generated = createInstanceConfiguration(legacy, artifact.summary, layout);
    expect(legacy.naruAppBasePath).toBeUndefined();
    expect(layout.appBasePath).toBe("/");
    expect(generated.gateway.appRegistrations).toEqual([
      expect.objectContaining({ routePrefix: "/" }),
    ]);
    expect(generated.naruEnvironment.NARU_APP_BASE_PATH).toBe("/");

    for (const value of ["/naru/", "/naru/..", "/_gateway/apps", "/naru?x=1"]) {
      expect(() =>
        parseInstallationIntent({ ...fixture.intent, naruAppBasePath: value }),
      ).toThrow();
    }
  });

  it("preserves approved additional Gateway routes without changing Host or Naru identity", () => {
    const fixture = createPrivateIngressDistributionFixture();
    const intent = parseInstallationIntent({
      ...fixture.intent,
      additionalGatewayApps: [
        { appId: "claude-lab", routePrefix: "/claude-lab", upstreamPort: 45999 },
      ],
    });
    const artifact = verifyDistributionArtifact(fixture.artifactRoot);
    const layout = createInstanceLayout(intent, artifact.summary);
    const generated = createInstanceConfiguration(intent, artifact.summary, layout);
    expect(WorkstationGatewayConfigSchema.parse(generated.gateway).appRegistrations).toEqual([
      expect.objectContaining({ appId: "naru", routePrefix: "/naru" }),
      {
        appId: "claude-lab",
        mode: "gateway-managed",
        routePrefix: "/claude-lab",
        upstream: { kind: "loopback", origin: "http://127.0.0.1:45999" },
        includeCredentialRef: true,
        enabled: true,
      },
    ]);
    expect(generated.host.appRegistrations).toHaveLength(2);
    expect(generated.naruEnvironment.NARU_GATEWAY_APP_ID).toBe("naru");
  });

  it("rejects unsafe, overlapping, and package-owned additional Gateway routes", () => {
    const fixture = createPrivateIngressDistributionFixture();
    const app = { appId: "claude-lab", routePrefix: "/claude-lab", upstreamPort: 45999 };
    for (const additionalGatewayApps of [
      [{ ...app, appId: "naru" }],
      [{ ...app, routePrefix: "/naru/child" }],
      [{ ...app, routePrefix: "/_gateway/apps" }],
      [{ ...app, upstreamPort: 0 }],
      [{ ...app, enabled: true }],
      [app, { ...app, appId: "another", routePrefix: "/claude-lab/child" }],
    ]) {
      expect(() => parseInstallationIntent({ ...fixture.intent, additionalGatewayApps })).toThrow();
    }
    const rootIntent = { ...fixture.intent, naruAppBasePath: undefined };
    expect(() => parseInstallationIntent({ ...rootIntent, additionalGatewayApps: [app] })).toThrow(
      /overlap/,
    );
    const artifact = verifyDistributionArtifact(fixture.artifactRoot);
    const layout = createInstanceLayout(fixture.intent, artifact.summary);
    const intent = parseInstallationIntent({
      ...fixture.intent,
      additionalGatewayApps: [{ ...app, upstreamPort: layout.ports.naru }],
    });
    expect(() => createInstanceConfiguration(intent, artifact.summary, layout)).toThrow(
      /package-owned listener/,
    );
  });

  it("rejects private ingress Origin drift instead of falling back to legacy config", () => {
    const fixture = createPrivateIngressDistributionFixture();
    expect(() =>
      parseInstallationIntent({
        ...fixture.intent,
        canonicalBrowserOrigin: "https://other.fixture.test:8443",
      }),
    ).toThrow(/must match/);
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
