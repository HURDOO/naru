import { expect, test, type Locator, type Page } from "@playwright/test";

const SESSION_LINE = /FAKE_CLAUDE_SESSION (startup|resume) ([0-9a-f-]{36})/;

test("resumes the last Claude conversation or starts a new one after the CLI exits", async ({
  page,
}) => {
  test.setTimeout(90_000);
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
    .fill("/private/tmp/naru-e2e-projects/public/editor/claude-resume-fixture");
  await page.getByLabel(/표시 이름/).fill("Claude resume fixture");
  await page.getByRole("button", { name: "연결하기" }).click();
  await expect(page.getByRole("heading", { name: "Claude resume fixture" })).toBeVisible();
  await page.getByRole("tab", { name: "Dev Terminal" }).click();
  await page.getByLabel("Dev Terminal 분할 메뉴").click();
  await page.getByRole("button", { name: "오른쪽에 Claude Code" }).click();

  const pane = page.getByLabel("Claude Code 1 Claude Code");
  const rows = pane.locator(".xterm:not(.terminal-resize-freeze) .xterm-rows");
  const first = await sessionLine(rows, "startup");

  await quit(page, pane);
  const resume = pane.getByRole("button", { name: "Claude 작업 재개" });
  await expect(resume).toBeVisible();
  await expect(pane.getByRole("button", { name: "새 Claude 시작" })).toBeVisible();
  await resume.focus();
  await page.keyboard.press("Enter");
  expect(await sessionLine(rows, "resume")).toBe(first);

  await quit(page, pane);
  await pane.getByRole("button", { name: "새 Claude 시작" }).click();
  const fresh = await sessionLine(rows, "startup");
  expect(fresh).not.toBe(first);

  await quit(page, pane);
  for (const width of [768, 360]) {
    await page.setViewportSize({ width, height: 780 });
    await page.getByRole("tab", { name: "Claude Code 1" }).click();
    await expect(pane.getByRole("button", { name: "Claude 작업 재개" })).toBeVisible();
    await expect(pane.getByRole("button", { name: "새 Claude 시작" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  }
});

async function sessionLine(rows: Locator, source: "startup" | "resume"): Promise<string> {
  let sessionId = "";
  await expect
    .poll(async () => {
      const match = SESSION_LINE.exec((await rows.textContent()) ?? "");
      sessionId = match?.[1] === source ? (match[2] ?? "") : "";
      return sessionId;
    })
    .not.toBe("");
  return sessionId;
}

async function quit(page: Page, pane: Locator): Promise<void> {
  await expect(pane).toHaveAttribute("data-restore-phase", "ready");
  await pane.locator(".xterm-helper-textarea").focus();
  await page.keyboard.insertText("quit");
  await page.keyboard.press("Enter");
  await expect(pane.locator(".terminal-overlay")).toBeVisible();
}
