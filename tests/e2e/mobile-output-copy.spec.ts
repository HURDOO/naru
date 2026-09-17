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
  ).toHaveAttribute("aria-pressed", "true");
  await expect(input).not.toBeFocused();
  await dispatchTouch(cdp, "touchEnd", touchX, touchY);
  await expect(surface.locator(".terminal-selection-action-menu")).toBeVisible();
  await expect(surface.locator(".terminal-selection-handle.is-start")).toBeVisible();
  const selectionScreenBounds = await surface.locator(".xterm-screen").boundingBox();
  if (!selectionScreenBounds) throw new Error("Terminal selection screen has no bounds.");
  const outsideX = selectionScreenBounds.x + selectionScreenBounds.width * 0.25;
  const outsideY = selectionScreenBounds.y + selectionScreenBounds.height * 0.75;
  await dispatchTouch(cdp, "touchStart", outsideX, outsideY);
  await dispatchTouch(cdp, "touchEnd", outsideX, outsideY);
  await expect(
    surface.getByRole("button", { name: "Dev Terminal 출력 선택", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(input).toBeFocused();

  const blankX = selectionScreenBounds.x + selectionScreenBounds.width * 0.85;
  await dispatchTouch(cdp, "touchStart", blankX, touchY);
  await page.waitForTimeout(550);
  await expect(
    surface.getByRole("button", { name: "Dev Terminal 출력 선택", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await dispatchTouch(cdp, "touchEnd", blankX, touchY);
  await surface.getByRole("button", { name: "Dev Terminal 선택한 출력 복사" }).click();
  await expect(surface.locator(".terminal-clipboard-notice")).toContainText(
    "복사할 터미널 출력을 먼저 선택",
  );
  await dispatchTouch(cdp, "touchStart", outsideX, outsideY);
  await dispatchTouch(cdp, "touchEnd", outsideX, outsideY);
  await expect(input).toBeFocused();

  await dispatchTouch(cdp, "touchStart", touchX, touchY);
  await page.waitForTimeout(550);
  await expect(
    surface.getByRole("button", { name: "Dev Terminal 출력 선택", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await dispatchTouch(cdp, "touchEnd", touchX, touchY);
  const paneTitle = surface.locator(".pane-identity").getByText("Dev Terminal", { exact: true });
  const paneTitleBounds = await paneTitle.boundingBox();
  if (!paneTitleBounds) throw new Error("Pane title has no bounds.");
  const paneTitleX = paneTitleBounds.x + paneTitleBounds.width / 2;
  const paneTitleY = paneTitleBounds.y + paneTitleBounds.height / 2;
  await dispatchTouch(cdp, "touchStart", paneTitleX, paneTitleY);
  await dispatchTouch(cdp, "touchEnd", paneTitleX, paneTitleY);
  await expect(
    surface.getByRole("button", { name: "Dev Terminal 출력 선택", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(input).toBeFocused();

  await dispatchTouch(cdp, "touchStart", touchX, touchY);
  await page.waitForTimeout(550);
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
  await expect(surface.locator(".terminal-clipboard-notice")).toContainText("복사했습니다");
  await expect(
    surface.getByRole("button", { name: "Dev Terminal 출력 선택", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(surface.locator(".terminal-selection-action-menu")).toBeHidden();

  const selectionButton = surface.getByRole("button", {
    name: "Dev Terminal 출력 선택",
    exact: true,
  });
  await selectionButton.click();
  await dispatchTouch(cdp, "touchStart", rowBounds.x + 3, touchY);
  await dispatchTouch(cdp, "touchMove", rowBounds.x + 74, touchY);
  await dispatchTouch(cdp, "touchEnd", rowBounds.x + 74, touchY);
  await surface.getByRole("button", { name: "Dev Terminal 선택한 출력 복사" }).click();
  await expect
    .poll(() => page.evaluate(async () => navigator.clipboard.readText()))
    .toContain("T44_COPY");
  await selectionButton.click();
  await selectionButton.click();
  await dispatchTouch(cdp, "touchStart", rowBounds.x + 3, touchY);
  await dispatchTouch(cdp, "touchMove", rowBounds.x + 74, touchY);
  await dispatchTouch(cdp, "touchEnd", rowBounds.x + 74, touchY);
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
  const outputRow = codex
    .locator(".xterm:not(.terminal-resize-freeze) .xterm-rows > div")
    .filter({ hasText: "FAKE_CODEX_READY" })
    .last();
  const rowBounds = await outputRow.boundingBox();
  if (!rowBounds) throw new Error("Codex output row has no bounds.");
  const cdp = await context.newCDPSession(page);
  await codex.getByRole("button", { name: "Main Codex 출력 선택", exact: true }).click();
  await dispatchTouch(cdp, "touchStart", rowBounds.x + 3, rowBounds.y + rowBounds.height / 2);
  await dispatchTouch(cdp, "touchMove", rowBounds.x + 140, rowBounds.y + rowBounds.height / 2);
  await dispatchTouch(cdp, "touchEnd", rowBounds.x + 140, rowBounds.y + rowBounds.height / 2);
  await codex.getByRole("button", { name: "Main Codex 선택한 출력 복사" }).click();
  await expect
    .poll(() => page.evaluate(async () => navigator.clipboard.readText()))
    .toContain("FAKE_CODEX_READY");
});

test("keeps Codex scrollback anchored and scrollable while selecting output", async ({
  page,
  context,
}) => {
  await openTerminal(page, "Main Codex");
  const codex = page.getByLabel("Main Codex Codex");
  const input = codex.locator(".xterm-helper-textarea");
  const screen = codex.locator(".xterm-screen");
  const rows = codex.locator(".xterm:not(.terminal-resize-freeze) .xterm-rows");
  const selectionButton = codex.getByRole("button", {
    name: "Main Codex 출력 선택",
    exact: true,
  });
  const cdp = await context.newCDPSession(page);

  await input.focus();
  await page.keyboard.insertText("/naru-e2e-focus-reporting");
  await page.keyboard.press("Enter");
  await expect(rows).toContainText("FAKE_CODEX_SCROLL_119");
  const screenBounds = await screen.boundingBox();
  if (!screenBounds) throw new Error("Codex terminal screen has no bounds.");
  const touchX = screenBounds.x + screenBounds.width * 0.45;
  const touchY = screenBounds.y + screenBounds.height * 0.55;

  await dispatchTouch(cdp, "touchStart", touchX, touchY);
  for (const delta of [30, 60, 90]) {
    await dispatchTouch(cdp, "touchMove", touchX, touchY + delta);
  }
  await dispatchTouch(cdp, "touchEnd", touchX, touchY + 90);
  const offsetBeforeSelection = await scrollBottomOffset(codex);
  expect(offsetBeforeSelection).toBeGreaterThan(0);
  await input.evaluate((element) => {
    element.setAttribute("data-test-focus-events", "0");
    element.addEventListener("focus", () => {
      const count = Number(element.getAttribute("data-test-focus-events") ?? "0");
      element.setAttribute("data-test-focus-events", String(count + 1));
    });
  });

  await dispatchTouch(cdp, "touchStart", touchX, touchY);
  await page.waitForTimeout(550);
  await expect(selectionButton).toHaveAttribute("aria-pressed", "true");
  await dispatchTouch(cdp, "touchEnd", touchX, touchY);
  expect(await scrollBottomOffset(codex)).toBeGreaterThan(0);
  await expect(input).toHaveAttribute("data-test-focus-events", "0");
  await expect(codex.locator(".terminal-selection-action-menu")).toBeVisible();

  await dispatchTouch(cdp, "touchStart", touchX, touchY);
  await dispatchTouch(cdp, "touchMove", touchX, touchY + 45);
  await dispatchTouch(cdp, "touchEnd", touchX, touchY + 45);
  await expect(selectionButton).toHaveAttribute("aria-pressed", "true");
  expect(await scrollBottomOffset(codex)).toBeGreaterThan(offsetBeforeSelection);
  await expect(codex.locator(".terminal-selection-action-menu")).toBeVisible();

  await selectionButton.click();
  await expect(codex.locator(".terminal-selection-action-menu")).toBeHidden();
  await selectionButton.click();
  const offsetBeforeEdgeSelection = await scrollBottomOffset(codex);
  await dispatchTouch(cdp, "touchStart", touchX, touchY);
  await dispatchTouch(cdp, "touchMove", touchX, screenBounds.y + 4);
  await page.waitForTimeout(260);
  await dispatchTouch(cdp, "touchEnd", touchX, screenBounds.y + 4);
  await expect(selectionButton).toHaveAttribute("aria-pressed", "true");
  expect(await scrollBottomOffset(codex)).toBeGreaterThan(offsetBeforeEdgeSelection);
  await expect(
    codex.locator(".terminal-selection-handle").filter({ visible: true }),
  ).not.toHaveCount(0);
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

async function scrollBottomOffset(surface: ReturnType<Page["getByLabel"]>): Promise<number> {
  return Number(await surface.getAttribute("data-scroll-bottom-offset"));
}
