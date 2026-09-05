import { request as httpRequest } from "node:http";
import { AppIdSchema } from "@naru/contracts/durable-session/v0";
import { DurableSessionClientError } from "./errors.js";
import { assertPrivateSocket } from "./node-security.js";
import type {
  DurableSessionOperationEnvelope,
  DurableSessionOperationTransport,
  DurableSessionRequestOptions,
} from "./transport.js";

const DEFAULT_RESPONSE_BYTES = 4 * 1_024 * 1_024;
const DEFAULT_TIMEOUT_MS = 35_000;

export interface UdsHttpDurableSessionTransportOptions {
  readonly socketPath: string;
  readonly appId: string;
  readonly credential: string;
  readonly responseBytes?: number;
  readonly timeoutMs?: number;
}

export class UdsHttpDurableSessionTransport implements DurableSessionOperationTransport {
  readonly #socketPath: string;
  readonly #appId: string;
  readonly #credential: string;
  readonly #responseBytes: number;
  readonly #timeoutMs: number;

  constructor(options: UdsHttpDurableSessionTransportOptions) {
    if (!AppIdSchema.safeParse(options.appId).success) {
      throw new DurableSessionClientError(
        "CLIENT_REQUEST_INVALID",
        "DurableSession app ID is invalid.",
      );
    }
    if (
      options.credential.length < 32 ||
      options.credential.length > 1_024 ||
      /\s/.test(options.credential)
    ) {
      throw new DurableSessionClientError(
        "CREDENTIAL_FILE_INVALID",
        "DurableSession app credential is invalid.",
      );
    }
    this.#socketPath = options.socketPath;
    this.#appId = options.appId;
    this.#credential = options.credential;
    this.#responseBytes = boundedPositiveInteger(
      options.responseBytes ?? DEFAULT_RESPONSE_BYTES,
      "response byte limit",
    );
    this.#timeoutMs = boundedPositiveInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "transport timeout",
    );
  }

  async send(
    envelope: DurableSessionOperationEnvelope,
    options: DurableSessionRequestOptions = {},
  ): Promise<unknown> {
    if (envelope.callerContext.appId !== this.#appId) {
      throw new DurableSessionClientError(
        "CALLER_CONTEXT_INVALID",
        "Caller app binding does not match the transport app ID.",
      );
    }
    if (options.signal?.aborted === true) {
      throw new DurableSessionClientError("REQUEST_ABORTED", "DurableSession request was aborted.");
    }
    assertPrivateSocket(this.#socketPath);
    const body = JSON.stringify(envelope);
    const timeoutMs =
      envelope.request.operation === "waitForEvents"
        ? Math.max(this.#timeoutMs, envelope.request.timeoutMs + 2_000)
        : this.#timeoutMs;

    return await new Promise<unknown>((resolvePromise, rejectPromise) => {
      let settled = false;
      const settleReject = (error: unknown): void => {
        if (settled) return;
        settled = true;
        rejectPromise(normalizeTransportError(error));
      };
      const request = httpRequest(
        {
          socketPath: this.#socketPath,
          method: "POST",
          path: "/v0/operations",
          agent: false,
          headers: {
            authorization: `Bearer ${this.#credential}`,
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body)),
            "x-durable-session-app-id": this.#appId,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.byteLength;
            if (bytes > this.#responseBytes) {
              response.destroy(new ResponseTooLargeError());
              return;
            }
            chunks.push(buffer);
          });
          response.once("error", settleReject);
          response.once("end", () => {
            if (settled) return;
            if (response.statusCode !== 200) {
              settleReject(new HttpStatusError(response.statusCode ?? 0));
              return;
            }
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
              settled = true;
              resolvePromise(value);
            } catch {
              settleReject(new InvalidJsonResponseError());
            }
          });
        },
      );

      const abort = (): void => {
        request.destroy(new RequestAbortedError());
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      request.once("close", () => options.signal?.removeEventListener("abort", abort));
      request.once("error", settleReject);
      request.setTimeout(timeoutMs, () => request.destroy(new RequestTimeoutError()));
      request.end(body);
    });
  }
}

class RequestTimeoutError extends Error {}
class RequestAbortedError extends Error {}
class ResponseTooLargeError extends Error {}
class InvalidJsonResponseError extends Error {}
class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super();
  }
}

function normalizeTransportError(error: unknown): DurableSessionClientError {
  if (error instanceof DurableSessionClientError) return error;
  if (error instanceof RequestTimeoutError) {
    return new DurableSessionClientError(
      "TRANSPORT_TIMEOUT",
      "DurableSession Host request timed out.",
    );
  }
  if (error instanceof RequestAbortedError) {
    return new DurableSessionClientError("REQUEST_ABORTED", "DurableSession request was aborted.");
  }
  if (
    error instanceof ResponseTooLargeError ||
    error instanceof InvalidJsonResponseError ||
    error instanceof HttpStatusError
  ) {
    return new DurableSessionClientError(
      "TRANSPORT_RESPONSE_INVALID",
      "DurableSession Host returned an invalid transport response.",
    );
  }
  return new DurableSessionClientError(
    "TRANSPORT_UNAVAILABLE",
    "DurableSession Host is unavailable.",
    { cause: error },
  );
}

function boundedPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DurableSessionClientError(
      "CLIENT_REQUEST_INVALID",
      `DurableSession ${label} must be a positive integer.`,
    );
  }
  return value;
}
