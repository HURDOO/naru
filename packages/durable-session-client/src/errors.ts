import type { DurableSessionError, ProtocolRequestId } from "@naru/contracts/durable-session/v0";

export type DurableSessionClientErrorCode =
  | "CLIENT_REQUEST_INVALID"
  | "CALLER_CONTEXT_INVALID"
  | "TRANSPORT_UNAVAILABLE"
  | "TRANSPORT_TIMEOUT"
  | "REQUEST_ABORTED"
  | "TRANSPORT_RESPONSE_INVALID"
  | "PROTOCOL_RESPONSE_MISMATCH"
  | "STREAM_QUEUE_OVERFLOW"
  | "PRIVATE_ENDPOINT_INVALID"
  | "CREDENTIAL_FILE_INVALID"
  | "PRIVATE_INPUT_INVALID";

export class DurableSessionClientError extends Error {
  readonly name = "DurableSessionClientError";

  constructor(
    readonly code: DurableSessionClientErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class DurableSessionProtocolError extends Error {
  readonly name = "DurableSessionProtocolError";
  readonly code: DurableSessionError["code"];
  readonly diagnosticId: string | undefined;

  constructor(
    readonly requestId: ProtocolRequestId,
    error: DurableSessionError,
  ) {
    super(error.message);
    this.code = error.code;
    this.diagnosticId = error.diagnosticId;
  }
}

export class DurableSessionStreamProtocolError extends Error {
  readonly name = "DurableSessionStreamProtocolError";
  readonly code: DurableSessionError["code"];
  readonly diagnosticId: string | undefined;

  constructor(error: DurableSessionError) {
    super(error.message);
    this.code = error.code;
    this.diagnosticId = error.diagnosticId;
  }
}
