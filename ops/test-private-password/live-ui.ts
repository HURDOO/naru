/** Browser acceptance with real Claude Code; emits booleans, never terminal text. */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

async function main(): Promise<void> {
  const root = process.argv[2];
  if (root === undefined || process.argv.length !== 3) throw new Error("Expected one test root.");
  const settings = JSON.parse(readFileSync(join(root, "settings.json"), "utf8")) as {
    browserOrigin: string;
  };
  const credential = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-s", "dev.naru.claude-password-9443", "-w"],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (credential.status !== 0 || !credential.stdout.trim()) {
    throw new Error("Test password is unavailable from Keychain.");
  }
  const project = join(root, "projects", "claude-live-test");
  mkdirSync(project, { mode: 0o700, recursive: true });
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
    await page.getByLabel("서버 절대 경로").fill(project);
    await page.getByLabel(/표시 이름/).fill("Claude live test");
    await page.getByRole("button", { name: "연결하기" }).click();
    await page.getByRole("tab", { name: "Dev Terminal" }).click();
    await page.getByLabel("Dev Terminal 분할 메뉴").click();
    await page.getByRole("button", { name: "오른쪽에 Claude Code" }).click();
    const pane = page.getByLabel("Claude Code 1 Claude Code");
    await expect(pane).toBeVisible();
    await expect(pane).toHaveAttribute("data-control-role", "controller");
    await expect(pane).toHaveAttribute("data-restore-phase", "ready", { timeout: 30_000 });
    const runtime = await pane.getAttribute("data-runtime-id");
    const rows = pane.locator(".xterm:not(.terminal-resize-freeze) .xterm-rows");
    await expect(rows).not.toBeEmpty();
    const terminalText = await rows.innerText();
    await page.reload();
    await expect(pane).toHaveAttribute("data-runtime-id", runtime ?? "", { timeout: 30_000 });
    await page.setViewportSize({ width: 360, height: 780 });
    await page.getByRole("tab", { name: "Claude Code 1" }).click();
    await expect(pane).toBeVisible();
    process.stdout.write(
      JSON.stringify({
        browserLogin: true,
        claudePaneStarted: Boolean(runtime),
        realClaudeUiVisible: /Claude/i.test(terminalText),
        reconnectPreservedRuntime: true,
        mobileWidthNoOverflow:
          (await page.evaluate(() => document.documentElement.scrollWidth)) === 360,
      }) + "\n",
    );
  } finally {
    await browser.close();
  }
}

void main().catch(() => {
  process.stderr.write("Isolated Claude browser acceptance failed; no terminal text was logged.\n");
  process.exitCode = 1;
});
