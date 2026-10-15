import { generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, symlink, realpath } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGatewayAssertion } from "@naru/gateway-verifier";
import type { GatewayPrincipalV1 } from "@naru/contracts/workstation-gateway/v1";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenCodeGateway } from "../src/server.js";
import type { OpenCodeGatewayConfig } from "../src/config.js";

const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of close.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "naru-opencode-fixture-")));
  const ui = join(root, "ui");
  const project = join(root, "projects");
  await mkdir(ui);
  await mkdir(project);
  await writeFile(join(ui, "index.html"), "<html>OpenCode</html>");
  await writeFile(join(root, "private.txt"), "outside");
  await symlink(join(root, "private.txt"), join(ui, "escape.txt"));
  const seen: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const backend = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
      seen.push({
        url: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks).toString(),
      });
      if (request.url === "/global/event") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: first\n\n");
        setTimeout(() => response.end("data: second\n\n"), 20);
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end('{"ok":true}');
    })();
  });
  const ws = new WebSocketServer({ server: backend });
  ws.on("connection", (socket, request) => {
    seen.push({ url: request.url ?? "", headers: request.headers, body: "ws" });
    socket.on("message", (data, binary) => socket.send(data, { binary }));
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  close.push(async () => {
    for (const socket of ws.clients) socket.terminate();
    ws.close();
    backend.closeAllConnections();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  });
  const keys = generateKeyPairSync("ed25519");
  const config: OpenCodeGatewayConfig = {
    version: 1,
    issuer: "gateway-fixture",
    audience: "omo",
    ownerSubject: "owner-fixture",
    browserOrigin: "https://naru.example.test",
    listenPort: 4097,
    upstreamPort: (backend.address() as AddressInfo).port,
    routePrefix: "/omo",
    uiRoot: ui,
    verifierKeysFile: join(root, "keys.json"),
    passwordFile: join(root, "password"),
    opencodeExecutable: join(root, "opencode"),
    opencodeSha256: "0".repeat(64),
    defaultDirectory: project,
    allowedProjectRoots: [project],
  };
  const adapter = createOpenCodeGateway({
    config,
    password: "fixture-backend-password",
    keys: new Map([["fixture-key", keys.publicKey]]),
  });
  adapter.server.listen(0, "127.0.0.1");
  await once(adapter.server, "listening");
  close.push(() => adapter.close());
  const origin = `http://127.0.0.1:${(adapter.server.address() as AddressInfo).port}`;
  const assertion = (overrides: Partial<GatewayPrincipalV1> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return createGatewayAssertion(
      {
        version: 1,
        iss: config.issuer,
        aud: "omo",
        sub: config.ownerSubject,
        authTime: now - 60,
        methods: ["passkey"],
        userVerified: true,
        origin: config.browserOrigin,
        ingressProfile: "fixture",
        issuedAt: now,
        expiresAt: now + 30,
        assertionId: randomUUID(),
        ...overrides,
      },
      "fixture-key",
      keys.privateKey,
    );
  };
  const headers = () => ({ "x-workstation-gateway-assertion": assertion() });
  return { origin, config, root, seen, assertion, headers };
}

describe("OpenCode Gateway adapter", () => {
  it("exposes approved picker folders only after app assertion verification", async () => {
    const f = await fixture();
    expect((await fetch(`${f.origin}/api/_naru/project-roots`)).status).toBe(401);
    const response = await fetch(`${f.origin}/api/_naru/project-roots`, { headers: f.headers() });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      version: 1,
      defaultDirectory: f.config.defaultDirectory,
      roots: f.config.allowedProjectRoots,
    });
    expect(f.seen).toEqual([]);
  });
  it("denies unsigned, other-app, wrong-owner, expired and replayed assertions", async () => {
    const f = await fixture();
    expect((await fetch(f.origin)).status).toBe(401);
    for (const token of [
      f.assertion({ aud: "other-app" }),
      f.assertion({ sub: "other-owner" }),
      f.assertion({ issuedAt: 1, expiresAt: 2, authTime: 0 }),
    ]) {
      expect(
        (await fetch(f.origin, { headers: { "x-workstation-gateway-assertion": token } })).status,
      ).toBe(401);
    }
    const token = f.assertion();
    expect(
      (await fetch(f.origin, { headers: { "x-workstation-gateway-assertion": token } })).status,
    ).toBe(200);
    expect(
      (await fetch(f.origin, { headers: { "x-workstation-gateway-assertion": token } })).status,
    ).toBe(401);
    expect(
      (await fetch(f.origin, { headers: { ...f.headers(), origin: "https://other.example.test" } }))
        .status,
    ).toBe(403);
  });
  it("serves SPA routes, denies missing assets and symlink escape", async () => {
    const f = await fixture();
    expect(
      await (await fetch(`${f.origin}/project/session/fixture`, { headers: f.headers() })).text(),
    ).toContain("OpenCode");
    expect((await fetch(`${f.origin}/assets/missing.js`, { headers: f.headers() })).status).toBe(
      404,
    );
    expect((await fetch(`${f.origin}/escape.txt`, { headers: f.headers() })).status).toBe(403);
  });
  it("forwards API writes with internal auth and strips browser identities and cookies", async () => {
    const f = await fixture();
    const body = '{"title":"fixture"}';
    const response = await fetch(
      `${f.origin}/api/session?directory=${encodeURIComponent(f.config.defaultDirectory)}`,
      {
        method: "POST",
        body,
        headers: {
          ...f.headers(),
          "content-type": "application/json",
          cookie: "gateway=fixture",
          authorization: "Basic browser-value",
          "x-workstation-gateway-csrf": "fixture-csrf",
          "x-forwarded-for": "192.0.2.1",
        },
      },
    );
    expect(response.status).toBe(200);
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0]?.body).toBe(body);
    expect(f.seen[0]?.url).toMatch(/^\/session\?/);
    expect(f.seen[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from("opencode:fixture-backend-password").toString("base64")}`,
    );
    for (const name of [
      "cookie",
      "x-workstation-gateway-assertion",
      "x-workstation-gateway-csrf",
      "x-forwarded-for",
    ])
      expect(f.seen[0]?.headers[name]).toBeUndefined();
  });
  it("rejects outside directories in query, encoded header, body and symlink targets", async () => {
    const f = await fixture();
    await symlink(f.root, join(f.config.defaultDirectory, "escape"));
    for (const directory of [f.root, join(f.config.defaultDirectory, "escape")]) {
      expect(
        (
          await fetch(`${f.origin}/api/path?directory=${encodeURIComponent(directory)}`, {
            headers: f.headers(),
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await fetch(`${f.origin}/api/path`, {
          headers: { ...f.headers(), "x-opencode-directory": encodeURIComponent(f.root) },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${f.origin}/api/session`, {
          method: "POST",
          headers: { ...f.headers(), "content-type": "application/json" },
          body: JSON.stringify({ location: { directory: f.root } }),
        })
      ).status,
    ).toBe(403);
    expect(f.seen).toHaveLength(0);
  });
  it("streams SSE and preserves authenticated binary WebSocket traffic through reconnect", async () => {
    const f = await fixture();
    const response = await fetch(`${f.origin}/api/global/event`, { headers: f.headers() });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toContain("data: second");
    for (let connection = 0; connection < 2; connection += 1) {
      const socket = new WebSocket(`${f.origin.replace("http:", "ws:")}/api/pty/fixture/connect`, {
        headers: f.headers(),
      });
      await once(socket, "open");
      socket.send(Buffer.from([0, 1, 255]));
      const [data, binary] = (await once(socket, "message")) as [Buffer, boolean];
      expect([...data]).toEqual([0, 1, 255]);
      expect(binary).toBe(true);
      socket.close();
      await once(socket, "close");
    }
    expect(f.seen.filter((item) => item.body === "ws")).toHaveLength(2);
  });
});
