import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NaruRepository } from "../../apps/server/src/database.js";
import type { PaneLaunchResolver } from "../../apps/server/src/launch-profiles.js";
import { PtySupervisor } from "../../apps/server/src/pty.js";
import type { ServerWsFrame } from "../../packages/contracts/src/index.js";

const PANE_COUNT = 6;
const BURST_LINES = 3_000;
const SUSTAINED_ROUNDS = readPositiveInteger("NARU_PERF_SUSTAINED_ROUNDS", 4);
const SUSTAINED_LINES = 2_500;
const LATENCY_ROUNDS = 10;
const MAX_INCREMENTAL_RSS_MIB = 192;
const MAX_ABSOLUTE_RSS_MIB = 384;
const MAX_HOST_INPUT_P95_MS = 150;
const MAX_EVENT_LOOP_P95_MS = 100;
const MAX_LOAD_DURATION_MS = 30_000;
const MAX_STAGED_PREVIEW_P95_MS = 100;
const MAX_STAGED_FULL_P95_MS = 500;
const fixturePath = fileURLToPath(new URL("../fixtures/perf-pty.mjs", import.meta.url));

interface PaneProbe {
  paneId: string;
  token: string;
  sequence: number;
  runtimeId: string;
  outputFrames: number;
  sequenceGaps: number;
  tail: string;
}

interface LagSampler {
  stop(): number[];
}

interface StagedSnapshotProbe {
  previewReadyMs: number;
  fullReadyMs: number;
  previewBytes: number;
  fullBytes: number;
}

async function main(): Promise<void> {
  collectGarbage();
  const initialRss = rssMiB();
  const base = await mkdtemp(join(tmpdir(), "naru-terminal-load-"));
  const repository = new NaruRepository(":memory:");
  const launchProfiles: PaneLaunchResolver = {
    resolve(context) {
      return {
        file: process.execPath,
        args: [fixturePath, context.pane.id.slice(0, 8)],
        environment: { TERM: "xterm-256color", LANG: "C.UTF-8" },
      };
    },
  };
  const supervisor = new PtySupervisor(repository, undefined, launchProfiles);
  const detaches: Array<() => void> = [];

  try {
    const paneIds: string[] = [];
    for (let projectIndex = 0; projectIndex < 2; projectIndex += 1) {
      const projectPath = join(base, `project-${projectIndex}`);
      await mkdir(projectPath);
      const project = repository.createProject(projectPath, `Performance ${projectIndex}`);
      paneIds.push(...repository.getWorkspace(project.id).panes.map((pane) => pane.id));
    }
    assert(paneIds.length === PANE_COUNT, `expected ${PANE_COUNT} default Panes`);

    const probes = paneIds.map<PaneProbe>((paneId, index) => ({
      paneId,
      token: `P${index}`,
      sequence: 0,
      runtimeId: "",
      outputFrames: 0,
      sequenceGaps: 0,
      tail: "",
    }));
    for (const probe of probes) supervisor.start(probe.paneId, 100, 30);
    for (const probe of probes) {
      detaches.push(
        await supervisor.attach(probe.paneId, 100, 30, (frame) => observeFrame(probe, frame)),
      );
    }
    assert(supervisor.count() === PANE_COUNT, "all six PTY runtimes must remain active");

    collectGarbage();
    const loadedBaselineRss = rssMiB();
    const lagSampler = startLagSampler();
    const loadStarted = performance.now();
    await runLoadRound(supervisor, probes, "BURST", BURST_LINES);
    for (let round = 0; round < SUSTAINED_ROUNDS; round += 1) {
      await runLoadRound(supervisor, probes, `S${round}`, SUSTAINED_LINES);
    }
    const loadDurationMs = performance.now() - loadStarted;
    const eventLoopDelays = lagSampler.stop();

    const inputLatencies: number[] = [];
    for (let round = 0; round < LATENCY_ROUNDS; round += 1) {
      await Promise.all(
        probes.map(async (probe) => {
          const marker = `PING_${probe.token}_${round}_${Date.now()}`;
          const started = performance.now();
          supervisor.write(probe.paneId, `PING ${marker}\n`);
          await waitForMarker(probe, marker);
          inputLatencies.push(performance.now() - started);
        }),
      );
    }

    const snapshots = await Promise.all(
      probes.map(async (probe) => captureSnapshot(supervisor, probe.paneId)),
    );
    for (const [index, snapshot] of snapshots.entries()) {
      const probe = probes[index];
      assert(probe !== undefined, "snapshot probe must exist");
      assert(snapshot.includes(`DONE_S${SUSTAINED_ROUNDS - 1}_${probe.token}`), "latest rows lost");
      assert(!snapshot.includes(`BURST_${probe.token}_00000`), "scrollback did not evict old rows");
    }
    for (const probe of probes) {
      assert(probe.runtimeId.length > 0, "runtime identity must be known before staged restore");
      supervisor.updateViewport(probe.paneId, probe.runtimeId, 1_000);
    }
    const stagedSnapshots = await Promise.all(
      probes.map(async (probe) => captureStagedSnapshot(supervisor, probe)),
    );

    await delay(100);
    collectGarbage();
    const finalRss = rssMiB();
    const incrementalRss = finalRss - initialRss;
    const steadyStateRss = finalRss - loadedBaselineRss;
    const hostInputP95 = percentile(inputLatencies, 0.95);
    const eventLoopP95 = percentile(eventLoopDelays, 0.95);
    const sequenceFrames = probes.reduce((total, probe) => total + probe.outputFrames, 0);
    const sequenceGaps = probes.reduce((total, probe) => total + probe.sequenceGaps, 0);
    const stagedPreviewP95 = percentile(
      stagedSnapshots.map((snapshot) => snapshot.previewReadyMs),
      0.95,
    );
    const stagedFullP95 = percentile(
      stagedSnapshots.map((snapshot) => snapshot.fullReadyMs),
      0.95,
    );

    assert(sequenceFrames > PANE_COUNT, "performance fixture did not observe output frames");
    assert(sequenceGaps === 0, "terminal output sequence contained gaps or duplicates");
    assert(loadDurationMs <= MAX_LOAD_DURATION_MS, "terminal load exceeded its duration ceiling");
    assert(incrementalRss <= MAX_INCREMENTAL_RSS_MIB, "incremental RSS exceeded its ceiling");
    assert(finalRss <= MAX_ABSOLUTE_RSS_MIB, "absolute RSS exceeded its ceiling");
    assert(hostInputP95 <= MAX_HOST_INPUT_P95_MS, "host input p95 exceeded its ceiling");
    assert(eventLoopP95 <= MAX_EVENT_LOOP_P95_MS, "event-loop p95 exceeded its ceiling");
    assert(
      stagedPreviewP95 <= MAX_STAGED_PREVIEW_P95_MS,
      "staged preview capture p95 exceeded its ceiling",
    );
    assert(stagedFullP95 <= MAX_STAGED_FULL_P95_MS, "staged full capture p95 exceeded its ceiling");

    const report = {
      schemaVersion: 2,
      measuredAt: new Date().toISOString(),
      runtime: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
      },
      workload: {
        panes: PANE_COUNT,
        linesPerPane: BURST_LINES + SUSTAINED_ROUNDS * SUSTAINED_LINES,
        totalLines: PANE_COUNT * (BURST_LINES + SUSTAINED_ROUNDS * SUSTAINED_LINES),
        latencySamples: inputLatencies.length,
        scrollbackRowsPerPane: 2_000,
      },
      thresholds: {
        incrementalRssMiB: MAX_INCREMENTAL_RSS_MIB,
        absoluteRssMiB: MAX_ABSOLUTE_RSS_MIB,
        hostInputP95Ms: MAX_HOST_INPUT_P95_MS,
        eventLoopP95Ms: MAX_EVENT_LOOP_P95_MS,
        loadDurationMs: MAX_LOAD_DURATION_MS,
        stagedPreviewP95Ms: MAX_STAGED_PREVIEW_P95_MS,
        stagedFullP95Ms: MAX_STAGED_FULL_P95_MS,
      },
      results: {
        initialRssMiB: round(initialRss),
        loadedBaselineRssMiB: round(loadedBaselineRss),
        finalRssMiB: round(finalRss),
        incrementalRssMiB: round(incrementalRss),
        steadyStateRssMiB: round(steadyStateRss),
        hostInputP95Ms: round(hostInputP95),
        eventLoopP95Ms: round(eventLoopP95),
        eventLoopMaxMs: round(Math.max(0, ...eventLoopDelays)),
        loadDurationMs: round(loadDurationMs),
        outputFrames: sequenceFrames,
        sequenceGaps,
        snapshotsBounded: true,
        stagedPreviewP95Ms: round(stagedPreviewP95),
        stagedFullP95Ms: round(stagedFullP95),
        stagedPreviewBytesP95: round(
          percentile(
            stagedSnapshots.map((snapshot) => snapshot.previewBytes),
            0.95,
          ),
        ),
        stagedFullBytesP95: round(
          percentile(
            stagedSnapshots.map((snapshot) => snapshot.fullBytes),
            0.95,
          ),
        ),
        passed: true,
      },
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    for (const detach of detaches) detach();
    await supervisor.shutdown();
    repository.close();
    await rm(base, { recursive: true, force: true });
  }
}

function observeFrame(probe: PaneProbe, frame: ServerWsFrame): void {
  if (frame.type === "pane.snapshot") {
    probe.sequence = frame.sequence;
    probe.runtimeId = frame.runtimeId;
    return;
  }
  if (frame.type !== "terminal.output") return;
  if (frame.sequence !== probe.sequence + 1) probe.sequenceGaps += 1;
  probe.sequence = frame.sequence;
  probe.outputFrames += 1;
  probe.tail = `${probe.tail}${frame.data}`.slice(-8_192);
}

async function captureStagedSnapshot(
  supervisor: PtySupervisor,
  probe: PaneProbe,
): Promise<StagedSnapshotProbe> {
  const started = performance.now();
  let preview: Extract<ServerWsFrame, { type: "pane.restore.preview" }> | undefined;
  let full: Extract<ServerWsFrame, { type: "pane.restore.full" }> | undefined;
  let previewReadyMs = Number.POSITIVE_INFINITY;
  let fullReadyMs = Number.POSITIVE_INFINITY;
  const detach = await supervisor.attach(
    probe.paneId,
    100,
    30,
    (frame) => {
      if (frame.type === "pane.restore.preview") {
        preview = frame;
        previewReadyMs = performance.now() - started;
      }
      if (frame.type === "pane.restore.full") {
        full = frame;
        fullReadyMs = performance.now() - started;
      }
    },
    "staged-v1",
    randomUUID(),
  );
  detach();
  assert(preview !== undefined && full !== undefined, "staged restore frames must both arrive");
  assert(preview.sequence === full.sequence, "staged restore sequences must match");
  assert(preview.runtimeId === probe.runtimeId, "staged preview runtime changed");
  assert(full.runtimeId === probe.runtimeId, "staged full runtime changed");
  assert(preview.bottomOffset === 1_000, "staged viewport offset was not preserved");
  assert(preview.serializedState.length < full.serializedState.length, "preview was not bounded");
  return {
    previewReadyMs,
    fullReadyMs,
    previewBytes: Buffer.byteLength(preview.serializedState),
    fullBytes: Buffer.byteLength(full.serializedState),
  };
}

async function runLoadRound(
  supervisor: PtySupervisor,
  probes: readonly PaneProbe[],
  round: string,
  lines: number,
): Promise<void> {
  const markers = probes.map((probe) => `${round}_${probe.token}`);
  for (const [index, probe] of probes.entries()) {
    const marker = markers[index];
    assert(marker !== undefined, "load marker must exist");
    supervisor.write(probe.paneId, `BURST ${lines} ${marker}\n`);
  }
  await Promise.all(
    probes.map((probe, index) => {
      const marker = markers[index];
      assert(marker !== undefined, "load marker must exist");
      return waitForMarker(probe, `DONE_${marker}`);
    }),
  );
}

async function captureSnapshot(supervisor: PtySupervisor, paneId: string): Promise<string> {
  let snapshot = "";
  const detach = await supervisor.attach(paneId, 100, 30, (frame) => {
    if (frame.type === "pane.snapshot") snapshot = frame.serializedState;
  });
  detach();
  assert(snapshot.length > 0, "snapshot capture returned no terminal state");
  return snapshot;
}

async function waitForMarker(probe: PaneProbe, marker: string): Promise<void> {
  const deadline = performance.now() + MAX_LOAD_DURATION_MS;
  while (!probe.tail.includes(marker)) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${marker}.`);
    await delay(2);
  }
}

function startLagSampler(intervalMs = 10): LagSampler {
  const delays: number[] = [];
  let previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    delays.push(Math.max(0, now - previous - intervalMs));
    previous = now;
  }, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      return delays;
    },
  };
}

function percentile(values: readonly number[], quantile: number): number {
  assert(values.length > 0, "percentile requires at least one sample");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(quantile * sorted.length) - 1] ?? 0;
}

function collectGarbage(): void {
  (globalThis as { gc?: () => void }).gc?.();
}

function rssMiB(): number {
  return process.memoryUsage().rss / 1024 / 1024;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error(`${name} must be an integer between 1 and 1000.`);
  }
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown terminal load failure.";
  process.stderr.write(`Terminal performance check failed: ${message}\n`);
  process.exitCode = 1;
});
