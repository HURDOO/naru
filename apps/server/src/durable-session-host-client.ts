import { randomUUID } from "node:crypto";
import {
  DURABLE_SESSION_PROTOCOL_VERSION,
  type DurableSessionCallerContext,
  type DurableSessionError,
  type DurableSessionOperationRequest,
  type DurableSessionOperationResult,
} from "@naru/contracts/durable-session/v0";
import { DurableSessionClient, DurableSessionProtocolError } from "@naru/durable-session-client";
import {
  readPrivateCredentialFile,
  UdsHttpDurableSessionTransport,
} from "@naru/durable-session-client/node";
import type { SessionRuntimeConfig } from "./config.js";

const REQUEST_TIMEOUT_MS = 30_000;
const CAPABILITIES = [
  "session:observe",
  "control:request",
  "control:preempt",
  "session:create:profile",
  "session:start",
  "session:stop",
  "session:forget",
  "profile:use",
] as const;

export type DurableHostConfig = Extract<SessionRuntimeConfig, { owner: "durable-host" }>;

export interface DurableSessionLifecycleClient {
  readiness(): Promise<boolean>;
  execute(request: DurableSessionOperationRequest): Promise<DurableSessionOperationResult>;
}

export class DurableSessionHostOperationError extends Error {
  readonly kind = "operation";

  constructor(readonly hostError: DurableSessionError) {
    super(hostError.message);
    this.name = "DurableSessionHostOperationError";
  }
}

/** A transport failure leaves a mutating operation's outcome ambiguous and must be retried. */
export class DurableSessionHostTransportError extends Error {
  readonly kind = "transport";

  constructor() {
    super("DurableSession Host transport is unavailable.");
    this.name = "DurableSessionHostTransportError";
  }
}

export class UdsDurableSessionLifecycleClient implements DurableSessionLifecycleClient {
  readonly #config: DurableHostConfig;

  constructor(config: DurableHostConfig) {
    this.#config = config;
  }

  async readiness(): Promise<boolean> {
    try {
      await this.#client().request({ operation: "listSessions", limit: 1 });
      return true;
    } catch {
      return false;
    }
  }

  async execute(request: DurableSessionOperationRequest): Promise<DurableSessionOperationResult> {
    try {
      return await this.#client().request(request);
    } catch (error) {
      if (error instanceof DurableSessionProtocolError) {
        throw new DurableSessionHostOperationError({
          code: error.code,
          message: error.message,
          ...(error.diagnosticId === undefined ? {} : { diagnosticId: error.diagnosticId }),
        });
      }
      throw new DurableSessionHostTransportError();
    }
  }

  #client(): DurableSessionClient {
    const transport = new UdsHttpDurableSessionTransport({
      socketPath: this.#config.socketPath,
      appId: this.#config.appId,
      credential: this.#credential(),
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    return new DurableSessionClient({
      transport,
      callerContext: () => this.#callerContext(),
    });
  }

  #callerContext(): DurableSessionCallerContext {
    return {
      appId: this.#config.appId,
      subject: this.#config.subject,
      capabilities: [...CAPABILITIES],
      sessionScope: { kind: "all" },
      profileScope: { kind: "ids", ids: [...this.#config.profileIds] },
      rootScope: { kind: "ids", ids: this.#config.roots.map((root) => root.rootId) },
      expiresAtMs: Date.now() + this.#config.callerTtlMs,
    };
  }

  #credential(): string {
    try {
      return readPrivateCredentialFile(this.#config.credentialFile);
    } catch {
      throw new DurableSessionHostTransportError();
    }
  }
}

export function operationRequestBase(): {
  readonly version: typeof DURABLE_SESSION_PROTOCOL_VERSION;
  readonly requestId: string;
} {
  return { version: DURABLE_SESSION_PROTOCOL_VERSION, requestId: randomUUID() };
}
