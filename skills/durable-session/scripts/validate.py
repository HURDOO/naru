#!/usr/bin/env python3
"""Validate durable-session skill fixtures without connecting to a Host or opening a PTY."""

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
    documents = [SKILL_ROOT / "SKILL.md", *(SKILL_ROOT / "references").glob("*.md")]
    for document in documents:
        for target in link_pattern.findall(document.read_text(encoding="utf-8")):
            clean_target = target.strip("<>").split("#", 1)[0]
            if not clean_target or "://" in clean_target:
                continue
            if not (document.parent / clean_target).resolve().exists():
                fail(f"Broken local link in {document.relative_to(SKILL_ROOT)}: {target}")


def validate_evaluations() -> None:
    payload = json.loads(EVALUATION_PATH.read_text(encoding="utf-8"))
    if payload.get("version") != 1 or payload.get("skill") != "durable-session":
        fail("Evaluation fixture identity is invalid.")
    cases = payload.get("cases")
    if not isinstance(cases, list) or len(cases) < 4:
        fail("At least four DurableSession evaluation cases are required.")
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
import { ExecCommandSpecV0Schema } from "./packages/contracts/src/durable-session/v0/index.ts";
import {
  SESSION_CLI_HELP,
  callerContextForInteractiveSession,
  parseCliArguments,
  runSessionCli,
} from "./apps/cli/src/index.ts";

async function main() {
const fixturePath = process.env.T15_FIXTURE_PATH;
if (!fixturePath) throw new Error("T15_FIXTURE_PATH is required.");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

for (const item of fixture.validCommands) {
  const parsed = parseCliArguments(item.argv, fixture.environment);
  if (parsed.mode !== "execute" || parsed.command.name !== item.name) {
    throw new Error(`Valid CLI fixture parsed incorrectly: ${JSON.stringify(item)}`);
  }
}
for (const argv of fixture.invalidCommands) {
  let rejected = false;
  try {
    parseCliArguments(argv, fixture.environment);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`Invalid CLI fixture was accepted: ${JSON.stringify(argv)}`);
}

const attachParsed = parseCliArguments(["attach", fixture.sessionId], fixture.environment);
const controlParsed = parseCliArguments(["control", fixture.sessionId], fixture.environment);
if (attachParsed.mode !== "execute" || attachParsed.command.name !== "attach") {
  throw new Error("Attach fixture did not parse as an interactive command.");
}
if (controlParsed.mode !== "execute" || controlParsed.command.name !== "control") {
  throw new Error("Control fixture did not parse as an interactive command.");
}
const attachCaller = callerContextForInteractiveSession(
  attachParsed.connection,
  attachParsed.command,
  1_780_000_000_000,
);
const controlCaller = callerContextForInteractiveSession(
  controlParsed.connection,
  controlParsed.command,
  1_780_000_000_000,
);
if (attachCaller.capabilities.includes("control:preempt")) {
  throw new Error("Observer attach unexpectedly delegated preempt.");
}
if (!controlCaller.capabilities.includes("control:preempt")) {
  throw new Error("Control command did not delegate explicit preempt capability.");
}
if (
  attachCaller.sessionScope.kind !== "ids" ||
  attachCaller.sessionScope.ids.length !== 1 ||
  attachCaller.sessionScope.ids[0] !== fixture.sessionId
) {
  throw new Error("Interactive caller was not scoped to exactly one Session.");
}

ExecCommandSpecV0Schema.parse(fixture.validExecSpec);
for (const spec of fixture.invalidExecSpecs) {
  if (ExecCommandSpecV0Schema.safeParse(spec).success) {
    throw new Error(`Unsafe arbitrary exec fixture was accepted: ${JSON.stringify(spec)}`);
  }
}

for (const token of [
  "run",
  "list",
  "watch",
  "attach",
  "control",
  "stop",
  "--credential-file",
  "watch --json",
]) {
  if (!SESSION_CLI_HELP.includes(token)) throw new Error(`CLI help is missing ${token}.`);
}

let stdout = "";
let stderr = "";
const exitCode = await runSessionCli(["--json", "attach", fixture.sessionId], {
  environment: fixture.environment,
  io: {
    stdout: (value) => { stdout += value; },
    stderr: (value) => { stderr += value; },
  },
});
if (exitCode !== 2 || stderr !== "") {
  throw new Error("Interactive JSON misuse did not fail through the JSON usage boundary.");
}
const failure = JSON.parse(stdout);
if (failure.ok !== false || failure.error?.code !== "USAGE") {
  throw new Error("Interactive JSON misuse did not return a stable usage error.");
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
    print("durable-session validation passed")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"durable-session validation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
