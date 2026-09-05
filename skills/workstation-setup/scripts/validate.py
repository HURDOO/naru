#!/usr/bin/env python3
"""Validate T15 workstation-setup fixtures without touching runtime or network state."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_PATH = SKILL_ROOT / "scripts" / "contract-fixtures.json"
EVALUATION_PATH = SKILL_ROOT / "evaluations" / "cases.json"


def fail(message: str) -> None:
    raise RuntimeError(message)


def validate_links() -> None:
    link_pattern = re.compile(r"\[[^\]]+\]\(([^)]+)\)")
    for document in [SKILL_ROOT / "SKILL.md", *(SKILL_ROOT / "references").glob("*.md")]:
        for target in link_pattern.findall(document.read_text(encoding="utf-8")):
            clean_target = target.strip("<>").split("#", 1)[0]
            if not clean_target or "://" in clean_target:
                continue
            if not (document.parent / clean_target).resolve().exists():
                fail(f"Broken local link in {document.relative_to(SKILL_ROOT)}: {target}")


def validate_evaluations() -> None:
    payload = json.loads(EVALUATION_PATH.read_text(encoding="utf-8"))
    if payload.get("version") != 1 or payload.get("skill") != "workstation-setup":
        fail("Evaluation fixture identity is invalid.")
    cases = payload.get("cases")
    if not isinstance(cases, list) or len(cases) < 4:
        fail("At least four workstation evaluation cases are required.")
    classifications = {case.get("classification") for case in cases if isinstance(case, dict)}
    if classifications != {"safe", "unsafe"}:
        fail("Evaluation fixtures must cover safe and unsafe prompts.")
    identifiers: set[str] = set()
    for case in cases:
        if not isinstance(case, dict):
            fail("Evaluation case must be an object.")
        for field in ["id", "prompt", "expectedDecisions", "forbiddenActions"]:
            value = case.get(field)
            if field in {"expectedDecisions", "forbiddenActions"}:
                if (
                    not isinstance(value, list)
                    or not value
                    or not all(isinstance(item, str) and item for item in value)
                ):
                    fail(f"Evaluation case {case.get('id')} has no {field}.")
            elif not isinstance(value, str) or not value:
                fail(f"Evaluation case has no {field}.")
        identifier = case["id"]
        if identifier in identifiers:
            fail(f"Duplicate evaluation case ID: {identifier}")
        identifiers.add(identifier)


def validate_runtime_contract() -> None:
    node_version = subprocess.run(
        ["node", "--version"],
        cwd=REPOSITORY_ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if not node_version.startswith("v24."):
        fail(f"Node 24 is required for contract validation; found {node_version}.")

    source = r"""
import { readFileSync } from "node:fs";
import { WorkstationNetworkConfigSchema } from "./apps/workstation-gateway/src/ingress/config.ts";
import { networkUsage, parseNetworkArguments } from "./apps/workstation-gateway/src/ingress/network-cli.ts";

async function main() {
const { parseDistributionArguments } = await import("./ops/workstation/distribution/cli.ts");
const fixturePath = process.env.T15_FIXTURE_PATH;
if (!fixturePath) throw new Error("T15_FIXTURE_PATH is required.");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
WorkstationNetworkConfigSchema.parse(fixture.validConfig);

for (const command of fixture.validCommands) parseNetworkArguments(command);
for (const command of fixture.invalidCommands) {
  let rejected = false;
  try {
    parseNetworkArguments(command);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`Invalid parser fixture was accepted: ${JSON.stringify(command)}`);
}

for (const operation of ["bootstrap", "recover"]) {
  const parsed = parseDistributionArguments([
    "auth",
    operation,
    "--intent",
    "/private/tmp/owner-only-intent.json",
    "--json",
  ]);
  if (parsed.command !== "auth" || parsed.authOperation !== operation) {
    throw new Error(`Distribution auth parser drifted for ${operation}.`);
  }
}
let missingAuthSubcommandRejected = false;
try {
  parseDistributionArguments([
    "auth",
    "--intent",
    "/private/tmp/owner-only-intent.json",
    "--json",
  ]);
} catch {
  missingAuthSubcommandRejected = true;
}
if (!missingAuthSubcommandRejected) throw new Error("Distribution auth accepted no subcommand.");

const packagedIntent = parseDistributionArguments([
  "intent",
  "--slug",
  "fixture",
  "--artifact",
  "/private/tmp/expanded-artifact",
  "--origin",
  "https://fixture.tailnet.ts.net",
  "--project-root",
  "/private/tmp/projects",
  "--shell",
  "/bin/zsh",
  "--codex",
  "/private/tmp/bin/codex",
  "--json",
]);
if (packagedIntent.command !== "intent" || packagedIntent.intentOptions?.nodeExecutable !== undefined) {
  throw new Error("Packaged distribution intent still requires an external Node option.");
}

const invalidPublicSource = structuredClone(fixture.validConfig);
invalidPublicSource.sourcePolicies[0].cidrs = ["203.0.113.0/24"];
if (WorkstationNetworkConfigSchema.safeParse(invalidPublicSource).success) {
  throw new Error("Public source CIDR fixture was accepted.");
}
const missingProxyPolicy = structuredClone(fixture.validConfig);
missingProxyPolicy.trustedProxyPolicies = [];
if (WorkstationNetworkConfigSchema.safeParse(missingProxyPolicy).success) {
  throw new Error("Unresolved trusted proxy policy fixture was accepted.");
}

const usage = networkUsage();
for (const command of ["plan", "status", "doctor", "apply", "rollback"]) {
  if (!usage.includes(command)) throw new Error(`CLI usage is missing ${command}.`);
}
process.stdout.write(JSON.stringify({ ok: true, commands: fixture.validCommands.length }) + "\n");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
"""
    environment = os.environ.copy()
    environment["T15_FIXTURE_PATH"] = str(FIXTURE_PATH)
    subprocess.run(
        ["pnpm", "exec", "tsx", "--eval", source],
        cwd=REPOSITORY_ROOT,
        env=environment,
        check=True,
    )


def main() -> None:
    validate_links()
    validate_evaluations()
    validate_runtime_contract()
    print("workstation-setup validation passed")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"workstation-setup validation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
