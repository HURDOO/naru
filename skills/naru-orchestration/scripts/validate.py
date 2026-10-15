#!/usr/bin/env python3
"""Validate naru-orchestration: the skill text matches Naru's own guidance and its tools exist."""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
EVALUATION_PATH = SKILL_ROOT / "evaluations" / "cases.json"


def fail(message: str) -> None:
    raise RuntimeError(message)


def validate_evaluations() -> None:
    payload = json.loads(EVALUATION_PATH.read_text(encoding="utf-8"))
    if payload.get("version") != 1 or payload.get("skill") != "naru-orchestration":
        fail("Evaluation fixture identity is invalid.")
    cases = payload.get("cases")
    if not isinstance(cases, list) or len(cases) < 4:
        fail("At least four orchestration evaluation cases are required.")
    if {case.get("classification") for case in cases} != {"safe", "unsafe"}:
        fail("Evaluation fixtures must cover safe and unsafe prompts.")
    identifiers = [case.get("id") for case in cases]
    if len(identifiers) != len(set(identifiers)):
        fail("Duplicate evaluation case ID.")
    for case in cases:
        for field in ["expectedDecisions", "forbiddenActions"]:
            values = case.get(field)
            if not isinstance(values, list) or not values:
                fail(f"Evaluation case {case.get('id')} has no {field}.")


def validate_contract() -> None:
    # Prints the guidance Naru gives managed agents and the agent tool names it serves.
    source = r"""
import { orchestrationSkillMarkdown } from "./apps/server/src/agent-runtime/orchestration-skill.ts";
import { AGENT_TOOLS } from "./apps/server/src/agent-platform/tools.ts";
process.stdout.write(JSON.stringify({
  markdown: orchestrationSkillMarkdown(),
  tools: AGENT_TOOLS.map((tool) => tool.name),
}));
"""
    output = subprocess.run(
        ["node", "--import", "tsx", "--input-type=module", "-e", source],
        cwd=REPOSITORY_ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    contract = json.loads(output)
    skill = (SKILL_ROOT / "SKILL.md").read_text(encoding="utf-8")
    if skill != contract["markdown"]:
        fail("SKILL.md differs from orchestrationSkillMarkdown(); regenerate it.")
    referenced = set(re.findall(r"`([a-z]+(?:_[a-z]+)+)`", skill))
    known = set(contract["tools"]) | {
        "origin_user_instruction_id",
        "idempotency_key",
    }
    missing = sorted(name for name in referenced if name not in known and "." not in name)
    if missing:
        fail(f"SKILL.md names tools Naru does not serve: {missing}")


def main() -> None:
    validate_evaluations()
    validate_contract()
    print("naru-orchestration contract validation passed")


if __name__ == "__main__":
    main()
