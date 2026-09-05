import {
  DURABLE_SESSION_PROTOCOL_VERSION,
  DurableSessionCallerContextSchema,
  DurableSessionOperationRequestSchema,
  DurableSessionOperationResponseSchema,
  type DurableSessionCallerContext,
  type DurableSessionOperationRequest,
  type DurableSessionOperationResult,
  type ProtocolRequestId,
} from "@naru/contracts/durable-session/v0";
import { DurableSessionClientError, DurableSessionProtocolError } from "./errors.js";
import type {
  DurableSessionOperationTransport,
  DurableSessionRequestOptions,
} from "./transport.js";

type Awaitable<T> = T | Promise<T>;

export type DurableSessionClientRequest<
  TRequest extends DurableSessionOperationRequest = DurableSessionOperationRequest,
> = TRequest extends DurableSessionOperationRequest
  ? Omit<TRequest, "version" | "requestId"> & { readonly requestId?: ProtocolRequestId }
  : never;

export type DurableSessionResultFor<
  TOperation extends DurableSessionOperationRequest["operation"],
> = Extract<DurableSessionOperationResult, { readonly operation: TOperation }>;

export type DurableSessionCallerContextProvider = (
  request: DurableSessionOperationRequest,
) => Awaitable<DurableSessionCallerContext>;

export interface DurableSessionClientOptions {
  readonly transport: DurableSessionOperationTransport;
  readonly callerContext: DurableSessionCallerContext | DurableSessionCallerContextProvider;
  readonly requestId?: () => ProtocolRequestId;
}

export class DurableSessionClient {
  readonly #transport: DurableSessionOperationTransport;
  readonly #callerContext: DurableSessionCallerContext | DurableSessionCallerContextProvider;
  readonly #requestId: () => ProtocolRequestId;

  constructor(options: DurableSessionClientOptions) {
    this.#transport = options.transport;
    this.#callerContext = options.callerContext;
    this.#requestId = options.requestId ?? defaultRequestId;
  }

  async request<const TRequest extends DurableSessionClientRequest>(
    input: TRequest,
    options?: DurableSessionRequestOptions,
  ): Promise<DurableSessionResultFor<TRequest["operation"]>> {
    const parsedRequest = DurableSessionOperationRequestSchema.safeParse({
      ...input,
      version: DURABLE_SESSION_PROTOCOL_VERSION,
      requestId: input.requestId ?? this.#requestId(),
    });
    if (!parsedRequest.success) {
      throw new DurableSessionClientError(
        "CLIENT_REQUEST_INVALID",
        "DurableSession request did not match public protocol v0.",
      );
    }

    const providedCaller =
      typeof this.#callerContext === "function"
        ? await this.#callerContext(parsedRequest.data)
        : this.#callerContext;
    const parsedCaller = DurableSessionCallerContextSchema.safeParse(providedCaller);
    if (!parsedCaller.success) {
      throw new DurableSessionClientError(
        "CALLER_CONTEXT_INVALID",
        "DurableSession caller context did not match public protocol v0.",
      );
    }

    const rawResponse = await this.#transport.send(
      { callerContext: parsedCaller.data, request: parsedRequest.data },
      options,
    );
    const parsedResponse = DurableSessionOperationResponseSchema.safeParse(rawResponse);
    if (!parsedResponse.success) {
      throw new DurableSessionClientError(
        "TRANSPORT_RESPONSE_INVALID",
        "Host response did not match public protocol v0.",
      );
    }
    if (parsedResponse.data.requestId !== parsedRequest.data.requestId) {
      throw new DurableSessionClientError(
        "PROTOCOL_RESPONSE_MISMATCH",
        "Host response request ID did not match the request.",
      );
    }
    if (!parsedResponse.data.ok) {
      throw new DurableSessionProtocolError(
        parsedResponse.data.requestId,
        parsedResponse.data.error,
      );
    }
    if (parsedResponse.data.result.operation !== parsedRequest.data.operation) {
      throw new DurableSessionClientError(
        "PROTOCOL_RESPONSE_MISMATCH",
        "Host response operation did not match the request.",
      );
    }

    return parsedResponse.data.result as DurableSessionResultFor<TRequest["operation"]>;
  }
}

function defaultRequestId(): ProtocolRequestId {
  return globalThis.crypto.randomUUID();
}
