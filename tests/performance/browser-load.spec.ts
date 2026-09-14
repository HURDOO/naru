import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

const projectPath = "/private/tmp/naru-e2e-projects/public/editor";
const INITIAL_DISPLAY_CEILING_MS = 2_000;
const INPUT_LATENCY_P95_CEILING_MS = 150;
const FRAME_INTERVAL_P95_CEILING_MS = 100;
const FRAME_INTERVAL_MAX_CEILING_MS = 500;
const FIRST_CORRECT_VIEWPORT_CEILING_MS = 1_500;
const FULL_HYDRATION_CEILING_MS = 2_000;
const PREVIEW_TO_FULL_VISUAL_GAP_CEILING_MS = 100;
const LIVE_RESIZE_CEILING_MS = 750;

test("keeps authenticated startup and terminal rendering responsive", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
      browserErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const passwordInput = page.getByLabel("Naru 비밀번호");
  if (!(await passwordInput.isVisible())) {
    await page.getByRole("button", { name: "비밀번호로 로그인" }).click();
  }
  await passwordInput.fill("naru-test-password");
  const initialDisplayStarted = await page.evaluate(() => performance.now());
  await page.getByRole("button", { name: "작업공간 열기" }).click();
  await expect(page.getByText("프로젝트를 연결해 주세요")).toBeVisible();
  const initialDisplayMs = (await page.evaluate(() => performance.now())) - initialDisplayStarted;
  expect(initialDisplayMs).toBeLessThanOrEqual(INITIAL_DISPLAY_CEILING_MS);

  await page.getByLabel("서버 절대 경로").fill(projectPath);
  await page.getByLabel(/표시 이름/).fill("Naru Performance");
  await page.getByRole("button", { name: "연결하기" }).click();
  await expect(page.getByRole("heading", { name: "Naru Performance", exact: true })).toBeVisible();
  await expect(page.locator(".pane-surface")).toHaveCount(3);
  await expect
    .poll(() =>
      page.evaluate(() => ({
        regular: document.fonts.check('400 13px "D2Coding"', "Naru 한글 Aa0"),
        bold: document.fonts.check('700 13px "D2Coding"', "Naru 한글 Aa0"),
      })),
    )
    .toEqual({ regular: true, bold: true });

  const projectRestoreStarted = performance.now();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Naru Performance", exact: true })).toBeVisible();
  await expect(page.locator(".pane-surface")).toHaveCount(3);
  await expect(page.getByLabel("Main Codex Codex")).toHaveAttribute(
    "data-runtime-id",
    /^[0-9a-f-]{36}$/,
  );
  const projectRestoreMs = performance.now() - projectRestoreStarted;
  expect(projectRestoreMs).toBeLessThanOrEqual(INITIAL_DISPLAY_CEILING_MS);

  const terminalSurface = page.getByLabel("Dev Terminal 터미널");
  const restart = terminalSurface.getByRole("button", { name: "Dev Terminal 재시작" });
  if (await restart.isEnabled()) await restart.click();
  await expect(terminalSurface).toHaveAttribute("data-runtime-id", /^[0-9a-f-]{36}$/);
  const input = terminalSurface.locator(".xterm-helper-textarea");
  const rows = terminalSurface.locator(".xterm:not(.terminal-resize-freeze) .xterm-rows");
  const restoreMeasurements: Array<{
    rows: number;
    firstCorrectViewportMs: number;
    fullHydrationMs: number;
  }> = [];
  const sidebarResizeMeasurements: Array<LiveResizeMeasurement> = [];
  const splitResizeMeasurements: Array<LiveResizeMeasurement> = [];
  const viewportResizeMeasurements: Array<LiveResizeMeasurement> = [];
  const rotationResizeMeasurements: Array<LiveResizeMeasurement> = [];
  const keyboardResizeMeasurements: Array<LiveResizeMeasurement> = [];
  const emptyRestoreStarted = performance.now();
  await page.reload();
  await expect(terminalSurface).toHaveAttribute("data-runtime-id", /^[0-9a-f-]{36}$/);
  await expect(terminalSurface.locator(".xterm:not(.terminal-resize-freeze)")).toBeVisible({
    timeout: INITIAL_DISPLAY_CEILING_MS,
  });
  const emptyFirstCorrectViewportMs = performance.now() - emptyRestoreStarted;
  await expect(terminalSurface).toHaveAttribute("data-restore-phase", "ready", {
    timeout: FULL_HYDRATION_CEILING_MS,
  });
  const emptyFullHydrationMs = performance.now() - emptyRestoreStarted;
  expect(emptyFirstCorrectViewportMs).toBeLessThanOrEqual(FIRST_CORRECT_VIEWPORT_CEILING_MS);
  expect(emptyFullHydrationMs).toBeLessThanOrEqual(FULL_HYDRATION_CEILING_MS);
  restoreMeasurements.push({
    rows: 0,
    firstCorrectViewportMs: emptyFirstCorrectViewportMs,
    fullHydrationMs: emptyFullHydrationMs,
  });
  const emptyResizeMarker = "NARU_RESIZE_0000_TAIL";
  await runTerminalCommand(page, `PS1='${emptyResizeMarker}> '`);
  await expect(rows).toContainText(emptyResizeMarker);
  sidebarResizeMeasurements.push(
    await measurePinnedSidebarResize(page, terminalSurface, 0, emptyResizeMarker),
  );
  splitResizeMeasurements.push(
    await measureSplitResize(page, terminalSurface, 0, emptyResizeMarker),
  );
  viewportResizeMeasurements.push(
    await measureViewportResize(page, terminalSurface, 0, emptyResizeMarker),
  );
  rotationResizeMeasurements.push(
    await measureRotationResize(page, terminalSurface, 0, emptyResizeMarker),
  );
  keyboardResizeMeasurements.push(
    await measureKeyboardResize(page, terminalSurface, 0, emptyResizeMarker),
  );
  let accumulatedRows = 0;
  for (const rowCount of [100, 1_000, 2_000]) {
    const addedRows = rowCount - accumulatedRows;
    const marker = `NARU_RESTORE_${String(rowCount).padStart(4, "0")}_DONE`;
    await runTerminalCommand(
      page,
      `i=0; while [ $i -lt ${addedRows} ]; do printf 'NARU_RESTORE_${String(rowCount).padStart(4, "0")}_%04d_abcdefghijklmnopqrstuvwxyz0123456789\\n' $i; i=$((i+1)); done; printf '${marker}\\n'`,
    );
    await expect(rows).toContainText(marker, { timeout: 15_000 });
    const restoreStarted = performance.now();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Naru Performance", exact: true }),
    ).toBeVisible();
    await expect(terminalSurface.locator(".xterm:not(.terminal-resize-freeze)")).toBeVisible({
      timeout: INITIAL_DISPLAY_CEILING_MS,
    });
    await expect(rows).toContainText(marker, { timeout: INITIAL_DISPLAY_CEILING_MS });
    const firstCorrectViewportMs = performance.now() - restoreStarted;
    await expect(terminalSurface).toHaveAttribute("data-restore-phase", "ready", {
      timeout: FULL_HYDRATION_CEILING_MS,
    });
    await expect(terminalSurface.locator(".xterm:not(.terminal-resize-freeze)")).toBeVisible();
    await page.waitForTimeout(200);
    await expect(terminalSurface.locator(".terminal-host")).not.toHaveAttribute(
      "data-resize-frozen",
      "true",
    );
    const fullHydrationMs = performance.now() - restoreStarted;
    expect(firstCorrectViewportMs).toBeLessThanOrEqual(FIRST_CORRECT_VIEWPORT_CEILING_MS);
    expect(fullHydrationMs).toBeLessThanOrEqual(FULL_HYDRATION_CEILING_MS);
    restoreMeasurements.push({ rows: rowCount, firstCorrectViewportMs, fullHydrationMs });
    const resizeMarker = `NARU_RESIZE_${String(rowCount).padStart(4, "0")}_TAIL`;
    await runTerminalCommand(page, `PS1='${resizeMarker}> '`);
    await expect(rows).toContainText(resizeMarker);
    sidebarResizeMeasurements.push(
      await measurePinnedSidebarResize(page, terminalSurface, rowCount, resizeMarker),
    );
    splitResizeMeasurements.push(
      await measureSplitResize(page, terminalSurface, rowCount, resizeMarker),
    );
    viewportResizeMeasurements.push(
      await measureViewportResize(page, terminalSurface, rowCount, resizeMarker),
    );
    rotationResizeMeasurements.push(
      await measureRotationResize(page, terminalSurface, rowCount, resizeMarker),
    );
    keyboardResizeMeasurements.push(
      await measureKeyboardResize(page, terminalSurface, rowCount, resizeMarker),
    );
    accumulatedRows = rowCount;
  }

  const latencySamples: number[] = [];
  for (let sample = 0; sample < 20; sample += 1) {
    const marker = `NARU_LATENCY_${String(sample).padStart(2, "0")}`;
    await input.focus();
    await page.keyboard.insertText(`printf '${marker}\\n'`);
    const started = await page.evaluate(() => performance.now());
    await page.keyboard.press("Enter");
    await expect(rows).toContainText(marker);
    latencySamples.push((await page.evaluate(() => performance.now())) - started);
  }

  await startFrameProbe(page, 2_000);
  await input.focus();
  await page.keyboard.insertText(
    "i=0; while [ $i -lt 4000 ]; do printf 'NARU_UI_%05d_abcdefghijklmnopqrstuvwxyz0123456789\\n' $i; i=$((i+1)); done; printf 'NARU_UI_DONE\\n'",
  );
  await page.keyboard.press("Enter");
  await expect(rows).toContainText("NARU_UI_DONE", { timeout: 15_000 });
  const frameIntervals = await finishFrameProbe(page);
  const uiTailMarker = "NARU_UI_TAIL";
  await runTerminalCommand(page, `PS1='${uiTailMarker}> '`);
  await expect(rows).toContainText(uiTailMarker);

  const projectSwitch = await measureProjectSwitch(page, uiTailMarker);
  keyboardResizeMeasurements.push(
    await measureKeyboardResize(page, terminalSurface, 2_000, uiTailMarker),
  );
  await runTerminalCommand(page, ":");
  await expect(terminalSurface).toHaveAttribute("data-scroll-bottom-offset", "0");
  await expect(rows).toContainText(uiTailMarker);
  const repeatedResizeMeasurements: LiveResizeMeasurement[] = [];
  for (let index = 0; index < 20; index += 1) {
    const focusedInput = terminalSurface.locator(".xterm-helper-textarea");
    await focusedInput.focus();
    repeatedResizeMeasurements.push(
      await measureLiveResizeAction(
        page,
        terminalSurface,
        "viewport",
        2_000,
        uiTailMarker,
        () => page.setViewportSize({ width: index % 2 === 0 ? 1_280 : 1_440, height: 900 }),
        focusedInput,
      ),
    );
  }
  const repeatedResizeDurations = repeatedResizeMeasurements.map(
    (measurement) => measurement.completionMs ?? Number.POSITIVE_INFINITY,
  );
  const repeatedResizeP95 = percentile(repeatedResizeDurations, 0.95);
  const repeatedResizeMax = Math.max(...repeatedResizeDurations);
  expect(repeatedResizeP95).toBeLessThanOrEqual(300);
  expect(repeatedResizeMax).toBeLessThanOrEqual(500);

  await page.addInitScript(() => {
    const store = globalThis as typeof globalThis & {
      __naruReloadProbe?: { visibleIntermediateFrames: number };
    };
    const probe = { visibleIntermediateFrames: 0 };
    store.__naruReloadProbe = probe;
    const sample = (): void => {
      const host = document.querySelector<HTMLElement>(
        '[aria-label="Dev Terminal 터미널"] .terminal-host',
      );
      const xterm = host?.querySelector<HTMLElement>(".xterm:not(.terminal-resize-freeze)");
      if (host && xterm) {
        const style = getComputedStyle(xterm);
        if (style.visibility === "visible" && host.dataset.terminalRestoreReady !== "true") {
          probe.visibleIntermediateFrames += 1;
        }
      }
      if (host?.dataset.terminalRestoreReady !== "true") requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const repeatedRestoreMeasurements: Array<{
    firstCorrectViewportMs: number;
    fullHydrationMs: number;
    visibleIntermediateFrames: number;
  }> = [];
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    await page.reload();
    await expect(rows).toContainText(uiTailMarker);
    const firstCorrectViewportMs = performance.now() - started;
    await expect(terminalSurface).toHaveAttribute("data-restore-phase", "ready");
    const fullHydrationMs = performance.now() - started;
    const visibleIntermediateFrames = await page.evaluate(() => {
      const store = globalThis as typeof globalThis & {
        __naruReloadProbe?: { visibleIntermediateFrames: number };
      };
      return store.__naruReloadProbe?.visibleIntermediateFrames ?? 0;
    });
    repeatedRestoreMeasurements.push({
      firstCorrectViewportMs,
      fullHydrationMs,
      visibleIntermediateFrames,
    });
  }
  const repeatedFirstCorrectP95 = percentile(
    repeatedRestoreMeasurements.map((measurement) => measurement.firstCorrectViewportMs),
    0.95,
  );
  const repeatedFullHydrationP95 = percentile(
    repeatedRestoreMeasurements.map((measurement) => measurement.fullHydrationMs),
    0.95,
  );
  expect(repeatedFirstCorrectP95).toBeLessThanOrEqual(1_000);
  expect(repeatedFullHydrationP95).toBeLessThanOrEqual(1_500);
  expect(
    repeatedRestoreMeasurements.reduce(
      (sum, measurement) => sum + measurement.visibleIntermediateFrames,
      0,
    ),
  ).toBe(0);
  const takeover = await measureTakeover(browser, page, uiTailMarker);

  const inputLatencyP95 = percentile(latencySamples, 0.95);
  const frameIntervalP95 = percentile(frameIntervals, 0.95);
  const frameIntervalMax = Math.max(...frameIntervals);
  expect(inputLatencyP95).toBeLessThanOrEqual(INPUT_LATENCY_P95_CEILING_MS);
  expect(frameIntervalP95).toBeLessThanOrEqual(FRAME_INTERVAL_P95_CEILING_MS);
  expect(frameIntervalMax).toBeLessThanOrEqual(FRAME_INTERVAL_MAX_CEILING_MS);
  await expect(page.locator("html")).not.toHaveAttribute("data-horizontal-overflow", "true");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    ),
  ).toBe(false);
  expect(browserErrors).toEqual([]);

  const report = {
    initialDisplayMs: round(initialDisplayMs),
    projectRestoreMs: round(projectRestoreMs),
    inputLatencySamples: latencySamples.length,
    inputLatencyP95Ms: round(inputLatencyP95),
    frameSamples: frameIntervals.length,
    frameIntervalP95Ms: round(frameIntervalP95),
    frameIntervalMaxMs: round(frameIntervalMax),
    restoreMeasurements: restoreMeasurements.map((measurement) => ({
      rows: measurement.rows,
      firstCorrectViewportMs: round(measurement.firstCorrectViewportMs),
      fullHydrationMs: round(measurement.fullHydrationMs),
    })),
    projectSwitch: {
      firstCorrectViewportMs: round(projectSwitch.firstCorrectViewportMs),
      fullHydrationMs: round(projectSwitch.fullHydrationMs),
      visibleIntermediateFrames: projectSwitch.visibleIntermediateFrames,
    },
    sidebarResizeMeasurements: sidebarResizeMeasurements.map(roundLiveResizeMeasurement),
    splitResizeMeasurements: splitResizeMeasurements.map(roundLiveResizeMeasurement),
    viewportResizeMeasurements: viewportResizeMeasurements.map(roundLiveResizeMeasurement),
    rotationResizeMeasurements: rotationResizeMeasurements.map(roundLiveResizeMeasurement),
    keyboardResizeMeasurements: keyboardResizeMeasurements.map(roundLiveResizeMeasurement),
    repeatedResize: {
      samples: repeatedResizeMeasurements.length,
      p95Ms: round(repeatedResizeP95),
      maxMs: round(repeatedResizeMax),
      markerMissingFrames: repeatedResizeMeasurements.reduce(
        (sum, measurement) => sum + measurement.markerMissingFrames,
        0,
      ),
    },
    repeatedRestore: {
      samples: repeatedRestoreMeasurements.length,
      firstCorrectViewportP95Ms: round(repeatedFirstCorrectP95),
      fullHydrationP95Ms: round(repeatedFullHydrationP95),
      visibleIntermediateFrames: repeatedRestoreMeasurements.reduce(
        (sum, measurement) => sum + measurement.visibleIntermediateFrames,
        0,
      ),
    },
    takeover: {
      firstCorrectViewportMs: round(takeover.firstCorrectViewportMs),
      fullHydrationMs: round(takeover.fullHydrationMs),
      visibleFramesBeforeFonts: takeover.visibleFramesBeforeFonts,
      visibleIntermediateFrames: takeover.visibleIntermediateFrames,
    },
    viewport: "1440x900",
    browser: await page.evaluate(() => navigator.userAgent),
    passed: true,
  };
  console.log(`NARU_BROWSER_PERFORMANCE ${JSON.stringify(report)}`);
});

interface LiveResizeMeasurement {
  scenario: LiveResizeScenario;
  rows: number;
  completionMs: number | null;
  timingSegmentsMs: {
    actionToInputCompleted: number | null;
    inputCompletedToLastResizeApply: number | null;
    inputCompletedToFreezeSettle: number | null;
  };
  observerEvents: number;
  resizeApplications: number;
  columnReflows: number;
  markerMissingFrames: number;
  freezeFrames: number;
  freezeStyleMismatchFrames: number;
  frameSamples: number;
  firstFrameIntervalMs: number | null;
  frameIntervalP95Ms: number | null;
  frameIntervalMaxMs: number | null;
  slowFramesMs: Array<{ endedAt: number; duration: number }>;
  longTasksMs: Array<{ startedAt: number; duration: number }>;
  longAnimationFramesMs: Array<{
    startedAt: number;
    duration: number;
    blockingDuration: number;
    renderStart: number;
    styleAndLayoutStart: number;
    scriptDuration: number;
  }>;
  terminalResizeApplications: Array<{
    pane: string;
    at: number;
    duration: number | null;
  }>;
  pageTimestampsMs: {
    observerInstalled: number;
    probeStarted: number | null;
    actionStarted: number | null;
    inputCompletedAt: number | null;
    resizeApplied: number[];
    freezeStarted: number[];
    freezeSettled: number[];
  };
}

type LiveResizeScenario = "pinned-sidebar" | "split-drag" | "viewport" | "rotation" | "keyboard";

type TerminalVisualProbeActionTrigger = "pointer" | "immediate";

interface TerminalVisualProbeResult {
  markerMissingFrames: number;
  freezeFrames: number;
  freezeStyleMismatchFrames: number;
  intervals: number[];
  frameIntervalsAtMs: Array<{ endedAt: number; duration: number }>;
  longTasksMs: Array<{ startedAt: number; duration: number }>;
  longAnimationFramesMs: Array<{
    startedAt: number;
    duration: number;
    blockingDuration: number;
    renderStart: number;
    styleAndLayoutStart: number;
    scriptDuration: number;
  }>;
  terminalResizeApplications: Array<{
    pane: string;
    at: number;
    duration: number | null;
  }>;
  observerInstalledAtMs: number;
  probeStartedAtMs: number | null;
  actionStartedAtMs: number | null;
  inputCompletedAtMs: number | null;
  resizeAppliedAtMs: number[];
  freezeStartedAtMs: number[];
  freezeSettledAtMs: number[];
}

async function measurePinnedSidebarResize(
  page: Page,
  terminal: Locator,
  rows: number,
  marker: string | undefined,
): Promise<LiveResizeMeasurement> {
  await page.setViewportSize({ width: 1_440, height: 900 });
  const host = terminal.locator(".terminal-host");
  const pinSidebar = page.getByRole("button", { name: "프로젝트 메뉴 펼치기 고정" });
  await expect(pinSidebar).toBeVisible();
  if (rows === 0) {
    const idleFrameIntervals = await measureIdleFrameIntervals(page, 600);
    console.log(
      `NARU_BROWSER_IDLE_FRAMES ${JSON.stringify({
        samples: idleFrameIntervals.length,
        firstMs: round(idleFrameIntervals.at(0) ?? Number.POSITIVE_INFINITY),
        p95Ms: round(percentile(idleFrameIntervals, 0.95)),
        maxMs: round(Math.max(...idleFrameIntervals)),
      })}`,
    );
  }
  const before = await terminalResizeCounters(host);
  const runtimeId = await terminal.getAttribute("data-runtime-id");
  const instanceId = await terminal.getAttribute("data-terminal-instance-id");
  const bottomOffset = await terminal.getAttribute("data-scroll-bottom-offset");
  await startTerminalVisualProbe(page, marker, 600, before.resizeApplications, "pointer");
  await startRestoreVisibilityProbe(page, "Naru Performance");
  await markTerminalVisualProbeAction(page);
  await pinSidebar.click();
  const samples = await finishTerminalVisualProbe(page);
  const after = await terminalResizeCounters(host);
  const measurement = liveResizeMeasurement("pinned-sidebar", rows, before, after, samples);
  assertLiveResizeMeasurement(measurement);

  expect(await terminal.getAttribute("data-runtime-id")).toBe(runtimeId);
  expect(await terminal.getAttribute("data-terminal-instance-id")).toBe(instanceId);
  expect(await terminal.getAttribute("data-scroll-bottom-offset")).toBe(bottomOffset);
  if (marker) {
    await expect(terminal.locator(".xterm:not(.terminal-resize-freeze) .xterm-rows")).toContainText(
      marker,
    );
  }

  const collapseSidebar = page.getByRole("button", { name: "프로젝트 메뉴 접기" });
  await expect(collapseSidebar).toBeVisible();
  const beforeCollapse = await terminalResizeCounters(host);
  await collapseSidebar.click();
  await waitForResizeAfter(host, beforeCollapse.resizeApplications);

  return measurement;
}

async function measureSplitResize(
  page: Page,
  terminal: Locator,
  rows: number,
  marker: string | undefined,
): Promise<LiveResizeMeasurement> {
  await page.setViewportSize({ width: 1_440, height: 900 });
  const separator = page.getByRole("separator", { name: "상하 Pane 크기 조절" }).first();
  const initialBox = await separator.boundingBox();
  expect(initialBox).not.toBeNull();
  const measurement = await measureLiveResizeAction(
    page,
    terminal,
    "split-drag",
    rows,
    marker,
    async () => {
      const x = (initialBox?.x ?? 0) + (initialBox?.width ?? 0) / 2;
      const y = (initialBox?.y ?? 0) + (initialBox?.height ?? 0) / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y - 64, { steps: 8 });
      await page.mouse.up();
    },
  );

  const movedBox = await separator.boundingBox();
  expect(movedBox).not.toBeNull();
  const host = terminal.locator(".terminal-host");
  const beforeReset = await terminalResizeCounters(host);
  const x = (movedBox?.x ?? 0) + (movedBox?.width ?? 0) / 2;
  const y = (movedBox?.y ?? 0) + (movedBox?.height ?? 0) / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 64, { steps: 8 });
  await page.mouse.up();
  await waitForResizeAfter(host, beforeReset.resizeApplications);
  return measurement;
}

async function measureViewportResize(
  page: Page,
  terminal: Locator,
  rows: number,
  marker: string | undefined,
): Promise<LiveResizeMeasurement> {
  await page.setViewportSize({ width: 1_440, height: 900 });
  const input = terminal.locator(".xterm-helper-textarea");
  await input.focus();
  const measurement = await measureLiveResizeAction(
    page,
    terminal,
    "viewport",
    rows,
    marker,
    () => page.setViewportSize({ width: 1_180, height: 780 }),
    input,
  );
  const host = terminal.locator(".terminal-host");
  const beforeReset = await terminalResizeCounters(host);
  await page.setViewportSize({ width: 1_440, height: 900 });
  await waitForResizeAfter(host, beforeReset.resizeApplications);
  return measurement;
}

async function measureRotationResize(
  page: Page,
  terminal: Locator,
  rows: number,
  marker: string | undefined,
): Promise<LiveResizeMeasurement> {
  const host = terminal.locator(".terminal-host");
  const beforeLandscape = await terminalResizeCounters(host);
  await page.setViewportSize({ width: 1_024, height: 768 });
  await waitForResizeAfter(host, beforeLandscape.resizeApplications);
  const input = terminal.locator(".xterm-helper-textarea");
  await input.focus();
  const measurement = await measureLiveResizeAction(
    page,
    terminal,
    "rotation",
    rows,
    marker,
    () => page.setViewportSize({ width: 768, height: 1_024 }),
    input,
  );
  const beforeReset = await terminalResizeCounters(host);
  await page.setViewportSize({ width: 1_440, height: 900 });
  await waitForResizeAfter(host, beforeReset.resizeApplications);
  return measurement;
}

async function measureLiveResizeAction(
  page: Page,
  terminal: Locator,
  scenario: LiveResizeScenario,
  rows: number,
  marker: string | undefined,
  action: () => Promise<unknown>,
  expectedFocus?: Locator,
): Promise<LiveResizeMeasurement> {
  const host = terminal.locator(".terminal-host");
  const before = await terminalResizeCounters(host);
  const runtimeId = await terminal.getAttribute("data-runtime-id");
  const instanceId = await terminal.getAttribute("data-terminal-instance-id");
  const bottomOffset = await terminal.getAttribute("data-scroll-bottom-offset");
  await startTerminalVisualProbe(
    page,
    marker,
    600,
    before.resizeApplications,
    scenario === "split-drag" ? "pointer" : "immediate",
  );
  await markTerminalVisualProbeAction(page);
  await action();
  const samples = await finishTerminalVisualProbe(page);
  const after = await terminalResizeCounters(host);
  const measurement = liveResizeMeasurement(scenario, rows, before, after, samples);
  assertLiveResizeMeasurement(measurement);

  expect(after.resizeApplications - before.resizeApplications).toBeLessThanOrEqual(2);
  expect(await terminal.getAttribute("data-runtime-id")).toBe(runtimeId);
  expect(await terminal.getAttribute("data-terminal-instance-id")).toBe(instanceId);
  expect(await terminal.getAttribute("data-scroll-bottom-offset")).toBe(bottomOffset);
  if (expectedFocus) await expect(expectedFocus).toBeFocused();
  if (marker) {
    await expect(terminal.locator(".xterm:not(.terminal-resize-freeze) .xterm-rows")).toContainText(
      marker,
    );
  }
  return measurement;
}

async function measureKeyboardResize(
  page: Page,
  terminal: Locator,
  rows: number,
  marker: string | undefined,
): Promise<LiveResizeMeasurement> {
  const host = terminal.locator(".terminal-host");
  const beforeBaseline = await terminalResizeCounters(host);
  await page.setViewportSize({ width: 690, height: 830 });
  await waitForResizeAfter(host, beforeBaseline.resizeApplications);
  const input = terminal.locator(".xterm-helper-textarea");
  await input.focus();
  const baseline = await terminalResizeCounters(host);
  const runtimeId = await terminal.getAttribute("data-runtime-id");
  const instanceId = await terminal.getAttribute("data-terminal-instance-id");
  const baselineColumns = await host.getAttribute("data-terminal-cols");
  const baselineBottomOffset = await terminal.getAttribute("data-scroll-bottom-offset");
  await startTerminalVisualProbe(page, marker, 800, baseline.resizeApplications, "immediate");
  await markTerminalVisualProbeAction(page);
  for (const viewport of [
    { width: 688, height: 740 },
    { width: 693, height: 640 },
    { width: 687, height: 540 },
    { width: 690, height: 420 },
  ]) {
    await page.setViewportSize(viewport);
  }
  const samples = await finishTerminalVisualProbe(page);
  const after = await terminalResizeCounters(host);
  const measurement = liveResizeMeasurement("keyboard", rows, baseline, after, samples);
  assertLiveResizeMeasurement(measurement);

  expect(after.resizeApplications - baseline.resizeApplications).toBeLessThanOrEqual(2);
  expect(await host.getAttribute("data-terminal-cols")).toBe(baselineColumns);
  expect(await host.getAttribute("data-resize-keyboard-session")).toBe("true");
  expect(await terminal.getAttribute("data-runtime-id")).toBe(runtimeId);
  expect(await terminal.getAttribute("data-terminal-instance-id")).toBe(instanceId);
  expect(await terminal.getAttribute("data-scroll-bottom-offset")).toBe(baselineBottomOffset);
  await expect(input).toBeFocused();
  if (marker) {
    await expect(terminal.locator(".xterm:not(.terminal-resize-freeze) .xterm-rows")).toContainText(
      marker,
    );
  }

  const beforeClose = await terminalResizeCounters(host);
  await page.setViewportSize({ width: 690, height: 830 });
  await waitForResizeAfter(host, beforeClose.resizeApplications);
  await expect(host).toHaveAttribute("data-resize-keyboard-session", "false");
  await expect(terminal).toHaveAttribute("data-scroll-bottom-offset", baselineBottomOffset ?? "0");
  await expect(input).toBeFocused();

  const beforeDesktop = await terminalResizeCounters(host);
  await page.setViewportSize({ width: 1_440, height: 900 });
  await waitForResizeAfter(host, beforeDesktop.resizeApplications);

  return measurement;
}

async function waitForResizeAfter(host: Locator, previousApplications: number): Promise<void> {
  await expect
    .poll(async () => Number((await host.getAttribute("data-resize-apply-count")) ?? "0"))
    .toBeGreaterThan(previousApplications);
  await expect.poll(async () => await host.getAttribute("data-resize-frozen")).not.toBe("true");
}

async function terminalResizeCounters(host: Locator): Promise<{
  observerEvents: number;
  resizeApplications: number;
  columnReflows: number;
}> {
  return {
    observerEvents: Number((await host.getAttribute("data-resize-observer-count")) ?? "0"),
    resizeApplications: Number((await host.getAttribute("data-resize-apply-count")) ?? "0"),
    columnReflows: Number((await host.getAttribute("data-column-reflow-count")) ?? "0"),
  };
}

async function measureIdleFrameIntervals(page: Page, durationMs: number): Promise<number[]> {
  return await page.evaluate(
    (duration) =>
      new Promise<number[]>((resolve) => {
        const intervals: number[] = [];
        const startedAt = performance.now();
        let previousAt = startedAt;
        const sample = (): void => {
          const now = performance.now();
          intervals.push(now - previousAt);
          previousAt = now;
          if (now - startedAt >= duration) resolve(intervals);
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
    durationMs,
  );
}

async function startTerminalVisualProbe(
  page: Page,
  marker: string | undefined,
  durationMs: number,
  previousApplications: number,
  actionTrigger: TerminalVisualProbeActionTrigger,
): Promise<void> {
  await page.evaluate(
    ({ expectedMarker, duration, applicationBaseline, trigger }) => {
      type PageTerminalVisualProbe = {
        samples: Array<{
          at: number;
          markerVisible: boolean;
          freezeVisible: boolean;
          freezeStyleMatches: boolean;
        }>;
        intervals: number[];
        frameIntervalsAtMs: Array<{ endedAt: number; duration: number }>;
        longTasksMs: Array<{ startedAt: number; duration: number }>;
        longAnimationFramesMs: Array<{
          startedAt: number;
          duration: number;
          blockingDuration: number;
          renderStart: number;
          styleAndLayoutStart: number;
          scriptDuration: number;
        }>;
        terminalResizeApplications: Array<{
          pane: string;
          at: number;
          duration: number | null;
        }>;
        observerInstalledAtMs: number;
        probeStartedAtMs: number | null;
        actionStartedAtMs: number | null;
        inputCompletedAtMs: number | null;
        resizeAppliedAtMs: number[];
        freezeStartedAtMs: number[];
        freezeSettledAtMs: number[];
        lastApplicationCount: number;
        previousFrameAtMs: number | null;
        freezeActive: boolean;
        armed: boolean;
        rafDone: boolean;
        done: boolean;
        observer: MutationObserver;
        longTaskObserver: PerformanceObserver | null;
        longAnimationFrameObserver: PerformanceObserver | null;
        maybeFinish: () => void;
        actionTrigger: TerminalVisualProbeActionTrigger;
        beginAction: () => void;
        removeActionListener: () => void;
      };
      const store = globalThis as typeof globalThis & {
        __naruTerminalVisualProbe?: PageTerminalVisualProbe;
      };
      const surface = document.querySelector<HTMLElement>('[aria-label="Dev Terminal 터미널"]');
      const host = surface?.querySelector<HTMLElement>(".terminal-host");
      if (!surface || !host)
        throw new Error("Dev Terminal host is unavailable for the visual probe");

      const probe: PageTerminalVisualProbe = {
        samples: [] as Array<{
          at: number;
          markerVisible: boolean;
          freezeVisible: boolean;
          freezeStyleMatches: boolean;
        }>,
        intervals: [] as number[],
        frameIntervalsAtMs: [] as Array<{ endedAt: number; duration: number }>,
        longTasksMs: [] as Array<{ startedAt: number; duration: number }>,
        longAnimationFramesMs: [] as Array<{
          startedAt: number;
          duration: number;
          blockingDuration: number;
          renderStart: number;
          styleAndLayoutStart: number;
          scriptDuration: number;
        }>,
        terminalResizeApplications: [] as Array<{
          pane: string;
          at: number;
          duration: number | null;
        }>,
        observerInstalledAtMs: performance.now(),
        probeStartedAtMs: null,
        actionStartedAtMs: null,
        inputCompletedAtMs: null,
        resizeAppliedAtMs: [] as number[],
        freezeStartedAtMs: [] as number[],
        freezeSettledAtMs: [] as number[],
        lastApplicationCount: applicationBaseline,
        previousFrameAtMs: null,
        freezeActive: Boolean(host.querySelector(".terminal-resize-freeze")),
        armed: false,
        rafDone: false,
        done: false,
        observer: undefined as unknown as MutationObserver,
        longTaskObserver: null,
        longAnimationFrameObserver: null,
        maybeFinish: (): void => {},
        actionTrigger: trigger,
        beginAction: (): void => {},
        removeActionListener: (): void => {},
      };
      probe.maybeFinish = (): void => {
        if (
          probe.actionStartedAtMs !== null &&
          probe.rafDone &&
          probe.resizeAppliedAtMs.length > 0 &&
          probe.freezeSettledAtMs.length >= probe.freezeStartedAtMs.length &&
          !probe.freezeActive
        ) {
          probe.done = true;
        }
      };
      store.__naruTerminalVisualProbe = probe;

      let markerVisible = true;
      let freezeVisible = false;
      let freezeStyleMatches = true;
      const styleSignature = (element: HTMLElement): string => {
        const style = getComputedStyle(element);
        return [
          style.color,
          style.fontFamily,
          style.fontKerning,
          style.fontSize,
          style.fontWeight,
          style.lineHeight,
          style.whiteSpace,
        ].join("|");
      };
      const refreshVisualState = (): void => {
        const frozenRows = surface.querySelector<HTMLElement>(".terminal-resize-freeze-rows");
        const liveRows = surface.querySelector<HTMLElement>(
          ".xterm:not(.terminal-resize-freeze) .xterm-rows",
        );
        const visibleRows = frozenRows ?? liveRows;
        markerVisible =
          expectedMarker === undefined ||
          Boolean(visibleRows?.textContent?.includes(expectedMarker));
        freezeVisible = Boolean(frozenRows);
        freezeStyleMatches =
          !frozenRows || !liveRows || styleSignature(frozenRows) === styleSignature(liveRows);
      };
      refreshVisualState();

      try {
        probe.longTaskObserver = new PerformanceObserver((entries) => {
          if (probe.actionStartedAtMs === null) return;
          for (const entry of entries.getEntries()) {
            if (entry.startTime + entry.duration >= probe.actionStartedAtMs) {
              probe.longTasksMs.push({ startedAt: entry.startTime, duration: entry.duration });
            }
          }
        });
        probe.longTaskObserver.observe({ type: "longtask", buffered: false });
      } catch {
        probe.longTaskObserver = null;
      }
      try {
        probe.longAnimationFrameObserver = new PerformanceObserver((entries) => {
          if (probe.actionStartedAtMs === null) return;
          for (const entry of entries.getEntries()) {
            if (entry.startTime + entry.duration < probe.actionStartedAtMs) continue;
            const timing = entry as PerformanceEntry & {
              blockingDuration?: number;
              renderStart?: number;
              styleAndLayoutStart?: number;
              scripts?: Array<{ duration?: number }>;
            };
            probe.longAnimationFramesMs.push({
              startedAt: entry.startTime,
              duration: entry.duration,
              blockingDuration: timing.blockingDuration ?? 0,
              renderStart: timing.renderStart ?? 0,
              styleAndLayoutStart: timing.styleAndLayoutStart ?? 0,
              scriptDuration:
                timing.scripts?.reduce((total, script) => total + (script.duration ?? 0), 0) ?? 0,
            });
          }
        });
        probe.longAnimationFrameObserver.observe({
          type: "long-animation-frame",
          buffered: false,
        });
      } catch {
        probe.longAnimationFrameObserver = null;
      }

      const containsFreeze = (nodes: NodeList): boolean =>
        Array.from(nodes).some(
          (node) =>
            node instanceof Element &&
            (node.matches(".terminal-resize-freeze") ||
              node.querySelector(".terminal-resize-freeze") !== null),
        );
      const recordFreezeStart = (at: number): void => {
        if (probe.actionStartedAtMs === null || probe.freezeActive) return;
        probe.freezeActive = true;
        probe.freezeStartedAtMs.push(at);
      };
      const recordFreezeSettle = (at: number): void => {
        if (probe.actionStartedAtMs === null || !probe.freezeActive) return;
        probe.freezeActive = false;
        probe.freezeSettledAtMs.push(at);
      };
      probe.observer = new MutationObserver((mutations) => {
        const at = performance.now();
        let visualStateChanged = false;
        for (const mutation of mutations) {
          if (host.contains(mutation.target)) visualStateChanged = true;
          if (mutation.type === "attributes") {
            if (mutation.attributeName === "data-resize-apply-count") {
              const target = mutation.target;
              if (target instanceof HTMLElement && probe.actionStartedAtMs !== null) {
                const pane =
                  target.closest<HTMLElement>("[data-runtime-id]")?.getAttribute("aria-label") ??
                  "unknown-pane";
                const duration = Number(target.dataset.resizeLastDurationMs);
                probe.terminalResizeApplications.push({
                  pane,
                  at,
                  duration: Number.isFinite(duration) ? duration : null,
                });
              }
              if (mutation.target === host) {
                const applicationCount = Number(host.dataset.resizeApplyCount ?? "0");
                if (probe.actionStartedAtMs !== null) {
                  while (probe.lastApplicationCount < applicationCount) {
                    probe.resizeAppliedAtMs.push(at);
                    probe.lastApplicationCount += 1;
                  }
                } else {
                  probe.lastApplicationCount = applicationCount;
                }
              }
            }
            if (mutation.target === host && mutation.attributeName === "data-resize-frozen") {
              if (mutation.oldValue === "true") recordFreezeSettle(at);
              else recordFreezeStart(at);
            }
          }
          if (mutation.type === "childList" && host.contains(mutation.target)) {
            if (containsFreeze(mutation.addedNodes)) recordFreezeStart(at);
            if (containsFreeze(mutation.removedNodes)) recordFreezeSettle(at);
          }
        }
        if (visualStateChanged) refreshVisualState();
        probe.maybeFinish();
      });
      probe.observer.observe(host, {
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ["data-resize-apply-count", "data-resize-frozen"],
        childList: true,
        characterData: true,
        subtree: true,
      });

      const sample = (): void => {
        const probeStartedAtMs = probe.probeStartedAtMs;
        const previousFrameAtMs = probe.previousFrameAtMs;
        if (probeStartedAtMs === null || previousFrameAtMs === null) return;
        const now = performance.now();
        const interval = now - previousFrameAtMs;
        probe.intervals.push(interval);
        probe.frameIntervalsAtMs.push({ endedAt: now, duration: interval });
        probe.previousFrameAtMs = now;
        probe.samples.push({
          at: now - probeStartedAtMs,
          markerVisible,
          freezeVisible,
          freezeStyleMatches,
        });
        if (now - probeStartedAtMs >= duration) {
          probe.rafDone = true;
          probe.maybeFinish();
          return;
        }
        requestAnimationFrame(sample);
      };
      probe.beginAction = (): void => {
        if (!probe.armed || probe.actionStartedAtMs !== null) return;
        const startedAt = performance.now();
        probe.actionStartedAtMs = startedAt;
        probe.probeStartedAtMs = startedAt;
        probe.previousFrameAtMs = startedAt;
        requestAnimationFrame(sample);
      };
      if (trigger === "pointer") {
        const onPointerDown = (): void => probe.beginAction();
        const onPointerUp = (): void => {
          if (probe.actionStartedAtMs === null || probe.inputCompletedAtMs !== null) return;
          probe.inputCompletedAtMs = performance.now();
        };
        document.addEventListener("pointerdown", onPointerDown, { capture: true, once: true });
        document.addEventListener("pointerup", onPointerUp, { capture: true, once: true });
        probe.removeActionListener = (): void => {
          document.removeEventListener("pointerdown", onPointerDown, { capture: true });
          document.removeEventListener("pointerup", onPointerUp, { capture: true });
        };
      }
    },
    {
      expectedMarker: marker,
      duration: durationMs,
      applicationBaseline: previousApplications,
      trigger: actionTrigger,
    },
  );
}

async function markTerminalVisualProbeAction(page: Page): Promise<void> {
  await page.evaluate((timeoutMs) => {
    const store = globalThis as typeof globalThis & {
      __naruTerminalVisualProbe?: {
        actionStartedAtMs: number | null;
        armed: boolean;
        done: boolean;
        actionTrigger: TerminalVisualProbeActionTrigger;
        beginAction: () => void;
      };
    };
    const probe = store.__naruTerminalVisualProbe;
    if (!probe) throw new Error("Terminal visual probe is unavailable");
    if (probe.armed || probe.actionStartedAtMs !== null) {
      throw new Error("Terminal visual probe action is set");
    }
    probe.armed = true;
    if (probe.actionTrigger === "immediate") probe.beginAction();
    setTimeout(() => {
      probe.done = true;
    }, timeoutMs);
  }, LIVE_RESIZE_CEILING_MS * 2);
}

async function finishTerminalVisualProbe(page: Page): Promise<TerminalVisualProbeResult> {
  await page.waitForFunction(() => {
    const store = globalThis as typeof globalThis & {
      __naruTerminalVisualProbe?: { done: boolean };
    };
    return store.__naruTerminalVisualProbe?.done === true;
  });
  return await page.evaluate(() => {
    const store = globalThis as typeof globalThis & {
      __naruTerminalVisualProbe?: {
        samples: Array<{
          markerVisible: boolean;
          freezeVisible: boolean;
          freezeStyleMatches: boolean;
        }>;
        intervals: number[];
        frameIntervalsAtMs: Array<{ endedAt: number; duration: number }>;
        longTasksMs: Array<{ startedAt: number; duration: number }>;
        longAnimationFramesMs: Array<{
          startedAt: number;
          duration: number;
          blockingDuration: number;
          renderStart: number;
          styleAndLayoutStart: number;
          scriptDuration: number;
        }>;
        terminalResizeApplications: Array<{
          pane: string;
          at: number;
          duration: number | null;
        }>;
        observerInstalledAtMs: number;
        probeStartedAtMs: number | null;
        actionStartedAtMs: number | null;
        inputCompletedAtMs: number | null;
        resizeAppliedAtMs: number[];
        freezeStartedAtMs: number[];
        freezeSettledAtMs: number[];
        observer: MutationObserver;
        longTaskObserver: PerformanceObserver | null;
        longAnimationFrameObserver: PerformanceObserver | null;
        removeActionListener: () => void;
      };
    };
    const probe = store.__naruTerminalVisualProbe;
    if (!probe) throw new Error("Terminal visual probe is unavailable");
    probe.observer.disconnect();
    probe.longTaskObserver?.disconnect();
    probe.longAnimationFrameObserver?.disconnect();
    probe.removeActionListener();
    return {
      markerMissingFrames: probe.samples.filter((sample) => !sample.markerVisible).length,
      freezeFrames: probe.samples.filter((sample) => sample.freezeVisible).length,
      freezeStyleMismatchFrames: probe.samples.filter(
        (sample) => sample.freezeVisible && !sample.freezeStyleMatches,
      ).length,
      intervals: probe.intervals,
      frameIntervalsAtMs: probe.frameIntervalsAtMs,
      longTasksMs: probe.longTasksMs,
      longAnimationFramesMs: probe.longAnimationFramesMs,
      terminalResizeApplications: probe.terminalResizeApplications,
      observerInstalledAtMs: probe.observerInstalledAtMs,
      probeStartedAtMs: probe.probeStartedAtMs,
      actionStartedAtMs: probe.actionStartedAtMs,
      inputCompletedAtMs: probe.inputCompletedAtMs,
      resizeAppliedAtMs: probe.resizeAppliedAtMs,
      freezeStartedAtMs: probe.freezeStartedAtMs,
      freezeSettledAtMs: probe.freezeSettledAtMs,
    };
  });
}

function liveResizeMeasurement(
  scenario: LiveResizeScenario,
  rows: number,
  before: { observerEvents: number; resizeApplications: number; columnReflows: number },
  after: { observerEvents: number; resizeApplications: number; columnReflows: number },
  samples: TerminalVisualProbeResult,
): LiveResizeMeasurement {
  const finalResizeAppliedAtMs = samples.resizeAppliedAtMs.at(-1);
  const finalFreezeSettledAtMs = samples.freezeSettledAtMs.at(-1);
  const completedAtMs = finalFreezeSettledAtMs ?? finalResizeAppliedAtMs;
  const completionMs =
    samples.actionStartedAtMs === null || completedAtMs === undefined
      ? null
      : completedAtMs - samples.actionStartedAtMs;
  const inputCompletedAtMs = samples.inputCompletedAtMs;
  const elapsedAfterInput = (endedAtMs: number | undefined): number | null =>
    inputCompletedAtMs === null || endedAtMs === undefined
      ? null
      : Math.max(0, endedAtMs - inputCompletedAtMs);
  return {
    scenario,
    rows,
    completionMs,
    timingSegmentsMs: {
      actionToInputCompleted:
        samples.actionStartedAtMs === null || inputCompletedAtMs === null
          ? null
          : inputCompletedAtMs - samples.actionStartedAtMs,
      inputCompletedToLastResizeApply: elapsedAfterInput(finalResizeAppliedAtMs),
      inputCompletedToFreezeSettle: elapsedAfterInput(finalFreezeSettledAtMs),
    },
    observerEvents: after.observerEvents - before.observerEvents,
    resizeApplications: after.resizeApplications - before.resizeApplications,
    columnReflows: after.columnReflows - before.columnReflows,
    markerMissingFrames: samples.markerMissingFrames,
    freezeFrames: samples.freezeFrames,
    freezeStyleMismatchFrames: samples.freezeStyleMismatchFrames,
    frameSamples: samples.intervals.length,
    firstFrameIntervalMs: samples.intervals.at(0) ?? null,
    frameIntervalP95Ms: samples.intervals.length > 0 ? percentile(samples.intervals, 0.95) : null,
    frameIntervalMaxMs: samples.intervals.length > 0 ? Math.max(...samples.intervals) : null,
    slowFramesMs: samples.frameIntervalsAtMs.filter(
      (interval) => interval.duration > FRAME_INTERVAL_P95_CEILING_MS,
    ),
    longTasksMs: samples.longTasksMs,
    longAnimationFramesMs: samples.longAnimationFramesMs,
    terminalResizeApplications: samples.terminalResizeApplications,
    pageTimestampsMs: {
      observerInstalled: samples.observerInstalledAtMs,
      probeStarted: samples.probeStartedAtMs,
      actionStarted: samples.actionStartedAtMs,
      inputCompletedAt: samples.inputCompletedAtMs,
      resizeApplied: samples.resizeAppliedAtMs,
      freezeStarted: samples.freezeStartedAtMs,
      freezeSettled: samples.freezeSettledAtMs,
    },
  };
}

function assertLiveResizeMeasurement(measurement: LiveResizeMeasurement): void {
  console.log(
    `NARU_BROWSER_LIVE_RESIZE ${JSON.stringify(roundLiveResizeMeasurement(measurement))}`,
  );

  expect(measurement.pageTimestampsMs.actionStarted).not.toBeNull();
  expect(measurement.pageTimestampsMs.resizeApplied.length).toBeGreaterThan(0);
  if (measurement.scenario === "keyboard") {
    expect(measurement.pageTimestampsMs.freezeStarted).toHaveLength(0);
  } else {
    expect(measurement.pageTimestampsMs.freezeStarted.length).toBeGreaterThan(0);
  }
  expect(measurement.pageTimestampsMs.freezeSettled).toHaveLength(
    measurement.pageTimestampsMs.freezeStarted.length,
  );
  expect(measurement.resizeApplications).toBeGreaterThan(0);
  expect(measurement.markerMissingFrames).toBe(0);
  expect(measurement.freezeStyleMismatchFrames).toBe(0);
  expect(measurement.pageTimestampsMs.probeStarted).not.toBeNull();
  expect(measurement.firstFrameIntervalMs).not.toBeNull();
  expect(measurement.frameIntervalP95Ms).not.toBeNull();
  expect(measurement.frameIntervalMaxMs).not.toBeNull();
  expect(measurement.completionMs).not.toBeNull();
  if (measurement.scenario === "pinned-sidebar" || measurement.scenario === "split-drag") {
    expect(measurement.pageTimestampsMs.inputCompletedAt).not.toBeNull();
    expect(measurement.timingSegmentsMs.actionToInputCompleted).not.toBeNull();
    expect(measurement.timingSegmentsMs.inputCompletedToLastResizeApply).not.toBeNull();
    expect(measurement.timingSegmentsMs.inputCompletedToFreezeSettle).not.toBeNull();
  }

  const actionStarted = measurement.pageTimestampsMs.actionStarted;
  const probeStarted = measurement.pageTimestampsMs.probeStarted;
  const finalResizeApplied = measurement.pageTimestampsMs.resizeApplied.at(-1);
  const finalFreezeStarted = measurement.pageTimestampsMs.freezeStarted.at(-1);
  const finalFreezeSettled = measurement.pageTimestampsMs.freezeSettled.at(-1);
  if (actionStarted !== null && probeStarted !== null) {
    expect(probeStarted).toBeGreaterThanOrEqual(measurement.pageTimestampsMs.observerInstalled);
    expect(actionStarted).toBe(probeStarted);
    for (const timestamp of [
      ...measurement.pageTimestampsMs.resizeApplied,
      ...measurement.pageTimestampsMs.freezeStarted,
      ...measurement.pageTimestampsMs.freezeSettled,
    ]) {
      expect(timestamp).toBeGreaterThanOrEqual(actionStarted);
    }
  }
  if (finalResizeApplied !== undefined && finalFreezeSettled !== undefined) {
    expect(finalFreezeSettled).toBeGreaterThanOrEqual(finalResizeApplied);
  }
  if (finalFreezeStarted !== undefined && finalFreezeSettled !== undefined) {
    expect(finalFreezeSettled).toBeGreaterThanOrEqual(finalFreezeStarted);
  }
  if (measurement.completionMs !== null) {
    expect(measurement.completionMs).toBeLessThanOrEqual(LIVE_RESIZE_CEILING_MS);
  }
  if (measurement.frameIntervalP95Ms !== null) {
    expect(measurement.frameIntervalP95Ms).toBeLessThanOrEqual(FRAME_INTERVAL_P95_CEILING_MS);
  }
  if (measurement.frameIntervalMaxMs !== null) {
    expect(measurement.frameIntervalMaxMs).toBeLessThanOrEqual(FRAME_INTERVAL_MAX_CEILING_MS);
  }
}

function roundLiveResizeMeasurement(measurement: LiveResizeMeasurement): LiveResizeMeasurement {
  return {
    ...measurement,
    completionMs: measurement.completionMs === null ? null : round(measurement.completionMs),
    timingSegmentsMs: {
      actionToInputCompleted:
        measurement.timingSegmentsMs.actionToInputCompleted === null
          ? null
          : round(measurement.timingSegmentsMs.actionToInputCompleted),
      inputCompletedToLastResizeApply:
        measurement.timingSegmentsMs.inputCompletedToLastResizeApply === null
          ? null
          : round(measurement.timingSegmentsMs.inputCompletedToLastResizeApply),
      inputCompletedToFreezeSettle:
        measurement.timingSegmentsMs.inputCompletedToFreezeSettle === null
          ? null
          : round(measurement.timingSegmentsMs.inputCompletedToFreezeSettle),
    },
    firstFrameIntervalMs:
      measurement.firstFrameIntervalMs === null ? null : round(measurement.firstFrameIntervalMs),
    frameIntervalP95Ms:
      measurement.frameIntervalP95Ms === null ? null : round(measurement.frameIntervalP95Ms),
    frameIntervalMaxMs:
      measurement.frameIntervalMaxMs === null ? null : round(measurement.frameIntervalMaxMs),
    slowFramesMs: measurement.slowFramesMs.map((frame) => ({
      endedAt: round(frame.endedAt),
      duration: round(frame.duration),
    })),
    longTasksMs: measurement.longTasksMs.map((task) => ({
      startedAt: round(task.startedAt),
      duration: round(task.duration),
    })),
    longAnimationFramesMs: measurement.longAnimationFramesMs.map((frame) => ({
      startedAt: round(frame.startedAt),
      duration: round(frame.duration),
      blockingDuration: round(frame.blockingDuration),
      renderStart: round(frame.renderStart),
      styleAndLayoutStart: round(frame.styleAndLayoutStart),
      scriptDuration: round(frame.scriptDuration),
    })),
    terminalResizeApplications: measurement.terminalResizeApplications.map((application) => ({
      pane: application.pane,
      at: round(application.at),
      duration: application.duration === null ? null : round(application.duration),
    })),
    pageTimestampsMs: {
      observerInstalled: round(measurement.pageTimestampsMs.observerInstalled),
      probeStarted:
        measurement.pageTimestampsMs.probeStarted === null
          ? null
          : round(measurement.pageTimestampsMs.probeStarted),
      actionStarted:
        measurement.pageTimestampsMs.actionStarted === null
          ? null
          : round(measurement.pageTimestampsMs.actionStarted),
      inputCompletedAt:
        measurement.pageTimestampsMs.inputCompletedAt === null
          ? null
          : round(measurement.pageTimestampsMs.inputCompletedAt),
      resizeApplied: measurement.pageTimestampsMs.resizeApplied.map(round),
      freezeStarted: measurement.pageTimestampsMs.freezeStarted.map(round),
      freezeSettled: measurement.pageTimestampsMs.freezeSettled.map(round),
    },
  };
}

async function runTerminalCommand(page: Page, command: string): Promise<void> {
  const terminal = page.getByLabel("Dev Terminal 터미널");
  const input = terminal.locator(".xterm-helper-textarea");
  await input.focus();
  await expect(input).toBeFocused();
  await page.keyboard.insertText(command);
  await page.keyboard.press("Enter");
}

async function measureProjectSwitch(
  page: Page,
  marker: string,
): Promise<{
  firstCorrectViewportMs: number;
  fullHydrationMs: number;
  visibleIntermediateFrames: number;
}> {
  const pinSidebar = page.getByRole("button", { name: "프로젝트 메뉴 펼치기 고정" });
  if (await pinSidebar.isVisible()) await pinSidebar.click();
  const addProject = page.getByRole("button", { name: "프로젝트 연결" });
  if ((await addProject.count()) > 0 && (await addProject.first().isVisible())) {
    await addProject.first().click();
  }
  await page
    .getByLabel("서버 절대 경로")
    .fill("/private/tmp/naru-e2e-projects/public/editor/apps/server/src");
  await page.getByLabel(/표시 이름/).fill("Naru Performance Switch");
  await page.getByRole("button", { name: "연결하기" }).click();
  await expect(
    page.getByRole("heading", { name: "Naru Performance Switch", exact: true }),
  ).toBeVisible();

  const started = performance.now();
  const gitGroup = page.getByRole("button", {
    name: /^Naru Performance Git 프로젝트/,
  });
  if ((await gitGroup.count()) > 0) {
    await gitGroup.first().click();
  } else {
    await page
      .locator(".project-row")
      .filter({ hasText: "Naru Performance" })
      .first()
      .locator(".project-main")
      .click();
  }
  const terminal = page.getByLabel("Dev Terminal 터미널");
  await expect(terminal.locator(".xterm:not(.terminal-resize-freeze)")).toBeVisible({
    timeout: INITIAL_DISPLAY_CEILING_MS,
  });
  await expect(terminal.locator(".xterm:not(.terminal-resize-freeze) .xterm-rows")).toContainText(
    marker,
    {
      timeout: INITIAL_DISPLAY_CEILING_MS,
    },
  );
  const firstCorrectViewportMs = performance.now() - started;
  await expect(terminal).toHaveAttribute("data-restore-phase", "ready", {
    timeout: FULL_HYDRATION_CEILING_MS,
  });
  const fullHydrationMs = performance.now() - started;
  const visibleIntermediateFrames = await finishRestoreVisibilityProbe(page);
  expect(visibleIntermediateFrames).toBe(0);
  expect(firstCorrectViewportMs).toBeLessThanOrEqual(FIRST_CORRECT_VIEWPORT_CEILING_MS);
  expect(fullHydrationMs).toBeLessThanOrEqual(FULL_HYDRATION_CEILING_MS);
  return { firstCorrectViewportMs, fullHydrationMs, visibleIntermediateFrames };
}

async function measureTakeover(
  browser: Browser,
  page: Page,
  marker: string,
): Promise<{
  firstCorrectViewportMs: number;
  fullHydrationMs: number;
  visibleFramesBeforeFonts: number;
  visibleIntermediateFrames: number;
}> {
  const storageState = await page.context().storageState();
  const origin = new URL(page.url()).origin;
  const context = await browser.newContext({
    baseURL: origin,
    storageState,
    hasTouch: true,
    viewport: { width: 390, height: 844 },
  });
  await context.route("**/fonts/d2coding/*.ttf", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  await context.addInitScript(() => {
    const store = globalThis as typeof globalThis & {
      __naruRestoreFontProbe?: {
        visibleFrames: number;
        visibleFramesBeforeFonts: number;
        visibleIntermediateFrames: number;
      };
    };
    const probe = {
      visibleFrames: 0,
      visibleFramesBeforeFonts: 0,
      visibleIntermediateFrames: 0,
    };
    store.__naruRestoreFontProbe = probe;
    const sample = (): void => {
      const host = document.querySelector<HTMLElement>(
        '[aria-label="Dev Terminal 터미널"] .terminal-host',
      );
      const xterm = host?.querySelector<HTMLElement>(".xterm:not(.terminal-resize-freeze)");
      if (xterm) {
        const style = getComputedStyle(xterm);
        const bounds = xterm.getBoundingClientRect();
        const visible =
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity) > 0 &&
          bounds.width > 0 &&
          bounds.height > 0;
        if (visible) {
          probe.visibleFrames += 1;
          if (host?.dataset.terminalRestoreReady !== "true") {
            probe.visibleIntermediateFrames += 1;
          }
          const fontsReady =
            document.fonts.check('400 13px "D2Coding"', "Naru 한글 Aa0") &&
            document.fonts.check('700 13px "D2Coding"', "Naru 한글 Aa0");
          if (!fontsReady) probe.visibleFramesBeforeFonts += 1;
        }
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const takeoverPage = await context.newPage();
  try {
    const started = performance.now();
    await takeoverPage.goto("/");
    const terminal = takeoverPage.getByLabel("Dev Terminal 터미널");
    await expect(terminal.locator(".xterm:not(.terminal-resize-freeze)")).toBeVisible({
      timeout: INITIAL_DISPLAY_CEILING_MS,
    });
    await expect(terminal.locator(".xterm:not(.terminal-resize-freeze) .xterm-rows")).toContainText(
      marker,
      {
        timeout: INITIAL_DISPLAY_CEILING_MS,
      },
    );
    const firstCorrectViewportMs = performance.now() - started;
    await expect(terminal).toHaveAttribute("data-restore-phase", "ready", {
      timeout: FULL_HYDRATION_CEILING_MS,
    });
    const fullHydrationMs = performance.now() - started;
    await expect
      .poll(() =>
        takeoverPage.evaluate(() => {
          const store = globalThis as typeof globalThis & {
            __naruRestoreFontProbe?: { visibleFrames: number };
          };
          return store.__naruRestoreFontProbe?.visibleFrames ?? 0;
        }),
      )
      .toBeGreaterThan(0);
    const fontProbe = await takeoverPage.evaluate(() => {
      const store = globalThis as typeof globalThis & {
        __naruRestoreFontProbe?: {
          visibleFrames: number;
          visibleFramesBeforeFonts: number;
          visibleIntermediateFrames: number;
        };
      };
      return store.__naruRestoreFontProbe;
    });
    expect(fontProbe?.visibleFrames ?? 0).toBeGreaterThan(0);
    expect(fontProbe?.visibleFramesBeforeFonts ?? 0).toBe(0);
    expect(fontProbe?.visibleIntermediateFrames ?? 0).toBe(0);
    expect(fullHydrationMs - firstCorrectViewportMs).toBeLessThanOrEqual(
      PREVIEW_TO_FULL_VISUAL_GAP_CEILING_MS,
    );
    expect(
      await takeoverPage.evaluate(() => ({
        regular: document.fonts.check('400 13px "D2Coding"', "Naru 한글 Aa0"),
        bold: document.fonts.check('700 13px "D2Coding"', "Naru 한글 Aa0"),
      })),
    ).toEqual({ regular: true, bold: true });
    await expect(terminal.locator(".xterm:not(.terminal-resize-freeze) .xterm-rows")).toContainText(
      marker,
    );
    expect(firstCorrectViewportMs).toBeLessThanOrEqual(FIRST_CORRECT_VIEWPORT_CEILING_MS);
    expect(fullHydrationMs).toBeLessThanOrEqual(FULL_HYDRATION_CEILING_MS);
    return {
      firstCorrectViewportMs,
      fullHydrationMs,
      visibleFramesBeforeFonts: fontProbe?.visibleFramesBeforeFonts ?? 0,
      visibleIntermediateFrames: fontProbe?.visibleIntermediateFrames ?? 0,
    };
  } finally {
    await context.close();
  }
}

async function startRestoreVisibilityProbe(page: Page, projectHeading: string): Promise<void> {
  await page.evaluate((expectedHeading) => {
    const store = globalThis as typeof globalThis & {
      __naruRestoreVisibilityProbe?: {
        active: boolean;
        done: boolean;
        visibleIntermediateFrames: number;
      };
    };
    const probe = { active: false, done: false, visibleIntermediateFrames: 0 };
    store.__naruRestoreVisibilityProbe = probe;
    const sample = (): void => {
      const heading = document.querySelector<HTMLElement>(".brand-context");
      if (heading?.textContent?.trim() === expectedHeading) probe.active = true;
      if (probe.active) {
        const host = document.querySelector<HTMLElement>(
          '[aria-label="Dev Terminal 터미널"] .terminal-host',
        );
        const xterm = host?.querySelector<HTMLElement>(".xterm:not(.terminal-resize-freeze)");
        if (host && xterm) {
          const style = getComputedStyle(xterm);
          const bounds = xterm.getBoundingClientRect();
          const visible =
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity) > 0 &&
            bounds.width > 0 &&
            bounds.height > 0;
          if (visible && host.dataset.terminalRestoreReady !== "true") {
            probe.visibleIntermediateFrames += 1;
          }
        }
      }
      if (!probe.done) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, projectHeading);
}

async function finishRestoreVisibilityProbe(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const store = globalThis as typeof globalThis & {
      __naruRestoreVisibilityProbe?: {
        done: boolean;
        visibleIntermediateFrames: number;
      };
    };
    const probe = store.__naruRestoreVisibilityProbe;
    if (probe) probe.done = true;
    return probe?.visibleIntermediateFrames ?? 0;
  });
}

async function startFrameProbe(page: Page, durationMs: number): Promise<void> {
  await page.evaluate((duration) => {
    const store = globalThis as typeof globalThis & {
      __naruFrameProbe?: { intervals: number[]; done: boolean };
    };
    const probe = { intervals: [] as number[], done: false };
    store.__naruFrameProbe = probe;
    const started = performance.now();
    let previous = 0;
    const sample = (now: number): void => {
      if (previous > 0) probe.intervals.push(now - previous);
      previous = now;
      if (now - started >= duration) {
        probe.done = true;
        return;
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, durationMs);
}

async function finishFrameProbe(page: Page): Promise<number[]> {
  await page.waitForFunction(() => {
    const store = globalThis as typeof globalThis & {
      __naruFrameProbe?: { done: boolean };
    };
    return store.__naruFrameProbe?.done === true;
  });
  return await page.evaluate(() => {
    const store = globalThis as typeof globalThis & {
      __naruFrameProbe?: { intervals: number[] };
    };
    return store.__naruFrameProbe?.intervals ?? [];
  });
}

function percentile(values: readonly number[], quantile: number): number {
  expect(values.length).toBeGreaterThan(0);
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(quantile * sorted.length) - 1] ?? Number.POSITIVE_INFINITY;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
