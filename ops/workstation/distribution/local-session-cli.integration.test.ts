import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runSessionCli } from "../../../apps/cli/src/runner.js";
import { DurableSessionHostConfigSchema } from "../../../apps/durable-session-host/src/config.js";
import { startDurableSessionHost } from "../../../apps/durable-session-host/src/host.js";
import { silentHostLogger } from "../../../apps/durable-session-host/src/logging.js";
import { verifyDistributionArtifact } from "./artifact.js";
import { createInstanceConfiguration } from "./configuration.js";
import { installOrUpdateInstanceCredentials } from "./credentials.js";
import { createInstanceLayout } from "./model.js";
import { ensureInstanceDirectories } from "./security.js";
import { createDistributionFixture } from "./test-support.js";

describe("T16 packaged local Session CLI identity", () => {
  it("authenticates through its own least-privilege Host registration", async () => {
    const fixture = createDistributionFixture();
    const artifact = verifyDistributionArtifact(fixture.artifactRoot);
    const layout = createInstanceLayout(fixture.intent, artifact.summary);
    const generated = createInstanceConfiguration(fixture.intent, artifact.summary, layout);
    if (generated.localSessionCli === undefined) {
      throw new Error("Fixture artifact is missing the local Session CLI feature.");
    }
    ensureInstanceDirectories(layout, layout.uid);
    installOrUpdateInstanceCredentials(layout, generated.naruEnvironment, {
      localSessionCli: true,
    });
    const host = await startDurableSessionHost(
      DurableSessionHostConfigSchema.parse(generated.host),
      { logger: silentHostLogger, hostEnvironment: {} },
    );

    try {
      const output: string[] = [];
      const errorOutput: string[] = [];
      const connection = generated.localSessionCli;
      const exitCode = await runSessionCli(
        [
          "--json",
          "--socket",
          connection.socketPath,
          "--app-id",
          connection.appId,
          "--credential-file",
          connection.credentialFile,
          "--subject",
          connection.subject,
          "--caller-ttl-ms",
          String(connection.callerTtlMs),
          "list",
        ],
        {
          environment: {},
          io: {
            stdout: (value) => output.push(value),
            stderr: (value) => errorOutput.push(value),
          },
        },
      );

      expect(exitCode).toBe(0);
      expect(errorOutput).toEqual([]);
      expect(JSON.parse(output.join(""))).toMatchObject({
        version: 1,
        ok: true,
        command: "list",
        result: { sessions: [] },
      });

      const wrongIdentityOutput: string[] = [];
      const wrongIdentityExitCode = await runSessionCli(
        [
          "--json",
          "--socket",
          connection.socketPath,
          "--app-id",
          connection.appId,
          "--credential-file",
          layout.files.hostCredential,
          "--subject",
          connection.subject,
          "list",
        ],
        {
          environment: {},
          io: {
            stdout: (value) => wrongIdentityOutput.push(value),
            stderr: () => undefined,
          },
        },
      );

      expect(wrongIdentityExitCode).not.toBe(0);
      expect(JSON.parse(wrongIdentityOutput.join(""))).toMatchObject({ ok: false });
      expect(readFileSync(layout.files.hostCredential, "utf8")).not.toBe(
        readFileSync(layout.files.localSessionCliCredential, "utf8"),
      );
      expect(JSON.stringify(generated.instance)).not.toContain(
        readFileSync(layout.files.localSessionCliCredential, "utf8").trim(),
      );
    } finally {
      await host.close();
    }
  });
});
