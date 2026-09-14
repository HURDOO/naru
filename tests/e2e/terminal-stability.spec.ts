import { expect, test, type Page } from "@playwright/test";

const projectPath = "/private/tmp/naru-e2e-projects/public/editor";

interface StabilityObservation {
  focusLosses: number;
  rendererChanges: number;
  hiddenFrames: number;
  frozenFrames: number;
  connectionChanges: number;
  visibilityChanges: number;
}

test("keeps the terminal visible and focused through sustained idle and input", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openTerminal(page);
  const surface = page.getByLabel("Main Codex Codex");
  const input = surface.locator(".xterm-helper-textarea");
  await input.focus();
  await expect(input).toBeFocused();

  await startObservation(page);
  await page.waitForTimeout(120_000);
  const idle = await finishObservation(page);
  console.log(`NARU_TERMINAL_STABILITY_IDLE ${JSON.stringify(idle)}`);
  expect(idle).toMatchObject({
    focusLosses: 0,
    rendererChanges: 0,
    hiddenFrames: 0,
    frozenFrames: 0,
    connectionChanges: 0,
    visibilityChanges: 0,
  });
  await expect(input).toBeFocused();

  await startObservation(page);
  for (let index = 0; index < 120; index += 1) {
    await page.keyboard.insertText("a");
    await page.waitForTimeout(1_000);
  }
  const typing = await finishObservation(page);
  console.log(`NARU_TERMINAL_STABILITY_INPUT ${JSON.stringify(typing)}`);
  expect(typing).toMatchObject({
    focusLosses: 0,
    rendererChanges: 0,
    hiddenFrames: 0,
    frozenFrames: 0,
    connectionChanges: 0,
    visibilityChanges: 0,
  });
  await expect(input).toBeFocused();
});

test("keeps an unchanged renderer across a same-runtime reconnect", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, argumentsList, newTarget) {
        const socket = Reflect.construct(target, argumentsList, newTarget) as WebSocket;
        if (String(argumentsList[0]).includes("/api/terminal")) {
          const state = globalThis as typeof globalThis & { __naruTerminalSocket?: WebSocket };
          state.__naruTerminalSocket = socket;
        }
        return socket;
      },
    });
  });
  await openTerminal(page);
  const surface = page.getByLabel("Main Codex Codex");
  const input = surface.locator(".xterm-helper-textarea");
  await input.focus();
  const instanceId = await surface.getAttribute("data-terminal-instance-id");
  const runtimeId = await surface.getAttribute("data-runtime-id");
  await page.evaluate(() => {
    const state = globalThis as typeof globalThis & { __naruTerminalSocket?: WebSocket };
    if (!state.__naruTerminalSocket) throw new Error("Terminal socket is missing.");
    state.__naruTerminalSocket.close(1000, "fixture reconnect");
  });
  await expect(page.locator(".app-shell")).toHaveAttribute("data-connection-state", "active");
  await expect(surface).toHaveAttribute("data-restore-phase", "ready");
  await expect(input).toBeFocused();
  const closeButton = surface.getByRole("button", { name: "Main Codex 닫기" });
  await closeButton.focus();
  await page.waitForTimeout(500);
  await expect(closeButton).toBeFocused();
  await expect(surface).toHaveAttribute("data-runtime-id", runtimeId ?? "");
  await expect(surface).toHaveAttribute("data-terminal-instance-id", instanceId ?? "");
});

test("crosses the freeze boundary at most once per keyboard session", async ({ page }) => {
  await openTerminal(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(page.locator(".app-shell")).toHaveAttribute("data-workspace-view", "focus");
  const surface = page.getByLabel("Main Codex Codex");
  await expect(surface).toHaveAttribute("data-restore-phase", "ready");
  const input = surface.locator(".xterm-helper-textarea");
  await input.focus();
  const instanceId = await surface.getAttribute("data-terminal-instance-id");
  const runtimeId = await surface.getAttribute("data-runtime-id");
  const host = surface.locator(".terminal-host");
  await host.evaluate((element) => {
    const state = globalThis as typeof globalThis & {
      __naruFreezeProbe?: { starts: number; stop: () => number };
    };
    let frozen = (element as HTMLElement).dataset.resizeFrozen === "true";
    const probe = { starts: 0, stop: () => 0 };
    const observer = new MutationObserver(() => {
      const next = (element as HTMLElement).dataset.resizeFrozen === "true";
      if (!frozen && next) probe.starts += 1;
      frozen = next;
    });
    observer.observe(element, { attributes: true, attributeFilter: ["data-resize-frozen"] });
    probe.stop = () => {
      observer.disconnect();
      delete state.__naruFreezeProbe;
      return probe.starts;
    };
    state.__naruFreezeProbe = probe;
  });
  for (const height of [650, 550, 450, 800]) {
    await page.setViewportSize({ width: 360, height });
    await page.waitForTimeout(350);
    await expect(input).toBeFocused();
  }
  const freezeStarts = await page.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __naruFreezeProbe?: { stop: () => number };
    };
    if (!state.__naruFreezeProbe) throw new Error("Freeze probe is missing.");
    return state.__naruFreezeProbe.stop();
  });
  console.log(`NARU_TERMINAL_KEYBOARD_FREEZE ${JSON.stringify({ freezeStarts })}`);
  expect(freezeStarts).toBeLessThanOrEqual(1);
  await expect(surface).toHaveAttribute("data-runtime-id", runtimeId ?? "");
  await expect(surface).toHaveAttribute("data-terminal-instance-id", instanceId ?? "");
  await expect(surface.locator(".xterm:not(.terminal-resize-freeze) .xterm-rows")).toHaveText(/\S/);
});

async function openTerminal(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "비밀번호로 로그인" }).click();
  await page.getByLabel("Naru 비밀번호").fill("naru-test-password");
  await page.getByRole("button", { name: "작업공간 열기" }).click();
  await expect(page.locator(".app-shell")).toBeVisible();
  if (await page.getByLabel("서버 절대 경로").isVisible()) {
    await page.getByLabel("서버 절대 경로").fill(projectPath);
    await page.getByLabel(/표시 이름/).fill("Naru Stability");
    await page.getByRole("button", { name: "연결하기" }).click();
  }
  await page.getByRole("tab", { name: "Main Codex", exact: true }).click();
  const surface = page.getByLabel("Main Codex Codex");
  await expect(surface).toHaveAttribute("data-control-role", "controller");
  await expect(surface).toHaveAttribute("data-restore-phase", "ready");
  await expect(surface.locator(".xterm:not(.terminal-resize-freeze) .xterm-rows")).toHaveText(/\S/);
}

async function startObservation(page: Page): Promise<void> {
  await page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>('[aria-label="Main Codex Codex"]');
    const input = surface?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    const host = surface?.querySelector<HTMLElement>(".terminal-host");
    if (!surface || !input || !host) throw new Error("Terminal stability fixture is missing.");
    const counts: StabilityObservation = {
      focusLosses: 0,
      rendererChanges: 0,
      hiddenFrames: 0,
      frozenFrames: 0,
      connectionChanges: 0,
      visibilityChanges: 0,
    };
    let instanceId = surface.dataset.terminalInstanceId;
    let connection = document.querySelector<HTMLElement>(".app-shell")?.dataset.connectionState;
    const focusOut = (event: FocusEvent): void => {
      if (event.target === input) counts.focusLosses += 1;
    };
    document.addEventListener("focusout", focusOut, true);
    const visibilityChange = (): void => {
      counts.visibilityChanges += 1;
    };
    document.addEventListener("visibilitychange", visibilityChange);
    const timer = window.setInterval(() => {
      const currentSurface = document.querySelector<HTMLElement>('[aria-label="Main Codex Codex"]');
      const nextInstanceId = currentSurface?.dataset.terminalInstanceId;
      if (nextInstanceId !== instanceId) {
        counts.rendererChanges += 1;
        instanceId = nextInstanceId;
      }
      const nextConnection =
        document.querySelector<HTMLElement>(".app-shell")?.dataset.connectionState;
      if (nextConnection !== connection) {
        counts.connectionChanges += 1;
        connection = nextConnection;
      }
      const live = currentSurface?.querySelector<HTMLElement>(
        ".terminal-host .xterm:not(.terminal-resize-freeze)",
      );
      if (!live || getComputedStyle(live).visibility !== "visible") counts.hiddenFrames += 1;
      if (currentSurface?.querySelector<HTMLElement>(".terminal-host")?.dataset.resizeFrozen) {
        counts.frozenFrames += 1;
      }
    }, 50);
    const state = globalThis as typeof globalThis & {
      __naruStabilityProbe?: { finish: () => StabilityObservation };
    };
    state.__naruStabilityProbe = {
      finish: () => {
        clearInterval(timer);
        document.removeEventListener("focusout", focusOut, true);
        document.removeEventListener("visibilitychange", visibilityChange);
        delete state.__naruStabilityProbe;
        return counts;
      },
    };
  });
}

async function finishObservation(page: Page): Promise<StabilityObservation> {
  return page.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __naruStabilityProbe?: { finish: () => StabilityObservation };
    };
    if (!state.__naruStabilityProbe) throw new Error("Terminal stability probe is missing.");
    return state.__naruStabilityProbe.finish();
  });
}
