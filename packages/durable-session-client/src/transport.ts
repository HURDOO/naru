import type {
  DurableSessionCallerContext,
  DurableSessionOperationRequest,
} from "@naru/contracts/durable-session/v0";

export interface DurableSessionOperationEnvelope {
  readonly callerContext: DurableSessionCallerContext;
  readonly request: DurableSessionOperationRequest;
}

export interface DurableSessionRequestOptions {
  readonly signal?: AbortSignal;
}

export interface DurableSessionOperationTransport {
  send(
    envelope: DurableSessionOperationEnvelope,
    options?: DurableSessionRequestOptions,
  ): Promise<unknown>;
}
