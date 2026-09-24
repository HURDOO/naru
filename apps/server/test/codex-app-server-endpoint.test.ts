import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codexProtectedSocketPath,
  connectCodexAppServer,
  inspectCodexAppServerEndpoint,
} from "../src/codex-app-server-endpoint.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});
function fixture(): string {
  return join(mkdtempSync(join(realpathSync("/tmp"), "naru-endpoint-test-")), "app.sock");
}
async function listen(path: string): Promise<Server> {
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  chmodSync(path, 0o600);
  servers.push(server);
  return server;
}
async function indirect(path: string): Promise<string> {
  const physical = codexProtectedSocketPath(path);
  mkdirSync(dirname(physical), { recursive: true, mode: 0o700 });
  await listen(physical);
  symlinkSync(physical, path);
  return physical;
}
describe("Codex app-server endpoint boundary", () => {
  it("rejects an owner mismatch (mocked caller uid; no filesystem ownership mutation)", async () => {
    const path = fixture();
    await listen(path);
    const actualUid = process.getuid!();
    const uid = vi.spyOn(process, "getuid").mockReturnValue(actualUid + 1);
    try {
      expect(() => inspectCodexAppServerEndpoint(path)).toThrow("NARU_CODEX_ENDPOINT_REJECTED");
    } finally {
      uid.mockRestore();
    }
  });
  it("connects to an unchanged direct socket", async () => {
    const path = fixture();
    await listen(path);
    const endpoint = inspectCodexAppServerEndpoint(path);
    expect(endpoint.connectPath).toBe(path);
    await new Promise<void>((resolve, reject) => {
      const socket = connectCodexAppServer(endpoint);
      socket.on("error", reject);
      socket.on("close", () => resolve());
    });
  });
  it("accepts only the deterministic protected socket for this alias", async () => {
    const path = fixture();
    const physical = await indirect(path);
    expect(inspectCodexAppServerEndpoint(path).connectPath).toBe(physical);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
  });
  it("does not invalidate endpoints when unrelated system tmp entries change", async () => {
    const path = fixture();
    await indirect(path);
    const before = inspectCodexAppServerEndpoint(path);
    fixture();
    await indirect(fixture());
    expect(inspectCodexAppServerEndpoint(path).identity).toBe(before.identity);
  });
  it("rejects another pane's protected socket even with the same owner", async () => {
    const other = await indirect(fixture());
    const path = fixture();
    symlinkSync(other, path);
    expect(() => inspectCodexAppServerEndpoint(path)).toThrow("NARU_CODEX_ENDPOINT_REJECTED");
  });
  it.each(["relative", "escape", "cycle", "file", "directory"])("rejects %s endpoints", (kind) => {
    const path = fixture();
    if (kind === "file") writeFileSync(path, "fixture");
    else if (kind === "directory") mkdirSync(path, { mode: 0o700 });
    else
      symlinkSync(
        kind === "relative" ? "missing" : kind === "cycle" ? path : "/outside.invalid/socket",
        path,
      );
    expect(() => inspectCodexAppServerEndpoint(path)).toThrow("NARU_CODEX_ENDPOINT_REJECTED");
  });
  it("distinguishes a not-yet-created target from a policy violation", () => {
    const path = fixture();
    symlinkSync(codexProtectedSocketPath(path), path);
    expect(() => inspectCodexAppServerEndpoint(path)).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });
  it("rejects an additional link at the physical target", async () => {
    const path = fixture();
    const physical = codexProtectedSocketPath(path);
    const other = fixture();
    await listen(other);
    symlinkSync(other, physical);
    symlinkSync(physical, path);
    expect(() => inspectCodexAppServerEndpoint(path)).toThrow("NARU_CODEX_ENDPOINT_REJECTED");
  });
  it.each([0o666, 0o660, 0o700])("rejects physical socket mode %s", async (mode) => {
    const path = fixture();
    const physical = await indirect(path);
    chmodSync(physical, mode);
    expect(() => inspectCodexAppServerEndpoint(path)).toThrow("NARU_CODEX_ENDPOINT_REJECTED");
  });
  it("rejects a non-private or symlinked advertised parent", async () => {
    const path = fixture();
    await listen(path);
    chmodSync(dirname(path), 0o755);
    expect(() => inspectCodexAppServerEndpoint(path)).toThrow("NARU_CODEX_ENDPOINT_REJECTED");
    chmodSync(dirname(path), 0o700);
    const alias = fixture();
    symlinkSync(dirname(path), alias);
    expect(() => inspectCodexAppServerEndpoint(join(alias, "app.sock"))).toThrow(
      "NARU_CODEX_ENDPOINT_REJECTED",
    );
  });
  it("rejects alias replacement between readiness and connection", async () => {
    const path = fixture();
    const physical = await indirect(path);
    const endpoint = inspectCodexAppServerEndpoint(path);
    unlinkSync(path);
    symlinkSync(physical, path);
    expect(() => connectCodexAppServer(endpoint)).toThrow("NARU_CODEX_ENDPOINT_REJECTED");
  });
});
