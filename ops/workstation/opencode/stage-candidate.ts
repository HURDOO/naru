import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { join, resolve, relative } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { readPrivateJson } from "../distribution/security.js";
import { parseInstallationIntent, createInstanceLayout } from "../distribution/model.js";
import { readCurrentReceiptForIntent } from "../distribution/transaction.js";
import { verifyDistributionArtifact } from "../distribution/artifact.js";
import { OpenCodeGatewayConfigSchema } from "../../../apps/opencode-gateway/src/config.js";

const uid = process.getuid?.();
if (uid === undefined) throw new Error("OS user is required.");
const instance = realpathSync(process.argv[2] ?? "");
const ui = realpathSync(process.argv[3] ?? "");
const source = resolve(import.meta.dirname, "../../..");
const value = readPrivateJson(join(instance, "ownership.json"), uid);
if (typeof value !== "object" || value === null || !("intent" in value))
  throw new Error("Missing installation intent.");
const intent = parseInstallationIntent(value.intent);
const receipt = readCurrentReceiptForIntent(intent);
if (!receipt || intent.targetUid !== uid || intent.ingress.kind !== "direct-private-tls")
  throw new Error("Expected current private Gateway installation.");
const artifact = verifyDistributionArtifact(receipt.artifact.root);
const layout = createInstanceLayout(intent, artifact.summary);
if (layout.stateRoot !== instance) throw new Error("Instance identity mismatch.");
const gatewayValue = readPrivateJson(join(instance, "config/workstation-gateway.json"), uid);
if (
  typeof gatewayValue !== "object" ||
  gatewayValue === null ||
  !("instanceId" in gatewayValue) ||
  !("ownerSubject" in gatewayValue)
)
  throw new Error("Invalid Gateway configuration.");
const executable = realpathSync(join(homedir(), ".opencode/bin/opencode"));
const base = join(homedir(), ".local/share/omo-ultimate");
if (realpathSync(base) !== base) throw new Error("Candidate root must be canonical.");
const plans = join(base, "plans");
mkdirSync(plans, { recursive: true, mode: 0o700 });
if (realpathSync(plans) !== plans || lstatSync(plans).uid !== uid)
  throw new Error("Invalid plans root.");
const root = join(plans, `gateway-${randomUUID()}`);
mkdirSync(root, { mode: 0o700 });
const release = join(root, "release");
mkdirSync(release, { mode: 0o700 });
const privateFiles = join(root, "config");
mkdirSync(privateFiles, { mode: 0o700 });
cpSync(join(source, "apps/opencode-gateway/dist"), join(release, "server"), {
  recursive: true,
  errorOnExist: true,
});
cpSync(ui, join(release, "ui"), { recursive: true, errorOnExist: true });
mkdirSync(join(release, "runtime"), { mode: 0o700 });
const node = join(release, "runtime/node");
cpSync(layout.runtime.nodeExecutable, node, { errorOnExist: true });
chmodSync(node, 0o700);
cpSync(join(source, "LICENSE"), join(release, "LICENSE-naru"));
const nodeLicense = join(receipt.artifact.root, "runtime/node/LICENSE");
try {
  cpSync(nodeLicense, join(release, "LICENSE-node"));
} catch {
  /* The input artifact still retains the runtime's full license archive. */
}
writeFileSync(
  join(release, "LICENSE-opencode"),
  readFileSync(resolve(ui, "../../../LICENSE"), "utf8"),
);
const upstreamLock = resolve(ui, "../../../pnpm-lock.yaml");
cpSync(upstreamLock, join(release, "opencode-ui-pnpm-lock.yaml"));
const publicFiles: { path: string; sha256: string }[] = [];
function scan(directory: string): void {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const filename = join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error("Release contains a symlink.");
    if (item.isDirectory()) scan(filename);
    else if (item.isFile())
      publicFiles.push({ path: relative(release, filename), sha256: sha(filename) });
    else throw new Error("Release contains a special file.");
  }
}
function sha(filename: string): string {
  return createHash("sha256").update(readFileSync(filename)).digest("hex");
}
function privateJson(filename: string, content: unknown): void {
  writeFileSync(filename, JSON.stringify(content, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}
scan(release);
publicFiles.sort((a, b) => a.path.localeCompare(b.path));
const manifest = {
  version: 1,
  adapterVersion: (
    JSON.parse(readFileSync(join(source, "apps/opencode-gateway/package.json"), "utf8")) as {
      version: string;
    }
  ).version,
  opencodeVersion: "1.18.35",
  omoVersion: "5.1.28",
  upstreamCommit: "53d1eabb61e21162157817bf677da0a4ad3332e3",
  upstreamArchiveSha256: "3092a7b9f55d80c42a9c1bb2e2cc0a9961316673faf92b741577257a1576dd59",
  files: publicFiles,
};
const manifestFile = join(release, "manifest.json");
privateJson(manifestFile, manifest);
const passwordFile = join(privateFiles, "backend-password");
writeFileSync(passwordFile, randomBytes(32).toString("base64url") + "\n", {
  mode: 0o600,
  flag: "wx",
});
const config = OpenCodeGatewayConfigSchema.parse({
  version: 1,
  issuer: gatewayValue.instanceId,
  audience: "omo",
  ownerSubject: gatewayValue.ownerSubject,
  browserOrigin: intent.canonicalBrowserOrigin,
  routePrefix: "/omo",
  listenPort: 4097,
  upstreamPort: 4096,
  uiRoot: join(release, "ui"),
  verifierKeysFile: layout.files.gatewayVerifierKeys,
  passwordFile,
  opencodeExecutable: executable,
  opencodeSha256: sha(executable),
  defaultDirectory: source,
  allowedProjectRoots: intent.allowedProjectRoots,
});
const configFile = join(privateFiles, "opencode-gateway.json");
privateJson(configFile, config);
const candidate = {
  ...receipt.intent,
  artifactRoot: artifact.summary.root,
  additionalGatewayApps: [
    ...(receipt.intent.additionalGatewayApps ?? []),
    { appId: "omo", routePrefix: "/omo", upstreamPort: 4097 },
  ],
};
const candidateFile = join(privateFiles, "naru-intent.json");
privateJson(candidateFile, candidate);
const report = spawnSync(
  layout.runtime.nodeExecutable,
  [
    join(artifact.summary.root, "bin/workstation.mjs"),
    "plan",
    "--intent",
    candidateFile,
    "--operation",
    "reconfigure",
    "--json",
  ],
  { encoding: "utf8" },
);
if (![0, 3].includes(report.status ?? -1))
  throw new Error("Gateway plan was blocked; inspect owner-only candidate.");
const plan: unknown = JSON.parse(report.stdout);
if (
  typeof plan !== "object" ||
  plan === null ||
  !("planDigest" in plan) ||
  !("restartServices" in plan) ||
  !("sourceTransition" in plan)
)
  throw new Error("Invalid Gateway plan.");
const planFile = join(root, "gateway-plan.json");
privateJson(planFile, plan);
const plistFile = join(root, "launch-agent.plist");
const xml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const label = "com.hurdoo.omo-ultimate";
const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(join(release, "server/main.js"))}</string><string>${xml(configFile)}</string></array><key>WorkingDirectory</key><string>${xml(config.defaultDirectory)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>ProcessType</key><string>Background</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml([join(homedir(), ".local/share/omo-ultimate/bin"), join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"))}</string><key>OMO_SEND_ANONYMOUS_TELEMETRY</key><string>0</string><key>OMO_DISABLE_POSTHOG</key><string>1</string></dict></dict></plist>\n`;
writeFileSync(plistFile, plist, { mode: 0o600, flag: "wx" });
const transition = plan.sourceTransition;
if (typeof transition !== "object" || transition === null || !("exactTarget" in transition))
  throw new Error("Source transition target missing.");
privateJson(join(root, "source-admission-prepared.json"), {
  version: 1,
  status: "prepared",
  purpose: "Register isolated OpenCode/OmO Gateway app",
  repositoryRealpath: realpathSync(source),
  planDigest: plan.planDigest,
  exactTarget: transition.exactTarget,
});
const serviceDigest = createHash("sha256")
  .update(
    JSON.stringify({
      manifest: sha(manifestFile),
      config: sha(configFile),
      password: sha(passwordFile),
      plist: sha(plistFile),
      gatewayPlan: plan.planDigest,
    }),
  )
  .digest("hex");
const summary = {
  version: 1,
  status: "prepared-awaiting-approval",
  serviceDigest,
  gatewayPlanDigest: plan.planDigest,
  appUrl: intent.canonicalBrowserOrigin + "/omo/",
  manifestDigest: sha(manifestFile),
  restartServices: plan.restartServices,
  paths: {
    root,
    release,
    configFile,
    plistFile,
    candidateFile,
    currentReceiptFile: join(instance, "ownership.json"),
    officialNode: layout.runtime.nodeExecutable,
    officialCLI: join(artifact.summary.root, "bin/workstation.mjs"),
    launchAgentDestination: join(homedir(), "Library/LaunchAgents", `${label}.plist`),
  },
  currentReceiptId: receipt.receiptId,
  sourceTransition: transition,
};
privateJson(join(root, "summary.json"), summary);
console.log(
  JSON.stringify({
    status: summary.status,
    serviceDigest,
    gatewayPlanDigest: plan.planDigest,
    restartServices: plan.restartServices,
    candidateRoot: root,
  }),
);
