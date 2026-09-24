import { describe, expect, it } from "vitest";
import { verifyDistributionArtifact } from "./artifact.js";
import { createInstanceLayout } from "./model.js";
import { startRuntimeTopology, stopRuntimeTopology } from "./runtime.js";
import { createDistributionFixture, FakeWorkstationRuntime } from "./test-support.js";

describe("Workstation runtime lifecycle", () => {
  it("waits for the previous process before bootstrapping the same runtime label", async () => {
    const fixture = createDistributionFixture({ packagedNodeRuntime: true });
    const artifact = verifyDistributionArtifact(fixture.artifactRoot);
    const layout = createInstanceLayout(fixture.intent, artifact.summary);
    const runtime = new DelayedStopRuntime();
    runtime.bootstrap(layout.uid, layout.launchAgentFiles.host);
    runtime.operations.length = 0;

    const transition = (async () => {
      await stopRuntimeTopology(runtime, layout, ["host"]);
      await startRuntimeTopology(runtime, layout, () => undefined, ["host"]);
    })();
    await Promise.resolve();

    expect(runtime.operations).toEqual([`stop-requested:${layout.labels.host}`]);
    expect(runtime.serviceState(layout.uid, layout.labels.host)).toBe("running");

    runtime.releaseStop();
    await transition;

    expect(runtime.operations).toEqual([
      `stop-requested:${layout.labels.host}`,
      `bootout:${layout.labels.host}`,
      `bootstrap:${layout.labels.host}`,
    ]);
    expect(runtime.operations).not.toContain(`kickstart:${layout.labels.host}`);
  });

  it("does not bootstrap after a bounded stop failure", async () => {
    const fixture = createDistributionFixture({ packagedNodeRuntime: true });
    const artifact = verifyDistributionArtifact(fixture.artifactRoot);
    const layout = createInstanceLayout(fixture.intent, artifact.summary);
    const runtime = new StopTimeoutRuntime();
    runtime.bootstrap(layout.uid, layout.launchAgentFiles.host);
    runtime.operations.length = 0;

    await expect(
      (async () => {
        await stopRuntimeTopology(runtime, layout, ["host"]);
        await startRuntimeTopology(runtime, layout, () => undefined, ["host"]);
      })(),
    ).rejects.toThrow("Runtime stop could not be confirmed");
    expect(runtime.operations).toEqual([`stop-requested:${layout.labels.host}`]);
  });
});

class DelayedStopRuntime extends FakeWorkstationRuntime {
  #resolveStop: (() => void) | undefined;
  readonly #stopped = new Promise<void>((resolvePromise) => {
    this.#resolveStop = resolvePromise;
  });

  releaseStop(): void {
    if (this.#resolveStop === undefined) throw new Error("Stop fixture is unavailable.");
    this.#resolveStop();
  }

  override async stopAndWait(uid: number, label: string): Promise<void> {
    this.operations.push(`stop-requested:${label}`);
    await this.#stopped;
    await super.stopAndWait(uid, label);
  }
}

class StopTimeoutRuntime extends FakeWorkstationRuntime {
  override async stopAndWait(_uid: number, label: string): Promise<void> {
    this.operations.push(`stop-requested:${label}`);
    await Promise.resolve();
    throw new Error("launchd service did not fully stop before timeout.");
  }
}
