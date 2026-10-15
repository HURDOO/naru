import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/**
 * Regression: with an agent Pane running, a restarted Naru checked the Host socket and then built
 * Fastify, whose lazy require of @fastify/ajv-compiler resolved through an unresolved pnpm symlink
 * and crashed ("Cannot find module 'ajv/dist/jtd'"). Node's realpath stops early when the last
 * stat in the process was a socket; the socket checks must not leave it there.
 */
describe("socket checks before lazy requires", () => {
  it("keeps Fastify's lazy requires resolvable after a private socket check", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "naru-sock-")));
    directories.push(directory);
    const script = join(directory, "probe.mts");
    writeFileSync(
      script,
      `import { createRequire } from "node:module";
import { createServer } from "node:net";
import { chmodSync } from "node:fs";
import { assertPrivateSocket } from ${JSON.stringify(
        pathToFileURL(join(repositoryRoot, "packages/durable-session-client/src/node-security.ts"))
          .href,
      )};
const require = createRequire(${JSON.stringify(join(repositoryRoot, "apps/server/package.json"))});
const fastify = require("fastify");
const socketPath = ${JSON.stringify(join(directory, "s.sock"))};
const server = createServer().listen(socketPath, () => {
  chmodSync(socketPath, 0o600);
  assertPrivateSocket(socketPath);
  try {
    fastify();
    process.stdout.write("built");
  } catch (error) {
    process.stdout.write(String(error));
  }
  server.close();
});
`,
      { mode: 0o600 },
    );
    const loader = pathToFileURL(join(repositoryRoot, "node_modules/tsx/dist/loader.mjs")).href;
    const result = spawnSync(process.execPath, ["--import", loader, script], {
      cwd: directory,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.stdout).toBe("built");
  });
});
