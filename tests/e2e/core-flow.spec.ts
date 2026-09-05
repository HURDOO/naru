import { AxeBuilder } from "@axe-core/playwright";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type CDPSession, type Locator, type Page } from "@playwright/test";
import type { LayoutNode, Workspace } from "../../packages/contracts/src/index.js";

const originProjectPath = "/private/tmp/naru-e2e-projects/public/editor";
const longProjectPath = "/private/tmp/naru-e2e-projects/public/editor/apps/web/src";
const longProjectName = `Naru ${"아주-긴-프로젝트-이름-".repeat(8)}`;
const handoffProjectPath = "/private/tmp/naru-e2e-projects/public/editor/apps/server/src";
const handoffProjectName = "Naru Handoff";
const accessibilityProjectPath = "/private/tmp/naru-e2e-projects/public/editor/packages/domain";
const accessibilityProjectName = "Naru Accessibility";
const accessibilityOtherPath = "/private/tmp/naru-e2e-projects/public/editor/packages/contracts";
const accessibilityOtherName = "Naru Accessibility Other";
const stableTaskTitle = "TUI /resume 직후 첫 model turn 전 원클릭 재개";
const e2eOrigin = `http://localhost:${process.env.NARU_E2E_WEB_PORT ?? "4991"}`;
const liveTerminalSelector = ".xterm:not(.terminal-resize-freeze)";
const liveTerminalRowsSelector = `${liveTerminalSelector} .xterm-rows`;

test.describe.configure({ mode: "serial", timeout: 90_000 });

test("register, use, manage, and remove a discoverable passkey", async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "비밀번호로 로그인" }).click();
    await page.getByLabel("Naru 비밀번호").fill("naru-test-password");
    await page.getByRole("button", { name: "작업공간 열기" }).click();
    await expect(page.getByText("프로젝트를 연결해 주세요")).toBeVisible();

    await page.getByRole("button", { name: "패스키", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "패스키 관리" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("새 패스키 이름").fill("E2E virtual passkey");
    await dialog.getByRole("button", { name: "등록", exact: true }).click();
    await expect(dialog.getByText("패스키를 등록했습니다.")).toBeVisible();
    await expect(dialog.getByText("E2E virtual passkey")).toBeVisible();
    await dialog.getByRole("button", { name: "패스키 관리 닫기" }).click();

    await page.getByRole("button", { name: "로그아웃" }).click();
    await expect(page.getByRole("button", { name: "패스키로 로그인" })).toBeVisible();
    await page.getByRole("button", { name: "패스키로 로그인" }).click();
    await expect(page.getByText("프로젝트를 연결해 주세요")).toBeVisible();

    await page.getByRole("button", { name: "패스키", exact: true }).click();
    await expect(dialog.getByText("최근 사용")).toBeVisible();
    page.once("dialog", (confirmation) => void confirmation.accept());
    await dialog.getByRole("button", { name: "삭제" }).click();
    await expect(dialog.getByText("아직 등록된 패스키가 없습니다.")).toBeVisible();
    await expect(dialog.getByText(/비밀번호 로그인은 계속 사용할 수 있습니다/)).toBeVisible();
    await dialog.getByRole("button", { name: "패스키 관리 닫기" }).click();

    await page.setViewportSize({ width: 360, height: 780 });
    const menuTrigger = page.getByRole("button", { name: "작업공간 메뉴 열기" });
    await menuTrigger.click();
    await page.getByRole("button", { name: "패스키 관리" }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("새 패스키 이름")).toBeFocused();
    expect(
      await dialog.evaluate((element) => element.getBoundingClientRect().width),
    ).toBeLessThanOrEqual(344);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(menuTrigger).toBeFocused();

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("button", { name: "로그아웃" }).click();
  } finally {
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    await cdp.detach();
  }
});

test("opens the password recovery path by default when mobile passkeys are unavailable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "PublicKeyCredential", {
      configurable: true,
      value: undefined,
    });
  });
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto("/");

  await expect(
    page.getByRole("button", { name: "이 브라우저는 패스키를 지원하지 않습니다" }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "비밀번호로 로그인" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(page.getByLabel("Naru 비밀번호")).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
  await expectNoAccessibilityViolations(page, "mobile login without passkeys");
});

test("login, manage projects, run a terminal, and restore the selected context", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: e2eOrigin,
  });
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
      browserErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "onLine", {
      configurable: true,
      get: () => false,
    });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /작업의 흐름을/ })).toBeVisible();

  await page.getByRole("button", { name: "비밀번호로 로그인" }).click();
  await page.getByLabel("Naru 비밀번호").fill("naru-test-password");
  await page.getByRole("button", { name: "작업공간 열기" }).click();
  await expect(page.getByText("프로젝트를 연결해 주세요")).toBeVisible();
  await expect(page.getByText("아직 연결한 프로젝트가 없습니다.")).toBeVisible();

  const projectRootGuidance = page.locator("#project-path-guidance");
  await expect(projectRootGuidance).toContainText("이 Workstation에서 허용된 상위 폴더");
  await expect(projectRootGuidance).toContainText(
    "상위 폴더 자체가 아니라, 그 안의 실제 프로젝트 폴더 절대 경로를 입력하세요.",
  );
  await expect(projectRootGuidance.locator("code")).toHaveText(["/private/tmp/naru-e2e-projects"]);
  await expect(page.getByLabel("서버 절대 경로")).toHaveAttribute(
    "aria-describedby",
    "project-path-guidance",
  );
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 768, height: 900 },
    { width: 360, height: 780 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(projectRootGuidance).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
  }

  await expect(page.getByText("아직 연결한 프로젝트가 없습니다.")).toBeVisible();
  await expect(page.getByLabel("서버 절대 경로")).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByLabel("서버 절대 경로").fill(originProjectPath);
  await page.getByLabel(/표시 이름/).fill("Naru E2E");
  await page.getByRole("button", { name: "연결하기" }).click();
  await expect(page.getByRole("heading", { name: "Naru E2E" })).toBeVisible();
  await expect(page.locator(".brand-context")).toHaveAttribute("title", "Naru E2E");
  await expect(page.locator(".workspace-header")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "새 터미널" })).toBeVisible();
  await expect(page.getByLabel("서버 절대 경로")).toHaveCount(0);
  await expect(page.locator(".pane-surface")).toHaveCount(3);
  await expect(page.getByLabel("Main Codex Codex")).toBeVisible();
  await expect(page.getByLabel("Quick Codex Codex")).toBeVisible();
  await expect(page.getByLabel("Dev Terminal 터미널")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => ({
        regular: document.fonts.check('400 13px "D2Coding"', "Naru 한글 Aa0"),
        bold: document.fonts.check('700 13px "D2Coding"', "Naru 한글 Aa0"),
      })),
    )
    .toEqual({ regular: true, bold: true });
  await expect(page.getByRole("separator", { name: "좌우 Pane 크기 조절" })).toHaveCount(1);
  await expect(page.getByRole("separator", { name: "상하 Pane 크기 조절" })).toHaveCount(1);

  const mainCodexSurface = page.getByLabel("Main Codex Codex");
  const quickCodexSurface = page.getByLabel("Quick Codex Codex");
  await expect(mainCodexSurface.locator(liveTerminalRowsSelector)).toContainText(
    "FAKE_CODEX_READY model=gpt-5.6-sol",
  );
  await expect(quickCodexSurface.locator(liveTerminalRowsSelector)).toContainText(
    "FAKE_CODEX_READY model=gpt-5.6-luna",
  );
  await expect(mainCodexSurface).toHaveAttribute("data-restore-phase", "ready");
  await expect(quickCodexSurface).toHaveAttribute("data-restore-phase", "ready");
  await expect(mainCodexSurface.locator(liveTerminalSelector)).toBeVisible();
  await expect(quickCodexSurface.locator(liveTerminalSelector)).toBeVisible();

  const mainCodexInput = mainCodexSurface.locator(".xterm-helper-textarea");
  await mainCodexInput.focus();
  await expect(mainCodexInput).toBeFocused();
  await page.keyboard.insertText("/status");
  await page.keyboard.press("Enter");
  const mainCodexSessionId = "11111111-1111-4111-8111-111111111111";
  await expect(mainCodexSurface.locator(liveTerminalRowsSelector)).toContainText(
    `Session ID: ${mainCodexSessionId}`,
  );
  await expect
    .poll(async () => {
      const current = await readWorkspace(page, "Naru E2E");
      const pane = current.panes.find((candidate) => candidate.title === "Main Codex");
      return {
        sessionId: pane?.codexSessionId,
        resumable: pane?.codexSessionResumable,
      };
    })
    .toEqual({ sessionId: mainCodexSessionId, resumable: true });
  const beforeResumeWorkspace = await readWorkspace(page, "Naru E2E");
  const beforeResumeActivity = beforeResumeWorkspace.panes.find(
    (candidate) => candidate.title === "Main Codex",
  )?.activity;
  if (!beforeResumeActivity) throw new Error("Main Codex activity is missing before resume");
  const mainActivity = mainCodexSurface.locator(".pane-actions .activity-status");
  const resumeProjectRow = page.locator(".project-row").filter({ hasText: "Naru E2E" });

  await mainCodexInput.focus();
  await page.keyboard.press("Control+C");
  await expect(mainCodexSurface.getByText("Codex가 중지되었습니다")).toBeVisible();
  await expect(mainCodexSurface.getByText("저장된 Codex session ID로")).toBeVisible();
  await expect(mainActivity).toHaveAttribute("data-activity-state", "failed");
  await expect(resumeProjectRow.locator(".project-status-icon .activity-status")).toHaveAttribute(
    "data-activity-state",
    "failed",
  );
  await mainCodexSurface.getByRole("button", { name: "Codex 작업 재개" }).click();
  await expect(mainCodexSurface.locator(liveTerminalRowsSelector)).toContainText(
    `resume=${mainCodexSessionId}`,
  );
  await expect(mainActivity).toHaveAttribute("data-activity-state", "idle");
  await expect(resumeProjectRow.locator(".project-status-icon .activity-status")).toHaveAttribute(
    "data-activity-state",
    "idle",
  );
  await expect
    .poll(async () => {
      const resumedWorkspace = await readWorkspace(page, "Naru E2E");
      return resumedWorkspace.panes.find((candidate) => candidate.title === "Main Codex")?.activity;
    })
    .toMatchObject({
      state: "idle",
      revision: beforeResumeActivity.revision + 2,
    });
  const resumedWorkspace = await readWorkspace(page, "Naru E2E");
  expect(
    resumedWorkspace.panes.find((candidate) => candidate.title === "Main Codex")?.activity
      .runtimeId,
  ).not.toBe(beforeResumeActivity.runtimeId);

  await expect(mainCodexSurface).toHaveAttribute("data-restore-phase", "ready");
  await mainCodexInput.focus();
  await expect(mainCodexInput).toBeFocused();
  await page.keyboard.insertText("/naru-e2e-complete");
  await page.keyboard.press("Enter");
  await expect(mainActivity).toHaveAttribute("data-activity-state", "completed");
  await page.waitForTimeout(100);
  await expect(mainActivity).toHaveAttribute("data-activity-state", "completed");
  await page.keyboard.insertText("NARU_READ_ACK");
  await expect(mainActivity).toHaveAttribute("data-activity-state", "idle");
  await page.keyboard.press("Enter");
  await expect(mainCodexSurface.locator(liveTerminalRowsSelector)).toContainText(
    'FAKE_CODEX_SUBMIT "NARU_READ_ACK"',
  );

  await mainCodexInput.focus();
  await page.keyboard.insertText("/naru-e2e-interrupt");
  await page.keyboard.press("Enter");
  await expect(mainActivity).toHaveAttribute("data-activity-state", "running");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Naru E2E" })).toBeVisible();
  await expect(mainActivity).toHaveAttribute("data-activity-state", "running");
  await expect(mainCodexSurface).toHaveAttribute("data-restore-phase", "ready");
  await expect(mainCodexSurface.locator(liveTerminalSelector)).toBeVisible();
  await mainCodexInput.focus();
  await expect(mainCodexInput).toBeFocused();
  await page.keyboard.press("Control+C");
  await expect(mainCodexSurface.locator(liveTerminalRowsSelector)).toContainText(
    "FAKE_CODEX_INTERRUPTED naru-e2e-interrupted-turn-2",
  );
  await expect(mainActivity).toHaveAttribute("data-activity-state", "canceled");
  await expect(mainActivity).toHaveAttribute("aria-label", "Main Codex 작업 상태: 사용자 취소");
  await expect(mainCodexSurface.getByText("실행 중", { exact: true })).toBeVisible();
  await expect
    .poll(async () => {
      const current = await readWorkspace(page, "Naru E2E");
      const currentPane = current.panes.find((candidate) => candidate.title === "Main Codex");
      return {
        activity: currentPane?.activity.state,
        sessionId: currentPane?.codexSessionId,
        resumable: currentPane?.codexSessionResumable,
      };
    })
    .toEqual({
      activity: "canceled",
      sessionId: mainCodexSessionId,
      resumable: true,
    });

  await mainCodexInput.focus();
  await page.keyboard.insertText("/naru-e2e-complete");
  await page.keyboard.press("Enter");
  await expect(mainActivity).toHaveAttribute("data-activity-state", "completed");
  await page.keyboard.insertText("NARU_AFTER_INTERRUPT");
  await expect(mainActivity).toHaveAttribute("data-activity-state", "idle");
  await page.keyboard.press("Enter");

  await mainCodexInput.focus();
  await page.keyboard.insertText("NARU_SHIFT_FIRST");
  await page.keyboard.press("Shift+Enter");
  await expect(mainCodexSurface.locator(liveTerminalRowsSelector)).toContainText(
    "FAKE_CODEX_SHIFT_ENTER",
  );
  await page.keyboard.insertText("NARU_SHIFT_SECOND");
  await page.keyboard.press("Enter");
  await expect(mainCodexSurface.locator(liveTerminalRowsSelector)).toContainText(
    'FAKE_CODEX_SUBMIT "NARU_SHIFT_FIRST\\nNARU_SHIFT_SECOND"',
  );

  const ctrlVPasteWasNotCanceled = await mainCodexInput.evaluate((input) => {
    const keyWasNotCanceled = input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "v",
        code: "KeyV",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "NARU_CTRL_V_TEXT");
    input.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      }),
    );
    return keyWasNotCanceled;
  });
  expect(ctrlVPasteWasNotCanceled).toBe(true);
  await page.keyboard.press("Enter");
  await expect(mainCodexSurface.locator(liveTerminalRowsSelector)).toContainText(
    'FAKE_CODEX_SUBMIT "NARU_CTRL_V_TEXT"',
  );

  await page.evaluate(() => {
    const state = window as unknown as {
      __naruClipboardFrames?: Array<Record<string, unknown>>;
      __naruOriginalWebSocketSend?: WebSocket["send"];
    };
    // The original method is restored below and always called with an explicit WebSocket receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalSend = WebSocket.prototype.send;
    state.__naruClipboardFrames = [];
    state.__naruOriginalWebSocketSend = originalSend;
    WebSocket.prototype.send = function (data): void {
      if (typeof data === "string") {
        const frame = JSON.parse(data) as Record<string, unknown>;
        if (typeof frame.type === "string" && frame.type.startsWith("clipboard.image.")) {
          state.__naruClipboardFrames?.push(frame);
          if (frame.type === "clipboard.image.commit") {
            queueMicrotask(() => {
              this.dispatchEvent(
                new MessageEvent("message", {
                  data: JSON.stringify({
                    type: "clipboard.image.result",
                    requestId: frame.requestId,
                    paneId: frame.paneId,
                    status: "attached",
                  }),
                }),
              );
            });
          }
          return;
        }
      }
      originalSend.call(this, data);
    };
  });
  await mainCodexInput.evaluate((input) => {
    const binary = atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    );
    const source = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const bytes = new Uint8Array(60_000);
    bytes.set(source);
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([bytes], "clipboard.png", { type: "image/png" }));
    input.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      }),
    );
  });
  await expect(mainCodexSurface.locator(".terminal-clipboard-notice")).toContainText(
    "이미지를 Codex에 붙였습니다.",
  );
  const clipboardFrames = await page.evaluate(() => {
    const state = window as unknown as {
      __naruClipboardFrames?: Array<Record<string, unknown>>;
      __naruOriginalWebSocketSend?: WebSocket["send"];
    };
    const frames = state.__naruClipboardFrames ?? [];
    if (state.__naruOriginalWebSocketSend) {
      WebSocket.prototype.send = state.__naruOriginalWebSocketSend;
    }
    delete state.__naruClipboardFrames;
    delete state.__naruOriginalWebSocketSend;
    return frames;
  });
  expect(clipboardFrames.map((frame) => frame.type)).toEqual([
    "clipboard.image.begin",
    "clipboard.image.chunk",
    "clipboard.image.chunk",
    "clipboard.image.commit",
  ]);
  expect(clipboardFrames[0]?.byteLength).toBe(60_000);
  expect(clipboardFrames[1]?.offset).toBe(0);
  expect(clipboardFrames[2]?.offset).toBe(48 * 1024);

  const mainCodexRuntimeLabel = await mainCodexSurface
    .locator(".pane-identity div span")
    .textContent();
  const quickCodexRuntimeLabel = await quickCodexSurface
    .locator(".pane-identity div span")
    .textContent();
  expect(mainCodexRuntimeLabel).toMatch(/^sol · xhigh · runtime [a-f0-9]{8}$/);
  expect(quickCodexRuntimeLabel).toMatch(/^luna · medium · runtime [a-f0-9]{8}$/);

  const defaultWorkspace = await readWorkspace(page, "Naru E2E");
  expect(defaultWorkspace.panes.map((pane) => [pane.title, pane.kind])).toEqual([
    ["Main Codex", "codex"],
    ["Quick Codex", "codex"],
    ["Dev Terminal", "terminal"],
  ]);
  expect(defaultWorkspace.layout).toMatchObject({
    type: "split",
    direction: "vertical",
    first: { type: "split", direction: "horizontal" },
  });

  await page.getByRole("button", { name: "터미널 다시 시작" }).click();
  await expect(page.getByLabel("Dev Terminal 터미널").getByText("실행 중")).toBeVisible();
  await expect(page.getByLabel("Dev Terminal 터미널")).toHaveAttribute(
    "data-runtime-id",
    /^[0-9a-f-]{36}$/,
  );
  await runTerminalCommand(page, "printf 'NARU_E2E_OK\\n'");
  await expect(devTerminalRows(page)).toContainText("NARU_E2E_OK");

  const originalDocumentTitle = await page.title();
  await runTerminalCommand(
    page,
    "printf '\\033]0;NARU_XSS_TITLE\\007<img src=x onerror=globalThis.__naruXss=1>\\n\\033]8;;javascript:alert(1)\\007NARU_BAD_LINK\\033]8;;\\007\\n'",
  );
  await expect(devTerminalRows(page)).toContainText("<img src=x onerror=globalThis.__naruXss=1>");
  await expect(devTerminalRows(page)).toContainText("NARU_BAD_LINK");
  await expect(page.locator(".terminal-host img")).toHaveCount(0);
  await expect(page.locator('.terminal-host a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => "__naruXss" in globalThis)).toBe(false);
  expect(await page.title()).toBe(originalDocumentTitle);
  await expect(page.getByLabel("Main Codex Codex").locator(".pane-identity div span")).toHaveText(
    mainCodexRuntimeLabel ?? "",
  );
  await expect(page.getByLabel("Quick Codex Codex").locator(".pane-identity div span")).toHaveText(
    quickCodexRuntimeLabel ?? "",
  );

  const runtimeLabel = await page
    .getByLabel("Dev Terminal 터미널")
    .locator(".pane-identity div span")
    .textContent();
  expect(runtimeLabel).toMatch(/^runtime [a-f0-9]{8}$/);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Naru E2E" })).toBeVisible();
  await expect(page.getByLabel("서버 절대 경로")).toHaveCount(0);
  await expect(
    page.getByLabel("Dev Terminal 터미널").locator(".pane-identity div span"),
  ).toHaveText(runtimeLabel ?? "");
  await expect(devTerminalRows(page)).toContainText("NARU_E2E_OK");

  await runTerminalCommand(page, "printf '\\033[?1049h\\033[2J\\033[HNARU_ALT_SCREEN\\n'");
  await expect(devTerminalRows(page)).toContainText("NARU_ALT_SCREEN");
  await page.reload();
  await expect(
    page.getByLabel("Dev Terminal 터미널").locator(".pane-identity div span"),
  ).toHaveText(runtimeLabel ?? "");
  await expect(devTerminalRows(page)).toContainText("NARU_ALT_SCREEN");
  await runTerminalCommand(page, "printf '\\033[?1049l'");
  await expect(devTerminalRows(page)).toContainText("NARU_E2E_OK");

  const terminalInput = page.getByLabel("Dev Terminal 터미널").locator(".xterm-helper-textarea");
  await page.evaluate(async () => {
    await navigator.clipboard.writeText("printf 'NARUCLIPBOARDOK\\n'");
  });
  await terminalInput.focus();
  await expect(terminalInput).toBeFocused();
  await page.keyboard.press("Meta+V");
  await page.keyboard.press("Enter");
  const clipboardRow = page
    .getByLabel("Dev Terminal 터미널")
    .locator(`${liveTerminalRowsSelector} > div`)
    .filter({ hasText: "NARUCLIPBOARDOK" })
    .last();
  await expect(clipboardRow).toBeVisible();
  const clipboardBox = await clipboardRow.boundingBox();
  expect(clipboardBox).not.toBeNull();
  await page.mouse.move((clipboardBox?.x ?? 0) + 2, (clipboardBox?.y ?? 0) + 7);
  await page.mouse.down();
  await page.mouse.move(
    (clipboardBox?.x ?? 0) + Math.min((clipboardBox?.width ?? 520) - 4, 520),
    (clipboardBox?.y ?? 0) + 7,
  );
  await page.mouse.up();
  await page.keyboard.press("Meta+C");
  await expect
    .poll(async () => await page.evaluate(async () => await navigator.clipboard.readText()))
    .toContain("NARUCLIPBOARDOK");

  await terminalInput.focus();
  await expect(terminalInput).toBeFocused();
  await page.keyboard.insertText("printf '");
  await page.keyboard.insertText("한글입력");
  await page.keyboard.insertText("\\n'");
  await page.keyboard.press("Enter");
  await expect(devTerminalRows(page)).toContainText("한글입력");

  await runTerminalCommand(
    page,
    "printf 'NARU_NET_BEFORE\\n'; sleep 0.6; printf 'NARU_NET_AFTER\\n'",
  );
  await expect(devTerminalRows(page)).toContainText("NARU_NET_BEFORE");
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(page.getByRole("status", { name: "터미널 연결 상태: 연결됨" })).toBeVisible();
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(page.getByText("재연결 중")).toBeVisible();
  await page.waitForTimeout(800);
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByRole("status", { name: "터미널 연결 상태: 연결됨" })).toBeVisible();
  await expect(devTerminalRows(page)).toContainText("NARU_NET_AFTER");
  await expect(
    page.getByLabel("Dev Terminal 터미널").locator(".pane-identity div span"),
  ).toHaveText(runtimeLabel ?? "");

  const beforeResize = await readWorkspace(page, "Naru E2E");
  if (beforeResize.layout?.type !== "split") throw new Error("default root split is missing");
  const rootSplitId = beforeResize.layout.id;
  const initialRootRatio = beforeResize.layout.ratio;
  const rootSeparator = page.locator(`[id="${rootSplitId}-separator"]`);
  await expect(rootSeparator).toHaveAttribute("aria-label", "상하 Pane 크기 조절");
  await rootSeparator.focus();
  await expect(rootSeparator).toBeFocused();
  await expect(rootSeparator).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("ArrowUp");
  await expect
    .poll(async () => {
      const current = await readWorkspace(page, "Naru E2E");
      return current.layout?.type === "split" ? current.layout.ratio : initialRootRatio;
    })
    .not.toBe(initialRootRatio);
  const resizedWorkspace = await readWorkspace(page, "Naru E2E");
  if (resizedWorkspace.layout?.type !== "split") throw new Error("resized root split is missing");
  const persistedRootRatio = resizedWorkspace.layout.ratio;

  await page.reload();
  const rootGroup = page.locator(`[id="${rootSplitId}"]`);
  const rootFirstPanel = rootGroup.locator(":scope > [data-panel]").first();
  const [rootBox, firstBox] = await Promise.all([
    rootGroup.boundingBox(),
    rootFirstPanel.boundingBox(),
  ]);
  expect(rootBox).not.toBeNull();
  expect(firstBox).not.toBeNull();
  expect((firstBox?.height ?? 0) / (rootBox?.height ?? 1)).toBeCloseTo(persistedRootRatio, 1);
  await expect(devTerminalRows(page)).toContainText("NARU_E2E_OK");

  const layoutBeforeCollapse = (await readWorkspace(page, "Naru E2E")).layout;
  const quickPaneBeforeCollapse = (await readWorkspace(page, "Naru E2E")).panes.find(
    (pane) => pane.title === "Quick Codex",
  );
  if (!quickPaneBeforeCollapse) throw new Error("Quick Codex Pane is missing");
  await page.getByRole("button", { name: "Quick Codex 접기" }).click();
  await expect(page.getByLabel("Quick Codex Codex")).toHaveCount(0);
  const restoreQuick = page.getByRole("button", { name: /Quick Codex 펼치기/ });
  await expect(restoreQuick).toBeVisible();
  await expect(page.locator("[data-group]")).toHaveCount(1);
  await expect
    .poll(async () => {
      const current = await readWorkspace(page, "Naru E2E");
      return paneIsCollapsed(current.layout, quickPaneBeforeCollapse.id);
    })
    .toBe(true);

  await page.reload();
  await expect(page.getByLabel("Quick Codex Codex")).toHaveCount(0);
  await page.getByRole("button", { name: /Quick Codex 펼치기/ }).click();
  await expect(page.getByLabel("Quick Codex Codex")).toBeVisible();
  await expect
    .poll(async () =>
      page
        .getByLabel("Quick Codex Codex")
        .evaluate((surface) => surface.contains(document.activeElement)),
    )
    .toBe(true);
  await expect(page.getByLabel("Quick Codex Codex").locator(".pane-identity div span")).toHaveText(
    quickCodexRuntimeLabel ?? "",
  );
  await expect
    .poll(async () => (await readWorkspace(page, "Naru E2E")).layout)
    .toEqual(layoutBeforeCollapse);

  await page.getByRole("button", { name: "Main Codex 접기" }).click();
  await page.getByRole("button", { name: "Quick Codex 접기" }).click();
  await expect(page.getByRole("button", { name: "Dev Terminal 접기" })).toBeDisabled();
  await page.getByRole("button", { name: /Main Codex 펼치기/ }).click();
  await page.getByRole("button", { name: /Quick Codex 펼치기/ }).click();
  await expect
    .poll(async () => (await readWorkspace(page, "Naru E2E")).layout)
    .toEqual(layoutBeforeCollapse);

  const quickPane = resizedWorkspace.panes.find((pane) => pane.title === "Quick Codex");
  if (!quickPane) throw new Error("Quick Codex Pane is missing");
  await page.getByRole("tab", { name: /Quick Codex/ }).click();
  await expect
    .poll(async () => (await readWorkspace(page, "Naru E2E")).activePaneId)
    .toBe(quickPane.id);
  await page.reload();
  await expect(page.getByRole("tab", { name: /Quick Codex/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.getByLabel("Dev Terminal 분할 메뉴").click();
  await page
    .locator("details.split-menu[open]")
    .getByRole("button", { name: "오른쪽에 터미널" })
    .click();
  await expect(page.locator(".pane-surface")).toHaveCount(4);
  await expect(page.locator("[data-group]")).toHaveCount(3);
  await expect(page.getByLabel("Terminal 2 터미널")).toBeVisible();
  await expect.poll(async () => (await readWorkspace(page, "Naru E2E")).panes.length).toBe(4);

  await page.reload();
  await expect(page.locator(".pane-surface")).toHaveCount(4);
  await expect(page.locator("[data-group]")).toHaveCount(3);
  let closeConfirmation = "";
  page.once("dialog", async (dialog) => {
    closeConfirmation = dialog.message();
    await dialog.accept();
  });
  await page
    .getByLabel("Terminal 2 터미널")
    .getByRole("button", { name: "Terminal 2 닫기" })
    .click();
  expect(closeConfirmation).toContain("실행 중인 프로세스를 종료");
  await expect(page.locator(".pane-surface")).toHaveCount(3);
  await expect(page.locator("[data-group]")).toHaveCount(2);
  await expect.poll(async () => (await readWorkspace(page, "Naru E2E")).panes.length).toBe(3);

  const beforeConflict = await readWorkspace(page, "Naru E2E");
  const persistedActive = beforeConflict.panes.find(
    (pane) => pane.id === beforeConflict.activePaneId,
  );
  const conflictingTarget = beforeConflict.panes.find(
    (pane) => pane.id !== beforeConflict.activePaneId,
  );
  if (!persistedActive || !conflictingTarget) throw new Error("conflict fixture Panes are missing");
  const workspaceRoute = "**/api/projects/*/workspace";
  await page.route(workspaceRoute, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    return route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        code: "LAYOUT_CONFLICT",
        message: "stale layout",
        requestId: "e2e-layout-conflict",
      }),
    });
  });
  await page.getByRole("tab", { name: new RegExp(conflictingTarget.title) }).click();
  await expect(page.getByRole("alert")).toContainText("최신 레이아웃을 다시 불러왔습니다");
  await expect(page.getByRole("tab", { name: new RegExp(persistedActive.title) })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.unroute(workspaceRoute);
  await page.getByRole("button", { name: "알림 닫기" }).click();

  await page.route(workspaceRoute, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        code: "INTERNAL_ERROR",
        message: "temporary save failure",
        requestId: "e2e-layout-failure",
      }),
    });
  });
  await page.getByRole("tab", { name: new RegExp(conflictingTarget.title) }).click();
  await expect(page.getByRole("alert")).toContainText("이전 저장 상태를 다시 불러왔습니다");
  await page.unroute(workspaceRoute);
  await page.getByRole("button", { name: "알림 닫기" }).click();

  await page.getByRole("tab", { name: /Main Codex/ }).click();
  await mainCodexInput.focus();
  await page.keyboard.insertText("/naru-e2e-complete");
  await page.keyboard.press("Enter");
  await expect(mainActivity).toHaveAttribute("data-activity-state", "completed");
  await page.getByRole("tab", { name: /Quick Codex/ }).click();
  const quickActivity = quickCodexSurface.locator(".pane-actions .activity-status");
  const quickCodexInput = quickCodexSurface.locator(".xterm-helper-textarea");
  await quickCodexInput.focus();
  await page.keyboard.insertText("/naru-e2e-complete");
  await page.keyboard.press("Enter");
  await expect(quickActivity).toHaveAttribute("data-activity-state", "completed");
  const e2eProjectRowBeforeSwitch = page.locator(".project-row").filter({ hasText: "Naru E2E" });
  await expect(
    e2eProjectRowBeforeSwitch.locator(".project-status-icon .activity-status"),
  ).toHaveAttribute("data-activity-state", "completed");

  await page.getByRole("button", { name: "프로젝트 연결" }).click();
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    return route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        code: "PROJECT_PERMISSION_DENIED",
        message: "프로젝트 경로를 읽을 권한이 없습니다.",
        requestId: "e2e-permission",
      }),
    });
  });
  await page.getByLabel("서버 절대 경로").fill("/private/tmp/naru-e2e-projects/private-project");
  await page.getByRole("button", { name: "연결하기" }).click();
  await expect(page.getByRole("alert")).toContainText("프로젝트 경로를 읽을 권한이 없습니다.");
  await page.unroute("**/api/projects");

  await page.getByLabel("서버 절대 경로").fill(longProjectPath);
  await page.getByLabel(/표시 이름/).fill(longProjectName);
  await page.getByRole("button", { name: "연결하기" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: longProjectName, exact: true })).toBeVisible();
  await e2eProjectRowBeforeSwitch.locator(".project-main").click();
  await expect(page.getByRole("heading", { name: "Naru E2E", exact: true })).toBeVisible();
  await expect
    .poll(
      async () =>
        (await readWorkspace(page, "Naru E2E")).panes.filter(
          (pane) => pane.activity.state === "completed",
        ).length,
    )
    .toBe(0);
  await expect(
    e2eProjectRowBeforeSwitch.locator(".project-status-icon .activity-status"),
  ).toHaveAttribute("data-activity-state", "idle");
  await page
    .locator(".project-row")
    .filter({ hasText: longProjectName })
    .locator(".project-main")
    .click();
  await expect(page.getByRole("heading", { name: longProjectName, exact: true })).toBeVisible();
  const projectSidebar = page.locator("#project-sidebar");
  await expect(projectSidebar).toHaveAttribute("data-presentation", "rail");
  await expect(projectSidebar).toHaveAttribute("data-expand-trigger", "hover");
  await expect(projectSidebar).toHaveCSS("width", "52px");
  const workspaceArea = page.locator(".workspace-area");
  const collapsedWorkspaceWidth = await workspaceArea.evaluate(
    (element) => element.getBoundingClientRect().width,
  );
  await workspaceArea.hover({ position: { x: 500, y: 200 } });
  await projectSidebar.hover();
  await expect(projectSidebar).toHaveAttribute("data-open-mode", "preview");
  await expect(projectSidebar).toHaveCSS("width", "280px");
  await expect
    .poll(async () => workspaceArea.evaluate((element) => element.getBoundingClientRect().width))
    .toBe(collapsedWorkspaceWidth);
  await workspaceArea.hover({ position: { x: 500, y: 200 } });
  await expect(projectSidebar).toHaveCSS("width", "52px");
  await projectSidebar.hover();
  await page.getByRole("button", { name: "프로젝트 메뉴 펼치기 고정" }).click();
  await expect(projectSidebar).toHaveAttribute("data-open-mode", "pinned");
  await workspaceArea.hover({ position: { x: 500, y: 200 } });
  await expect(projectSidebar).toHaveCSS("width", "280px");
  await expect
    .poll(async () => workspaceArea.evaluate((element) => element.getBoundingClientRect().width))
    .toBe(collapsedWorkspaceWidth - 228);

  const longProjectTitle = page
    .locator(".project-list strong")
    .filter({ hasText: longProjectName })
    .first();
  const longProjectPathText = page
    .locator(".project-list .project-main small")
    .filter({ hasText: longProjectPath })
    .first();
  await expect(longProjectTitle).toHaveAttribute("title", longProjectName);
  await expect(longProjectPathText).toHaveAttribute("title", longProjectPath);
  await expect(longProjectTitle).toHaveCSS("text-overflow", "ellipsis");
  await expect(longProjectPathText).toHaveCSS("text-overflow", "ellipsis");
  expect(
    await longProjectTitle.evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(true);
  expect(
    await longProjectPathText.evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(true);
  const topbarProjectTitle = page.locator(".brand-context");
  await expect(topbarProjectTitle).toHaveAttribute("title", longProjectName);
  await expect(topbarProjectTitle).toHaveCSS("text-overflow", "ellipsis");
  expect(
    await topbarProjectTitle.evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(true);

  await page.reload();
  await expect(page.getByRole("heading", { name: longProjectName, exact: true })).toBeVisible();

  await page.setViewportSize({ width: 768, height: 900 });
  await expect(projectSidebar).toHaveAttribute("data-presentation", "rail");
  const tabletSidebarExpand = page.getByRole("button", {
    name: "프로젝트 메뉴 펼치기 고정",
  });
  await tabletSidebarExpand.focus();
  await page.keyboard.press("Enter");
  await expect(longProjectTitle).toBeVisible();
  await page.getByRole("button", { name: "프로젝트 메뉴 접기" }).click();
  await expect(projectSidebar).toHaveCSS("width", "52px");
  await expect(page.getByRole("heading", { name: longProjectName, exact: true })).toBeVisible();
  await expect(page.getByTestId("recursive-workspace")).toBeVisible();
  await expect(page.locator(".pane-surface")).toHaveCount(3);
  await page.getByRole("button", { name: "Quick Codex 접기" }).click();
  await expect(page.locator(".pane-surface")).toHaveCount(2);
  await page.getByRole("button", { name: /Quick Codex 펼치기/ }).click();
  await expect(page.locator(".pane-surface")).toHaveCount(3);
  const adaptiveWorkspace = await readWorkspace(page, longProjectName);
  await chooseWorkspaceView(page, "집중 보기");
  await expect(page.getByTestId("focused-workspace")).toBeVisible();
  await expect(page.locator(".pane-surface")).toHaveCount(1);
  await chooseWorkspaceView(page, "분할 보기");
  await expect(page.getByTestId("recursive-workspace")).toBeVisible();
  await expect(page.locator(".pane-surface")).toHaveCount(3);
  const afterViewSwitch = await readWorkspace(page, longProjectName);
  expect(afterViewSwitch.layout).toEqual(adaptiveWorkspace.layout);
  expect(afterViewSwitch.panes.map((pane) => pane.id)).toEqual(
    adaptiveWorkspace.panes.map((pane) => pane.id),
  );

  await page.setViewportSize({ width: 360, height: 780 });
  await page.reload();
  await expect(page.getByRole("heading", { name: longProjectName, exact: true })).toBeVisible();
  await expect(projectSidebar).toHaveAttribute("data-presentation", "overlay");
  await expect(page.getByTestId("focused-workspace")).toBeVisible();
  await expect(page.locator(".pane-surface")).toHaveCount(1);
  const mobileActiveWorkspace = await readWorkspace(page, longProjectName);
  const mobileActivePane = mobileActiveWorkspace.panes.find(
    (pane) => pane.id === mobileActiveWorkspace.activePaneId,
  );
  if (!mobileActivePane) throw new Error("mobile active Pane is missing");
  await page.getByRole("button", { name: `${mobileActivePane.title} 접기` }).click();
  await expect(
    page.getByRole("button", { name: new RegExp(`${mobileActivePane.title} 펼치기`) }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole("button", { name: new RegExp(`${mobileActivePane.title} 펼치기`) }).click();
  await expect(page.locator(`.pane-surface[data-pane-id="${mobileActivePane.id}"]`)).toBeVisible();
  await expect(page.getByRole("button", { name: "프로젝트 메뉴 열기" })).toBeVisible();
  await openTopbarMenu(page);
  const mobileTopbarMenu = page.getByRole("group", { name: "작업공간 메뉴" });
  await expect(mobileTopbarMenu.getByRole("button", { name: "새 터미널" })).toBeVisible();
  await expect(mobileTopbarMenu.getByRole("button", { name: "입력 도우미: 자동" })).toBeVisible();
  await expect(mobileTopbarMenu.getByRole("button", { name: "스크린 리더 모드" })).toBeVisible();
  await expect(mobileTopbarMenu.getByRole("button", { name: "로그아웃" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "작업공간 메뉴 열기" })).toBeFocused();
  await page.getByRole("button", { name: "프로젝트 메뉴 열기" }).click();
  await expect(longProjectTitle).toBeVisible();

  await page.getByRole("button", { name: "프로젝트 연결" }).click();
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    return route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        code: "PROJECT_PERMISSION_DENIED",
        message: "프로젝트 경로를 읽을 권한이 없습니다.",
        requestId: "e2e-mobile-permission",
      }),
    });
  });
  await page.getByLabel("서버 절대 경로").fill("/private/tmp/naru-e2e-projects/private-project");
  await page.getByRole("button", { name: "연결하기" }).click();
  const mobileNotice = page.getByRole("alert");
  await expect(mobileNotice).toContainText("프로젝트 경로를 읽을 권한이 없습니다.");
  const noticeBox = await mobileNotice.boundingBox();
  expect(noticeBox).not.toBeNull();
  expect((noticeBox?.x ?? 0) + (noticeBox?.width ?? 0)).toBeLessThanOrEqual(360);
  await page.unroute("**/api/projects");
  await page.getByRole("button", { name: "알림 닫기" }).click();
  await page.getByRole("button", { name: "폼 닫기" }).click();

  await page
    .locator(".project-row")
    .filter({ hasText: "Naru E2E" })
    .locator(".project-main")
    .click();
  await page.getByRole("tab", { name: /Dev Terminal/ }).click();
  await expect(page.getByLabel("Dev Terminal 터미널")).toBeVisible();
  await expect(
    page.getByLabel("Dev Terminal 터미널").locator(".pane-identity div span"),
  ).toHaveText(runtimeLabel ?? "");
  await expect
    .poll(async () => {
      const current = await readWorkspace(page, "Naru E2E");
      return current.panes.find((pane) => pane.id === current.activePaneId)?.title;
    })
    .toBe("Dev Terminal");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Naru E2E" })).toBeVisible();
  await expect(devTerminalRows(page)).toContainText("NARU_E2E_OK");

  await page.waitForTimeout(100);
  const mobileColumns = await readTerminalColumns(page, "MOBILE");
  await expect(
    page.getByLabel("Dev Terminal 터미널").locator(".pane-identity div span"),
  ).toHaveText(runtimeLabel ?? "");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect
    .poll(async () => {
      const value = await page
        .getByLabel("Dev Terminal 터미널")
        .locator(".terminal-host")
        .getAttribute("data-terminal-cols");
      return value === null ? 0 : Number(value);
    })
    .toBeGreaterThan(mobileColumns);
  const desktopColumns = await readTerminalColumns(page, "DESKTOP");
  expect(desktopColumns).toBeGreaterThan(mobileColumns);
  await expect(page.getByLabel("Main Codex Codex").locator(".pane-identity div span")).toHaveText(
    mainCodexRuntimeLabel ?? "",
  );
  await expect(page.getByLabel("Quick Codex Codex").locator(".pane-identity div span")).toHaveText(
    quickCodexRuntimeLabel ?? "",
  );
  await expect(
    page.getByLabel("Dev Terminal 터미널").locator(".pane-identity div span"),
  ).toHaveText(runtimeLabel ?? "");

  await runTerminalCommand(page, "exit 7");
  await expect(page.getByText("터미널이 중지되었습니다")).toBeVisible();
  await expect(page.getByText("종료됨")).toBeVisible();
  const e2eProjectRow = page.locator(".project-row").filter({ hasText: "Naru E2E" });
  await expect(e2eProjectRow.locator(".project-status-icon .activity-status")).toHaveAttribute(
    "data-activity-state",
    "failed",
  );
  await page.getByRole("button", { name: "터미널 다시 시작" }).click();
  await expect(page.getByLabel("Dev Terminal 터미널").getByText("실행 중")).toBeVisible();
  await expect(e2eProjectRow.locator(".project-status-icon .activity-status")).toHaveAttribute(
    "data-activity-state",
    "idle",
  );
  await expect
    .poll(
      async () =>
        await page
          .getByLabel("Dev Terminal 터미널")
          .locator(".pane-identity div span")
          .textContent(),
    )
    .not.toBe(runtimeLabel);
  await runTerminalCommand(page, "printf 'NARU_RESTART_OK\\n'");
  await expect(devTerminalRows(page)).toContainText("NARU_RESTART_OK");

  const freshMainCodex = page.getByLabel("Main Codex Codex");
  await freshMainCodex.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+C");
  await expect(freshMainCodex.getByRole("button", { name: "Codex 작업 재개" })).toBeVisible();
  await expect(freshMainCodex.getByRole("button", { name: "새 Codex 시작" })).toBeVisible();
  await freshMainCodex.getByRole("button", { name: "새 Codex 시작" }).click();
  await expect(freshMainCodex.locator(liveTerminalRowsSelector)).toContainText("resume=none");
  expect(browserErrors).toEqual([]);
});

test("returns to login for REST and WebSocket authentication loss and safely restores workspace", async ({
  page,
}) => {
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Naru E2E", exact: true })).toBeVisible();
  await expect(page.locator(".pane-surface")).toHaveCount(3);

  await page.route("**/api/passkeys", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({
        code: "AUTH_REQUIRED",
        message: "로그인이 필요합니다.",
        requestId: "e2e-expired-rest-session",
      }),
    });
  });
  await page.getByRole("button", { name: "패스키", exact: true }).click();
  await expect(page.locator(".login-session-notice")).toContainText("세션이 만료되었습니다");
  await expect(page.locator(".app-shell")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Naru E2E", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Naru 비밀번호")).toBeHidden();
  await page.unroute("**/api/passkeys");

  await loginWithPassword(page, "naru-test-password");
  await expect(page.getByRole("heading", { name: "Naru E2E", exact: true })).toBeVisible();
  await expect(page.locator(".pane-surface")).toHaveCount(3);

  await page.evaluate(async () => {
    const sessionResponse = await fetch("/api/session");
    const session = (await sessionResponse.json()) as { csrfToken: string };
    const logoutResponse = await fetch("/api/auth/logout", {
      method: "POST",
      headers: { "x-csrf-token": session.csrfToken },
    });
    if (!logoutResponse.ok) throw new Error(`Logout failed with ${logoutResponse.status}.`);
  });
  await expect(page.locator(".login-session-notice")).toContainText(
    "로그아웃되어 다시 인증해야 합니다",
  );
  await expect(page.locator(".app-shell")).toHaveCount(0);

  await loginWithPassword(page, "naru-test-password");
  await expect(page.getByRole("heading", { name: "Naru E2E", exact: true })).toBeVisible();
  await expect(page.locator(".pane-surface")).toHaveCount(3);
});

function paneIsCollapsed(layout: LayoutNode | null, paneId: string): boolean {
  if (layout === null) return false;
  if (layout.type === "pane") return layout.paneId === paneId && layout.collapsed;
  return paneIsCollapsed(layout.first, paneId) || paneIsCollapsed(layout.second, paneId);
}

test("opens independent Docs and Tasks Panes with persistent responsive document views", async ({
  page,
}) => {
  const browserErrors = collectBrowserErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);

  const existingProject = await page.evaluate(async (path) => {
    const response = await fetch("/api/projects");
    const projects = (await response.json()) as Array<{ name: string; path: string }>;
    return projects.find((project) => project.path === path) ?? null;
  }, originProjectPath);
  const documentProjectName = existingProject?.name ?? "Naru Docs E2E";
  if (!existingProject) {
    await addProjectWithKeyboard(page, originProjectPath, documentProjectName);
  }

  const projectButton = page
    .locator(".project-row")
    .filter({ hasText: documentProjectName })
    .locator(".project-main");
  const sidebarExpand = page.getByRole("button", { name: "프로젝트 메뉴 펼치기 고정" });
  if (existingProject && !(await projectButton.isVisible())) {
    await sidebarExpand.click();
  }
  if (existingProject) await projectButton.click();
  await expect(page.getByRole("heading", { name: documentProjectName, exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Docs", exact: true }).click();
  const firstDocs = page.getByLabel("Docs 문서");
  await expect(firstDocs).toBeVisible();
  await expect(firstDocs.getByText("읽기 전용")).toBeVisible();
  const taskDocumentButton = firstDocs
    .locator(".document-navigation button")
    .filter({ hasText: "docs/TASKS.md" });
  await taskDocumentButton.focus();
  await page.keyboard.press("Enter");
  await expect(taskDocumentButton).toHaveAttribute("aria-current", "page");
  await expect(firstDocs.locator(".document-header")).toContainText("TASKS");
  const docsTaskSection = firstDocs
    .locator(".document-section")
    .filter({ hasText: "프로젝트 Docs·Tasks 정리 보기 Pane" });
  await expect(docsTaskSection).not.toHaveAttribute("open", "");
  await docsTaskSection.locator("summary").click();
  await expect(docsTaskSection).toHaveAttribute("open", "");
  await expect(docsTaskSection.locator(".document-section-body")).toContainText(
    "현재 선택한 프로젝트 폴더",
  );
  await expect(firstDocs.locator(".document-content")).toHaveCSS("padding-left", "16px");
  await expect(firstDocs.locator(".document-content")).toHaveCSS("padding-right", "16px");
  await expect(docsTaskSection.locator("summary")).toHaveCSS("padding-left", "8px");
  await expect(docsTaskSection.locator("summary")).toHaveCSS("padding-right", "8px");
  await expect(docsTaskSection.locator(".document-section-body")).toHaveCSS("padding-left", "12px");
  await expect(docsTaskSection.locator(".document-section-body")).toHaveCSS(
    "padding-right",
    "12px",
  );
  await expect(docsTaskSection.locator(".document-markdown")).toHaveCSS("font-size", "14px");
  const headerFlow = await firstDocs.locator(".document-header").evaluate((header) => {
    const metadata = header.querySelector("p")?.getBoundingClientRect();
    const actions = header.querySelector(".document-open-actions")?.getBoundingClientRect();
    return metadata && actions
      ? { metadataBottom: metadata.bottom, actionsTop: actions.top }
      : null;
  });
  expect(headerFlow).not.toBeNull();
  expect(headerFlow?.actionsTop ?? 0).toBeGreaterThanOrEqual(headerFlow?.metadataBottom ?? 1);

  await firstDocs.getByRole("button", { name: "오른쪽에 열기" }).click();
  const secondDocs = page.getByLabel("Docs 2 문서");
  await expect(secondDocs).toBeVisible();
  await expect(secondDocs.locator(".document-header")).toContainText("docs/TASKS.md");
  await expect(page.locator('.pane-surface[data-pane-kind="docs"]')).toHaveCount(2);

  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  const tasksPane = page.getByLabel("Tasks 작업 목록");
  await expect(tasksPane).toBeVisible();
  await page.setViewportSize({ width: 768, height: 900 });
  await chooseWorkspaceView(page, "집중 보기");
  await expect(page.getByTestId("focused-workspace")).toBeVisible();
  const currentTask = tasksPane.locator(".task-card").filter({ hasText: stableTaskTitle });
  await expect(currentTask).not.toHaveAttribute("open", "");
  await expect(currentTask.getByText(/실행 중 Codex TUI/)).toBeHidden();
  await currentTask.locator("summary").click();
  await expect(currentTask).toHaveAttribute("open", "");
  await expect(currentTask.getByText(/실행 중 Codex TUI/)).toBeVisible();
  await expect(currentTask.locator("summary")).toHaveCSS("padding-left", "8px");
  await expect(currentTask.locator("summary")).toHaveCSS("padding-right", "8px");
  await expect(currentTask.locator(".task-card-body")).toHaveCSS("padding-left", "12px");
  await expect(currentTask.locator(".task-card-body")).toHaveCSS("padding-right", "12px");
  await expect(currentTask.locator(".task-card-body")).toHaveCSS("font-size", "14px");
  await expect(tasksPane.getByText("진행 중", { exact: true }).first()).toBeVisible();
  const inProgressTaskGroup = tasksPane
    .locator(".task-group")
    .filter({ has: page.getByRole("heading", { name: "진행 중", exact: true }) });
  await expect(inProgressTaskGroup).toContainText("진행 중인 작업이 없습니다.");
  const nextTaskGroup = tasksPane
    .locator(".task-group")
    .filter({ has: page.getByRole("heading", { name: "다음 작업", exact: true }) });
  await expect(nextTaskGroup).toContainText("명시된 다음 작업이 없습니다.");
  const deferredTaskGroup = tasksPane
    .locator(".task-group")
    .filter({ has: page.getByRole("heading", { name: "보류", exact: true }) });
  await expect(deferredTaskGroup).toContainText("T14");
  await expect(deferredTaskGroup).toContainText("T26");
  await expect(deferredTaskGroup).not.toContainText("T27");
  await expect(tasksPane.locator('.task-card[data-status="deferred"]')).toHaveCount(2);
  const completedTaskGroup = tasksPane.locator(".completed-task-group");
  await expect(completedTaskGroup).not.toHaveAttribute("open", "");
  await expect(completedTaskGroup).toContainText("T33");
  await expect(completedTaskGroup).toContainText("T27");
  await expectNoAccessibilityViolations(page, "Docs and Tasks workspace");

  const workspace = await readWorkspace(page, documentProjectName);
  const docsPanes = workspace.panes.filter((pane) => pane.kind === "docs");
  expect(docsPanes).toHaveLength(2);
  expect(docsPanes.map((pane) => pane.viewState.selectedDocumentPath)).toEqual([
    "docs/TASKS.md",
    "docs/TASKS.md",
  ]);
  expect(workspace.panes.filter((pane) => pane.kind === "tasks")).toHaveLength(1);

  await page.getByRole("tab", { name: "Docs", exact: true }).click();
  await expect(firstDocs).toBeVisible();
  await expect(firstDocs.locator(".document-header")).toContainText("docs/TASKS.md");
  await page.getByRole("tab", { name: "Tasks", exact: true }).click();
  await expect(tasksPane.getByText(stableTaskTitle)).toBeVisible();
  await expect
    .poll(async () => {
      const persisted = await readWorkspace(page, documentProjectName);
      return persisted.panes.find((pane) => pane.id === persisted.activePaneId)?.kind;
    })
    .toBe("tasks");

  await page.reload();
  await expect(tasksPane).toBeVisible();
  await expect(tasksPane.getByText(stableTaskTitle)).toBeVisible();
  await expect(
    tasksPane.locator(".task-card").filter({ hasText: stableTaskTitle }),
  ).not.toHaveAttribute("open", "");

  await page.setViewportSize({ width: 360, height: 780 });
  await expect(page.getByTestId("focused-workspace")).toBeVisible();
  await expect(page.locator(".pane-surface")).toHaveCount(1);
  await expect(tasksPane).toBeVisible();
  await expect(tasksPane.locator(".document-content")).toHaveCSS("padding-left", "10px");
  await expect(tasksPane.locator(".document-content")).toHaveCSS("padding-right", "10px");
  await tasksPane.getByRole("button", { name: "문서 목록 접기" }).click();
  await expect(tasksPane.locator(".document-navigation")).toHaveCount(0);
  await expect(tasksPane.getByText(stableTaskTitle)).toBeVisible();
  const horizontalOverflow = await tasksPane.evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  );
  expect(horizontalOverflow).toBeLessThanOrEqual(1);

  await openTopbarMenu(page);
  await page
    .getByRole("group", { name: "작업공간 메뉴" })
    .getByRole("button", { name: "Docs Pane" })
    .click();
  await expect(page.getByRole("tab", { name: /Docs 2/ })).toBeVisible();
  await expect(page.locator('.pane-surface[data-pane-kind="docs"]')).toHaveCount(1);
  await expect(page.getByLabel("Docs 문서")).toContainText("docs/TASKS.md");

  await page.setViewportSize({ width: 1280, height: 800 });
  const runtimeIds = await readAllRuntimeIds(page);
  const inputTools = page.locator(".mobile-terminal-tools");
  await expect(inputTools).toHaveCount(3);
  for (const tool of await inputTools.all()) await expect(tool).toBeHidden();
  const inputToolsToggle = page.getByRole("button", { name: "입력 도우미: 자동" });
  await inputToolsToggle.click();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-terminal-input-tools", "always");
  for (const tool of await inputTools.all()) await expect(tool).toBeVisible();
  const wideTabletTerminal = page.getByLabel("Dev Terminal 터미널");
  await wideTabletTerminal.getByRole("button", { name: "한글 입력" }).click();
  await expect(wideTabletTerminal.getByLabel("Dev Terminal 터미널로 보낼 텍스트")).toBeVisible();
  await expect(wideTabletTerminal.getByLabel("Dev Terminal 터미널로 보낼 텍스트")).toBeFocused();
  await expectRuntimeIds(page, runtimeIds);
  await page.reload();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-terminal-input-tools", "always");
  await expect(page.getByRole("button", { name: "입력 도우미: 항상" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  for (const tool of await page.locator(".mobile-terminal-tools").all()) {
    await expect(tool).toBeVisible();
  }
  await expectRuntimeIds(page, runtimeIds);
  await page.getByRole("button", { name: "입력 도우미: 항상" }).click();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-terminal-input-tools", "auto");
  for (const tool of await page.locator(".mobile-terminal-tools").all()) {
    await expect(tool).toBeHidden();
  }
  expect(browserErrors).toEqual([]);
});

test("edits project files, preserves drafts, and resolves a concurrent save conflict", async ({
  page,
}) => {
  const filesProjectPath = process.env.NARU_E2E_FILES_PROJECT;
  if (!filesProjectPath) throw new Error("NARU_E2E_FILES_PROJECT is required");
  const browserErrors = collectBrowserErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await addProjectWithKeyboard(page, filesProjectPath, "Naru Files E2E");
  await expect(page.getByRole("heading", { name: "Naru Files E2E", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Files", exact: true }).click();
  const filesPane = page.getByLabel("Files 프로젝트 파일");
  await expect(filesPane).toBeVisible();
  const sourceDirectory = filesPane.getByRole("button", { name: /src/ });
  await sourceDirectory.focus();
  await page.keyboard.press("Enter");
  const appFile = filesPane.getByRole("button", { name: /app\.ts/ });
  await expect(appFile).toBeVisible();
  await appFile.click();

  const editor = filesPane.getByLabel("src/app.ts 편집");
  await expect(editor).toHaveValue("const base = true;\n");
  await editor.fill("const mine = true;\n");
  await expect(filesPane.getByText("메모리 초안 보존됨")).toBeVisible();

  await writeFile(join(filesProjectPath, "src", "app.ts"), "const theirs = true;\n");
  await filesPane.getByRole("button", { name: "저장", exact: true }).click();
  await expect(
    filesPane.getByRole("heading", { name: "내 초안과 현재 디스크 변경이 겹칩니다" }),
  ).toBeVisible();
  expect(await readFile(join(filesProjectPath, "src", "app.ts"), "utf8")).toBe(
    "const theirs = true;\n",
  );
  expect(await readFile(join(filesProjectPath, "src", "app.ts"), "utf8")).not.toContain("<<<<<<<");

  await expect(filesPane.getByRole("heading", { name: "직접 병합" })).toBeVisible();
  await expect(filesPane.getByText("1개 중 0개 선택 · 1개 남음")).toBeVisible();
  await expect(filesPane.getByRole("button", { name: "병합 결과 검토" })).toBeDisabled();
  await expect(filesPane.locator(".file-conflict-base")).not.toHaveAttribute("open", "");
  await expect(filesPane.getByRole("heading", { name: "Codex로 병합" })).toBeVisible();
  await expect(filesPane.locator(".file-conflict-recovery")).not.toHaveAttribute("open", "");
  await expect(filesPane.getByRole("button", { name: "내 초안으로 덮어쓰기" })).toBeHidden();

  await expectNoAccessibilityViolations(page, "Files conflict editor");

  await page.setViewportSize({ width: 768, height: 900 });
  await expect
    .poll(async () => filesPane.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 360, height: 780 });
  await expect(page.locator(".app-shell")).toHaveAttribute("data-workspace-view", "focus");
  await expect(filesPane.getByRole("heading", { name: "직접 병합" })).toBeVisible();
  await expect
    .poll(async () => filesPane.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1);

  const codexSelector = filesPane.getByLabel("충돌을 전달할 Codex Pane");
  await expect(codexSelector.locator("option:checked")).toHaveText("Main Codex");
  await expect(filesPane.getByText("Main Codex를 기본으로 선택했습니다")).toBeVisible();
  await filesPane.getByRole("button", { name: "Main Codex로 병합 요청" }).click();
  await expect(filesPane.getByText("요청을 보냈습니다", { exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(filesPane.getByRole("button", { name: "병합 결과 검토" })).toBeDisabled();

  const codexMergedSource = "const mine = true;\nconst theirs = true;\n";
  await writeFile(join(filesProjectPath, "src", "app.ts"), codexMergedSource);
  await page.getByRole("tab", { name: /Main Codex/ }).click();
  await expect(filesPane).toHaveCount(0);
  const mainCodex = page.getByLabel("Main Codex Codex");
  await expect(mainCodex).toHaveAttribute("data-restore-phase", "ready");
  await expect(mainCodex.locator(liveTerminalSelector)).toBeVisible();
  const mainCodexInput = mainCodex.locator(".xterm-helper-textarea");
  await mainCodexInput.focus();
  await expect(mainCodexInput).toBeFocused();
  await page.keyboard.insertText("/naru-e2e-complete");
  await page.keyboard.press("Enter");
  await expect(mainCodex.locator(".pane-actions .activity-status")).toHaveAttribute(
    "data-activity-state",
    "completed",
  );

  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(filesPane.getByRole("heading", { name: "병합 결과를 검토해 주세요" })).toBeVisible();
  await expect(
    filesPane.getByRole("heading", { name: "내 초안과 현재 디스크 변경이 겹칩니다" }),
  ).toHaveCount(0);
  await expect(editor).toHaveValue(codexMergedSource);
  await expect(filesPane.locator(".file-assistant-review > details")).not.toHaveAttribute(
    "open",
    "",
  );
  expect(await readFile(join(filesProjectPath, "src", "app.ts"), "utf8")).toBe(codexMergedSource);
  await filesPane.getByRole("button", { name: "검토 완료" }).click();

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId("recursive-workspace")).toBeVisible();
  await expect(editor).toHaveValue(codexMergedSource);
  await editor.fill("const manualMine = true;\n");
  await expect(editor).toHaveValue("const manualMine = true;\n");
  await expect(filesPane.getByText("메모리 초안 보존됨")).toBeVisible();
  await writeFile(join(filesProjectPath, "src", "app.ts"), "const manualTheirs = true;\n");
  await filesPane.getByRole("button", { name: "저장", exact: true }).click();
  const firstHunk = filesPane.locator(".file-conflict-hunk").first();
  await firstHunk.getByRole("button", { name: "내 변경 사용", exact: true }).click();
  await expect(filesPane.getByText("1개 선택 완료")).toBeVisible();
  await expect(filesPane.getByRole("button", { name: "병합 결과 검토" })).toBeEnabled();
  await filesPane.getByRole("button", { name: "병합 결과 검토" }).click();
  await expect(editor).toHaveValue("const manualMine = true;\n");
  await filesPane.getByRole("button", { name: "저장", exact: true }).click();
  await expect(filesPane.getByText("저장됨", { exact: true })).toBeVisible();
  expect(await readFile(join(filesProjectPath, "src", "app.ts"), "utf8")).toBe(
    "const manualMine = true;\n",
  );

  await filesPane.getByRole("button", { name: "파일 탐색기 펼치기" }).click();
  await filesPane.getByLabel("새 파일").fill("src/new.ts");
  await filesPane.getByRole("button", { name: "만들기" }).click();
  const newEditor = filesPane.getByLabel("src/new.ts 편집");
  await expect(newEditor).toHaveValue("");
  await newEditor.fill("export const created = true;\n");
  await filesPane.getByRole("button", { name: "저장", exact: true }).click();
  await expect(filesPane.getByText("저장됨", { exact: true })).toBeVisible();
  expect(await readFile(join(filesProjectPath, "src", "new.ts"), "utf8")).toBe(
    "export const created = true;\n",
  );

  await filesPane.getByRole("button", { name: "파일 탐색기 펼치기" }).click();
  await filesPane.getByRole("button", { name: /\.env/ }).click();
  await expect(filesPane.getByRole("heading", { name: "민감할 수 있는 파일입니다" })).toBeVisible();
  await expect(filesPane.getByText("TOKEN=fake-e2e-value")).toHaveCount(0);
  await filesPane.getByRole("button", { name: "내용 열기" }).click();
  await expect(filesPane.getByLabel(".env 편집")).toHaveValue("TOKEN=fake-e2e-value\n");

  await page.setViewportSize({ width: 768, height: 900 });
  await expect(filesPane).toBeVisible();
  expect(
    await filesPane.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 360, height: 780 });
  await expect(page.getByTestId("focused-workspace")).toBeVisible();
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(filesPane.getByRole("heading", { name: "민감할 수 있는 파일입니다" })).toBeVisible();
  await filesPane.getByRole("button", { name: "내용 열기" }).click();
  await expect(filesPane.getByLabel(".env 편집")).toHaveValue("TOKEN=fake-e2e-value\n");
  await filesPane.getByRole("button", { name: "파일 탐색기 펼치기" }).click();
  await expect(filesPane.locator(".files-navigation")).toBeVisible();
  await filesPane.getByRole("button", { name: "파일 탐색기 접기" }).click();
  await expect(filesPane.locator(".files-navigation")).toHaveCount(0);
  expect(
    await filesPane.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  await expectNoAccessibilityViolations(page, "Files conflict editor and narrow editor");
  expect(browserErrors).toEqual([]);
});

test("keeps a second browser observable until explicit takeover and preserves every runtime", async ({
  page,
  browser,
}) => {
  const desktopErrors = collectBrowserErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);

  const pinSidebar = page.getByRole("button", { name: "프로젝트 메뉴 펼치기 고정" });
  if (await pinSidebar.isVisible()) await pinSidebar.click();
  const addProject = page.getByRole("button", { name: "프로젝트 연결" });
  if ((await addProject.count()) > 0 && (await addProject.first().isVisible())) {
    await addProject.first().click();
  }
  await page.getByLabel("서버 절대 경로").fill(handoffProjectPath);
  await page.getByLabel(/표시 이름/).fill(handoffProjectName);
  await page.getByRole("button", { name: "연결하기" }).click();
  await expect(page.getByRole("heading", { name: handoffProjectName, exact: true })).toBeVisible();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-lease-acquisition", "initial");
  await expect(page.locator(".pane-surface")).toHaveCount(3);

  await page.getByRole("button", { name: "터미널 다시 시작" }).click();
  await expect(page.getByLabel("Dev Terminal 터미널").getByText("실행 중")).toBeVisible();
  await runTerminalCommand(page, "printf 'NARU_HANDOFF_DESKTOP\\n'");
  await expect(devTerminalRows(page)).toContainText("NARU_HANDOFF_DESKTOP");
  const runtimeIds = await readAllRuntimeIds(page);

  await page.reload();
  await expect(page.getByRole("heading", { name: handoffProjectName, exact: true })).toBeVisible();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-lease-acquisition", "reconnect");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-surface-role", "controller");
  await expectRuntimeIds(page, runtimeIds);
  await expect(devTerminalRows(page)).toContainText("NARU_HANDOFF_DESKTOP");
  const desktopCanonicalColumns = await page
    .getByLabel("Dev Terminal 터미널")
    .locator(".terminal-host")
    .getAttribute("data-terminal-cols");
  expect(desktopCanonicalColumns).toMatch(/^\d+$/);

  const mobileContext = await browser.newContext({
    baseURL: e2eOrigin,
    hasTouch: true,
    viewport: { width: 360, height: 780 },
  });
  const mobilePage = await mobileContext.newPage();
  const mobileCdp = await mobileContext.newCDPSession(mobilePage);
  const mobileErrors = collectBrowserErrors(mobilePage);
  try {
    await signIn(mobilePage);
    await expect(mobilePage.locator(".app-shell")).toHaveAttribute("data-surface-role", "observer");
    await expect(mobilePage.locator(".app-shell")).toHaveAttribute(
      "data-connection-state",
      "active",
    );
    await expect(page.locator(".app-shell")).toHaveAttribute("data-surface-role", "controller");
    await expect(page.locator(".app-shell")).toHaveAttribute("data-connection-state", "active");
    await expect(mobilePage.locator(".takeover-banner")).toContainText(
      "다른 화면이 제어 중입니다.",
    );
    await expect(
      mobilePage.getByRole("button", { name: "제어권 가져오기", exact: true }),
    ).toBeVisible();

    await mobilePage.getByRole("button", { name: "프로젝트 메뉴 열기" }).click();
    await mobilePage
      .locator(".project-row")
      .filter({ hasText: handoffProjectName })
      .locator(".project-main")
      .click();
    await expect(
      mobilePage.getByRole("heading", { name: handoffProjectName, exact: true }),
    ).toBeVisible();
    await expect(mobilePage.getByTestId("focused-workspace")).toBeVisible();
    await expect(mobilePage.locator(".pane-surface")).toHaveCount(1);

    for (const pane of runtimePaneDefinitions) {
      const tab = mobilePage.getByRole("tab", { name: new RegExp(pane.title) });
      await tab.click();
      const surface = mobilePage.getByLabel(pane.label);
      await expect(surface).toBeVisible();
      await expect(surface).toHaveAttribute("data-runtime-id", runtimeIds[pane.title] ?? "missing");
      await expect(surface).toHaveAttribute("data-control-role", "observer");
    }

    const devTab = mobilePage.getByRole("tab", { name: /Dev Terminal/ });
    await devTab.focus();
    await mobilePage.keyboard.press("ArrowRight");
    const mainTab = mobilePage.getByRole("tab", { name: /Main Codex/ });
    await expect(mainTab).toBeFocused();
    await expect(mainTab).toHaveAttribute("aria-selected", "true");
    await devTab.click();
    const observerDevTerminal = mobilePage.getByLabel("Dev Terminal 터미널");
    await expect(observerDevTerminal.locator(".terminal-host")).toHaveAttribute(
      "data-terminal-cols",
      desktopCanonicalColumns ?? "missing",
    );
    await expect(observerDevTerminal.locator(".terminal-host")).toHaveAttribute("tabindex", "0");
    await expect(mobilePage.getByRole("button", { name: "Dev Terminal 닫기" })).toBeDisabled();
    await expect(
      mobilePage.getByRole("button", {
        name: "Dev Terminal 분할은 보기 전용 화면에서 사용할 수 없음",
      }),
    ).toBeDisabled();

    const blockedObserverInput = observerDevTerminal.locator(".xterm-helper-textarea");
    await blockedObserverInput.focus();
    await mobilePage.keyboard.type("printf 'NARU_OBSERVER_INPUT_SHOULD_NOT_RUN\\n'");
    await mobilePage.keyboard.press("Enter");
    await mobilePage.waitForTimeout(200);
    await expect(devTerminalRows(page)).not.toContainText("NARU_OBSERVER_INPUT_SHOULD_NOT_RUN");

    await mobilePage.getByRole("button", { name: "제어권 가져오기", exact: true }).click();
    await expect(mobilePage.locator(".app-shell")).toHaveAttribute(
      "data-lease-acquisition",
      "takeover",
    );
    await expect(mobilePage.locator(".app-shell")).toHaveAttribute(
      "data-surface-role",
      "controller",
    );
    await expect(page.locator(".app-shell")).toHaveAttribute("data-surface-role", "observer");
    await expect(page.locator(".app-shell")).toHaveAttribute("data-connection-state", "active");

    const staleDesktopInput = page
      .getByLabel("Dev Terminal 터미널")
      .locator(".xterm-helper-textarea");
    await staleDesktopInput.focus();
    await page.keyboard.type("printf 'NARU_STALE_INPUT_SHOULD_NOT_RUN\\n'");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    await expect(devTerminalRows(mobilePage)).not.toContainText("NARU_STALE_INPUT_SHOULD_NOT_RUN");

    await runTerminalCommand(mobilePage, "printf 'NARU_HANDOFF_MOBILE\\n'");
    await expect(devTerminalRows(mobilePage)).toContainText("NARU_HANDOFF_MOBILE");

    const mobileTerminalTools = mobilePage.getByRole("toolbar", {
      name: "Dev Terminal 모바일 터미널 키",
    });
    await expect(mobileTerminalTools).toBeVisible();
    await runTerminalCommand(mobilePage, "cat -v");
    await mobileTerminalTools.getByRole("button", { name: "Dev Terminal 위쪽 방향키" }).click();
    await expect(devTerminalRows(mobilePage)).toContainText("^[[A");
    await mobileTerminalTools
      .getByRole("button", { name: "Dev Terminal Ctrl 다음 키와 조합" })
      .click();
    const mobileTerminalInput = mobilePage
      .getByLabel("Dev Terminal 터미널")
      .locator(".xterm-helper-textarea");
    await mobileTerminalInput.focus();
    await mobilePage.keyboard.insertText("c");
    await expect(devTerminalRows(mobilePage)).toContainText("^C");

    await runTerminalCommand(
      mobilePage,
      'IFS= read -r first; IFS= read -r second; printf \'NARU_COMPOSE_%s|%s\\n\' "$first" "$second"',
    );
    await mobileTerminalTools.getByRole("button", { name: "한글 입력" }).click();
    const composeForm = mobilePage.getByRole("form", {
      name: "Dev Terminal 한글 보조 입력",
    });
    const composeTextArea = composeForm.getByLabel("Dev Terminal 터미널로 보낼 텍스트");
    await expect(composeForm).toHaveAttribute("autocomplete", "off");
    await expect(composeTextArea).toHaveAttribute("autocomplete", "off");
    await expect(composeTextArea).toHaveJSProperty("tagName", "TEXTAREA");
    await composeTextArea.fill("한글보조입력\n두번째줄");
    await composeForm.getByRole("button", { name: "입력" }).click();
    await mobileTerminalTools.getByRole("button", { name: "Dev Terminal Enter 키" }).click();
    await expect(devTerminalRows(mobilePage)).toContainText("NARU_COMPOSE_한글보조입력|두번째줄");
    await mobileTerminalTools.getByRole("button", { name: "한글 입력" }).click();

    const mobileDevTerminal = mobilePage.locator(
      '.pane-surface[data-pane-kind="terminal"][aria-label="Dev Terminal 터미널"]',
    );
    const scrollRuntimeId = await mobileDevTerminal.getAttribute("data-runtime-id");
    await runTerminalCommand(
      mobilePage,
      "for i in $(seq 1 320); do printf 'NARU_SCROLL_%03d\\n' $i; done",
    );
    await expect(devTerminalRows(mobilePage)).toContainText("NARU_SCROLL_320");
    const terminalScreen = mobileDevTerminal.locator(`${liveTerminalSelector} .xterm-screen`);
    const terminalScrollbar = mobileDevTerminal.locator(".scrollbar.vertical");
    const terminalScrollbarThumb = terminalScrollbar.locator(".slider");
    await expect(terminalScreen).toHaveCSS("touch-action", "pan-x pinch-zoom");
    await expect(terminalScrollbar).toHaveCSS("opacity", "1");
    await expect(terminalScrollbar).toHaveCSS("pointer-events", "auto");
    await expect(terminalScrollbar).toHaveAttribute("data-naru-touch-scrollbar", "true");
    await expect(terminalScrollbar).toHaveCSS("touch-action", "none");
    await expect(terminalScrollbarThumb).toHaveCSS("touch-action", "none");
    expect(
      await terminalScrollbar.evaluate((element) => element.getBoundingClientRect().width),
    ).toBe(28);

    await swipeTerminalScrollback(mobileCdp, terminalScreen);
    await expect
      .poll(async () => await devTerminalRows(mobilePage).textContent())
      .not.toContain("NARU_SCROLL_320");
    const scrollThumbTopBeforeRestore = await terminalScrollbarThumb.evaluate((element) =>
      Number.parseFloat((element as HTMLElement).style.top),
    );
    const scrollBottomOffsetBeforeRestore = Number(
      await mobileDevTerminal.getAttribute("data-scroll-bottom-offset"),
    );
    expect(scrollBottomOffsetBeforeRestore).toBeGreaterThan(0);
    const firstVisibleScrollRowBeforeRestore = await firstVisibleTerminalScrollRow(mobilePage);

    await mainTab.click();
    await devTab.click();
    await expect(mobileDevTerminal).toHaveAttribute(
      "data-runtime-id",
      scrollRuntimeId ?? "missing",
    );
    await expect(mobileDevTerminal).toHaveAttribute("data-restore-phase", "ready");
    await expect
      .poll(async () => Number(await mobileDevTerminal.getAttribute("data-scroll-bottom-offset")))
      .toBeGreaterThan(0);
    await expect
      .poll(async () => await firstVisibleTerminalScrollRow(mobilePage))
      .toBe(firstVisibleScrollRowBeforeRestore);
    await expect
      .poll(async () => await devTerminalRows(mobilePage).textContent())
      .not.toContain("NARU_SCROLL_320");
    await expect
      .poll(async () =>
        Math.abs(
          (await terminalScrollbarThumb.evaluate((element) =>
            Number.parseFloat((element as HTMLElement).style.top),
          )) - scrollThumbTopBeforeRestore,
        ),
      )
      .toBeLessThanOrEqual(1);

    await dragTerminalScrollbarThumbContinuously(
      mobileCdp,
      terminalScrollbar,
      terminalScrollbarThumb,
      -48,
    );
    await dragTerminalScrollbarThumbContinuously(
      mobileCdp,
      terminalScrollbar,
      terminalScrollbarThumb,
      36,
    );
    await dragTerminalScrollbarThumbContinuously(
      mobileCdp,
      terminalScrollbar,
      terminalScrollbarThumb,
      -24,
    );

    await runTerminalCommand(mobilePage, "printf 'NARU_SCROLL_INPUT_OK\\n'");
    await expect(devTerminalRows(mobilePage)).toContainText("NARU_SCROLL_INPUT_OK");
    await expect(mobileDevTerminal).toHaveAttribute(
      "data-runtime-id",
      scrollRuntimeId ?? "missing",
    );

    await mobilePage.setViewportSize({ width: 768, height: 900 });
    await expect(mobilePage.locator(".app-shell")).toHaveAttribute("data-workspace-view", "multi");
    await expect(mobilePage.getByTestId("recursive-workspace")).toBeVisible();
    await expect(mobilePage.locator(".pane-surface")).toHaveCount(3);
    await expectRuntimeIds(mobilePage, runtimeIds);
    const touchSeparator = mobilePage.getByRole("separator").first();
    await expect(touchSeparator).toHaveCSS("touch-action", "none");

    const beforeViewChange = await readWorkspace(mobilePage, handoffProjectName);
    await chooseWorkspaceView(mobilePage, "집중 보기");
    await expect(mobilePage.locator(".app-shell")).toHaveAttribute("data-workspace-view", "focus");
    await expect(mobilePage.locator(".pane-surface")).toHaveCount(1);
    await expect(mobilePage.getByRole("separator")).toHaveCount(0);
    await chooseWorkspaceView(mobilePage, "분할 보기");
    await expect(mobilePage.locator(".pane-surface")).toHaveCount(3);
    const afterViewChange = await readWorkspace(mobilePage, handoffProjectName);
    expect(afterViewChange.layout).toEqual(beforeViewChange.layout);
    expect(afterViewChange.panes.map((pane) => pane.id)).toEqual(
      beforeViewChange.panes.map((pane) => pane.id),
    );
    await expectRuntimeIds(mobilePage, runtimeIds);

    const foldTerminalHost = mobileDevTerminal.locator(".terminal-host");
    const foldBaselineResizeApplications = Number(
      (await foldTerminalHost.getAttribute("data-resize-apply-count")) ?? "0",
    );
    await mobilePage.setViewportSize({ width: 690, height: 830 });
    await expect
      .poll(async () =>
        Number((await foldTerminalHost.getAttribute("data-resize-apply-count")) ?? "0"),
      )
      .toBeGreaterThan(foldBaselineResizeApplications);
    await expect(mobilePage.locator(".app-shell")).toHaveAttribute("data-workspace-view", "multi");
    await mobilePage.getByRole("tab", { name: /Dev Terminal/ }).click();
    const foldTerminalInput = mobilePage
      .getByLabel("Dev Terminal 터미널")
      .locator(".xterm-helper-textarea");
    const foldTerminalInstanceId = await mobileDevTerminal.getAttribute(
      "data-terminal-instance-id",
    );
    expect(foldTerminalInstanceId).toMatch(/^\d+$/);
    const foldColumns = await foldTerminalHost.getAttribute("data-terminal-cols");
    const foldBottomOffset = await mobileDevTerminal.getAttribute("data-scroll-bottom-offset");
    const foldResizeApplications = Number(
      (await foldTerminalHost.getAttribute("data-resize-apply-count")) ?? "0",
    );
    await foldTerminalInput.focus();
    await mobilePage.setViewportSize({ width: 687, height: 420 });
    await expect
      .poll(async () =>
        Number((await foldTerminalHost.getAttribute("data-resize-apply-count")) ?? "0"),
      )
      .toBeGreaterThan(foldResizeApplications);
    await expect(mobilePage.locator(".app-shell")).toHaveAttribute("data-workspace-view", "multi");
    await expect(mobilePage.getByTestId("recursive-workspace")).toBeVisible();
    await expect(mobilePage.locator(".pane-surface")).toHaveCount(3);
    await expect(foldTerminalInput).toBeFocused();
    await expect(mobileDevTerminal).toHaveAttribute(
      "data-terminal-instance-id",
      foldTerminalInstanceId ?? "missing",
    );
    expect(
      Number((await foldTerminalHost.getAttribute("data-resize-apply-count")) ?? "0") -
        foldResizeApplications,
    ).toBeLessThanOrEqual(2);
    await expect(foldTerminalHost).toHaveAttribute("data-terminal-cols", foldColumns ?? "missing");
    await expect(foldTerminalHost).toHaveAttribute("data-resize-keyboard-session", "true");
    await expect(foldTerminalHost).not.toHaveAttribute("data-resize-frozen", "true");
    await expect(mobileDevTerminal).toHaveAttribute(
      "data-scroll-bottom-offset",
      foldBottomOffset ?? "0",
    );
    await expect
      .poll(async () =>
        mobilePage.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--naru-viewport-height"),
        ),
      )
      .toBe("420px");
    await mobilePage.keyboard.type("printf 'NARU_FOLD_KEYBOARD_OK\\n'");
    await expect(devTerminalRows(mobilePage)).toContainText("NARU_FOLD_KEYBOARD_OK");
    await expectRuntimeIds(mobilePage, runtimeIds);

    const foldResizeApplicationsBeforeClose = Number(
      (await foldTerminalHost.getAttribute("data-resize-apply-count")) ?? "0",
    );
    const foldBottomOffsetBeforeClose = await mobileDevTerminal.getAttribute(
      "data-scroll-bottom-offset",
    );
    await mobilePage.setViewportSize({ width: 690, height: 830 });
    await expect
      .poll(async () =>
        Number((await foldTerminalHost.getAttribute("data-resize-apply-count")) ?? "0"),
      )
      .toBeGreaterThan(foldResizeApplicationsBeforeClose);
    await expect(foldTerminalInput).toBeFocused();
    await expect(mobileDevTerminal).toHaveAttribute(
      "data-terminal-instance-id",
      foldTerminalInstanceId ?? "missing",
    );
    await expect(foldTerminalHost).toHaveAttribute("data-resize-keyboard-session", "false");
    await expect(foldTerminalHost).toHaveAttribute("data-terminal-cols", foldColumns ?? "missing");
    await expect(mobileDevTerminal).toHaveAttribute(
      "data-scroll-bottom-offset",
      foldBottomOffsetBeforeClose ?? "0",
    );
    await mobilePage.keyboard.press("Enter");
    await expect(devTerminalRows(mobilePage)).toContainText("NARU_FOLD_KEYBOARD_OK");
    const foldTerminalTools = mobilePage.getByRole("toolbar", {
      name: "Dev Terminal 모바일 터미널 키",
    });
    await foldTerminalTools.getByRole("button", { name: "한글 입력" }).click();
    const foldComposeForm = mobilePage.getByRole("form", {
      name: "Dev Terminal 한글 보조 입력",
    });
    const foldComposeInput = foldComposeForm.getByLabel("Dev Terminal 터미널로 보낼 텍스트");
    await expect(foldComposeInput).toBeFocused();
    await mobilePage.setViewportSize({ width: 690, height: 420 });
    await expect(mobilePage.locator(".app-shell")).toHaveAttribute("data-workspace-view", "multi");
    await expect(foldComposeForm).toBeVisible();
    await expect(foldComposeInput).toBeFocused();
    await expect(mobilePage.locator(".pane-surface")).toHaveCount(3);
    await expectRuntimeIds(mobilePage, runtimeIds);
    await mobilePage.setViewportSize({ width: 690, height: 830 });
    await foldTerminalTools.getByRole("button", { name: "한글 입력" }).click();

    await mobilePage.setViewportSize({ width: 1440, height: 900 });
    await expect(mobilePage.locator(".app-shell")).toHaveAttribute("data-workspace-view", "multi");
    await expect(mobilePage.getByRole("button", { name: "집중 보기" })).toHaveCount(0);
    await expectRuntimeIds(mobilePage, runtimeIds);

    await mobilePage.setViewportSize({ width: 780, height: 360 });
    await expect(mobilePage.locator(".app-shell")).toHaveAttribute("data-workspace-view", "focus");
    await expect(mobilePage.getByTestId("focused-workspace")).toBeVisible();
    await expect(mobilePage.locator(".pane-surface")).toHaveCount(1);

    await mobilePage.setViewportSize({ width: 360, height: 780 });
    await mobilePage.getByRole("tab", { name: /Dev Terminal/ }).click();
    await expect(mobilePage.getByLabel("Dev Terminal 터미널")).toHaveAttribute(
      "data-runtime-id",
      runtimeIds["Dev Terminal"] ?? "missing",
    );
    await mobilePage.setViewportSize({ width: 360, height: 420 });
    await expect
      .poll(async () =>
        mobilePage.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--naru-viewport-height"),
        ),
      )
      .toBe("420px");
    const tabListBox = await mobilePage.getByRole("tablist", { name: "열린 Pane" }).boundingBox();
    const toolbarBox = await mobilePage.locator(".pane-toolbar").boundingBox();
    expect(tabListBox).not.toBeNull();
    expect(toolbarBox).not.toBeNull();
    expect((tabListBox?.y ?? 0) + (tabListBox?.height ?? 0)).toBeLessThanOrEqual(420);
    expect((toolbarBox?.y ?? 0) + (toolbarBox?.height ?? 0)).toBeLessThanOrEqual(420);
    await runTerminalCommand(mobilePage, "printf 'NARU_SOFT_KEYBOARD_OK\\n'");
    await expect(devTerminalRows(mobilePage)).toContainText("NARU_SOFT_KEYBOARD_OK");

    await page.getByRole("button", { name: "제어권 가져오기", exact: true }).click();
    await expect(page.locator(".app-shell")).toHaveAttribute("data-lease-acquisition", "takeover");
    await expect(page.locator(".app-shell")).toHaveAttribute("data-connection-state", "active");
    await expect(page.locator(".app-shell")).toHaveAttribute("data-surface-role", "controller");
    await expect(mobilePage.locator(".app-shell")).toHaveAttribute("data-surface-role", "observer");
    await expect(mobilePage.locator(".app-shell")).toHaveAttribute(
      "data-connection-state",
      "active",
    );
    await expectRuntimeIds(page, runtimeIds);
    await expect(devTerminalRows(page)).toContainText("NARU_SOFT_KEYBOARD_OK");

    expect(mobileErrors).toEqual([]);
  } finally {
    await mobileContext.close();
  }
  expect(desktopErrors).toEqual([]);
});

test("offers actionable failures and supports keyboard-only, screen-reader, and WCAG flows", async ({
  page,
}) => {
  const browserErrors = collectBrowserErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/session", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        code: "INTERNAL_ERROR",
        message: "temporary startup failure",
        requestId: "e2e-startup-failure",
      }),
    });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Naru 서버에 연결할 수 없습니다" })).toBeVisible();
  await expect(page.getByText("e2e-startup-failure")).toBeVisible();
  await expectNoAccessibilityViolations(page, "startup failure");

  await page.unroute("**/api/session");
  await page.getByRole("button", { name: "다시 시도" }).press("Enter");
  const passkeyLogin = page.getByRole("button", { name: "패스키로 로그인" });
  await expect(passkeyLogin).toBeFocused();
  const password = page.getByLabel("Naru 비밀번호");
  await expect(password).toBeHidden();
  await page.keyboard.press("Tab");
  const passwordDisclosure = page.getByRole("button", { name: "비밀번호로 로그인" });
  await expect(passwordDisclosure).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(password).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(passwordDisclosure).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(password).toBeHidden();

  await page.route("**/api/auth/passkey/options", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        code: "INTERNAL_ERROR",
        message: "passkey temporarily unavailable",
        requestId: "e2e-passkey-failure",
      }),
    });
  });
  await passkeyLogin.press("Enter");
  await expect(password).toBeFocused();
  await expect(page.getByRole("alert")).toContainText("passkey temporarily unavailable");
  await page.unroute("**/api/auth/passkey/options");
  await expectNoAccessibilityViolations(page, "login");
  await password.fill("naru-test-password");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "작업공간 열기" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-connection-state", "active");

  await addProjectWithKeyboard(page, accessibilityProjectPath, accessibilityProjectName);
  await expect(
    page.getByRole("heading", { name: accessibilityProjectName, exact: true }),
  ).toBeFocused();
  await addProjectWithKeyboard(page, accessibilityOtherPath, accessibilityOtherName);
  await expect(
    page.getByRole("heading", { name: accessibilityOtherName, exact: true }),
  ).toBeFocused();

  const desktopSidebarExpand = page.getByRole("button", {
    name: "프로젝트 메뉴 펼치기 고정",
  });
  await desktopSidebarExpand.focus();
  await page.keyboard.press("Enter");

  const firstProjectButton = page
    .locator(".project-row")
    .filter({ has: page.getByText(accessibilityProjectName, { exact: true }) })
    .locator(".project-main");
  await firstProjectButton.focus();
  await page.keyboard.press("Enter");
  const firstProjectHeading = page.getByRole("heading", {
    name: accessibilityProjectName,
    exact: true,
  });
  await expect(firstProjectHeading).toBeFocused();
  const screenReaderToggle = page.getByRole("button", { name: "스크린 리더 모드" });
  await screenReaderToggle.press("Enter");
  await expect(screenReaderToggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Main Codex 명령 입력")).toBeAttached();
  await expect(page.getByLabel("Quick Codex 명령 입력")).toBeAttached();
  await expect(page.getByLabel("Dev Terminal 명령 입력")).toBeAttached();
  const mainCodexSurface = page.getByLabel("Main Codex Codex");
  await expect(mainCodexSurface).toHaveAttribute("data-restore-phase", "ready");
  await expect(mainCodexSurface.locator(liveTerminalSelector)).toBeVisible();
  const mainCodexInput = page.getByLabel("Main Codex 명령 입력");
  await expect(mainCodexInput).toHaveAttribute("aria-describedby", /-terminal-keyboard-help$/);
  await mainCodexInput.focus();
  await expect(mainCodexInput).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Main Codex 닫기" })).toBeFocused();
  await expectNoAccessibilityViolations(page, "desktop workspace");

  await page.setViewportSize({ width: 360, height: 780 });
  await expect(page.locator(".app-shell")).toHaveAttribute("data-workspace-view", "focus");
  const projectToggle = page.getByRole("button", { name: "프로젝트 메뉴 열기" });
  await projectToggle.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".sidebar-close")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(projectToggle).toBeFocused();
  const topbarMenuTrigger = page.getByRole("button", { name: "작업공간 메뉴 열기" });
  await topbarMenuTrigger.focus();
  await page.keyboard.press("Enter");
  const topbarMenu = page.getByRole("group", { name: "작업공간 메뉴" });
  await expect(topbarMenu).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(topbarMenu.getByRole("button", { name: "새 터미널" })).toBeFocused();
  await expectNoAccessibilityViolations(page, "open narrow workspace menu");
  await page.keyboard.press("Escape");
  await expect(topbarMenuTrigger).toBeFocused();
  const presenceHeartbeat = await page.evaluate(() => {
    let captured: Record<string, unknown> | undefined;
    // The original method is restored synchronously and called with an explicit WebSocket receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data): void {
      if (typeof data === "string") {
        const frame = JSON.parse(data) as Record<string, unknown>;
        if (frame.type === "heartbeat") captured = frame;
      }
      originalSend.call(this, data);
    };
    window.dispatchEvent(new Event("focus"));
    WebSocket.prototype.send = originalSend;
    return captured;
  });
  expect(presenceHeartbeat).toMatchObject({
    type: "heartbeat",
    presence: {
      visible: true,
      focused: true,
    },
  });
  const interactionRevision = (presenceHeartbeat?.presence as Record<string, unknown> | undefined)
    ?.interactionRevision;
  expect(typeof interactionRevision).toBe("number");
  await topbarMenuTrigger.press("Enter");
  const notificationAction = topbarMenu.getByRole("button", { name: "알림 관리" });
  await notificationAction.focus();
  await page.keyboard.press("Enter");
  const notificationDialog = page.getByRole("dialog", { name: "알림 관리" });
  await expect(notificationDialog).toBeVisible();
  await expect(notificationDialog).toContainText("서버 Web Push 미설정");
  const inactivityDelay = notificationDialog.getByLabel("활성 기기 알림 대기");
  await expect(inactivityDelay).toHaveValue("2");
  await inactivityDelay.fill("3");
  await notificationDialog.getByRole("button", { name: "저장" }).click();
  await expect(notificationDialog).toContainText("활성 기기 알림 대기 시간을 저장했습니다.");
  await inactivityDelay.fill("2");
  await notificationDialog.getByRole("button", { name: "저장" }).click();
  await expectNoAccessibilityViolations(page, "notification management dialog");
  await page.keyboard.press("Escape");
  await expect(notificationDialog).toHaveCount(0);
  await expect(topbarMenuTrigger).toBeFocused();
  await topbarMenuTrigger.press("Enter");
  await page.locator(".pane-tabs").click({ position: { x: 4, y: 4 } });
  await expect(topbarMenu).toHaveCount(0);
  await expectNoAccessibilityViolations(page, "narrow workspace");

  await page.setViewportSize({ width: 768, height: 900 });
  const tabletSidebarExpand = page.getByRole("button", {
    name: "프로젝트 메뉴 펼치기 고정",
  });
  await tabletSidebarExpand.focus();
  await page.keyboard.press("Enter");
  const otherProjectButton = page
    .locator(".project-row")
    .filter({ has: page.getByText(accessibilityOtherName, { exact: true }) })
    .locator(".project-main");
  await otherProjectButton.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: accessibilityOtherName, exact: true }),
  ).toBeFocused();

  const projects = await readProjects(page);
  const inaccessibleProject = projects.find((project) => project.name === accessibilityProjectName);
  if (!inaccessibleProject) throw new Error("Accessibility project is missing.");
  const inaccessibleWorkspaceRoute = `**/api/projects/${inaccessibleProject.id}/workspace`;
  await page.route(inaccessibleWorkspaceRoute, async (route) => {
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        code: "PROJECT_MISSING",
        message: "프로젝트 경로를 찾거나 읽을 수 없습니다.",
        requestId: "e2e-project-missing",
      }),
    });
  });
  await tabletSidebarExpand.press("Enter");
  await firstProjectButton.focus();
  await page.keyboard.press("Enter");
  const unavailableHeading = page.getByRole("heading", {
    name: "프로젝트 폴더를 찾을 수 없습니다",
  });
  await expect(unavailableHeading).toBeFocused();
  await expect(page.getByText("e2e-project-missing")).toBeVisible();
  await expect(page.getByRole("button", { name: "다시 시도" })).toBeVisible();
  await expect(page.getByRole("button", { name: "프로젝트 관리" })).toBeVisible();
  await expectNoAccessibilityViolations(page, "missing project recovery");

  await page.getByRole("button", { name: "프로젝트 관리" }).press("Enter");
  await expect(
    page.getByRole("button", { name: `${accessibilityProjectName} 제거` }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(tabletSidebarExpand).toBeFocused();
  await page.unroute(inaccessibleWorkspaceRoute);
  await page.getByRole("button", { name: "다시 시도" }).press("Enter");
  await expect(firstProjectHeading).toBeFocused();

  const splitSummary = page.getByLabel("Dev Terminal 분할 메뉴");
  await splitSummary.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  const splitAction = page
    .locator("details.split-menu[open]")
    .getByRole("button", { name: "오른쪽에 터미널" });
  await expect(splitAction).toBeFocused();
  await page.keyboard.press("Enter");
  const newPaneTab = page.getByRole("tab", { name: /Terminal 2/ });
  await expect(newPaneTab).toBeFocused();
  const newPane = page.getByLabel("Terminal 2 터미널");
  await expect(newPane).toBeVisible();

  const closeNewPane = newPane.getByRole("button", { name: "Terminal 2 닫기" });
  await closeNewPane.focus();
  page.once("dialog", async (dialog) => dialog.dismiss());
  await page.keyboard.press("Enter");
  await expect(closeNewPane).toBeFocused();
  page.once("dialog", async (dialog) => dialog.accept());
  await page.keyboard.press("Enter");
  await expect(newPane).toHaveCount(0);
  await expect(page.locator('[role="tab"][aria-selected="true"]')).toBeFocused();
  expect(browserErrors).toEqual([]);
});

async function openTopbarMenu(page: Page): Promise<void> {
  const trigger = page.getByRole("button", { name: "작업공간 메뉴 열기" });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.getByRole("group", { name: "작업공간 메뉴" })).toBeVisible();
}

async function chooseWorkspaceView(page: Page, label: "집중 보기" | "분할 보기"): Promise<void> {
  await openTopbarMenu(page);
  await page
    .getByRole("group", { name: "작업공간 메뉴" })
    .getByRole("button", { name: label })
    .click();
}

async function runTerminalCommand(page: Page, command: string): Promise<void> {
  const terminal = page.locator(
    '.pane-surface[data-pane-kind="terminal"][aria-label="Dev Terminal 터미널"]',
  );
  await expect(terminal).toHaveAttribute("data-runtime-id", /^[0-9a-f-]{36}$/);
  await expect(terminal).toHaveAttribute("data-restore-phase", /^(ready|deferred)$/);
  await expect(terminal.locator(liveTerminalSelector)).toBeVisible();
  const terminalInput = terminal.locator(".xterm-helper-textarea");
  await terminalInput.focus();
  await expect(terminalInput).toBeFocused();
  await page.keyboard.insertText(command);
  await page.keyboard.press("Enter");
}

async function swipeTerminalScrollback(cdp: CDPSession, screen: Locator): Promise<void> {
  const bounds = await screen.boundingBox();
  if (!bounds) throw new Error("Terminal screen is not visible.");
  const clientX = bounds.x + bounds.width / 2;
  const startY = bounds.y + bounds.height * 0.3;
  const endY = bounds.y + bounds.height * 0.75;

  await dispatchCdpTouch(cdp, "touchStart", clientX, startY);
  try {
    for (let step = 1; step <= 6; step += 1) {
      await dispatchCdpTouch(cdp, "touchMove", clientX, startY + ((endY - startY) * step) / 6);
    }
  } finally {
    await dispatchCdpTouch(cdp, "touchEnd", clientX, endY);
  }
}

async function dragTerminalScrollbarThumbContinuously(
  cdp: CDPSession,
  scrollbar: Locator,
  thumb: Locator,
  deltaY: number,
): Promise<void> {
  const bounds = await thumb.boundingBox();
  if (!bounds) throw new Error("Terminal scrollbar thumb is not visible.");
  const clientX = bounds.x + bounds.width / 2;
  const startY = bounds.y + bounds.height / 2;
  const readTop = async (): Promise<number> =>
    thumb.evaluate((element) => Number.parseFloat((element as HTMLElement).style.top));
  let previousTop = await readTop();

  await dispatchCdpTouch(cdp, "touchStart", clientX, startY);
  await expect(scrollbar).toHaveAttribute("data-naru-touch-scrollbar-dragging", "true");
  try {
    for (let step = 1; step <= 4; step += 1) {
      await dispatchCdpTouch(cdp, "touchMove", clientX, startY + (deltaY * step) / 4);
      if (deltaY < 0) {
        await expect.poll(readTop).toBeLessThan(previousTop);
      } else {
        await expect.poll(readTop).toBeGreaterThan(previousTop);
      }
      previousTop = await readTop();
      await expect(scrollbar).toHaveAttribute("data-naru-touch-scrollbar-dragging", "true");
    }
  } finally {
    await dispatchCdpTouch(cdp, "touchEnd", clientX, startY + deltaY);
  }
  await expect(scrollbar).not.toHaveAttribute("data-naru-touch-scrollbar-dragging");
}

async function dispatchCdpTouch(
  cdp: CDPSession,
  type: "touchStart" | "touchMove" | "touchEnd",
  x: number,
  y: number,
): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", {
    type,
    touchPoints:
      type === "touchEnd"
        ? []
        : [
            {
              x,
              y,
              id: 1,
              radiusX: 5,
              radiusY: 5,
              force: 1,
            },
          ],
  });
}

const runtimePaneDefinitions = [
  { title: "Main Codex", label: "Main Codex Codex" },
  { title: "Quick Codex", label: "Quick Codex Codex" },
  { title: "Dev Terminal", label: "Dev Terminal 터미널" },
] as const;

async function readAllRuntimeIds(page: Page): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const pane of runtimePaneDefinitions) {
    const surface = page.getByLabel(pane.label);
    await expect(surface).toHaveAttribute("data-runtime-id", /^[0-9a-f-]{36}$/);
    const runtimeId = await surface.getAttribute("data-runtime-id");
    if (!runtimeId) throw new Error(`${pane.title} runtime ID is missing.`);
    result[pane.title] = runtimeId;
  }
  return result;
}

async function expectRuntimeIds(page: Page, runtimeIds: Record<string, string>): Promise<void> {
  for (const pane of runtimePaneDefinitions) {
    await expect(page.getByLabel(pane.label, { exact: true })).toHaveAttribute(
      "data-runtime-id",
      runtimeIds[pane.title] ?? "missing",
    );
  }
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await loginWithPassword(page, "naru-test-password");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-connection-state", "active");
}

async function loginWithPassword(page: Page, password: string): Promise<void> {
  const input = page.getByLabel("Naru 비밀번호");
  if (!(await input.isVisible())) {
    await page.getByRole("button", { name: "비밀번호로 로그인" }).click();
  }
  await input.fill(password);
  await page.getByRole("button", { name: "작업공간 열기" }).click();
}

async function addProjectWithKeyboard(page: Page, path: string, name: string): Promise<void> {
  const addProject = page.getByRole("button", { name: "프로젝트 연결" });
  if ((await addProject.count()) > 0 && (await addProject.first().isVisible())) {
    await addProject.first().focus();
    await addProject.first().press("Enter");
  }
  const pathInput = page.getByLabel("서버 절대 경로");
  await expect(pathInput).toBeVisible();
  await pathInput.fill(path);
  await page.getByLabel(/표시 이름/).fill(name);
  const submit = page.getByRole("button", { name: "연결하기" });
  await submit.focus();
  await submit.press("Enter");
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}

async function readProjects(page: Page): Promise<Array<{ id: string; name: string }>> {
  return await page.evaluate(async () => {
    const response = await fetch("/api/projects");
    return (await response.json()) as Array<{ id: string; name: string }>;
  });
}

async function expectNoAccessibilityViolations(page: Page, state: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"])
    .analyze();
  expect(
    results.violations,
    `${state}: ${results.violations
      .map((violation) => `${violation.id} (${violation.nodes.length})`)
      .join(", ")}`,
  ).toEqual([]);
}

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function readTerminalColumns(page: Page, label: string): Promise<number> {
  const marker = `NARU_SIZE_${label}_`;
  await runTerminalCommand(page, `stty size | awk '{print "${marker}"$1"x"$2}'`);
  let columns: number | null = null;
  await expect
    .poll(async () => {
      const contents = await devTerminalRows(page).innerText();
      const matches = [...contents.matchAll(new RegExp(`${marker}(\\d+)x(\\d+)`, "g"))];
      const value = matches.at(-1)?.[2];
      columns = value ? Number(value) : null;
      return columns;
    })
    .not.toBeNull();
  if (columns === null) throw new Error(`Terminal size marker ${marker} is missing.`);
  return columns;
}

function devTerminalRows(page: Page) {
  return page
    .locator('.pane-surface[data-pane-kind="terminal"][aria-label="Dev Terminal 터미널"]')
    .locator(liveTerminalRowsSelector);
}

async function firstVisibleTerminalScrollRow(page: Page): Promise<string | null> {
  const contents = await devTerminalRows(page).innerText();
  return contents.match(/NARU_SCROLL_\d{3}/)?.[0] ?? null;
}

async function readWorkspace(page: Page, projectName: string): Promise<Workspace> {
  return await page.evaluate(async (name) => {
    const projectsResponse = await fetch("/api/projects");
    const projects = (await projectsResponse.json()) as Array<{ id: string; name: string }>;
    const project = projects.find((candidate) => candidate.name === name);
    if (!project) throw new Error(`Project ${name} is missing.`);
    const workspaceResponse = await fetch(`/api/projects/${project.id}/workspace`);
    return (await workspaceResponse.json()) as Workspace;
  }, projectName);
}
