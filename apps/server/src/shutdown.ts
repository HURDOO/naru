import { safeErrorFields } from "./observability.js";

export type ShutdownSignal = "SIGINT" | "SIGTERM";

interface ShutdownLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

interface ShutdownApp {
  log: ShutdownLogger;
  close(): Promise<void>;
}

interface ShutdownOptions {
  now?: () => Date;
  setExitCode?: (exitCode: number) => void;
}

export function createGracefulShutdownHandler(
  app: ShutdownApp,
  options: ShutdownOptions = {},
): (signal: ShutdownSignal) => Promise<void> {
  const now = options.now ?? (() => new Date());
  const setExitCode = options.setExitCode ?? ((exitCode: number) => (process.exitCode = exitCode));
  let shutdownPromise: Promise<void> | null = null;

  return (signal) => {
    shutdownPromise ??= runShutdown(app, signal, now, setExitCode);
    return shutdownPromise;
  };
}

async function runShutdown(
  app: ShutdownApp,
  signal: ShutdownSignal,
  now: () => Date,
  setExitCode: (exitCode: number) => void,
): Promise<void> {
  app.log.info(
    { timestamp: now().toISOString(), event: "server.shutdown.started", signal },
    "server shutdown started",
  );
  try {
    await app.close();
    app.log.info(
      { timestamp: now().toISOString(), event: "server.shutdown.completed", signal },
      "server shutdown completed",
    );
  } catch (error) {
    app.log.error(
      {
        timestamp: now().toISOString(),
        event: "server.shutdown.failed",
        signal,
        ...safeErrorFields(error),
      },
      "server shutdown failed",
    );
    setExitCode(1);
  }
}
