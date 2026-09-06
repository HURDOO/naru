import type { ServerOptions } from "node:https";
import {
  LastKnownGoodTlsMaterialManager,
  validateTlsMaterial,
  type TlsMaterialLifecycleStatus,
  type TlsMaterialReloadResult,
  type TlsMaterialSource,
  type TlsMaterialWatcher,
  type ValidatedTlsMaterial,
} from "@naru/tls-material";
import type { PrivateIngressV0 } from "@naru/contracts/private-ingress/v0";
import type { GatewayLogger } from "../logging.js";

export const DIRECT_PRIVATE_TLS_RELOAD_INTERVAL_MS = 10_000;

export interface DirectPrivateTlsMaterialProvider {
  loadInitial(ingress: PrivateIngressV0): ServerOptions;
  start?(server: unknown): void;
  stop?(): void;
  reloadNow?(): TlsMaterialReloadResult;
  status?(): TlsMaterialLifecycleStatus;
  acceptsNewConnections?(): boolean;
}

export class GatewayDirectTlsMaterialProvider implements DirectPrivateTlsMaterialProvider {
  readonly #ingress: PrivateIngressV0;
  readonly #manager: LastKnownGoodTlsMaterialManager;

  constructor(
    ingress: PrivateIngressV0,
    options: {
      readonly now?: () => number;
      readonly reloadIntervalMs?: number;
      readonly logger?: GatewayLogger;
    } = {},
  ) {
    this.#ingress = ingress;
    const now = options.now ?? Date.now;
    const source = new DirectTlsMaterialSource(
      ingress,
      options.reloadIntervalMs ?? DIRECT_PRIVATE_TLS_RELOAD_INTERVAL_MS,
    );
    this.#manager = new LastKnownGoodTlsMaterialManager(source, {
      now,
      eventSink: (event) => {
        if (event.event === "tls.material.reloaded") {
          options.logger?.write({ level: "info", event: "tls.material.reloaded" });
          return;
        }
        options.logger?.write({
          level: "warn",
          event: "tls.material.reload-rejected",
          ...(event.errorCode === undefined ? {} : { code: event.errorCode }),
        });
      },
    });
  }

  loadInitial(ingress: PrivateIngressV0): ServerOptions {
    if (ingress !== this.#ingress) {
      throw new Error("Direct TLS material provider was used with a different ingress profile.");
    }
    return this.#manager.loadInitial();
  }

  start(server: unknown): void {
    this.#manager.start(server);
  }

  stop(): void {
    this.#manager.stop();
  }

  reloadNow(): TlsMaterialReloadResult {
    return this.#manager.reloadNow();
  }

  status(): TlsMaterialLifecycleStatus {
    return this.#manager.status();
  }

  acceptsNewConnections(): boolean {
    return this.#manager.acceptsNewConnections();
  }
}

class DirectTlsMaterialSource implements TlsMaterialSource {
  constructor(
    private readonly ingress: PrivateIngressV0,
    private readonly reloadIntervalMs: number,
  ) {
    if (!Number.isInteger(reloadIntervalMs) || reloadIntervalMs < 1_000) {
      throw new Error("Direct TLS reload interval is invalid.");
    }
  }

  load(now: number): ValidatedTlsMaterial {
    return validateTlsMaterial(
      {
        approvedRoot: this.ingress.tls.approvedRoot,
        certificateFile: this.ingress.tls.certificateFile,
        privateKeyFile: this.ingress.tls.privateKeyFile,
        serverNames: [new URL(this.ingress.browserOrigin).hostname],
        allowSymlinkReferences: true,
      },
      { now },
    );
  }

  watch(onChange: () => void): TlsMaterialWatcher {
    const timer = setInterval(onChange, this.reloadIntervalMs);
    timer.unref();
    return { close: () => clearInterval(timer) };
  }
}
