import { expect, test } from "@playwright/test";

test("creates a Claude Code pane and preserves its PTY through browser reconnect", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
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
    .fill("/private/tmp/naru-e2e-projects/public/editor/claude-fixture");
  await page.getByLabel(/표시 이름/).fill("Claude fixture");
  await page.getByRole("button", { name: "연결하기" }).click();
  await expect(
    page.getByLabel("Main Codex Codex").locator(".xterm:not(.terminal-resize-freeze) .xterm-rows"),
  ).toContainText("FAKE_CODEX_READY");
  await expect(
    page.getByLabel("Quick Codex Codex").locator(".xterm:not(.terminal-resize-freeze) .xterm-rows"),
  ).toContainText("FAKE_CODEX_READY");

  await page.getByRole("tab", { name: "Dev Terminal" }).click();
  await expect(page.getByRole("tab", { name: "Dev Terminal" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByLabel("Dev Terminal 분할 메뉴").click();
  await page.getByRole("button", { name: "오른쪽에 Claude Code" }).click();
  const pane = page.getByLabel("Claude Code 1 Claude Code");
  await expect(pane).toBeVisible();
  await expect(pane).toHaveAttribute("data-control-role", "controller");
  await expect(pane).toHaveAttribute("data-restore-phase", "ready");
  const liveRows = pane.locator(".xterm:not(.terminal-resize-freeze) .xterm-rows");
  await expect(liveRows).toContainText("FAKE_CLAUDE_READY");
  const runtimeId = await pane.getAttribute("data-runtime-id");
  expect(runtimeId).toBeTruthy();
  await pane.locator(".xterm-helper-textarea").focus();
  await page.keyboard.insertText("ping");
  await page.keyboard.press("Enter");
  await expect(liveRows).toContainText("FAKE_CLAUDE_PONG");

  const activity = pane.locator(".pane-actions .activity-status");
  const submit = async (command: string): Promise<void> => {
    await pane.locator(".xterm-helper-textarea").focus();
    await page.keyboard.insertText(command);
    await page.keyboard.press("Enter");
  };
  await submit("status-start");
  await expect(liveRows).toContainText("FAKE_CLAUDE_RUNNING");
  await expect(activity).toHaveAttribute("data-activity-state", "running");
  await submit("status-need");
  await expect(liveRows).toContainText("FAKE_CLAUDE_NEEDS_PERMISSION");
  await expect(activity).toHaveAttribute("data-activity-state", "interaction-required");
  await submit("status-resume");
  await expect(liveRows).toContainText("FAKE_CLAUDE_RESUMED");
  await expect(activity).toHaveAttribute("data-activity-state", "running");
  await submit("status-done");
  await expect(liveRows).toContainText("FAKE_CLAUDE_COMPLETED");
  await expect(activity).toHaveAttribute("data-activity-state", "completed");

  await page.reload();
  await expect(pane).toHaveAttribute("data-runtime-id", runtimeId ?? "");
  await expect(liveRows).toContainText("FAKE_CLAUDE_PONG");
  for (const width of [768, 360]) {
    await page.setViewportSize({ width, height: 780 });
    await page.getByRole("tab", { name: "Claude Code 1" }).click();
    await expect(pane).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  }
});
