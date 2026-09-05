import { expect, test } from "@playwright/test";
import { WorkstationGateway } from "../../apps/workstation-gateway/src/gateway.js";
import { createGatewayTestFixture } from "../../apps/workstation-gateway/test/support.js";

test("keeps the Gateway pre-auth surface responsive and keyboard operable", async ({ page }) => {
  const { config } = createGatewayTestFixture();
  const gateway = await WorkstationGateway.create(config);
  try {
    const response = await gateway.browser.inject({
      method: "GET",
      url: "/_gateway/login?return=%2Fapp",
      headers: {
        host: new URL(config.browserOrigin).host,
        accept: "text/html",
      },
    });
    expect(response.statusCode).toBe(200);
    await page.setContent(response.body, { waitUntil: "domcontentloaded" });

    const login = page.getByRole("button", { name: "패스키로 로그인" });
    const disclosure = page.getByRole("button", { name: "새 워크스테이션 등록" });
    await login.focus();
    await expect(login).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(disclosure).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByLabel("로컬 bootstrap code")).toBeFocused();

    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 360, height: 780 },
      { width: 280, height: 653 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(login).toBeVisible();
      const layout = await page.evaluate(() => {
        const main = document.querySelector("main")?.getBoundingClientRect();
        return {
          viewportWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          mainLeft: main?.left,
          mainRight: main?.right,
        };
      });
      expect(layout.documentWidth).toBe(layout.viewportWidth);
      expect(layout.mainLeft).toBeGreaterThanOrEqual(0);
      expect(layout.mainRight).toBeLessThanOrEqual(viewport.width);
    }
  } finally {
    await gateway.close();
  }
});
