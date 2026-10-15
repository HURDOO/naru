import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

if (process.versions.node.split(".")[0] !== "24") throw new Error("Node 24 required");
process.umask(0o077);
const logs = resolve("../../experiments/naru-agent-spikes/codex-runtime/logs");
mkdirSync(logs, { recursive: true, mode: 0o700 });
chmodSync(logs, 0o700);
const home = mkdtempSync("/private/tmp/naru-codex-schema-");
const env = { HOME: home, CODEX_HOME: home, PATH: process.env.PATH };
const codex = process.env.NARU_SPIKE_CODEX ?? "codex";
for (const [name, args] of [
  ["version", ["--version"]],
  ["features", ["features", "list"]],
  [
    "schema",
    ["app-server", "generate-json-schema", "--experimental", "--out", join(logs, "schema")],
  ],
  ["types", ["app-server", "generate-ts", "--experimental", "--out", join(logs, "types")]],
] as const) {
  const result = execFileSync(codex, [...args], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  writeFileSync(join(logs, `${name}.txt`), result, { mode: 0o600 });
  console.log(`${name}: collected`);
}
