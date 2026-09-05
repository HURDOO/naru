import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeDistributionArtifactManifest } from "./artifact.js";
import {
  ARTIFACT_FEATURE_LOCAL_SESSION_CLI,
  DISTRIBUTION_SCHEMA_VERSION,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_EXECUTABLE_MODE,
  PRIVATE_FILE_MODE,
  WORKSTATION_PACKAGE_ID,
} from "./constants.js";
import {
  parseInstallationIntent,
  stableJson,
  type WorkstationInstallationIntentV1,
} from "./model.js";
import { PACKAGED_NODE_RUNTIME } from "./node-runtime.js";
import type {
  GatewayVerifierKeySetV1,
  ServiceRuntimeState,
  WorkstationRuntimeController,
} from "./runtime.js";

export interface DistributionFixture {
  readonly root: string;
  readonly home: string;
  readonly projectRoot: string;
  readonly artifactRoot: string;
  readonly nodeExecutable: string;
  readonly codexExecutable: string;
  readonly intent: WorkstationInstallationIntentV1;
}

export function createDistributionFixture(
  options: {
    readonly buildId?: string;
    readonly origin?: string;
    readonly slug?: string;
    readonly packagedNodeRuntime?: boolean;
    readonly localSessionCliFeature?: boolean;
  } = {},
): DistributionFixture {
  const root = mkdtempSync("/private/tmp/n");
  chmodSync(root, PRIVATE_DIRECTORY_MODE);
  const home = root;
  const applicationSupport = join(home, "Library", "Application Support");
  const launchAgents = join(home, "Library", "LaunchAgents");
  const projectRoot = join(home, "coding");
  for (const directory of [join(home, "Library"), applicationSupport, launchAgents, projectRoot]) {
    mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE });
  }
  const nodeExecutable = join(home, "bin", "node");
  const codexExecutable = join(home, "bin", "codex");
  mkdirSync(join(home, "bin"), { mode: PRIVATE_DIRECTORY_MODE });
  writeExecutable(
    nodeExecutable,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo v24.1.0; exit 0; fi\nif [ "$2" = "--help" ]; then echo "Usage:"; exit 0; fi\nexit 0\n',
  );
  writeExecutable(
    codexExecutable,
    '#!/bin/sh\nif [ "$1" = "doctor" ]; then printf \'%s\\n\' \'{"checks":{"installation":{"status":"ok"},"auth.credentials":{"status":"ok"},"config.load":{"status":"ok"}}}\'; exit 0; fi\nexit 0\n',
  );
  const artifactRoot = createArtifactFixture(root, options.buildId ?? "fixture-build-0001", {
    ...(options.packagedNodeRuntime === undefined
      ? {}
      : { packagedNodeRuntime: options.packagedNodeRuntime }),
    ...(options.localSessionCliFeature === undefined
      ? {}
      : { localSessionCliFeature: options.localSessionCliFeature }),
  });
  const selectedNodeExecutable =
    options.packagedNodeRuntime === true
      ? join(artifactRoot, PACKAGED_NODE_RUNTIME.executableRelativePath)
      : nodeExecutable;
  const uid = process.getuid?.() ?? 501;
  const intent = parseInstallationIntent({
    version: DISTRIBUTION_SCHEMA_VERSION,
    packageId: WORKSTATION_PACKAGE_ID,
    installationId: "11111111-1111-4111-8111-111111111111",
    slug: options.slug ?? "w",
    targetUid: uid,
    homeDirectory: home,
    artifactRoot,
    canonicalBrowserOrigin: options.origin ?? "https://naru.fixture.test:8443",
    allowedProjectRoots: [projectRoot],
    nodeExecutable: selectedNodeExecutable,
    shellExecutable: "/bin/zsh",
    codexExecutable,
    ingress: { kind: "none", profileId: "local-only" },
  });
  return {
    root,
    home,
    projectRoot,
    artifactRoot,
    nodeExecutable: selectedNodeExecutable,
    codexExecutable,
    intent,
  };
}

export function createArtifactFixture(
  parent: string,
  buildId: string,
  options: {
    readonly packagedNodeRuntime?: boolean;
    readonly localSessionCliFeature?: boolean;
  } = {},
): string {
  const artifactRoot = join(parent, buildId);
  mkdirSync(artifactRoot, { mode: PRIVATE_DIRECTORY_MODE });
  const packagedNodeContents =
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo v24.20.0; exit 0; fi\nif [ "$1" = "--print" ]; then echo arm64; exit 0; fi\nif [ "$2" = "--help" ]; then echo "Usage:"; exit 0; fi\nexit 0\n';
  const packagedNodeRuntime = {
    ...PACKAGED_NODE_RUNTIME,
    executableSha256: createHash("sha256").update(packagedNodeContents).digest("hex"),
  };
  const files: readonly {
    readonly path: string;
    readonly contents: string;
    readonly executable?: boolean;
  }[] = [
    { path: "LICENSE", contents: "fixture-project-license\n" },
    { path: "NOTICE", contents: "fixture-project-notice\n" },
    { path: "THIRD_PARTY_NOTICES.md", contents: "fixture-third-party-notices\n" },
    { path: "components/host/dist/main.js", contents: "export {};\n" },
    {
      path: "components/cli/dist/main.js",
      contents:
        '#!/usr/bin/env node\nif (process.argv.includes("--help")) console.log("Usage:");\n',
    },
    { path: "components/gateway/dist/main.js", contents: "export {};\n" },
    { path: "components/naru/dist/index.js", contents: "export {};\n" },
    { path: "components/naru/dist/codex-integration-launcher.js", contents: "export {};\n" },
    { path: "components/naru/dist/codex-session-hook-cli.js", contents: "export {};\n" },
    {
      path: "components/host/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
      contents: "fixture-native",
    },
    {
      path: "components/host/node_modules/node-pty/build/Release/pty.node",
      contents: "fixture-native",
    },
    {
      path: "components/host/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
      contents: "fixture-helper",
      executable: true,
    },
    {
      path: "web-base/index.html",
      contents:
        '<!doctype html><html><head><meta name="naru-canonical-origin" content="https://naru.example.test:8443" /><link rel="manifest" href="/manifest.webmanifest" /></head><body></body></html>\n',
    },
    {
      path: "web-base/manifest.webmanifest",
      contents: `${JSON.stringify(
        {
          id: "https://naru.example.test:8443/",
          name: "Naru",
          start_url: "https://naru.example.test:8443/?source=pwa",
          scope: "https://naru.example.test:8443/",
          display: "standalone",
          icons: [
            {
              src: "https://naru.example.test:8443/icons/naru-192.png",
              sizes: "192x192",
              type: "image/png",
            },
          ],
        },
        null,
        2,
      )}\n`,
    },
    {
      path: "web-base/sw.js",
      contents:
        '/* Naru generated service worker. Build revision: abcdef1234567890abcd */\nconst CACHE_NAME = "naru-app-shell-" + "abcdef1234567890abcd";\n',
    },
    { path: "web-base/LICENSE", contents: "fixture-license\n" },
    { path: "web-base/icons/naru-192.png", contents: "fixture-icon" },
    { path: "bin/workstation.mjs", contents: "export {};\n" },
    { path: "bin/workstation-maintenance.mjs", contents: "export {};\n" },
    {
      path: "bin/durable-session.mjs",
      contents: 'await import("../components/cli/dist/main.js");\n',
    },
    ...(options.packagedNodeRuntime === true
      ? [
          {
            path: PACKAGED_NODE_RUNTIME.executableRelativePath,
            contents: packagedNodeContents,
            executable: true,
          },
          {
            path: PACKAGED_NODE_RUNTIME.licenseRelativePath,
            contents: "fixture-node-license\n",
          },
          {
            path: "runtime/node/source.json",
            contents: `${stableJson(packagedNodeRuntime)}\n`,
          },
        ]
      : []),
  ];
  for (const file of files) {
    const target = join(artifactRoot, file.path);
    mkdirSync(dirname(target), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    writeFileSync(target, file.contents, {
      mode: file.executable === true ? PRIVATE_EXECUTABLE_MODE : PRIVATE_FILE_MODE,
    });
    chmodSync(target, file.executable === true ? PRIVATE_EXECUTABLE_MODE : PRIVATE_FILE_MODE);
  }
  writeDistributionArtifactManifest(artifactRoot, {
    buildId,
    sourceCommit: "a".repeat(40),
    lockfileSha256: "b".repeat(64),
    features: options.localSessionCliFeature === false ? [] : [ARTIFACT_FEATURE_LOCAL_SESSION_CLI],
    ...(options.packagedNodeRuntime === true ? { nodeRuntime: packagedNodeRuntime } : {}),
  });
  return artifactRoot;
}

export class FakeWorkstationRuntime implements WorkstationRuntimeController {
  readonly operations: string[] = [];
  readonly #states = new Map<string, ServiceRuntimeState>();

  serviceState(_uid: number, label: string): ServiceRuntimeState {
    return this.#states.get(label) ?? "unloaded";
  }

  bootstrap(_uid: number, plistPath: string): void {
    const label = plistPath
      .split("/")
      .at(-1)
      ?.replace(/\.plist$/, "");
    if (label === undefined) throw new Error("Fixture plist label is missing.");
    this.operations.push(`bootstrap:${label}`);
    this.#states.set(label, "loaded");
  }

  bootout(_uid: number, label: string): void {
    this.operations.push(`bootout:${label}`);
    this.#states.set(label, "unloaded");
  }

  kickstart(_uid: number, label: string): void {
    this.operations.push(`kickstart:${label}`);
    this.#states.set(label, "running");
  }

  async waitForUdsReady(socketPath: string, path: "/readyz"): Promise<void> {
    void socketPath;
    void path;
    await Promise.resolve();
  }

  async waitForHttpReady(origin: string, path: "/readyz"): Promise<void> {
    void origin;
    void path;
    await Promise.resolve();
  }

  async readGatewayVerifierKeys(socketPath: string): Promise<GatewayVerifierKeySetV1> {
    void socketPath;
    await Promise.resolve();
    return {
      version: 1,
      keys: [
        {
          keyId: "fixture-key",
          algorithm: "Ed25519",
          publicKeyPem:
            "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n-----END PUBLIC KEY-----\n",
        },
      ],
    };
  }
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: PRIVATE_EXECUTABLE_MODE });
  chmodSync(path, PRIVATE_EXECUTABLE_MODE);
}
