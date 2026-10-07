import { expect, test, type Page, type Locator } from "@playwright/test";

const origin = `http://localhost:${process.env.NARU_E2E_WEB_PORT ?? "4991"}`;

async function openTui(page: Page): Promise<Locator> {
  await page.goto("/");
  await page.getByRole("button", { name: "비밀번호로 로그인" }).click();
  await page.getByLabel("Naru 비밀번호").fill("naru-test-password");
  await page.getByRole("button", { name: "작업공간 열기" }).click();
  await expect(page.locator(".app-shell")).toBeVisible();
  if (await page.getByLabel("서버 절대 경로").isVisible()) {
    await page.getByLabel("서버 절대 경로").fill("/private/tmp/naru-e2e-projects/public/editor");
    await page.getByLabel(/표시 이름/).fill("TUI Copy");
    await page.getByRole("button", { name: "연결하기" }).click();
  }
  await page.getByRole("tab", { name: "Main Codex", exact: true }).click();
  const pane = page.getByLabel("Main Codex Codex");
  await expect(pane).toHaveAttribute("data-restore-phase", "ready");
  const rows = pane.locator(".xterm:not(.terminal-resize-freeze) .xterm-rows");
  if (!(await rows.textContent())?.includes("TUI offset=")) {
    await pane.locator(".xterm-helper-textarea").focus();
    await page.keyboard.insertText("/naru-e2e-mouse-tui");
    await page.keyboard.press("Enter");
  }
  await expect(rows).toContainText("TUI offset=");
  return pane;
}

for (const width of [1440, 768, 360]) {
  test(`copies a mouse-tracking TUI by desktop drag at ${width}px`, async ({
    page,
    context,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    const pane = await openTui(page);
    const rows = pane.locator(".xterm:not(.terminal-resize-freeze) .xterm-rows > div");
    const clickCount = Number((await rows.first().innerText()).match(/clicks=(\d+)/)?.[1]);
    const row = rows.nth(2);
    await expect(row).toContainText(/ROW_\d+ 한글 😀 copy/);
    const expected = (await row.innerText()).trim();
    const bounds = await row.boundingBox();
    if (!bounds) throw new Error("No TUI row bounds");
    await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width - 3, bounds.y + bounds.height / 2, { steps: 8 });
    await page.mouse.up();
    // Any-event tracking reports hover after release; xterm clears its native selection
    // on that input even though Naru still owns the selected text.
    await page.mouse.move(bounds.x + 20, bounds.y + bounds.height * 1.5);
    const highlight = pane.locator(".xterm-selection > div").first();
    await expect(highlight).toBeVisible();
    await expect(pane.locator(".xterm-helper-textarea")).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("selection-focus.png") });
    await page.keyboard.press("ControlOrMeta+c");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
    await expect(rows.first()).toContainText(`clicks=${clickCount}`);
    await page.keyboard.press("ControlOrMeta+v");
    await expect(rows.last()).toContainText(`PASTE:${expected}`);
    await expect(highlight).toBeHidden();
    // Selecting again through the toolbar must still work after the app redraws.
    await expect(pane.locator(".terminal-selection-action-menu")).toBeHidden();
    await page.mouse.move(bounds.x + 10, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await expect(pane.locator(".xterm-screen")).not.toHaveClass(/naru-touch-select/);
    await page.mouse.move(bounds.x + 11, bounds.y + bounds.height / 2 + 1);
    await expect(pane.locator(".xterm-screen")).not.toHaveClass(/naru-touch-select/);
    await page.mouse.up();
    await expect(rows.first()).toContainText(`clicks=${clickCount + 2}`);
    await expect(pane.locator(".xterm-screen")).not.toHaveClass(/naru-touch-select/);
    await page.setViewportSize({ width, height: 620 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    if (width < 1024) {
      const selector = pane.getByRole("button", { name: "Main Codex 출력 선택", exact: true });
      await selector.focus();
      await expect(selector).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(selector).toHaveAttribute("aria-pressed", "true");
    } else {
      await pane.locator(".xterm-helper-textarea").focus();
      await page.keyboard.press("Shift+Tab");
      await expect(pane.locator(".xterm-helper-textarea")).not.toBeFocused();
    }
  });
}

test("touch selection and handles auto-scroll the TUI in both directions", async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: origin,
    hasTouch: true,
    viewport: { width: 360, height: 780 },
  });
  const page = await context.newPage();
  try {
    const pane = await openTui(page);
    const screen = pane.locator(".xterm-screen");
    const bounds = await screen.boundingBox();
    if (!bounds) throw new Error("No TUI screen bounds");
    const header = pane.locator(".xterm:not(.terminal-resize-freeze) .xterm-rows > div").first();
    const offset = async (): Promise<number> =>
      Number((await header.innerText()).match(/offset=(\d+)/)?.[1]);
    const before = await offset();
    const initialClicks = Number((await header.innerText()).match(/clicks=(\d+)/)?.[1]);
    const cdp = await context.newCDPSession(page);
    const touch = async (
      type: "touchStart" | "touchMove" | "touchEnd",
      x: number,
      y: number,
    ): Promise<void> => {
      await cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }],
      });
    };
    const x = bounds.x + bounds.width / 2;
    await touch("touchStart", x, bounds.y + bounds.height / 2);
    await page.waitForTimeout(550);
    await touch("touchMove", x, bounds.y + 3);
    await expect.poll(offset).toBeLessThan(before);
    await touch("touchEnd", x, bounds.y + 3);
    const stopped = await offset();
    await page.waitForTimeout(200);
    expect(await offset()).toBe(stopped);
    const handle = pane.locator(".terminal-selection-handle.is-end");
    await expect(handle).toBeVisible();
    const handleBounds = await handle.boundingBox();
    if (!handleBounds) throw new Error("No selection handle bounds");
    await touch(
      "touchStart",
      handleBounds.x + handleBounds.width / 2,
      handleBounds.y + handleBounds.height / 2,
    );
    await touch("touchMove", x, bounds.y + bounds.height - 3);
    await expect.poll(offset).toBeGreaterThan(stopped);
    await touch("touchEnd", x, bounds.y + bounds.height - 3);
    await expect(header).toContainText(`clicks=${initialClicks}`);
  } finally {
    await context.close();
  }
});
