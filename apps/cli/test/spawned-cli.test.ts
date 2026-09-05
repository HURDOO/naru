import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const CREDENTIAL = "fixture-client-credential-0123456789-ABCDEFGHIJ";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolvePromise, reject) =>
            server.close((error) => (error ? reject(error) : resolvePromise())),
          ),
      ),
  );
});

describe("spawned Session CLI JSON contract", () => {
  it("writes one stable success envelope to stdout and no diagnostics", async () => {
    const fixture = await createFixture((_request, requestId) => ({
      version: 0,
      requestId,
      ok: true,
      result: { operation: "listSessions", sessions: [], nextCursor: null },
    }));

    const result = await spawnCli(fixture, ["list", "--limit", "10"]);

    expect(result).toEqual({
      exitCode: 0,
      stdout:
        '{"version":1,"command":"list","ok":true,"result":{"operation":"listSessions","sessions":[],"nextCursor":null}}\n',
      stderr: "",
    });
    expect(fixture.requests).toHaveLength(1);
    const observed = fixture.requests[0] as {
      readonly callerContext: { readonly appId: unknown; readonly subject: unknown };
      readonly request: {
        readonly version: unknown;
        readonly requestId: unknown;
        readonly operation: unknown;
        readonly limit: unknown;
      };
    };
    expect(observed).toMatchObject({
      callerContext: { appId: "fixture-app", subject: "fixture-owner" },
      request: { version: 0, operation: "listSessions", limit: 10 },
    });
    expect(typeof observed.request.requestId).toBe("string");
  });

  it("keeps public errors machine-readable with a stable exit code", async () => {
    const fixture = await createFixture((_request, requestId) => ({
      version: 0,
      requestId,
      ok: false,
      error: { code: "CAPABILITY_REQUIRED", message: "Capability was denied." },
    }));

    const result = await spawnCli(fixture, ["list"]);

    expect(result).toEqual({
      exitCode: 4,
      stdout:
        '{"version":1,"command":"list","ok":false,"error":{"code":"CAPABILITY_REQUIRED","message":"Capability was denied."}}\n',
      stderr: "",
    });
  });

  it("does not place credential values in argv or machine output", async () => {
    const fixture = await createFixture((_request, requestId) => ({
      version: 0,
      requestId,
      ok: true,
      result: { operation: "listSessions", sessions: [], nextCursor: null },
    }));

    const result = await spawnCli(fixture, ["list"]);

    expect(fixture.spawnedArguments.join(" ")).not.toContain(CREDENTIAL);
    expect(result.stdout).not.toContain(CREDENTIAL);
    expect(result.stderr).not.toContain(CREDENTIAL);
  });

  it("rejects interactive commands in JSON mode before opening a terminal stream", async () => {
    const fixture = await createFixture((_request, requestId) => ({
      version: 0,
      requestId,
      ok: true,
      result: { operation: "listSessions", sessions: [], nextCursor: null },
    }));

    const result = await spawnCli(fixture, ["attach", "10000000-0000-4000-8000-000000000001"]);

    expect(result).toEqual({
      exitCode: 2,
      stdout:
        '{"version":1,"command":"attach","ok":false,"error":{"code":"USAGE","message":"attach/control are interactive; use watch --json for machine-readable events."}}\n',
      stderr: "",
    });
    expect(fixture.requests).toEqual([]);
  });
});

interface Fixture {
  readonly root: string;
  readonly socketPath: string;
  readonly credentialFile: string;
  readonly requests: unknown[];
  spawnedArguments: string[];
}

async function createFixture(
  respond: (request: IncomingMessage, requestId: string) => unknown,
): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dsv0-t08-cli-")));
  chmodSync(root, 0o700);
  const socketPath = join(root, "host.sock");
  const credentialFile = join(root, "credential");
  writeFileSync(credentialFile, `${CREDENTIAL}\n`, { mode: 0o600 });
  chmodSync(credentialFile, 0o600);
  const requests: unknown[] = [];
  const server = createServer((request, response) => {
    void handleFixtureRequest(request, response, requests, respond).catch(() => {
      response.statusCode = 500;
      response.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolvePromise);
  });
  chmodSync(socketPath, 0o600);
  return { root, socketPath, credentialFile, requests, spawnedArguments: [] };
}

async function handleFixtureRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: unknown[],
  respond: (request: IncomingMessage, requestId: string) => unknown,
): Promise<void> {
  const body = JSON.parse(await readBody(request)) as {
    readonly request: { readonly requestId: string };
  };
  requests.push(body);
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(respond(request, body.request.requestId)));
}

async function spawnCli(
  fixture: Fixture,
  commandArguments: readonly string[],
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const arguments_ = [
    "--import",
    "tsx",
    resolve("apps/cli/src/main.ts"),
    "--json",
    "--socket",
    fixture.socketPath,
    "--app-id",
    "fixture-app",
    "--credential-file",
    fixture.credentialFile,
    "--subject",
    "fixture-owner",
    ...commandArguments,
  ];
  fixture.spawnedArguments = arguments_;
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, arguments_, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (exitCode) =>
      resolvePromise({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
}

async function readBody(request: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8");
}
