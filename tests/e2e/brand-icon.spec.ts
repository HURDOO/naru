import { expect, test } from "@playwright/test";

test("renders the transparent Naru mark on login and in the app header", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const loginMark = page.locator(".login-brand .brand-mark");
  await expect(loginMark).toBeVisible();
  await expect(loginMark).toHaveCSS("background-image", /naru-512\.png/);
  await expect(loginMark).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(loginMark).toHaveCSS("border-top-width", "0px");
  await expect(loginMark).toHaveCSS("width", "42px");
  await expect(loginMark).toHaveCSS("height", "42px");

  await page.getByRole("button", { name: "비밀번호로 로그인" }).click();
  await page.getByLabel("Naru 비밀번호").fill("naru-test-password");
  await page.getByRole("button", { name: "작업공간 열기" }).click();
  await expect(page.locator(".topbar")).toBeVisible();

  await page.setViewportSize({ width: 360, height: 780 });
  const headerMark = page.locator(".topbar .brand-mark");
  await expect(headerMark).toBeVisible();
  await expect(headerMark).toHaveCSS("background-image", /naru-512\.png/);
  await expect(headerMark).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(headerMark).toHaveCSS("border-top-width", "0px");
  await expect(headerMark).toHaveCSS("width", "26px");
  await expect(headerMark).toHaveCSS("height", "26px");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
});
