/** Creates a separate, owner-only acceptance instance; never edits Workstation state. */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PrivateIngressSourcePolicyV0Schema,
  type PrivateIngressV0,
} from "../../packages/contracts/src/private-ingress/v0/index.js";
import { hashPassword } from "../../apps/server/src/password.js";
import { verifyDistributionArtifact } from "../workstation/distribution/artifact.js";
import { parseInstallationIntent } from "../workstation/distribution/model.js";
import { inspectExecutable, readPrivateJson } from "../workstation/distribution/security.js";
import { parseInstallationReceipt } from "../workstation/distribution/transaction.js";

const TEST_ROOT_PREFIX = "/private/tmp/naru-claude-9443.";
const KEYCHAIN_SERVICE = "dev.naru.claude-password-9443";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let phase = "discovery";

function withoutUnrelatedGatewayApps(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!("additionalGatewayApps" in record)) return value;
  if (!Array.isArray(record.additionalGatewayApps)) {
    throw new Error("Gateway app extension has an invalid shape.");
  }
  const baseIntent = { ...record };
  delete baseIntent.additionalGatewayApps;
  return baseIntent;
}

function compatibleReceipt(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return { ...record, intent: withoutUnrelatedGatewayApps(record.intent) };
}

function discoverVerifiedIngress(): PrivateIngressV0 {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Owner identity is unavailable.");
  const instancesRoot = join(
    homedir(),
    "Library",
    "Application Support",
    "Naru Workstation",
    "instances",
  );
  const matches: PrivateIngressV0[] = [];
  phase = "instance-list";
  for (const entry of readdirSync(instancesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const stateRoot = join(instancesRoot, entry.name);
    const ownershipPath = join(stateRoot, "ownership.json");
    if (!existsSync(ownershipPath)) continue;
    phase = "receipt-file";
    const receiptValue = readPrivateJson(ownershipPath, uid);
    phase = "receipt-parse";
    const receipt = parseInstallationReceipt(compatibleReceipt(receiptValue));
    phase = "artifact";
    const artifact = verifyDistributionArtifact(receipt.artifact.root);
    if (artifact.summary.manifestDigest !== receipt.artifact.manifestDigest) {
      throw new Error("Installed artifact digest changed.");
    }
    const configDir = join(stateRoot, "config");
    phase = "config-list";
    for (const filename of readdirSync(configDir)) {
      if (!filename.endsWith(".json")) continue;
      let intent;
      try {
        intent = parseInstallationIntent(
          withoutUnrelatedGatewayApps(readPrivateJson(join(configDir, filename), uid)),
        );
      } catch {
        continue;
      }
      if (
        intent.version !== 2 ||
        intent.installationId !== receipt.installationId ||
        intent.targetUid !== uid ||
        intent.canonicalBrowserOrigin !== receipt.intent.canonicalBrowserOrigin ||
        JSON.stringify(intent.ingress) !== JSON.stringify(receipt.intent.ingress) ||
        receipt.namespace !== entry.name
      ) {
        continue;
      }
      matches.push(intent.ingress);
    }
  }
  phase = `intent-count-${matches.length}`;
  if (matches.length !== 1) {
    throw new Error("Expected exactly one verified private-ingress Workstation intent.");
  }
  return matches[0] as PrivateIngressV0;
}

function claudeExecutable(): string {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (!directory) continue;
    const candidate = join(directory, "claude");
    if (!existsSync(candidate)) continue;
    const canonical = realpathSync(candidate);
    inspectExecutable(canonical);
    return canonical;
  }
  throw new Error("Claude Code executable is unavailable.");
}

function runQuietly(file: string, args: string[], environment = process.env): void {
  const result = spawnSync(file, args, {
    cwd: REPO_ROOT,
    env: environment,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("An isolated test preparation command failed.");
  }
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
}

function launchAgent(root: string, node: string): string {
  const script = join(REPO_ROOT, "ops", "test-private-password", "server.ts");
  const argumentsXml = [node, "--import", "tsx", script, root]
    .map((value) => `<string>${xml(value)}</string>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${KEYCHAIN_SERVICE}</string>\n<key>ProgramArguments</key><array>${argumentsXml}</array>\n<key>WorkingDirectory</key><string>${xml(REPO_ROOT)}</string>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>ThrottleInterval</key><integer>10</integer>\n<key>StandardOutPath</key><string>${xml(join(root, "stdout.log"))}</string>\n<key>StandardErrorPath</key><string>${xml(join(root, "stderr.log"))}</string>\n<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH ?? "/usr/bin:/bin")}</string></dict>\n</dict></plist>\n`;
}

async function main(): Promise<void> {
  if (process.argv.length !== 3 || !["check", "prepare"].includes(process.argv[2] ?? "")) {
    throw new Error("Expected check or prepare.");
  }
  const source = discoverVerifiedIngress();
  phase = "runtime";
  const node = realpathSync(process.execPath);
  const nodeVersion = spawnSync(node, ["--version"], { encoding: "utf8" });
  if (!nodeVersion.stdout.startsWith("v24.")) throw new Error("Node 24 is required.");
  inspectExecutable(node);
  const claude = claudeExecutable();
  if (source.sourcePolicy.allowedCidrs.length !== 0) {
    throw new Error("The isolated test accepts only exact private source addresses.");
  }
  const originUrl = new URL(source.browserOrigin);
  originUrl.port = "9443";
  const browserOrigin = originUrl.origin;
  const sourcePolicy = PrivateIngressSourcePolicyV0Schema.parse({
    ...source.sourcePolicy,
    allowedAddresses: [...new Set([...source.sourcePolicy.allowedAddresses, source.listener.host])],
  });
  if (process.argv[2] === "check") {
    process.stdout.write(
      JSON.stringify({
        verified: true,
        exactSourceCount: sourcePolicy.allowedAddresses.length,
        node24: true,
        claude: true,
      }) + "\n",
    );
    return;
  }
  phase = "credential-check";
  const existingCredential = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-s", KEYCHAIN_SERVICE],
    { encoding: "utf8" },
  );
  if (existingCredential.status === 0) throw new Error("Test credential already exists.");
  const priorUmask = process.umask(0o077);
  phase = "test-root";
  let root: string;
  try {
    root = mkdtempSync(TEST_ROOT_PREFIX);
    mkdirSync(join(root, "data"), { mode: 0o700 });
    mkdirSync(join(root, "projects"), { mode: 0o700 });
  } finally {
    process.umask(priorUmask);
  }
  const password = randomBytes(24).toString("base64url");
  const passwordHash = await hashPassword(password);
  phase = "web-build";
  const settings = {
    browserOrigin,
    listenerHost: source.listener.host,
    sourcePolicy,
    tls: {
      approvedRoot: source.tls.approvedRoot,
      certificateFile: source.tls.certificateFile,
      privateKeyFile: source.tls.privateKeyFile,
      serverNames: [originUrl.hostname],
      allowSymlinkReferences: true,
    },
    passwordHash,
    sessionSecret: randomBytes(48).toString("base64url"),
    claudeExecutable: claude,
  };
  writeFileSync(join(root, "settings.json"), JSON.stringify(settings), { mode: 0o600, flag: "wx" });
  runQuietly(
    "pnpm",
    ["--filter", "@naru/web", "exec", "vite", "build", "--outDir", join(root, "web-dist")],
    {
      ...process.env,
      NARU_PWA_BUILD_ORIGIN: browserOrigin,
      NARU_APP_BASE_PATH: "/",
    },
  );
  chmodSync(join(root, "web-dist"), 0o700);
  writeFileSync(join(root, "launch-agent.plist"), launchAgent(root, node), {
    mode: 0o600,
    flag: "wx",
  });
  phase = "keychain";
  runQuietly("/usr/bin/security", [
    "add-generic-password",
    "-a",
    "naru-test",
    "-s",
    KEYCHAIN_SERVICE,
    "-w",
    password,
  ]);
  process.stdout.write(
    JSON.stringify({ prepared: true, root, keychainService: KEYCHAIN_SERVICE }) + "\n",
  );
}

void main().catch((error: unknown) => {
  const category =
    phase === "receipt-parse" && error instanceof Error
      ? ` (${error.message.replace(/https?:\/\/\S+|\/\S+/g, "[redacted]").slice(0, 160)})`
      : "";
  process.stderr.write(
    `Isolated 9443 preparation failed at ${phase}${category}; production was not changed.\n`,
  );
  process.exitCode = 1;
});
