import { readWorkstationGatewayConfig } from "./config.js";
import { WorkstationGateway } from "./gateway.js";
import { JsonStderrGatewayLogger } from "./logging.js";

const configPath = process.argv[2];
if (configPath === undefined || process.argv.length !== 3) {
  process.stderr.write("Usage: workstation-gateway <private-config.json>\n");
  process.exit(2);
}

const logger = new JsonStderrGatewayLogger();
const gateway = await WorkstationGateway.create(readWorkstationGatewayConfig(configPath), {
  logger,
});

let shuttingDown = false;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  await gateway.close();
};

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    void shutdown()
      .catch(() => {
        process.exitCode = 1;
      })
      .finally(() => {
        process.exit();
      });
  });
}

process.on("uncaughtException", () => {
  process.exitCode = 1;
  void shutdown().finally(() => process.exit());
});
process.on("unhandledRejection", () => {
  process.exitCode = 1;
  void shutdown().finally(() => process.exit());
});

await gateway.listen();
