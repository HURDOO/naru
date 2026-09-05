import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, scryptSync } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AttachmentLease,
  DurableSessionCallerContext,
  DurableSessionEvent,
} from "../../packages/contracts/src/durable-session/v0/index.js";
import { DurableSessionClient } from "../../packages/durable-session-client/src/index.js";
import {
  readPrivateCredentialFile,
  UdsWebSocketDurableSessionTransport,
} from "../../packages/durable-session-client/src/node.js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { DurableSessionHostConfigSchema } from "../../apps/durable-session-host/src/config.js";
import {
  startDurableSessionHost,
  type RunningDurableSessionHost,
} from "../../apps/durable-session-host/src/host.js";
import { silentHostLogger } from "../../apps/durable-session-host/src/logging.js";
import { MemoryMetadataRepository } from "../../apps/durable-session-host/src/metadata.js";
import {
  createHostFixture,
  FakeRuntimePort,
} from "../../apps/durable-session-host/test/support.js";
import type { DurableHostConfig } from "../../apps/server/src/durable-session-host-client.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

test.describe.configure({ mode: "serial", timeout: 45_000 });

test("projects external request, reject, approve, accept, and user preempt through Host", async ({
  browser,
}) => {
  const fixture = createHostFixture();
  const projectRoot = fixture.config.roots[0];
  const baseProfile = fixture.config.profiles[0];
  if (projectRoot === undefined || baseProfile === undefined) {
    throw new Error("Durable control fixture is incomplete.");
  }
  const hostConfig = DurableSessionHostConfigSchema.parse({
    ...fixture.config,
    profiles: ["shell", "codex-main", "codex-quick"].map((profileId) => ({
      ...baseProfile,
      profileId,
      args: [profileId],
    })),
    appRegistrations: fixture.config.appRegistrations.map((registration) => ({
      ...registration,
      profileScope: {
        kind: "ids",
        ids: ["shell", "codex-main", "codex-quick"],
      },
    })),
    integrationPolicies: [
      {
        policyRef: "naru-codex-v0",
        appId: "fixture-app",
        integrationKind: "codex",
        profileIds: ["codex-main", "codex-quick"],
        configKeys: ["policyRef", "bindingId"],
      },
    ],
  });
  const runtime = new FakeRuntimePort();
  const durableConfig = durableHostConfig(
    fixture,
    hostConfig.profiles.map((profile) => profile.profileId),
  );
  const apiPort = await reservePort();
  const webPort = await reservePort();
  const webOrigin = `http://127.0.0.1:${webPort}`;
  let host: RunningDurableSessionHost | null = null;
  let naru: ChildProcess | null = null;
  let vite: ChildProcess | null = null;
  let context: BrowserContext | null = null;
  let requester: ExternalRequester | null = null;

  try {
    host = await startDurableSessionHost(hostConfig, {
      metadata: new MemoryMetadataRepository(),
      runtime,
      logger: silentHostLogger,
      hostEnvironment: {},
    });
    naru = startNaru(fixture, durableConfig, apiPort, webOrigin);
    await waitForServer(`http://127.0.0.1:${apiPort}/healthz`, naru, "Naru");
    vite = startVite(apiPort, webPort);
    await waitForServer(webOrigin, vite, "Vite");

    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const browserErrors = collectBrowserErrors(page);
    await signIn(page, webOrigin);
    await page.getByLabel("서버 절대 경로").fill(join(projectRoot.path, "sample"));
    await page.getByLabel(/표시 이름/).fill("Durable Control E2E");
    await page.getByRole("button", { name: "연결하기" }).click();
    await expect(page.getByRole("heading", { name: "Durable Control E2E" })).toBeVisible();

    const mainCodex = page.getByLabel("Main Codex Codex");
    await expect(mainCodex).toHaveAttribute("data-control-role", "controller");
    const mainRuntime = await waitForRuntime(runtime, "codex-main");
    requester = await openRequester(durableConfig, mainRuntime.request.sessionId);

    const rejectedRequest = await requestControl(requester);
    const rejected = waitForAttachmentEvent(
      requester.transport,
      requester.lease.attachmentId,
      "control.request-resolved",
    );
    const requestBanner = page.locator(".control-request-banner");
    await expect(requestBanner).toContainText("외부 도구가 Main Codex 제어권을 요청했습니다.");
    await requestBanner.getByRole("button", { name: "거절" }).click();
    expect(await rejected).toMatchObject({
      controlRequestId: rejectedRequest.request.controlRequestId,
      resolution: "rejected",
    });
    await expect(requestBanner).toBeHidden();
    await expect(mainCodex).toHaveAttribute("data-control-role", "controller");

    const approvedRequest = await requestControl(requester);
    const offered = waitForAttachmentEvent(
      requester.transport,
      requester.lease.attachmentId,
      "control.offered",
    );
    await expect(requestBanner).toContainText("외부 도구가 Main Codex 제어권을 요청했습니다.");
    await requestBanner.getByRole("button", { name: "승인" }).click();
    await expect(requestBanner).toContainText("요청자 응답을 기다리는 중입니다.");
    const offer = await offered;
    expect(offer.offer.controlRequestId).toBe(approvedRequest.request.controlRequestId);
    const accepted = await requester.client.request({
      operation: "acceptControl",
      sessionId: requester.lease.sessionId,
      attachmentId: requester.lease.attachmentId,
      expectedRuntimeId: requester.lease.runtimeId,
      expectedControllerGeneration: offer.controllerGeneration,
      controlOfferId: offer.offer.controlOfferId,
      idempotencyKey: randomUUID(),
      terminal: { cols: 88, rows: 26 },
    });
    await expect(mainCodex).toHaveAttribute("data-control-role", "observer");
    await expect(mainCodex.getByText("외부 제어 중")).toBeVisible();
    await expect(mainCodex.locator(".terminal-host")).toHaveAttribute("tabindex", "0");
    await expect(requestBanner).toBeHidden();

    const runtimeRecord = runtime.records.find(
      (record) => record.request.runtimeId === requester?.lease.runtimeId,
    );
    if (runtimeRecord === undefined) throw new Error("Main Codex fake runtime is missing.");
    await requester.client.request({
      operation: "sendInput",
      sessionId: requester.lease.sessionId,
      attachmentId: requester.lease.attachmentId,
      expectedRuntimeId: requester.lease.runtimeId,
      expectedControllerGeneration: accepted.control.controllerGeneration,
      inputId: randomUUID(),
      data: "EXTERNAL_ACCEPTED\r",
    });
    expect(runtimeRecord.writes.join("")).toContain("EXTERNAL_ACCEPTED");

    const browserInput = mainCodex.locator(".xterm-helper-textarea");
    await browserInput.focus();
    await page.keyboard.type("BROWSER_STALE_INPUT");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(100);
    expect(runtimeRecord.writes.join("")).not.toContain("BROWSER_STALE_INPUT");

    await requester.client.request({
      operation: "releaseControl",
      sessionId: requester.lease.sessionId,
      attachmentId: requester.lease.attachmentId,
      expectedControllerGeneration: accepted.control.controllerGeneration,
    });
    await expect(mainCodex).toHaveAttribute("data-control-role", "controller");

    await requester.transport.close();
    requester = await openRequester(durableConfig, mainRuntime.request.sessionId);
    const preemptedRequest = await requestControl(requester);
    const preemptedOfferPromise = waitForAttachmentEvent(
      requester.transport,
      requester.lease.attachmentId,
      "control.offered",
    );
    await expect(requestBanner).toContainText("외부 도구가 Main Codex 제어권을 요청했습니다.");
    await requestBanner.getByRole("button", { name: "승인" }).click();
    const preemptedOffer = await preemptedOfferPromise;
    expect(preemptedOffer.offer.controlRequestId).toBe(preemptedRequest.request.controlRequestId);
    const preemptedAcceptance = await requester.client.request({
      operation: "acceptControl",
      sessionId: requester.lease.sessionId,
      attachmentId: requester.lease.attachmentId,
      expectedRuntimeId: requester.lease.runtimeId,
      expectedControllerGeneration: preemptedOffer.controllerGeneration,
      controlOfferId: preemptedOffer.offer.controlOfferId,
      idempotencyKey: randomUUID(),
      terminal: { cols: 90, rows: 28 },
    });
    await expect(mainCodex).toHaveAttribute("data-control-role", "observer");

    await mainCodex.getByRole("button", { name: "Pane 제어권 가져오기" }).click();
    await expect(mainCodex).toHaveAttribute("data-control-role", "controller");
    let externalStaleRejected = false;
    try {
      await requester.client.request({
        operation: "sendInput",
        sessionId: requester.lease.sessionId,
        attachmentId: requester.lease.attachmentId,
        expectedRuntimeId: requester.lease.runtimeId,
        expectedControllerGeneration: preemptedAcceptance.control.controllerGeneration,
        inputId: randomUUID(),
        data: "EXTERNAL_STALE_INPUT\r",
      });
    } catch {
      externalStaleRejected = true;
    }
    expect(externalStaleRejected).toBe(true);
    expect(runtimeRecord.writes.join("")).not.toContain("EXTERNAL_STALE_INPUT");

    await browserInput.focus();
    await page.keyboard.type("NARU_PREEMPT_OK");
    await page.keyboard.press("Enter");
    await expect.poll(() => runtimeRecord.writes.join("")).toContain("NARU_PREEMPT_OK");
    expect(browserErrors).toEqual([]);
  } finally {
    await requester?.transport.close().catch(() => undefined);
    await context?.close().catch(() => undefined);
    if (vite !== null) await stopChild(vite);
    if (naru !== null) await stopChild(naru);
    await host?.close().catch(() => undefined);
  }
});

interface ExternalRequester {
  readonly transport: UdsWebSocketDurableSessionTransport;
  readonly client: DurableSessionClient;
  readonly lease: AttachmentLease;
}

function durableHostConfig(
  fixture: ReturnType<typeof createHostFixture>,
  profileIds: readonly string[],
): DurableHostConfig {
  return {
    owner: "durable-host",
    socketPath: fixture.config.socketPath,
    credentialFile: fixture.credentialFile,
    appId: "fixture-app",
    subject: "fixture-owner",
    callerTtlMs: 50_000,
    idempotencyTtlMs: fixture.config.idempotencyTtlMs,
    profileIds,
    roots: fixture.config.roots,
  };
}

async function openRequester(
  config: DurableHostConfig,
  sessionId: string,
): Promise<ExternalRequester> {
  const callerContext: DurableSessionCallerContext = {
    appId: config.appId,
    subject: config.subject,
    capabilities: ["session:observe", "control:request"],
    sessionScope: { kind: "all" },
    profileScope: { kind: "ids", ids: [...config.profileIds] },
    rootScope: { kind: "ids", ids: config.roots.map((root) => root.rootId) },
    expiresAtMs: Date.now() + config.callerTtlMs,
  };
  const transport = await UdsWebSocketDurableSessionTransport.connect({
    socketPath: config.socketPath,
    appId: config.appId,
    credential: readPrivateCredentialFile(config.credentialFile),
    callerContext,
    operationTimeoutMs: 35_000,
  });
  const client = new DurableSessionClient({ transport, callerContext });
  const opened = await client
    .request({
      operation: "openAttachment",
      sessionId,
      clientInstanceId: randomUUID(),
    })
    .catch((error: unknown) => {
      const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
      throw new Error(`External requester could not open its Host attachment (${code}).`, {
        cause: error,
      });
    });
  return { transport, client, lease: opened.attachment };
}

function requestControl(requester: ExternalRequester) {
  return requester.client.request({
    operation: "requestControl",
    sessionId: requester.lease.sessionId,
    attachmentId: requester.lease.attachmentId,
    expectedControllerGeneration: requester.lease.controllerGeneration,
  });
}

async function waitForAttachmentEvent<T extends DurableSessionEvent["type"]>(
  transport: UdsWebSocketDurableSessionTransport,
  attachmentId: string,
  type: T,
): Promise<Extract<DurableSessionEvent, { type: T }>> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 5_000);
  try {
    for (;;) {
      const frame = await transport.nextAttachmentEvent({ signal: timeout.signal });
      if (frame.attachmentId !== attachmentId || frame.event.type !== type) continue;
      return frame.event as Extract<DurableSessionEvent, { type: T }>;
    }
  } finally {
    clearTimeout(timer);
  }
}

async function signIn(page: Page, origin: string): Promise<void> {
  await page.goto(origin);
  await page.getByRole("button", { name: "비밀번호로 로그인" }).click();
  await page.getByLabel("Naru 비밀번호").fill("naru-test-password");
  await page.getByRole("button", { name: "작업공간 열기" }).click();
  await expect(page.getByText("프로젝트를 연결해 주세요")).toBeVisible();
}

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

function startNaru(
  fixture: ReturnType<typeof createHostFixture>,
  config: DurableHostConfig,
  apiPort: number,
  webOrigin: string,
): ChildProcess {
  const cleanEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) => value !== undefined && name !== "NODE_ENV" && !name.startsWith("NARU_"),
    ),
  );
  const roots = Object.fromEntries(config.roots.map((root) => [root.rootId, root.path]));
  return spawn(join(repositoryRoot, "node_modules/.bin/tsx"), ["src/index.ts"], {
    cwd: join(repositoryRoot, "apps/server"),
    env: {
      ...cleanEnvironment,
      NODE_ENV: "test",
      NARU_AUTH_MODE: "app-managed",
      NARU_HOST: "127.0.0.1",
      NARU_PORT: String(apiPort),
      NARU_ALLOWED_ORIGINS: webOrigin,
      NARU_PROJECT_ROOTS: config.roots.map((root) => root.path).join(","),
      NARU_PASSWORD_HASH: e2ePasswordHash(),
      NARU_SESSION_SECRET: "durable-control-e2e-session-secret-2026",
      NARU_SESSION_COOKIE_NAME: "naru_durable_control_e2e",
      NARU_DATA_DIR: join(fixture.root, "naru-data"),
      NARU_CODEX_PATH: join(repositoryRoot, "tests/fixtures/fake-codex.mjs"),
      NARU_SESSION_OWNER: "durable-host",
      NARU_DURABLE_SESSION_SOCKET_PATH: config.socketPath,
      NARU_DURABLE_SESSION_CREDENTIAL_FILE: config.credentialFile,
      NARU_DURABLE_SESSION_APP_ID: config.appId,
      NARU_DURABLE_SESSION_SUBJECT: config.subject,
      NARU_DURABLE_SESSION_CALLER_TTL_MS: String(config.callerTtlMs),
      NARU_DURABLE_SESSION_IDEMPOTENCY_TTL_MS: String(config.idempotencyTtlMs),
      NARU_DURABLE_SESSION_PROFILE_IDS: JSON.stringify(config.profileIds),
      NARU_DURABLE_SESSION_ROOTS: JSON.stringify(roots),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function e2ePasswordHash(): string {
  const salt = Buffer.from("naru-durable-control-e2e");
  const hash = scryptSync("naru-test-password", salt, 64, {
    N: 32_768,
    r: 8,
    p: 1,
    maxmem: 64 * 1_024 * 1_024,
  });
  return ["scrypt", "32768", "8", "1", salt.toString("base64url"), hash.toString("base64url")].join(
    "$",
  );
}

type FakeRuntimeRecord = FakeRuntimePort["records"][number];

async function waitForRuntime(
  runtime: FakeRuntimePort,
  profileId: string,
): Promise<FakeRuntimeRecord> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const record = runtime.records.find(
      (candidate) => candidate.request.launch.args[0] === profileId,
    );
    if (record !== undefined) return record;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for Host runtime profile ${profileId}.`);
}

function startVite(apiPort: number, webPort: number): ChildProcess {
  return spawn(join(repositoryRoot, "apps/web/node_modules/.bin/vite"), ["--host", "127.0.0.1"], {
    cwd: join(repositoryRoot, "apps/web"),
    env: {
      ...process.env,
      NARU_API_PORT: String(apiPort),
      NARU_WEB_PORT: String(webPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForServer(origin: string, child: ChildProcess, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let output = "";
  child.stdout?.on("data", (chunk) => (output += String(chunk)));
  child.stderr?.on("data", (chunk) => (output += String(chunk)));
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited early.\n${output}`);
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch {
      // The isolated process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for isolated ${label}.\n${output}`);
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Port allocation failed.");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
}
