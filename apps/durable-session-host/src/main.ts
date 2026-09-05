import { readDurableSessionHostConfig } from "./config.js";
import { startDurableSessionHost } from "./host.js";

const configPath = process.env.DURABLE_SESSION_HOST_CONFIG;
if (configPath === undefined || configPath === "") {
  throw new Error("DURABLE_SESSION_HOST_CONFIG must point to a private Host config file.");
}

process.umask(0o077);
const config = readDurableSessionHostConfig(configPath);
const host = await startDurableSessionHost(config);

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void host.close().then(
    () => {
      process.exitCode = 0;
    },
    () => {
      process.exitCode = 1;
    },
  );
};

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
