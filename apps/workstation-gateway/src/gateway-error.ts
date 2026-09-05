import { randomUUID } from "node:crypto";
import type { GatewayBrowserErrorCode } from "@naru/contracts/workstation-gateway/v1";

export type GatewayErrorCode = GatewayBrowserErrorCode;

export class GatewayError extends Error {
  readonly diagnosticId: string | undefined;

  constructor(
    readonly code: GatewayErrorCode,
    readonly statusCode: number,
    message: string,
    diagnosticId?: string,
  ) {
    super(message);
    this.name = "GatewayError";
    this.diagnosticId = diagnosticId;
  }
}

export function internalGatewayError(): GatewayError {
  return new GatewayError(
    "INTERNAL_ERROR",
    500,
    "Workstation Gateway request failed.",
    randomUUID(),
  );
}
