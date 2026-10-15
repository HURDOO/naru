#!/usr/bin/env python3
"""Run the non-interactive T15 skill package and live-contract validation suite."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path


SKILLS_ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = SKILLS_ROOT.parent
EXPECTED_SKILLS = {"durable-session", "gateway-app", "naru-orchestration", "workstation-setup"}
ALLOWED_FRONTMATTER = {"name", "description", "license", "allowed-tools", "metadata"}
NAME_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def fail(message: str) -> None:
    raise RuntimeError(message)


def parse_frontmatter(skill_file: Path) -> dict[str, str]:
    content = skill_file.read_text(encoding="utf-8")
    match = re.match(r"^---\n(.*?)\n---(?:\n|$)", content, re.DOTALL)
    if match is None:
        fail(f"Invalid frontmatter boundary: {skill_file}")
    frontmatter: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if not line or line.lstrip().startswith("#"):
            continue
        if line[:1].isspace():
            fail(f"Nested frontmatter requires the official validator: {skill_file}")
        key, separator, value = line.partition(":")
        if not separator or not key or not value.strip():
            fail(f"Invalid frontmatter line in {skill_file}: {line}")
        if key in frontmatter:
            fail(f"Duplicate frontmatter key in {skill_file}: {key}")
        frontmatter[key] = value.strip().strip('"').strip("'")
    unexpected = set(frontmatter) - ALLOWED_FRONTMATTER
    if unexpected:
        fail(f"Unexpected frontmatter keys in {skill_file}: {sorted(unexpected)}")
    return frontmatter


def parse_interface(openai_file: Path) -> dict[str, str]:
    lines = openai_file.read_text(encoding="utf-8").splitlines()
    try:
        start = lines.index("interface:") + 1
    except ValueError as error:
        raise RuntimeError(f"Missing interface mapping: {openai_file}") from error
    interface: dict[str, str] = {}
    for line in lines[start:]:
        if line and not line.startswith(" "):
            break
        if not line:
            continue
        match = re.fullmatch(r"  ([a-z_]+): (\"(?:[^\"\\]|\\.)*\")", line)
        if match is None:
            fail(f"Interface strings must be quoted in {openai_file}: {line}")
        interface[match.group(1)] = json.loads(match.group(2))
    return interface


def validate_metadata(skill_root: Path) -> None:
    name = skill_root.name
    frontmatter = parse_frontmatter(skill_root / "SKILL.md")
    if frontmatter.get("name") != name or NAME_PATTERN.fullmatch(name) is None:
        fail(f"Skill name and folder do not match: {skill_root}")
    description = frontmatter.get("description", "")
    if not description or len(description) > 1_024 or "<" in description or ">" in description:
        fail(f"Skill description is invalid: {skill_root}")

    interface = parse_interface(skill_root / "agents" / "openai.yaml")
    for field in ["display_name", "short_description", "default_prompt"]:
        if not interface.get(field):
            fail(f"Missing interface.{field}: {skill_root}")
    if not 25 <= len(interface["short_description"]) <= 64:
        fail(f"short_description must be 25-64 characters: {skill_root}")
    if f"${name}" not in interface["default_prompt"]:
        fail(f"default_prompt must mention ${name}: {skill_root}")

    validator = skill_root / "scripts" / "validate.py"
    if not validator.is_file() or validator.stat().st_mode & 0o111 == 0:
        fail(f"Missing executable contract validator: {skill_root}")
    for path in skill_root.rglob("*"):
        if path.is_symlink():
            fail(f"Skill package must not contain symlinks: {path}")


def find_node24() -> Path:
    candidates = [
        shutil.which("node"),
        "/opt/homebrew/opt/node@24/bin/node",
        "/usr/local/opt/node@24/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ]
    seen: set[Path] = set()
    for candidate in candidates:
        if candidate is None:
            continue
        path = Path(candidate).resolve()
        if path in seen or not path.is_file() or not os.access(path, os.X_OK):
            continue
        seen.add(path)
        result = subprocess.run(
            [str(path), "--version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip().startswith("v24."):
            return path
    fail("Node.js 24 LTS was not found; no validation command was run.")


def main() -> None:
    skill_roots = sorted(
        path for path in SKILLS_ROOT.iterdir() if path.is_dir() and (path / "SKILL.md").is_file()
    )
    actual_skills = {path.name for path in skill_roots}
    if actual_skills != EXPECTED_SKILLS:
        fail(f"Expected exactly {sorted(EXPECTED_SKILLS)}; found {sorted(actual_skills)}")
    for skill_root in skill_roots:
        validate_metadata(skill_root)

    node24 = find_node24()
    environment = os.environ.copy()
    environment["PATH"] = os.pathsep.join([str(node24.parent), environment.get("PATH", "")])
    version = subprocess.run(
        [str(node24), "--version"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    print(f"using Node {version}", flush=True)

    for skill_root in skill_roots:
        subprocess.run(
            [sys.executable, str(skill_root / "scripts" / "validate.py")],
            cwd=REPOSITORY_ROOT,
            env=environment,
            check=True,
        )

    subprocess.run(
        ["pnpm", "exec", "prettier", "--check", "skills"],
        cwd=REPOSITORY_ROOT,
        env=environment,
        check=True,
    )
    print("T15 non-interactive validation passed")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"T15 validation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
