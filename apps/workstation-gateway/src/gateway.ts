import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { GatewayAdminServer } from "./admin-server.js";
import { GatewayAppRegistry } from "./app-registry.js";
import { GatewayAssertionIssuer } from "./assertion-issuer.js";
import { buildGatewayBrowserServer } from "./browser-server.js";
import type { WorkstationGatewayConfig } from "./config.js";
import { GatewayRepository } from "./database.js";
import { gatewayVerifierKey, loadOrCreateGatewayKeys, type GatewayKeys } from "./keys.js";
import {
  createGatewayBrowserListener,
  type GatewayBrowserListenerAdapter,
  type GatewayBrowserListenerDependencies,
} from "./listeners/index.js";
import type { GatewayLogger } from "./logging.js";
import { silentGatewayLogger } from "./logging.js";
import { GatewayPasskeyManager, type WebAuthnOperations } from "./passkeys.js";
import { GatewaySessionStore, SystemGatewayClock, type GatewayClock } from "./sessions.js";
import { GatewayWebSocketRegistry } from "./websocket-registry.js";

export interface WorkstationGatewayDependencies {
  readonly clock?: GatewayClock;
  readonly logger?: GatewayLogger;
  readonly webauthn?: WebAuthnOperations;
  readonly browserListener?: GatewayBrowserListenerDependencies;
}

export class WorkstationGateway {
  readonly repository: GatewayRepository;
  readonly keys: GatewayKeys;
  readonly registry: GatewayAppRegistry;
  readonly sessions: GatewaySessionStore;
  readonly passkeys: GatewayPasskeyManager;
  readonly issuer: GatewayAssertionIssuer;
  readonly sockets: GatewayWebSocketRegistry;
  readonly browser: FastifyInstance;
  readonly browserListener: GatewayBrowserListenerAdapter;
  readonly admin: GatewayAdminServer;
  readonly #clock: GatewayClock;
  readonly #logger: GatewayLogger;
  #closed = false;

  private constructor(
    readonly config: WorkstationGatewayConfig,
    browser: FastifyInstance,
    browserListener: GatewayBrowserListenerAdapter,
    components: {
      repository: GatewayRepository;
      keys: GatewayKeys;
      registry: GatewayAppRegistry;
      sessions: GatewaySessionStore;
      passkeys: GatewayPasskeyManager;
      issuer: GatewayAssertionIssuer;
      sockets: GatewayWebSocketRegistry;
      admin: GatewayAdminServer;
      clock: GatewayClock;
      logger: GatewayLogger;
    },
  ) {
    this.repository = components.repository;
    this.keys = components.keys;
    this.registry = components.registry;
    this.sessions = components.sessions;
    this.passkeys = components.passkeys;
    this.issuer = components.issuer;
    this.sockets = components.sockets;
    this.admin = components.admin;
    this.browser = browser;
    this.browserListener = browserListener;
    this.#clock = components.clock;
    this.#logger = components.logger;
  }

  static async create(
    config: WorkstationGatewayConfig,
    dependencies: WorkstationGatewayDependencies = {},
  ): Promise<WorkstationGateway> {
    const clock = dependencies.clock ?? new SystemGatewayClock();
    const logger = dependencies.logger ?? silentGatewayLogger;
    const browserListener = createGatewayBrowserListener(config, dependencies.browserListener);
    const keys = loadOrCreateGatewayKeys(config.dataDirectory);
    const repository = new GatewayRepository(join(config.dataDirectory, "gateway.sqlite"));
    const registry = new GatewayAppRegistry(config.appRegistrations);
    const sessions = new GatewaySessionStore(repository, keys.sessionDigestKey, config, clock);
    const passkeys = new GatewayPasskeyManager(
      repository,
      sessions,
      keys.bootstrapDigestKey,
      keys.ceremonyDigestKey,
      config,
      dependencies.webauthn,
      clock,
      logger,
    );
    const issuer = new GatewayAssertionIssuer(config, keys, clock);
    const sockets = new GatewayWebSocketRegistry(() => clock.nowMs());
    const ready = (): boolean => repository.ping();
    let browser: FastifyInstance;
    try {
      browser = await buildGatewayBrowserServer({
        config,
        registry,
        sessions,
        passkeys,
        issuer,
        sockets,
        logger,
        ready,
        ...(browserListener.httpsOptions === undefined
          ? {}
          : { httpsOptions: browserListener.httpsOptions }),
      });
    } catch (error) {
      repository.close();
      throw error;
    }
    const admin = new GatewayAdminServer({
      config,
      registry,
      passkeys,
      sessions,
      verifierKey: gatewayVerifierKey(keys),
      ready,
      onSessionsRevoked: (sessionIds) => {
        for (const sessionId of sessionIds) sockets.closeSession(sessionId);
      },
    });
    return new WorkstationGateway(config, browser, browserListener, {
      repository,
      keys,
      registry,
      sessions,
      passkeys,
      issuer,
      sockets,
      admin,
      clock,
      logger,
    });
  }

  async listen(): Promise<void> {
    this.#assertOpen();
    await this.admin.listen();
    try {
      await this.browserListener.listen(this.browser);
    } catch (error) {
      await this.admin.close();
      throw error;
    }
    this.#logger.write({ level: "info", event: "gateway.started" });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#logger.write({ level: "info", event: "gateway.stopping" });
    this.sockets.closeAll();
    await this.browser.close();
    await this.admin.close();
    this.repository.close();
    this.#logger.write({ level: "info", event: "gateway.stopped" });
  }

  nowMs(): number {
    return this.#clock.nowMs();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Workstation Gateway is closed.");
  }
}
