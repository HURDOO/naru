import { spawn, execFileSync } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";
import { createGatewayTestFixture } from "../../../apps/workstation-gateway/test/support.js";
import { WorkstationGateway } from "../../../apps/workstation-gateway/src/gateway.js";
import { createOpenCodeGateway } from "../../../apps/opencode-gateway/src/server.js";
import type { OpenCodeGatewayConfig } from "../../../apps/opencode-gateway/src/config.js";

const uiRoot = realpathSync(process.argv[2] ?? "");
const executable = realpathSync(process.argv[3] ?? "");
const root = realpathSync(mkdtempSync(join(tmpdir(), "omo-ui-smoke-")));
const project = join(root, "project");
mkdirSync(project);
writeFileSync(join(project, "README.md"), "Synthetic mobile session fixture.\n");
execFileSync("/usr/bin/git", ["init", "-q", project]);
const key = join(root, "tls-key.pem");
const certificate = join(root, "tls-certificate.pem");
execFileSync(
  "/usr/bin/openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    certificate,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
  ],
  { stdio: "ignore" },
);
const tls = createHttpsServer({ key: readFileSync(key), cert: readFileSync(certificate) });
tls.listen(0, "127.0.0.1");
await once(tls, "listening");
const origin = `https://localhost:${(tls.address() as AddressInfo).port}`;
const password = randomBytes(32).toString("base64url");
// This OpenCode process gets a fixture-only data/cache home; it cannot alter live sessions or logins.
const backend = spawn(
  executable,
  ["serve", "--hostname", "127.0.0.1", "--port", "0", "--cors", origin, "--log-level", "ERROR"],
  {
    cwd: project,
    env: {
      ...process.env,
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
      OPENCODE_SERVER_PASSWORD: password,
      OMO_SEND_ANONYMOUS_TELEMETRY: "0",
      OMO_DISABLE_POSTHOG: "1",
    },
    stdio: ["ignore", "pipe", "ignore"],
  },
);
let output = "";
backend.stdout.on("data", (chunk: Buffer) => {
  output += chunk.toString();
});
let adapter: ReturnType<typeof createOpenCodeGateway> | undefined;
let gateway: WorkstationGateway | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  let upstreamPort = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
    if (match?.[1]) {
      upstreamPort = Number(match[1]);
      break;
    }
    if (backend.exitCode !== null) throw new Error("Fixture OpenCode stopped.");
    await setTimeout(500);
  }
  if (!upstreamPort) throw new Error("Fixture OpenCode readiness timeout.");
  const fixture = createGatewayTestFixture({ browserOrigin: origin });
  const config: OpenCodeGatewayConfig = {
    version: 1,
    issuer: fixture.config.instanceId,
    audience: "omo",
    ownerSubject: fixture.config.ownerSubject,
    browserOrigin: origin,
    listenPort: 4097,
    upstreamPort,
    routePrefix: "/omo",
    uiRoot,
    verifierKeysFile: join(root, "unused-keys"),
    passwordFile: join(root, "unused-password"),
    opencodeExecutable: executable,
    opencodeSha256: "0".repeat(64),
    defaultDirectory: project,
    allowedProjectRoots: [project],
  };
  // Gateway and adapter share this fixture's generated signing key, exactly as independent managed apps do.
  const { loadOrCreateGatewayKeys } = await import("../../../apps/workstation-gateway/src/keys.js");
  const keys = loadOrCreateGatewayKeys(fixture.config.dataDirectory);
  adapter = createOpenCodeGateway({
    config,
    password,
    keys: new Map([[keys.signingKeyId, keys.signingPublicKey]]),
  });
  adapter.server.listen(0, "127.0.0.1");
  await once(adapter.server, "listening");
  gateway = await WorkstationGateway.create({
    ...fixture.config,
    appRegistrations: [
      {
        appId: "omo",
        mode: "gateway-managed",
        routePrefix: "/omo",
        upstream: {
          kind: "loopback",
          origin: `http://127.0.0.1:${(adapter.server.address() as AddressInfo).port}`,
        },
        enabled: true,
        includeCredentialRef: false,
      },
    ],
  });
  await gateway.browser.listen({ host: "127.0.0.1", port: 0 });
  const gatewayPort = (gateway.browser.server.address() as AddressInfo).port;
  tls.on("request", (request, response) => {
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: gatewayPort,
        method: request.method,
        path: request.url,
        headers: request.headers,
      },
      (result) => {
        response.writeHead(result.statusCode ?? 502, result.headers);
        result.pipe(response);
      },
    );
    upstream.on("error", () => {
      response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
    response.on("close", () => upstream.destroy());
  });
  gateway.repository.createCredential({
    credentialRecordId: "fixture-credential",
    credentialId: "fixture-browser",
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 0,
    transports: [],
    deviceType: "multiDevice",
    backedUp: true,
    createdAt: gateway.nowMs(),
  });
  const session = gateway.sessions.create({
    subject: gateway.config.ownerSubject,
    credentialRecordId: "fixture-credential",
    credentialId: "fixture-browser",
    authTime: Math.floor(gateway.nowMs() / 1000),
  });
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const mobileCreate = process.argv.includes("--mobile-create");
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    ...(mobileCreate
      ? { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true }
      : {}),
  });
  await context.addCookies([
    {
      name: gateway.config.sessionCookieName,
      value: session.token,
      domain: "localhost",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  const page = await context.newPage();
  await page.addInitScript(() => {
    const errors: string[] = [];
    Object.assign(window, { fixtureUiErrorTitles: errors });
    new MutationObserver(() => {
      for (const heading of document.querySelectorAll("h1")) {
        if (/문제가 발생했습니다|Something went wrong/.test(heading.textContent ?? ""))
          errors.push(heading.textContent ?? "");
      }
    }).observe(document, { childList: true, subtree: true });
  });
  const errors: string[] = [];
  const failures: string[] = [];
  let eventConnected = false;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/omo/api/global/event" && response.status() === 200)
      eventConnected = true;
    if (response.status() >= 400)
      failures.push(new URL(response.url()).pathname + ":" + String(response.status()));
  });
  await page.goto(`${origin}/omo/`);
  await page.waitForTimeout(3000);
  console.log("UI text:", (await page.locator("body").innerText()).slice(0, 800));
  console.log("UI errors:", errors);
  console.log("HTTP failures:", [...new Set(failures)]);
  if (mobileCreate) {
    await page
      .getByRole("banner")
      .getByRole("button", { name: /^새 세션$|^New session$/ })
      .tap();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const add = page.locator('[data-action="home-add-project"]:visible');
    if (await add.count()) await add.tap();
    else await page.getByRole("button", { name: /^(프로젝트 열기|Open project)$/ }).tap();
    await page.getByRole("dialog").waitFor();
    const folder = page
      .getByRole("dialog")
      .locator(`[data-directory-path=${JSON.stringify(project)}]`);
    await expect(folder).toBeVisible();
    await page
      .getByRole("dialog")
      .getByPlaceholder(/폴더 검색|Search folders/)
      .fill("project");
    await expect(folder).toBeVisible();
    await page
      .getByRole("dialog")
      .getByPlaceholder(/폴더 검색|Search folders/)
      .fill(project);
    await expect(folder).toBeVisible();
    await page.screenshot({ path: join(root, "mobile-project-dialog.png") });
    await folder.tap();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page
      .getByRole("banner")
      .getByRole("button", { name: /^새 세션$|^New session$/ })
      .tap();
    const editor = page.locator('[contenteditable="true"]:visible').first();
    await expect(editor).toBeVisible();
    await page.route("**/omo/api/session/*/prompt_async*", async (route) =>
      route.fulfill({ status: 204 }),
    );
    await page.route("**/omo/api/api/session/*/prompt*", async (route) =>
      route.fulfill({ status: 204 }),
    );
    await editor.fill("Synthetic mobile session creation. No model invocation.");
    const [response] = await Promise.all([
      page.waitForResponse(
        (response) =>
          /\/omo\/api\/(?:api\/)?session$/.test(new URL(response.url()).pathname) &&
          response.request().method() === "POST",
      ),
      page.getByRole("button", { name: /^전송$|^보내기$|Send|메시지 보내기/ }).tap(),
    ]).catch(async (error: unknown) => {
      console.log(
        "Mobile creation failure:",
        (await page.locator("body").innerText()).slice(0, 3000),
      );
      console.log("Requests:", [...new Set(failures)]);
      throw error;
    });
    expect(response.status()).toBe(200);
    const value = (await response.json()) as { id?: string };
    expect(value.id).toBeTruthy();
    await expect(page).toHaveURL(new RegExp(value.id!));
    await expect(page.locator('[contenteditable="true"]:visible').first()).toBeVisible();
    await page.screenshot({ path: join(root, "mobile-session-created.png") });
    eventConnected = false;
    await page.reload();
    await expect(page).toHaveURL(new RegExp(value.id!));
    await expect(page.locator('[contenteditable="true"]:visible').first()).toBeVisible();
    await expect.poll(() => eventConnected).toBe(true);
    await page
      .getByRole("banner")
      .getByRole("button", { name: /^새 세션$|^New session$/ })
      .tap();
    await expect(page).toHaveURL(/\/omo\/new-session\?draftId=/);
    await expect(page.locator('[contenteditable="true"]:visible').first()).toBeVisible();
    await page
      .getByRole("banner")
      .getByRole("button", { name: /^탭 닫기$|^Close tab$/ })
      .last()
      .tap();
    await expect(page).toHaveURL(new RegExp(value.id!));
    console.log(
      "Mobile folders, first-message creation, reload/reconnect and second draft handoff passed.",
    );
  }
  for (const width of [1440, 768, 360]) {
    await page.setViewportSize({ width, height: width === 360 ? 740 : 900 });
    await page.screenshot({ path: join(root, `ui-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.tagName !== "BODY")).toBe(true);
    expect(await page.locator(":focus-visible").count()).toBeGreaterThan(0);
    await page.screenshot({ path: join(root, `focus-${width}.png`) });
  }
  await page.setViewportSize({ width: 360, height: 520 });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (mobileCreate) {
    const editorBox = await page.locator('[contenteditable="true"]:visible').first().boundingBox();
    expect(editorBox).toBeTruthy();
    expect(editorBox!.y + editorBox!.height).toBeLessThanOrEqual(520);
    const send = page.getByRole("button", { name: /^전송$|^보내기$|Send|메시지 보내기/ });
    const sendBox = await send.boundingBox();
    expect(sendBox).toBeTruthy();
    expect(sendBox!.y + sendBox!.height).toBeLessThanOrEqual(520);
    expect(
      await send.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
        );
      }),
    ).toBe(true);
  }
  await page.screenshot({ path: join(root, "ui-dynamic-viewport.png") });
  const result = await page.evaluate(async (prefix) => {
    const session = (await fetch("/_gateway/session", { credentials: "same-origin" }).then(
      (response) => response.json(),
    )) as { csrfToken: string };
    const response = await fetch(`${prefix}/omo/api/session`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "x-workstation-gateway-csrf": session.csrfToken,
      },
      body: JSON.stringify({ title: "Gateway fixture session" }),
    });
    return { status: response.status, value: (await response.json()) as { id?: string } };
  }, origin);
  expect(result.status).toBe(200);
  expect(result.value.id).toBeTruthy();
  expect(errors).toEqual([]);
  expect(failures).toEqual([]);
  expect(eventConnected).toBe(true);
  expect(await page.evaluate(() => Reflect.get(window, "fixtureUiErrorTitles") as unknown)).toEqual(
    [],
  );
  console.log("UI, authenticated session creation and viewport/focus smoke passed. Fixture:", root);
} finally {
  await browser?.close();
  await gateway?.close();
  await adapter?.close();
  tls.closeAllConnections();
  await new Promise<void>((resolve) => tls.close(() => resolve()));
  backend.kill("SIGTERM");
  await setTimeout(500);
  if (backend.exitCode === null) backend.kill("SIGKILL");
}
