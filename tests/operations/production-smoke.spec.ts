import { expect, test } from "@playwright/test";

const projectPath = process.env.NARU_PRODUCTION_SMOKE_PROJECT;
const port = process.env.NARU_PRODUCTION_SMOKE_PORT;

test("serves a clean production build and completes login, project, and PTY smoke", async ({
  page,
  request,
}) => {
  if (projectPath === undefined || port === undefined) {
    throw new Error("Production smoke fixture environment is missing.");
  }

  const health = await request.get("/healthz");
  const readiness = await request.get("/readyz");
  expect(await health.json()).toMatchObject({ status: "ok" });
  expect(await readiness.json()).toMatchObject({ status: "ready" });

  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
      browserErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.addInitScript(() => {
    let permission: NotificationPermission = "default";
    Object.defineProperty(Notification, "permission", {
      configurable: true,
      get: () => permission,
    });
    Object.defineProperty(Notification, "requestPermission", {
      configurable: true,
      value: () => {
        permission = "denied";
        const state = window as typeof window & { __naruPermissionRequests?: number };
        state.__naruPermissionRequests = (state.__naruPermissionRequests ?? 0) + 1;
        return Promise.resolve(permission);
      },
    });
  });

  await page.goto("/");
  await expect(page.locator('script[src*="/@vite/client"]')).toHaveCount(0);

  const manifestResponse = await request.get("/manifest.webmanifest");
  expect(manifestResponse.headers()["cache-control"]).toBe("no-cache");
  expect(await manifestResponse.json()).toMatchObject({
    id: "/",
    start_url: "/?source=pwa",
    scope: "/",
    display: "standalone",
  });
  const workerResponse = await request.get("/sw.js");
  expect(workerResponse.headers()["cache-control"]).toBe("no-cache, no-store, must-revalidate");
  expect(workerResponse.headers()["service-worker-allowed"]).toBe("/");

  await expect
    .poll(() =>
      page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        return registration.scope;
      }),
    )
    .toBe(`${page.url().replace(/\/$/, "")}/`);
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
  const cacheInspection = await page.evaluate(async () => {
    const names = await caches.keys();
    const shellNames = names.filter((name) => name.startsWith("naru-app-shell:/:"));
    const entries = await Promise.all(
      shellNames.map(async (name) => {
        const cache = await caches.open(name);
        return (await cache.keys()).map((request) => new URL(request.url).pathname);
      }),
    );
    const cachedApi = await Promise.all(
      shellNames.map(async (name) => (await caches.open(name)).match("/api/session")),
    );
    return { shellNames, entries: entries.flat(), cachedApi: cachedApi.some(Boolean) };
  });
  expect(cacheInspection.shellNames).toHaveLength(1);
  expect(cacheInspection.entries).toContain("/index.html");
  expect(cacheInspection.entries).toContain("/manifest.webmanifest");
  expect(cacheInspection.entries.some((entry) => entry.startsWith("/assets/"))).toBe(true);
  expect(cacheInspection.cachedApi).toBe(false);

  await page.evaluate(() => {
    const state = window as typeof window & { __naruInstallPrompted?: boolean };
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, {
      prompt: () => {
        state.__naruInstallPrompted = true;
        return Promise.resolve();
      },
      userChoice: Promise.resolve({ outcome: "accepted", platform: "e2e" }),
    });
    window.dispatchEvent(event);
  });
  const installNotice = page.locator('.pwa-shell-notice[data-kind="install"]');
  await expect(installNotice.getByText("Naru를 앱으로 설치")).toBeVisible();
  await expect(installNotice).toContainText("로그인과 터미널은 Naru 연결이 필요합니다");
  await installNotice.getByRole("button", { name: "설치", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as typeof window & { __naruInstallPrompted?: boolean }).__naruInstallPrompted,
      ),
    )
    .toBe(true);
  await expect(installNotice).toBeHidden();

  await page.context().setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Naru 서버에 연결할 수 없습니다" })).toBeVisible();
  await page.context().setOffline(false);
  await page.reload();
  await expect(page.getByRole("heading", { name: /작업의 흐름을/ })).toBeVisible();

  await page.getByRole("button", { name: "비밀번호로 로그인" }).click();
  await page.getByLabel("Naru 비밀번호").fill("naru-production-password");
  await page.getByRole("button", { name: "작업공간 열기" }).click();
  await expect(page.getByText("프로젝트를 연결해 주세요")).toBeVisible();

  await page.getByRole("button", { name: "알림", exact: true }).click();
  const pushDialog = page.getByRole("dialog", { name: "알림 관리" });
  await expect(pushDialog).toBeVisible();
  await expect(pushDialog).toContainText(
    "프로젝트명, 명령과 터미널 내용은 알림에 포함하지 않습니다",
  );
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __naruPermissionRequests?: number })
          .__naruPermissionRequests ?? 0,
    ),
  ).toBe(0);
  await pushDialog.getByRole("button", { name: "이 기기에서 켜기" }).click();
  await expect(pushDialog.getByRole("alert")).toContainText(
    "브라우저에서 알림 권한이 차단됐습니다",
  );
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __naruPermissionRequests?: number })
          .__naruPermissionRequests ?? 0,
    ),
  ).toBe(1);
  await pushDialog.getByRole("button", { name: "알림 관리 닫기" }).click();

  await page.getByLabel("서버 절대 경로").fill(projectPath);
  await page.getByLabel(/표시 이름/).fill("Production Smoke");
  await page.getByRole("button", { name: "연결하기" }).click();
  await expect(page.getByRole("heading", { name: "Production Smoke" })).toBeVisible();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page.getByLabel("Files 프로젝트 파일")).toBeVisible();

  const notificationTarget = await page.evaluate(async () => {
    const projects = (await (await fetch("/api/projects")).json()) as Array<{ id: string }>;
    const project = projects[0];
    if (!project) throw new Error("Production smoke project is missing.");
    const workspace = (await (await fetch(`/api/projects/${project.id}/workspace`)).json()) as {
      panes: Array<{ id: string; title: string }>;
    };
    const pane = workspace.panes.find((candidate) => candidate.title === "Quick Codex");
    if (!pane) throw new Error("Quick Codex Pane is missing.");
    return { projectId: project.id, paneId: pane.id };
  });
  const notificationEventId = "00000000-0000-4000-8000-000000000099";
  await page.goto(
    `/?naruProject=${notificationTarget.projectId}&naruPane=${notificationTarget.paneId}&naruEvent=${notificationEventId}`,
  );
  await expect(page.locator(`[data-pane-id="${notificationTarget.paneId}"]`)).toHaveAttribute(
    "data-active",
    "true",
  );
  await expect.poll(() => new URL(page.url()).searchParams.has("naruEvent")).toBe(false);

  const devTerminal = page.getByLabel("Dev Terminal 터미널");
  await expect(devTerminal.getByText("중지됨")).toBeVisible();
  await devTerminal.getByRole("button", { name: "터미널 다시 시작" }).click();
  await expect(devTerminal.getByText("실행 중")).toBeVisible();
  await expect(devTerminal).toHaveAttribute("data-runtime-id", /.+/);
  await expect(devTerminal).toHaveAttribute("data-restore-phase", "ready");
  const liveTerminal = devTerminal.locator(".xterm:not(.terminal-resize-freeze)");
  await expect(liveTerminal).toBeVisible();
  const terminalInput = devTerminal.locator(".xterm-helper-textarea");
  await terminalInput.focus();
  await expect(terminalInput).toBeFocused();
  await page.keyboard.insertText("printf 'NARU_PRODUCTION_SMOKE_OK\\n'");
  await page.keyboard.press("Enter");
  await expect(liveTerminal.locator(".xterm-rows")).toContainText("NARU_PRODUCTION_SMOKE_OK");

  const runtimeBeforeUpdate = await devTerminal.getAttribute("data-runtime-id");
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js?e2e-update=1", {
      scope: "/",
      updateViaCache: "none",
    });
  });
  const updateNotice = page.locator('.pwa-shell-notice[data-kind="update"]');
  await expect(updateNotice.getByText("새 버전 준비됨")).toBeVisible();
  const updateNavigation = page.waitForNavigation();
  await updateNotice.getByRole("button", { name: "지금 업데이트" }).click();
  await updateNavigation;
  await expect(page.getByRole("heading", { name: "Production Smoke" })).toBeVisible();
  await expect(page.getByLabel("Dev Terminal 터미널")).toHaveAttribute(
    "data-runtime-id",
    runtimeBeforeUpdate ?? "missing-runtime",
  );

  await page.addInitScript(() => {
    const browserMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query: string): MediaQueryList => {
      const result = browserMatchMedia(query);
      if (query === "(display-mode: standalone)") {
        Object.defineProperty(result, "matches", { configurable: true, value: true });
      }
      return result;
    };
  });
  await page.reload();
  await page.setViewportSize({ width: 360, height: 780 });
  expect(await page.evaluate(() => matchMedia("(display-mode: standalone)").matches)).toBe(true);
  await expect(page.locator("html")).toHaveAttribute("data-naru-display-mode", "standalone");
  await expect
    .poll(() =>
      page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        appHeight: document.querySelector(".app-shell")?.getBoundingClientRect().height ?? 0,
      })),
    )
    .toMatchObject({ clientWidth: 360, scrollWidth: 360, appHeight: 780 });
  expect(browserErrors).toEqual([]);

  await expect(
    fetch(`http://10.23.45.10:${port}/healthz`, {
      signal: AbortSignal.timeout(750),
    }),
  ).rejects.toThrow();
});
