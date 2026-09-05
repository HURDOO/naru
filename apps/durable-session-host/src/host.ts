import type { DurableSessionHostConfig } from "./config.js";
import { HostAppRegistry } from "./app-registry.js";
import { HostCommandPolicy } from "./command-policy.js";
import type { HostLogger } from "./logging.js";
import { JsonStderrHostLogger } from "./logging.js";
import type { MetadataRepository } from "./metadata.js";
import { SqliteMetadataRepository } from "./metadata.js";
import type { RuntimePort } from "./runtime.js";
import { NodePtyRuntimePort } from "./runtime.js";
import type { HostClock, HostIds } from "./session-service.js";
import { SessionService, SystemHostClock } from "./session-service.js";
import { HostTransportServer } from "./transport.js";

export interface DurableSessionHostDependencies {
  readonly metadata?: MetadataRepository;
  readonly runtime?: RuntimePort;
  readonly logger?: HostLogger;
  readonly clock?: HostClock;
  readonly ids?: HostIds;
  readonly hostEnvironment?: NodeJS.ProcessEnv;
}

export interface RunningDurableSessionHost {
  readonly service: SessionService;
  readonly transport: HostTransportServer;
  close(): Promise<void>;
}

export async function startDurableSessionHost(
  config: DurableSessionHostConfig,
  dependencies: DurableSessionHostDependencies = {},
): Promise<RunningDurableSessionHost> {
  const logger = dependencies.logger ?? new JsonStderrHostLogger();
  const clock = dependencies.clock ?? new SystemHostClock();
  const commandPolicy = new HostCommandPolicy(config, dependencies.hostEnvironment);
  const appRegistry = new HostAppRegistry(config.appRegistrations);
  const metadata = dependencies.metadata ?? new SqliteMetadataRepository(config.dataDirectory);
  const service = new SessionService({
    metadata,
    runtime: dependencies.runtime ?? new NodePtyRuntimePort(),
    commandPolicy,
    sessionLimit: config.sessionLimit,
    maxAttachmentsPerSession: config.maxAttachmentsPerSession,
    attachmentQueueBytes: config.attachmentQueueBytes,
    eventJournalLimit: config.eventJournalLimit,
    inputDedupeTtlMs: config.inputDedupeTtlMs,
    inputDedupeLimit: config.inputDedupeLimit,
    expirySweepIntervalMs: config.expirySweepIntervalMs,
    idempotencyTtlMs: config.idempotencyTtlMs,
    idempotencyLimit: config.idempotencyLimit,
    logger,
    clock,
    ...(dependencies.ids === undefined ? {} : { ids: dependencies.ids }),
  });
  const transport = new HostTransportServer({
    socketPath: config.socketPath,
    requestBodyBytes: config.requestBodyBytes,
    maxConcurrentRequests: config.maxConcurrentRequests,
    maxConcurrentStreams: config.maxConcurrentStreams,
    appRegistry,
    service,
    logger,
    clock,
  });

  let initialized = false;
  try {
    await service.initialize();
    initialized = true;
    await transport.listen();
  } catch (error) {
    try {
      if (initialized) await service.shutdown();
      else metadata.close();
    } finally {
      appRegistry.close();
    }
    throw error;
  }
  logger.write({ level: "info", event: "host.started" });

  let closing: Promise<void> | null = null;
  return {
    service,
    transport,
    close: () => {
      closing ??= (async () => {
        logger.write({ level: "info", event: "host.stopping" });
        try {
          await transport.close();
          await service.shutdown();
        } finally {
          appRegistry.close();
        }
        logger.write({ level: "info", event: "host.stopped" });
      })();
      return closing;
    },
  };
}
