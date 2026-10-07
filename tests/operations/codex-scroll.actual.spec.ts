import { randomUUID } from "node:crypto";
import { expect, test, type Locator } from "@playwright/test";
import { startCodexAcceptanceFixture } from "../../apps/server/test/codex-acceptance-fixture.js";

for (const width of [1440, 768, 360]) {
  test(`actual Codex preserves its native transcript scrolling at ${width}px`, async ({
    page,
    browser,
  }) => {
    test.skip(!process.env.NARU_ACTUAL_CODEX, "Requires an explicit isolated Codex executable");
    test.setTimeout(150_000);
    const password = randomUUID();
    const server = await startCodexAcceptanceFixture(
      process.env.NARU_ACTUAL_CODEX!,
      password,
      Array.from(
        { length: 80 },
        (_, i) => `SCROLL_FIXTURE_LINE_${String(i).padStart(3, "0")}`,
      ).join("\n"),
    );
    try {
      await page.setViewportSize({ width, height: 900 });
      const pane = server.repository
        .getWorkspace(server.project.id)
        .panes.find((p) => p.kind === "codex")!;
      await server.supervisor.start(pane.id, 100, 30);
      await page.goto(server.origin);
      await page.getByRole("button", { name: "비밀번호로 로그인" }).click();
      await page.getByLabel("Naru 비밀번호").fill(password);
      await page.getByRole("button", { name: "작업공간 열기" }).click();
      const terminal = page.getByRole("tabpanel", { name: "Main Codex Codex", exact: true });
      const input = page.getByLabel("Main Codex 명령 입력");
      await expect(input).toBeVisible();
      await expect(terminal).toContainText("Ask Codex", { timeout: 20_000 });
      await input.pressSequentially("Reply with a short greeting.", { delay: 30 });
      await input.press("Enter");
      await expect(terminal).toContainText("SCROLL_FIXTURE_LINE_079", { timeout: 20_000 });
      await page.reload();
      await expect(terminal).toContainText("SCROLL_FIXTURE_LINE_079", { timeout: 20_000 });
      await terminal.locator(".xterm:not(.terminal-resize-freeze) .xterm-screen").hover();
      for (let i = 0; i < 35; i++) await page.mouse.wheel(0, -120);
      await expect(terminal).toContainText("SCROLL_FIXTURE_LINE_000");
      {
        const screen = terminal.locator(".xterm:not(.terminal-resize-freeze) .xterm-screen");
        await expect(screen).toHaveCount(1);
        for (let i = 0; i < 60; i++) {
          await touchScroll(screen, -80);
          await page.waitForTimeout(16);
        }
        await expect(terminal).toContainText("SCROLL_FIXTURE_LINE_079");
        for (let i = 0; i < 60; i++) {
          await touchScroll(screen, 80);
          await page.waitForTimeout(16);
        }
        await expect(terminal).toContainText("SCROLL_FIXTURE_LINE_000");
        await expect(screen).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      }
      const observerContext = await browser.newContext({ viewport: { width, height: 900 } });
      try {
        const observer = await observerContext.newPage();
        let inputs = 0;
        observer.on("websocket", (socket) =>
          socket.on("framesent", ({ payload }) => {
            try {
              const frame: unknown = JSON.parse(String(payload));
              if (
                typeof frame === "object" &&
                frame !== null &&
                "type" in frame &&
                frame.type === "terminal.input"
              )
                inputs++;
            } catch {
              /* Other frames aren't input. */
            }
          }),
        );
        await observer.goto(server.origin);
        await observer.getByRole("button", { name: "비밀번호로 로그인" }).click();
        await observer.getByLabel("Naru 비밀번호").fill(password);
        await observer.getByRole("button", { name: "작업공간 열기" }).click();
        const other = observer.getByRole("tabpanel", { name: "Main Codex Codex", exact: true });
        await expect(other).toHaveAttribute("data-control-role", "observer");
        await expect(other).toContainText("SCROLL_FIXTURE_LINE_000");
        await other.locator(".xterm:not(.terminal-resize-freeze) .xterm-screen").hover();
        await observer.mouse.wheel(0, 300);
        await touchScroll(other.locator(".xterm:not(.terminal-resize-freeze) .xterm-screen"), -80);
        expect(inputs).toBe(0);
        await observer.getByRole("button", { name: "제어권 가져오기", exact: true }).click();
        await expect(other).toHaveAttribute("data-control-role", "controller");
        await expect(terminal).toHaveAttribute("data-control-role", "observer");
        await other.locator(".xterm:not(.terminal-resize-freeze) .xterm-screen").hover();
        for (let i = 0; i < 35; i++) await observer.mouse.wheel(0, 120);
        await expect(other).toContainText("SCROLL_FIXTURE_LINE_079");
        expect(inputs).toBeGreaterThan(0);
        await expect(terminal).toContainText("SCROLL_FIXTURE_LINE_079");
        await observer.setViewportSize({ width, height: 620 });
        await expect(
          other.locator(".xterm:not(.terminal-resize-freeze) .xterm-screen"),
        ).toBeVisible();
        expect(await observer.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      } finally {
        await observerContext.close();
      }
    } finally {
      await page.close();
      await server.close();
    }
  });
}

async function touchScroll(screen: Locator, distance: number): Promise<void> {
  await screen.evaluate((element, delta) => {
    const rect = element.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const startY = rect.top + rect.height / 2;
    for (const [type, clientY] of [
      ["pointerdown", startY],
      ["pointermove", startY + delta],
      ["pointerup", startY + delta],
    ] as const) {
      element.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 77,
          pointerType: "touch",
          isPrimary: true,
          clientX,
          clientY,
        }),
      );
    }
  }, distance);
}
