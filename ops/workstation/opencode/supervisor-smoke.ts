import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import assert from "node:assert/strict";

const release = realpathSync(process.argv[2] ?? "");
const executable = realpathSync(process.argv[3] ?? "");
const root = realpathSync(mkdtempSync(join(tmpdir(), "omo-supervisor-smoke-")));
const project = join(root, "project");
mkdirSync(project, { mode: 0o700 });
const password = randomBytes(32).toString("base64url");
const passwordFile = join(root, "password");
writeFileSync(passwordFile, password, { mode: 0o600 });
const verifierKeysFile = join(root, "keys.json");
writeFileSync(
  verifierKeysFile,
  JSON.stringify({
    version: 1,
    keys: [
      {
        keyId: "fixture-key",
        algorithm: "Ed25519",
        publicKeyPem: generateKeyPairSync("ed25519").publicKey.export({
          format: "pem",
          type: "spki",
        }),
      },
    ],
  }),
  { mode: 0o600 },
);
const reservations = [createServer(), createServer()];
for (const server of reservations) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
}
const [listenPort, upstreamPort] = reservations.map(
  (server) => (server.address() as AddressInfo).port,
);
assert(listenPort && upstreamPort);
for (const server of reservations)
  await new Promise<void>((resolve) => server.close(() => resolve()));
const configFile = join(root, "config.json");
const config = {
  version: 1,
  issuer: "gateway-fixture",
  audience: "omo",
  ownerSubject: "owner-fixture",
  browserOrigin: "https://naru.example.test",
  listenPort,
  upstreamPort,
  routePrefix: "/omo",
  uiRoot: join(release, "ui"),
  verifierKeysFile,
  passwordFile,
  opencodeExecutable: executable,
  opencodeSha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
  defaultDirectory: project,
  allowedProjectRoots: [project],
};
writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
const adapterOrigin = `http://127.0.0.1:${listenPort}`;
const backendOrigin = `http://127.0.0.1:${upstreamPort}`;
const auth = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
const start = () => {
  const child = spawn(
    join(release, "runtime/node"),
    [join(release, "server/main.js"), configFile],
    {
      cwd: project,
      env: {
        ...process.env,
        XDG_DATA_HOME: join(root, "data"),
        XDG_CACHE_HOME: join(root, "cache"),
        OMO_SEND_ANONYMOUS_TELEMETRY: "0",
        OMO_DISABLE_POSTHOG: "1",
      },
      stdio: "ignore",
    },
  );
  return child;
};
async function stopped(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(500) });
    return false;
  } catch {
    return true;
  }
}
for (let cycle = 0; cycle < 2; cycle += 1) {
  const child = start();
  try {
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      assert.equal(child.exitCode, null, "Supervisor exited before readiness.");
      try {
        const response = await fetch(`${adapterOrigin}/_adapter/health`, {
          signal: AbortSignal.timeout(500),
        });
        ready = response.ok;
      } catch {
        /* Fixture-only startup polling. */
      }
      if (ready) break;
      await setTimeout(500);
    }
    assert(ready, "Supervisor readiness timeout.");
    assert.equal((await fetch(adapterOrigin)).status, 401);
    assert.equal((await fetch(`${backendOrigin}/global/health`)).status, 401);
    assert.equal((await fetch(`${backendOrigin}/global/health`, { headers: auth })).status, 200);
    const agentsResponse = await fetch(`${backendOrigin}/agent`, { headers: auth });
    assert.equal(agentsResponse.status, 200);
    const agents: unknown = await agentsResponse.json();
    assert(Array.isArray(agents));
    assert(
      agents.some(
        (agent: unknown) =>
          typeof agent === "object" &&
          agent !== null &&
          "name" in agent &&
          typeof agent.name === "string" &&
          /sisyphus/i.test(agent.name),
      ),
      "OmO agent did not load in the compiled service.",
    );
    const exit = once(child, "exit");
    child.kill("SIGTERM");
    const [code] = (await exit) as unknown[];
    assert.equal(code, 0);
    assert(await stopped(`${adapterOrigin}/_adapter/health`), "Adapter survived shutdown.");
    assert(await stopped(`${backendOrigin}/global/health`), "Backend survived shutdown.");
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
}
writeFileSync(configFile, JSON.stringify({ ...config, opencodeSha256: "0".repeat(64) }));
const rejected = start();
const [code] = (await once(rejected, "exit")) as unknown[];
assert.equal(code, 1);
assert(await stopped(`${backendOrigin}/global/health`), "Changed executable digest was accepted.");
console.log(JSON.stringify({ status: "passed", cycles: 2, pluginLoaded: true, fixtureRoot: root }));
