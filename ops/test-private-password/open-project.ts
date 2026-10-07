/** Register one explicitly approved project and verify the isolated Claude default workspace. */
import { spawnSync } from "node:child_process";
import { chromium, expect } from "@playwright/test";
import { loadTestServerSettings } from "./server.js";

async function main(): Promise<void> {
  const [root, projectPath] = process.argv.slice(2);
  if (root === undefined || projectPath === undefined || process.argv.length !== 4) {
    throw new Error("Expected test root and exact project path.");
  }
  const { settings } = loadTestServerSettings(root);
  if (settings.exactProjectRoot !== projectPath) {
    throw new Error("The requested project is not the exact approved test project.");
  }
  const credential = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-s", "dev.naru.claude-password-9443", "-w"],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (credential.status !== 0 || !credential.stdout.trim()) {
    throw new Error("Test password is unavailable from Keychain.");
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(settings.browserOrigin);
    await page.getByRole("button", { name: "비밀번호로 로그인" }).click();
    await page.getByLabel("Naru 비밀번호").fill(credential.stdout.trim());
    await page.getByRole("button", { name: "작업공간 열기" }).click();
    await expect(page.getByRole("button", { name: "로그아웃" })).toBeVisible();
    if (!(await page.getByLabel("서버 절대 경로").isVisible())) {
      await page.getByRole("button", { name: "프로젝트 연결" }).click();
    }
    await page.getByLabel("서버 절대 경로").fill(projectPath);
    await page.getByLabel(/표시 이름/).fill("Cheers");
    await page.getByRole("button", { name: "연결하기" }).click();
    const first = page.getByLabel("Claude Code 1 Claude Code");
    const second = page.getByLabel("Claude Code 2 Claude Code");
    await expect(first).toBeVisible({ timeout: 30_000 });
    await expect(second).toBeVisible({ timeout: 30_000 });
    await expect(first).toHaveAttribute("data-restore-phase", "ready", { timeout: 30_000 });
    await expect(second).toHaveAttribute("data-restore-phase", "ready", { timeout: 30_000 });
    const firstRuntime = await first.getAttribute("data-runtime-id");
    const secondRuntime = await second.getAttribute("data-runtime-id");
    if (!firstRuntime || !secondRuntime || firstRuntime === secondRuntime) {
      throw new Error("The two Claude Panes did not start independent runtimes.");
    }
    await expect(page.getByLabel("Main Codex Codex")).toHaveCount(0);
    await expect(page.getByLabel("Quick Codex Codex")).toHaveCount(0);
    await page.setViewportSize({ width: 360, height: 780 });
    await page.getByRole("tab", { name: "Claude Code 1" }).click();
    await expect(first).toBeVisible();
    const mobileWidthNoOverflow =
      (await page.evaluate(() => document.documentElement.scrollWidth)) === 360;
    if (!mobileWidthNoOverflow) throw new Error("The mobile viewport overflows.");
    process.stdout.write(
      JSON.stringify({
        projectRegistered: true,
        twoIndependentClaudeRuntimes: true,
        defaultCodexPanesAbsent: true,
        mobileWidthNoOverflow,
      }) + "\n",
    );
  } finally {
    await browser.close();
  }
}

void main().catch(() => {
  process.stderr.write(
    "Isolated project browser check failed; no private path or terminal text was logged.\n",
  );
  process.exitCode = 1;
});
