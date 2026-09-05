#!/usr/bin/env python3
"""Validate T15 gateway-app fixtures without starting a listener or service."""

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
    if payload.get("version") != 1 or payload.get("skill") != "gateway-app":
        fail("Evaluation fixture identity is invalid.")
    cases = payload.get("cases")
    if not isinstance(cases, list) or len(cases) < 4:
        fail("At least four gateway evaluation cases are required.")
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
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  GatewayBrowserFailureResponseV1Schema,
  WORKSTATION_GATEWAY_BROWSER_ROUTE_PREFIX,
  WORKSTATION_GATEWAY_CSRF_HEADER,
  WORKSTATION_GATEWAY_LOGIN_PATH,
  isWorkstationGatewayBrowserPath,
} from "./packages/contracts/src/workstation-gateway/v1/index.ts";
import { WorkstationGatewayConfigSchema } from "./apps/workstation-gateway/src/config.ts";
import { sanitizedUpstreamHeaders } from "./apps/workstation-gateway/src/proxy.ts";
import {
  GatewayAssertionError,
  InMemoryGatewayReplayStore,
  createGatewayAssertion,
  verifyGatewayAssertion,
} from "./packages/gateway-verifier/src/index.ts";

const fixturePath = process.env.T15_FIXTURE_PATH;
if (!fixturePath) throw new Error("T15_FIXTURE_PATH is required.");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
WorkstationGatewayConfigSchema.parse(fixture.validConfig);
const browserFailure = GatewayBrowserFailureResponseV1Schema.parse(fixture.authenticationRequired);
if (browserFailure.error.code !== "AUTHENTICATION_REQUIRED") {
  throw new Error("Gateway authentication failure fixture drifted.");
}
if (
  WORKSTATION_GATEWAY_BROWSER_ROUTE_PREFIX !== "/_gateway" ||
  WORKSTATION_GATEWAY_LOGIN_PATH !== "/_gateway/login" ||
  !isWorkstationGatewayBrowserPath(WORKSTATION_GATEWAY_LOGIN_PATH) ||
  isWorkstationGatewayBrowserPath("/_gateway-app")
) {
  throw new Error("Gateway-owned browser route contract drifted.");
}
if (GatewayBrowserFailureResponseV1Schema.safeParse({
  ...fixture.authenticationRequired,
  error: { code: "AUTH_REQUIRED", message: "application-owned code" },
}).success) {
  throw new Error("Application auth failure was accepted as a Gateway envelope.");
}

const publicUpstream = structuredClone(fixture.validConfig);
publicUpstream.appRegistrations[0].upstream = { kind: "loopback", origin: "http://0.0.0.0:49101" };
if (WorkstationGatewayConfigSchema.safeParse(publicUpstream).success) {
  throw new Error("Public managed upstream fixture was accepted.");
}
const reservedRoute = structuredClone(fixture.validConfig);
reservedRoute.appRegistrations[0].routePrefix = "/_gateway/auth";
if (WorkstationGatewayConfigSchema.safeParse(reservedRoute).success) {
  throw new Error("Reserved managed route fixture was accepted.");
}

const now = 1_780_000_020;
const keyId = "fixture-ed25519-key";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const assertion = createGatewayAssertion(fixture.principal, keyId, privateKey);
const options = (overrides = {}) => ({
  expectedIssuer: fixture.principal.iss,
  expectedAudience: fixture.principal.aud,
  expectedOrigin: fixture.principal.origin,
  resolveKey: (candidate) => candidate === keyId ? publicKey : undefined,
  replayStore: new InMemoryGatewayReplayStore(),
  now: () => now,
  ...overrides,
});
verifyGatewayAssertion(assertion, options());

const sanitizedHeaders = sanitizedUpstreamHeaders({
  host: "gateway.invalid",
  cookie: "__Host-workstation=fixture-gateway; app-session=fixture-app",
  [WORKSTATION_GATEWAY_CSRF_HEADER]: "fixture-gateway-csrf",
  "x-csrf-token": "fixture-app-csrf",
  "x-workstation-gateway-spoof": "must-not-pass",
}, "__Host-workstation", assertion);
if (sanitizedHeaders[WORKSTATION_GATEWAY_CSRF_HEADER] !== undefined) {
  throw new Error("Gateway CSRF header leaked to the managed upstream.");
}
if (sanitizedHeaders["x-workstation-gateway-spoof"] !== undefined) {
  throw new Error("Reserved Gateway header leaked to the managed upstream.");
}
if (sanitizedHeaders["x-csrf-token"] !== "fixture-app-csrf") {
  throw new Error("Application CSRF header was not preserved independently.");
}
if (sanitizedHeaders.cookie !== "app-session=fixture-app") {
  throw new Error("Gateway cookie stripping did not preserve the application cookie.");
}

const replayStore = new InMemoryGatewayReplayStore();
verifyGatewayAssertion(assertion, options({ replayStore }));
let replayRejected = false;
try {
  verifyGatewayAssertion(assertion, options({ replayStore }));
} catch (error) {
  replayRejected = error instanceof GatewayAssertionError && error.code === "ASSERTION_REPLAYED";
}
if (!replayRejected) throw new Error("Assertion replay fixture was not rejected.");

let audienceRejected = false;
try {
  verifyGatewayAssertion(assertion, options({ expectedAudience: "other-app" }));
} catch (error) {
  audienceRejected = error instanceof GatewayAssertionError && error.code === "ASSERTION_AUDIENCE_MISMATCH";
}
if (!audienceRejected) throw new Error("Wrong audience fixture was not rejected.");

let originRejected = false;
try {
  verifyGatewayAssertion(assertion, options({ expectedOrigin: "https://other.invalid" }));
} catch (error) {
  originRejected = error instanceof GatewayAssertionError && error.code === "ASSERTION_ORIGIN_MISMATCH";
}
if (!originRejected) throw new Error("Wrong Origin fixture was not rejected.");

let unknownKeyRejected = false;
try {
  verifyGatewayAssertion(assertion, options({ resolveKey: () => undefined }));
} catch (error) {
  unknownKeyRejected = error instanceof GatewayAssertionError && error.code === "ASSERTION_KEY_UNKNOWN";
}
if (!unknownKeyRejected) throw new Error("Unknown verifier key fixture was not rejected.");

process.stdout.write(JSON.stringify({ ok: true, registrations: fixture.validConfig.appRegistrations.length }) + "\n");
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
    print("gateway-app validation passed")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"gateway-app validation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
