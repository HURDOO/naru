import { expect, test, type CDPSession, type Page } from "@playwright/test";

const projectPath = "/private/tmp/naru-e2e-projects/public/editor";

test.use({
  hasTouch: true,
  viewport: { width: 360, height: 780 },
  // This exercises Chromium with Samsung's UA, not the Samsung Internet engine.
  userAgent:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36",
});

test("selects and copies terminal output with touch without breaking scroll or focus", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "http://localhost:4991",
  });
  await openTerminal(page);
  const surface = page.getByLabel("Dev Terminal 터미널");
  const input = surface.locator(".xterm-helper-textarea");
  await input.focus();
  await page.keyboard.insertText("printf 'T44_COPY_한글_😀\\n'");
  await page.keyboard.press("Enter");
  const outputRow = surface
    .locator(".xterm:not(.terminal-resize-freeze) .xterm-rows > div")
    .filter({ hasText: "T44_COPY_한글_😀" })
    .last();
  await expect(outputRow).toBeVisible();
  await expect(outputRow.locator("xpath=following-sibling::div[1]")).toHaveText(/[$%]\s*$/);
  const rowBounds = await outputRow.boundingBox();
  if (!rowBounds) throw new Error("Output row has no bounds.");
  const cdp = await context.newCDPSession(page);
  const touchX = rowBounds.x + 24;
  const touchY = rowBounds.y + rowBounds.height / 2;
  await input.focus();
  await dispatchTouch(cdp, "touchStart", touchX, touchY);
  await page.waitForTimeout(550);
  await expect(
    surface.getByRole("button", { name: "Dev Terminal 출력 선택", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await dispatchTouch(cdp, "touchEnd", touchX, touchY);
  await input.evaluate((element) => element.blur());
  await dispatchTouch(cdp, "touchStart", touchX, touchY);
  await page.waitForTimeout(550);
  await expect(
    surface.getByRole("button", { name: "Dev Terminal 선택한 출력 복사" }),
  ).toBeVisible();
  await dispatchTouch(cdp, "touchEnd", touchX, touchY);
  await expect(surface.locator(".terminal-selection-handle.is-start")).toBeVisible();
  const endHandle = surface.locator(".terminal-selection-handle.is-end");
  await expect(endHandle).toBeVisible();
  const handleBounds = await endHandle.boundingBox();
  if (!handleBounds) throw new Error("Selection handle has no bounds.");
  await dispatchTouch(
    cdp,
    "touchStart",
    handleBounds.x + handleBounds.width / 2,
    handleBounds.y + handleBounds.height / 2,
  );
  await dispatchTouch(cdp, "touchMove", rowBounds.x + 160, touchY);
  await dispatchTouch(cdp, "touchEnd", rowBounds.x + 160, touchY);
  await endHandle.focus();
  await expect(endHandle).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await surface.getByRole("button", { name: "Dev Terminal 선택한 출력 복사" }).click();
  await expect
    .poll(() => page.evaluate(async () => navigator.clipboard.readText()))
    .toContain("T44_COPY_한글_😀");
  await expect(
    surface.getByRole("button", { name: "Dev Terminal 출력 선택", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");

  const selectionButton = surface.getByRole("button", {
    name: "Dev Terminal 출력 선택",
    exact: true,
  });
  await selectionButton.click();
  await surface.getByRole("button", { name: "Dev Terminal 선택한 출력 복사" }).click();
  await expect(surface.locator(".terminal-clipboard-notice")).toContainText(
    "복사할 터미널 출력을 먼저 선택",
  );
  await dispatchTouch(cdp, "touchStart", rowBounds.x + 3, touchY);
  await dispatchTouch(cdp, "touchMove", rowBounds.x + 74, touchY);
  await dispatchTouch(cdp, "touchEnd", rowBounds.x + 74, touchY);
  await surface.getByRole("button", { name: "Dev Terminal 선택한 출력 복사" }).click();
  await expect
    .poll(() => page.evaluate(async () => navigator.clipboard.readText()))
    .toContain("T44_COPY");
  await selectionButton.click();
  await surface.getByRole("button", { name: "Dev Terminal 출력 전체 선택" }).click();
  await page.setViewportSize({ width: 768, height: 780 });
  await expect(selectionButton).toHaveAttribute("aria-pressed", "false");
  await page.setViewportSize({ width: 360, height: 780 });
  await expect(surface).toHaveAttribute("data-restore-phase", "ready");

  await input.focus();
  await expect(input).toBeFocused();
  await page.keyboard.insertText("printf 'T44_AFTER_COPY\\n'");
  await page.keyboard.press("Enter");
  await expect(surface.locator(".xterm:not(.terminal-resize-freeze) .xterm-rows")).toContainText(
    "T44_AFTER_COPY",
  );
  await page.keyboard.insertText("for i in $(seq 1 80); do printf 'T44_SCROLL_%03d\\n' $i; done");
  await page.keyboard.press("Enter");
  await expect(surface.locator(".xterm:not(.terminal-resize-freeze) .xterm-rows")).toContainText(
    "T44_SCROLL_080",
  );
  const screenBounds = await surface.locator(".xterm-screen").boundingBox();
  if (!screenBounds) throw new Error("Terminal screen has no bounds.");
  const swipeX = screenBounds.x + screenBounds.width / 2;
  const swipeStartY = screenBounds.y + screenBounds.height * 0.3;
  const lastScrollRow = surface
    .locator(".xterm:not(.terminal-resize-freeze) .xterm-rows > div")
    .filter({ hasText: "T44_SCROLL_080" })
    .last();
  await expect(lastScrollRow.locator("xpath=following-sibling::div[1]")).toHaveText(/[$%]\s*$/);
  await dispatchTouch(cdp, "touchStart", swipeX, swipeStartY);
  for (const delta of [35, 70, 105, 140]) {
    await dispatchTouch(cdp, "touchMove", swipeX, swipeStartY + delta);
  }
  await dispatchTouch(cdp, "touchEnd", swipeX, swipeStartY + 140);
  await expect
    .poll(async () => Number(await surface.getAttribute("data-scroll-bottom-offset")))
    .toBeGreaterThan(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
});

test("copies Codex Pane output with the explicit selection tool", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "http://localhost:4991",
  });
  await openTerminal(page, "Main Codex");
  const codex = page.getByLabel("Main Codex Codex");
  await expect(codex.locator(".xterm:not(.terminal-resize-freeze) .xterm-rows")).toContainText(
    "FAKE_CODEX_READY",
  );
  await expect(codex).toHaveAttribute("data-restore-phase", "ready");
  await codex.getByRole("button", { name: "Main Codex 출력 선택", exact: true }).click();
  await codex.getByRole("button", { name: "Main Codex 출력 전체 선택" }).click();
  await codex.getByRole("button", { name: "Main Codex 선택한 출력 복사" }).click();
  await expect
    .poll(() => page.evaluate(async () => navigator.clipboard.readText()))
    .toContain("FAKE_CODEX_READY");
});

test("copy remains read-only for an observer and reports clipboard rejection", async ({
  page,
  browser,
}) => {
  await openTerminal(page);
  const observerContext = await browser.newContext({
    hasTouch: true,
    viewport: { width: 360, height: 780 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  try {
    const observer = await observerContext.newPage();
    await openTerminal(observer);
    await expect(observer.locator(".app-shell")).toHaveAttribute("data-surface-role", "observer");
    const surface = observer.getByLabel("Dev Terminal 터미널");
    await expect(surface).toHaveAttribute("data-control-role", "observer");
    await surface.getByRole("button", { name: "Dev Terminal 출력 선택", exact: true }).click();
    await surface.getByRole("button", { name: "Dev Terminal 출력 전체 선택" }).click();
    await surface.getByRole("button", { name: "Dev Terminal 선택한 출력 복사" }).click();
    await expect(surface.locator(".terminal-clipboard-notice")).toContainText("복사했습니다");

    await observer.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: () => Promise.reject(new Error("denied")),
      });
    });
    await surface.getByRole("button", { name: "Dev Terminal 출력 선택", exact: true }).click();
    await surface.getByRole("button", { name: "Dev Terminal 출력 전체 선택" }).click();
    await surface.getByRole("button", { name: "Dev Terminal 선택한 출력 복사" }).click();
    await expect(surface.locator(".terminal-clipboard-notice")).toContainText(
      "복사하지 못했습니다",
    );
    await expect(
      surface.getByRole("button", { name: "Dev Terminal 출력 선택", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  } finally {
    await observerContext.close();
  }
});

async function openTerminal(
  page: Page,
  pane: "Dev Terminal" | "Main Codex" = "Dev Terminal",
): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "비밀번호로 로그인" }).click();
  await page.getByLabel("Naru 비밀번호").fill("naru-test-password");
  await page.getByRole("button", { name: "작업공간 열기" }).click();
  await expect(page.locator(".app-shell")).toBeVisible();
  if (await page.getByLabel("서버 절대 경로").isVisible()) {
    await page.getByLabel("서버 절대 경로").fill(projectPath);
    await page.getByLabel(/표시 이름/).fill("Naru Output Copy");
    await page.getByRole("button", { name: "연결하기" }).click();
  }
  await page.getByRole("tab", { name: pane, exact: true }).click();
  const surface = page.getByLabel(
    pane === "Dev Terminal" ? "Dev Terminal 터미널" : "Main Codex Codex",
  );
  const restart = surface.getByRole("button", {
    name: "터미널 다시 시작",
  });
  if (await restart.isVisible()) await restart.click();
  await expect(surface).toHaveAttribute("data-restore-phase", "ready");
}

async function dispatchTouch(
  cdp: CDPSession,
  type: "touchStart" | "touchMove" | "touchEnd",
  x: number,
  y: number,
): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1, radiusX: 5, radiusY: 5, force: 1 }],
  });
}
