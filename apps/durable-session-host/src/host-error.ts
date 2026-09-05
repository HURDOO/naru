import type {
  DurableSessionError,
  DurableSessionErrorCode,
} from "@naru/contracts/durable-session/v0";

export class HostOperationError extends Error {
  constructor(
    readonly code: DurableSessionErrorCode,
    message: string,
    readonly diagnosticId?: string,
  ) {
    super(message);
    this.name = "HostOperationError";
  }

  toDurableSessionError(): DurableSessionError {
    return {
      code: this.code,
      message: this.message,
      ...(this.diagnosticId === undefined ? {} : { diagnosticId: this.diagnosticId }),
    };
  }
}

export function fromDurableSessionError(error: DurableSessionError): HostOperationError {
  return new HostOperationError(error.code, error.message, error.diagnosticId);
}
