import { expect, test, type CDPSession, type Page } from "@playwright/test";

test.use({
  hasTouch: true,
  viewport: { width: 1440, height: 900 },
});

test("scrolls a Claude fullscreen pane by touch after reconnect and viewport changes", async ({
  page,
  context,
  browser,
}) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await page.getByRole("button", { name: "비밀번호로 로그인" }).click();
  await page.getByLabel("Naru 비밀번호").fill("naru-test-password");
  await page.getByRole("button", { name: "작업공간 열기" }).click();
  await expect(page.getByRole("button", { name: "로그아웃" })).toBeVisible();
  if (!(await page.getByLabel("서버 절대 경로").isVisible())) {
    await page.getByRole("button", { name: "프로젝트 연결" }).click();
  }
  await page
    .getByLabel("서버 절대 경로")
    .fill("/private/tmp/naru-e2e-projects/public/editor/claude-scroll-fixture");
  await page.getByLabel(/표시 이름/).fill("Claude scroll fixture");
  await page.getByRole("button", { name: "연결하기" }).click();
  await expect(page.getByRole("heading", { name: "Claude scroll fixture" })).toBeVisible();
  await page.getByRole("tab", { name: "Dev Terminal" }).click();
  await page.getByLabel("Dev Terminal 분할 메뉴").click();
  await page.getByRole("button", { name: "오른쪽에 Claude Code" }).click();
  const pane = page.getByLabel("Claude Code 1 Claude Code");
  const rows = pane.locator(".xterm:not(.terminal-resize-freeze) .xterm-rows");
  await expect(rows).toContainText("FAKE_CLAUDE_READY");
  const input = pane.locator(".xterm-helper-textarea");
  await input.focus();
  await page.keyboard.insertText("scroll-test");
  await page.keyboard.press("Enter");
  await expect(rows).toContainText("FAKE_CLAUDE_SCROLL_000");

  const cdp = await context.newCDPSession(page);
  for (const width of [360, 768, 1440]) {
    await page.setViewportSize({ width, height: 780 });
    await page.getByRole("tab", { name: "Claude Code 1" }).click();
    await expect(pane).toHaveAttribute("data-restore-phase", "ready");
    const before = await scrollMarker(rows);
    await dragDown(cdp, pane);
    await expect.poll(() => scrollMarker(rows)).toBeGreaterThan(before);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  }

  await page.reload();
  await page.getByRole("tab", { name: "Claude Code 1" }).click();
  await expect(pane).toHaveAttribute("data-restore-phase", "ready");
  const before = await scrollMarker(rows);
  await dragDown(cdp, pane);
  await expect.poll(() => scrollMarker(rows)).toBeGreaterThan(before);

  await page.setViewportSize({ width: 360, height: 620 });
  const beforeViewportChange = await scrollMarker(rows);
  await dragDown(cdp, pane);
  await expect.poll(() => scrollMarker(rows)).toBeGreaterThan(beforeViewportChange);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);

  const observerContext = await browser.newContext({
    baseURL: new URL(page.url()).origin,
    hasTouch: true,
    viewport: { width: 360, height: 780 },
  });
  try {
    const observer = await observerContext.newPage();
    await observer.goto("/");
    await observer.getByRole("button", { name: "비밀번호로 로그인" }).click();
    await observer.getByLabel("Naru 비밀번호").fill("naru-test-password");
    await observer.getByRole("button", { name: "작업공간 열기" }).click();
    await expect(observer.locator(".app-shell")).toHaveAttribute("data-surface-role", "observer");
    await observer.getByRole("button", { name: "프로젝트 메뉴 열기" }).click();
    await observer
      .locator(".project-row")
      .filter({ hasText: "Claude scroll fixture" })
      .locator(".project-main")
      .click();
    await observer.getByRole("tab", { name: "Claude Code 1" }).click();
    const observerPane = observer.getByLabel("Claude Code 1 Claude Code");
    await expect(observerPane).toHaveAttribute("data-control-role", "observer");
    await expect(observerPane).toHaveAttribute("data-restore-phase", "ready");
    const observerCdp = await observerContext.newCDPSession(observer);
    const beforeHandoff = await scrollMarker(rows);
    await dragDown(observerCdp, observerPane);
    await observer.waitForTimeout(150);
    expect(await scrollMarker(rows)).toBe(beforeHandoff);

    await observer.getByRole("button", { name: "제어권 가져오기", exact: true }).click();
    await expect(observerPane).toHaveAttribute("data-control-role", "controller");
    await expect(pane).toHaveAttribute("data-control-role", "observer");
    await dragDown(observerCdp, observerPane);
    await expect.poll(() => scrollMarker(rows)).toBeGreaterThan(beforeHandoff);
  } finally {
    await observerContext.close();
  }
});

async function scrollMarker(rows: ReturnType<Page["locator"]>): Promise<number> {
  const text = await rows.textContent();
  return Number(/FAKE_CLAUDE_SCROLL_(\d+)/.exec(text ?? "")?.[1] ?? "0");
}

async function dragDown(cdp: CDPSession, pane: ReturnType<Page["getByLabel"]>): Promise<void> {
  const screen = pane.locator(".xterm:not(.terminal-resize-freeze) .xterm-screen");
  await expect(screen).toBeVisible();
  // A resize-freeze renderer swap can detach the matched screen between the two calls.
  let bounds = await screen.boundingBox();
  for (let attempt = 0; !bounds && attempt < 20; attempt++) {
    await screen.page().waitForTimeout(50);
    bounds = await screen.boundingBox();
  }
  if (!bounds) throw new Error("Claude terminal screen has no bounds.");
  const x = bounds.x + bounds.width / 2;
  const startY = bounds.y + bounds.height * 0.35;
  await touch(cdp, "touchStart", x, startY);
  for (const delta of [20, 40, 60]) await touch(cdp, "touchMove", x, startY + delta);
  await touch(cdp, "touchEnd", x, startY + 60);
}

async function touch(
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
