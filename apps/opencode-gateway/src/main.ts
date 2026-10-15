import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { readConfig, readOwnerFile, readVerifierKeys } from "./config.js";
import { createOpenCodeGateway } from "./server.js";

async function main(): Promise<void> {
  const filename = process.argv[2];
  if (!filename) throw new Error("Configuration required.");
  const config = readConfig(filename);
  const executable = lstatSync(config.opencodeExecutable);
  if (
    !executable.isFile() ||
    executable.isSymbolicLink() ||
    realpathSync(config.opencodeExecutable) !== config.opencodeExecutable ||
    executable.uid !== process.getuid?.()
  )
    throw new Error("Invalid executable.");
  if (
    createHash("sha256").update(readFileSync(config.opencodeExecutable)).digest("hex") !==
    config.opencodeSha256
  )
    throw new Error("Executable digest changed.");
  const password = readOwnerFile(config.passwordFile).toString("utf8").trim();
  if (password.length < 32 || /\s/.test(password)) throw new Error("Invalid backend password.");
  const keys = readVerifierKeys(config.verifierKeysFile);
  const adapter = createOpenCodeGateway({ config, password, keys });
  const backend = spawn(
    config.opencodeExecutable,
    [
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(config.upstreamPort),
      "--cors",
      config.browserOrigin,
      "--log-level",
      "ERROR",
    ],
    {
      cwd: config.defaultDirectory,
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_SERVER_USERNAME: "opencode",
        OMO_SEND_ANONYMOUS_TELEMETRY: "0",
        OMO_DISABLE_POSTHOG: "1",
      },
      stdio: "ignore",
    },
  );
  const awake = spawn("/usr/bin/caffeinate", ["-i"], { stdio: "ignore" });
  process.once("exit", () => {
    backend.kill("SIGKILL");
    awake.kill("SIGTERM");
  });
  let stopping = false;
  const stop = async (exitCode: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await adapter.close();
    backend.kill("SIGTERM");
    awake.kill("SIGTERM");
    await setTimeout(1000);
    if (backend.exitCode === null) backend.kill("SIGKILL");
    process.exit(exitCode);
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      void stop(0);
    });
  backend.once("error", () => {
    void stop(1);
  });
  backend.once("exit", () => {
    if (!stopping) void stop(1);
  });
  const fail = async (): Promise<void> => {
    console.error("OpenCode Gateway startup failed.");
    await stop(1);
  };
  adapter.server.on("error", () => {
    void fail();
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (backend.exitCode !== null) throw new Error("Backend stopped.");
    try {
      const response = await fetch(`http://127.0.0.1:${config.upstreamPort}/global/health`, {
        headers: {
          authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
        },
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) break;
    } catch {
      /* Bound startup polling without recording private errors. */
    }
    if (attempt === 59) {
      await stop(1);
      return;
    }
    await setTimeout(1000);
  }
  await new Promise<void>((resolve, reject) => {
    adapter.server.once("error", reject);
    adapter.server.listen(config.listenPort, "127.0.0.1", resolve);
  });
  console.log("OpenCode Gateway ready.");
}

void main().catch(() => {
  console.error("OpenCode Gateway startup failed.");
  process.exit(1);
});
