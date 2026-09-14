import { expect, test } from "@playwright/test";

const projectPath = "/private/tmp/naru-e2e-projects/public/editor";

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 360, height: 800 },
  userAgent:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36",
});

test("keeps the live terminal tail visible while the visual viewport pans for a keyboard", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await page.getByRole("button", { name: "비밀번호로 로그인" }).click();
  await page.getByLabel("Naru 비밀번호").fill("naru-test-password");
  await page.getByRole("button", { name: "작업공간 열기" }).click();
  await expect(page.locator(".app-shell")).toBeVisible();
  if (await page.getByLabel("서버 절대 경로").isVisible()) {
    await page.getByLabel("서버 절대 경로").fill(projectPath);
    await page.getByLabel(/표시 이름/).fill("Naru Keyboard Tail");
    await page.getByRole("button", { name: "연결하기" }).click();
  }
  await expect(page.locator(".app-shell")).toHaveAttribute("data-connection-state", "active");
  if (await page.getByRole("button", { name: "제어권 가져오기", exact: true }).isVisible()) {
    await page.getByRole("button", { name: "제어권 가져오기", exact: true }).click();
  } else if (await page.getByRole("button", { name: "이 화면에서 제어 시작" }).isVisible()) {
    await page.getByRole("button", { name: "이 화면에서 제어 시작" }).click();
  }
  await expect(page.locator(".app-shell")).toHaveAttribute("data-surface-role", "controller");
  await page.getByRole("tab", { name: "Dev Terminal", exact: true }).click();
  const surface = page.getByLabel("Dev Terminal 터미널");
  const restart = surface.getByRole("button", { name: "Dev Terminal 재시작" });
  if (await restart.isEnabled()) await restart.click();
  await expect(surface).toHaveAttribute("data-restore-phase", "ready");
  const rows = surface.locator(".xterm:not(.terminal-resize-freeze) .xterm-rows");
  const input = surface.locator(".xterm-helper-textarea");
  await input.focus();
  await expect(input).toBeFocused();
  await page.keyboard.insertText(
    "i=0; while [ $i -lt 160 ]; do printf 'NARU_KB_SCROLL_%03d\\n' \"$i\"; i=$((i+1)); done; printf 'NARU_KB_TAIL\\n'",
  );
  await page.keyboard.press("Enter");
  await expect(rows).toContainText("NARU_KB_TAIL");
  await expect(surface).toHaveAttribute("data-scroll-bottom-offset", "0");
  await page.waitForTimeout(200);
  const instanceId = await surface.getAttribute("data-terminal-instance-id");

  await page.evaluate(() => {
    const result = {
      samples: 0,
      tailHiddenFrames: 0,
      longestHiddenRun: 0,
      liveMissingFrames: 0,
      liveClippedFrames: 0,
      frozenFrames: 0,
      freezeVisibleFrames: 0,
      hiddenExamples: [] as Array<{
        viewportHeight: number;
        viewportTop: number;
        hostHeight: number;
        rowTop: number | null;
        rowBottom: number | null;
        offset: string | undefined;
        frozen: boolean;
      }>,
    };
    let hiddenRun = 0;
    let running = true;
    const sample = (): void => {
      if (!running) return;
      const host = document.querySelector<HTMLElement>(
        '[aria-label="Dev Terminal 터미널"] .terminal-host',
      );
      const live = host?.querySelector<HTMLElement>(".xterm:not(.terminal-resize-freeze)");
      const row = [...(live?.querySelectorAll<HTMLElement>(".xterm-rows > div") ?? [])].find(
        (element) => element.textContent?.includes("NARU_KB_TAIL"),
      );
      const frozen = host?.querySelector<HTMLElement>(".terminal-resize-freeze");
      const frozenRow = [
        ...(frozen?.querySelectorAll<HTMLElement>(".xterm-rows > div") ?? []),
      ].find((element) => element.textContent?.includes("NARU_KB_TAIL"));
      const viewport = window.visualViewport;
      const hostBounds = host?.getBoundingClientRect();
      const rowBounds = row?.getBoundingClientRect();
      const top = viewport?.offsetTop ?? 0;
      const bottom = top + (viewport?.height ?? innerHeight);
      const liveVisible =
        hostBounds !== undefined &&
        rowBounds !== undefined &&
        live != null &&
        getComputedStyle(live).visibility === "visible" &&
        rowBounds.bottom > Math.max(top, hostBounds.top) &&
        rowBounds.top < Math.min(bottom, hostBounds.bottom);
      const frozenBounds = frozenRow?.getBoundingClientRect();
      const frozenVisible =
        hostBounds !== undefined &&
        frozenBounds !== undefined &&
        frozen != null &&
        getComputedStyle(frozen).visibility === "visible" &&
        frozenBounds.bottom > Math.max(top, hostBounds.top) &&
        frozenBounds.top < Math.min(bottom, hostBounds.bottom);
      result.samples += 1;
      if (frozen) result.frozenFrames += 1;
      if (frozenVisible) result.freezeVisibleFrames += 1;
      if (!row) result.liveMissingFrames += 1;
      else if (!liveVisible) result.liveClippedFrames += 1;
      if (!(frozen ? frozenVisible : liveVisible)) {
        result.tailHiddenFrames += 1;
        hiddenRun += 1;
        result.longestHiddenRun = Math.max(result.longestHiddenRun, hiddenRun);
        if (result.hiddenExamples.length < 8) {
          result.hiddenExamples.push({
            viewportHeight: viewport?.height ?? innerHeight,
            viewportTop: top,
            hostHeight: hostBounds?.height ?? 0,
            rowTop: rowBounds?.top ?? null,
            rowBottom: rowBounds?.bottom ?? null,
            offset: host?.closest<HTMLElement>(".pane-surface")?.dataset.scrollBottomOffset,
            frozen: Boolean(frozen),
          });
        }
      } else {
        hiddenRun = 0;
      }
      requestAnimationFrame(sample);
    };
    const state = window as typeof window & {
      __naruKeyboardTailProbe?: { stop: () => typeof result };
    };
    state.__naruKeyboardTailProbe = {
      stop: () => {
        running = false;
        delete state.__naruKeyboardTailProbe;
        return result;
      },
    };
    requestAnimationFrame(sample);
  });

  const states = [];
  for (const [height, top] of [
    [800, 0],
    [700, 0],
    [600, 40],
    [500, 110],
    [430, 150],
    [500, 110],
    [800, 0],
  ]) {
    await page.evaluate(
      ({ height, top }) => {
        const viewport = window.visualViewport;
        if (!viewport) throw new Error("Visual viewport is missing.");
        Object.defineProperty(viewport, "height", { configurable: true, value: height });
        Object.defineProperty(viewport, "offsetTop", { configurable: true, value: top });
        viewport.dispatchEvent(new Event("resize"));
        viewport.dispatchEvent(new Event("scroll"));
      },
      { height, top },
    );
    await page.waitForTimeout(220);
    states.push(
      await page.evaluate(() => {
        const surface = document.querySelector<HTMLElement>('[aria-label="Dev Terminal 터미널"]');
        const host = surface?.querySelector<HTMLElement>(".terminal-host");
        const live = host?.querySelector<HTMLElement>(".xterm:not(.terminal-resize-freeze)");
        const row = [...(live?.querySelectorAll<HTMLElement>(".xterm-rows > div") ?? [])].find(
          (element) => element.textContent?.includes("NARU_KB_TAIL"),
        );
        const viewport = window.visualViewport;
        const rowBounds = row?.getBoundingClientRect();
        const hostBounds = host?.getBoundingClientRect();
        const viewportTop = viewport?.offsetTop ?? 0;
        const viewportBottom = viewportTop + (viewport?.height ?? innerHeight);
        return {
          viewportHeight: viewport?.height ?? innerHeight,
          viewportTop,
          hostHeight: hostBounds?.height ?? 0,
          tailRendered: Boolean(row),
          tailWithinViewport:
            rowBounds !== undefined &&
            hostBounds !== undefined &&
            rowBounds.bottom > Math.max(viewportTop, hostBounds.top) &&
            rowBounds.top < Math.min(viewportBottom, hostBounds.bottom),
          bottomOffset: surface?.dataset.scrollBottomOffset,
          restorePhase: surface?.dataset.restorePhase,
          rendererId: surface?.dataset.terminalInstanceId,
          frozen: host?.dataset.resizeFrozen === "true",
          inputFocused: document.activeElement === live?.querySelector(".xterm-helper-textarea"),
        };
      }),
    );
  }
  const frameProbe = await page.evaluate(() => {
    const state = window as typeof window & {
      __naruKeyboardTailProbe?: {
        stop: () => {
          samples: number;
          tailHiddenFrames: number;
          longestHiddenRun: number;
          frozenFrames: number;
        };
      };
    };
    if (!state.__naruKeyboardTailProbe) throw new Error("Keyboard tail probe is missing.");
    return state.__naruKeyboardTailProbe.stop();
  });
  console.log(`NARU_KEYBOARD_TAIL ${JSON.stringify(states)}`);
  console.log(`NARU_KEYBOARD_TAIL_FRAMES ${JSON.stringify(frameProbe)}`);
  expect(frameProbe.samples).toBeGreaterThan(30);
  // The frame sampled before ResizeObserver runs may still see the previous host size.
  // No clipped tail may persist across paint opportunities, and keyboard height changes
  // must never cover the newly fitted live terminal with a stale freeze overlay.
  expect(frameProbe.longestHiddenRun).toBeLessThanOrEqual(1);
  expect(frameProbe.tailHiddenFrames).toBeLessThanOrEqual(4);
  expect(frameProbe.frozenFrames).toBe(0);
  for (const state of states) {
    expect(state.tailRendered).toBe(true);
    expect(state.tailWithinViewport).toBe(true);
    expect(state.bottomOffset).toBe("0");
    expect(state.restorePhase).toBe("ready");
    expect(state.rendererId).toBe(instanceId);
    expect(state.inputFocused).toBe(true);
  }
});
