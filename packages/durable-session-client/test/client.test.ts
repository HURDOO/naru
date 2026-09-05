import type {
  DurableSessionCallerContext,
  DurableSessionOperationRequest,
  DurableSessionOperationResponse,
  ProtocolRequestId,
} from "@naru/contracts/durable-session/v0";
import { describe, expect, it } from "vitest";
import { DurableSessionClient } from "../src/client.js";
import { DurableSessionProtocolError } from "../src/errors.js";
import type { DurableSessionClientError } from "../src/errors.js";
import type {
  DurableSessionOperationEnvelope,
  DurableSessionOperationTransport,
} from "../src/transport.js";

const REQUEST_ID = "70000000-0000-4000-8000-000000000001" as ProtocolRequestId;
const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const RUNTIME_ID = "20000000-0000-4000-8000-000000000001";

describe("DurableSessionClient", () => {
  it("validates and correlates a typed public operation", async () => {
    const transport = new FixtureTransport((envelope) =>
      success(envelope.request, {
        operation: "listSessions",
        sessions: [sessionView()],
        nextCursor: null,
      }),
    );
    const client = fixtureClient(transport);

    const result = await client.request({ operation: "listSessions", limit: 5 });

    expect(result.operation).toBe("listSessions");
    expect(result.sessions[0]?.sessionId).toBe(SESSION_ID);
    expect(transport.envelopes[0]).toMatchObject({
      callerContext: { appId: "fixture-app" },
      request: { version: 0, requestId: REQUEST_ID, operation: "listSessions", limit: 5 },
    });
  });

  it("turns public failures into stable protocol errors", async () => {
    const transport = new FixtureTransport((envelope) => ({
      version: 0,
      requestId: envelope.request.requestId,
      ok: false,
      error: { code: "SESSION_NOT_FOUND", message: "Session was not found." },
    }));
    const client = fixtureClient(transport);

    const error = await client
      .request({ operation: "getSession", sessionId: SESSION_ID })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DurableSessionProtocolError);
    expect(error).toMatchObject({ code: "SESSION_NOT_FOUND", requestId: REQUEST_ID });
  });

  it("rejects invalid requests and mismatched responses without leaking raw payloads", async () => {
    const unused = new FixtureTransport(() => {
      throw new Error("transport should not be called");
    });
    const client = fixtureClient(unused);

    const invalid = await client
      .request({ operation: "listSessions", limit: 0 })
      .catch((caught: unknown) => caught);
    expect(invalid).toMatchObject({ code: "CLIENT_REQUEST_INVALID" });
    expect(unused.envelopes).toHaveLength(0);

    const mismatch = fixtureClient(
      new FixtureTransport(() => ({
        version: 0,
        requestId: "70000000-0000-4000-8000-000000000002",
        ok: true,
        result: { operation: "listSessions", sessions: [], nextCursor: null },
      })),
    );
    await expect(mismatch.request({ operation: "listSessions", limit: 1 })).rejects.toMatchObject({
      code: "PROTOCOL_RESPONSE_MISMATCH",
    });
  });

  it("rejects an invalid caller context before transport", async () => {
    const transport = new FixtureTransport(() => {
      throw new Error("transport should not be called");
    });
    const client = new DurableSessionClient({
      transport,
      callerContext: { ...caller(), expiresAtMs: -1 },
      requestId: () => REQUEST_ID,
    });

    await expect(client.request({ operation: "listSessions", limit: 1 })).rejects.toEqual(
      expect.objectContaining<Partial<DurableSessionClientError>>({
        code: "CALLER_CONTEXT_INVALID",
      }),
    );
    expect(transport.envelopes).toHaveLength(0);
  });
});

class FixtureTransport implements DurableSessionOperationTransport {
  readonly envelopes: DurableSessionOperationEnvelope[] = [];

  constructor(readonly respond: (envelope: DurableSessionOperationEnvelope) => unknown) {}

  async send(envelope: DurableSessionOperationEnvelope): Promise<unknown> {
    this.envelopes.push(envelope);
    return await this.respond(envelope);
  }
}

function fixtureClient(transport: DurableSessionOperationTransport): DurableSessionClient {
  return new DurableSessionClient({
    transport,
    callerContext: caller(),
    requestId: () => REQUEST_ID,
  });
}

function caller(): DurableSessionCallerContext {
  return {
    appId: "fixture-app",
    subject: "fixture-owner",
    capabilities: ["session:observe"],
    sessionScope: { kind: "all" },
    profileScope: { kind: "ids", ids: ["fixture-profile"] },
    rootScope: { kind: "ids", ids: ["fixture-root"] },
    expiresAtMs: 4_000_000_000_000,
  };
}

function success(
  request: DurableSessionOperationRequest,
  result: Extract<DurableSessionOperationResponse, { readonly ok: true }>["result"],
): DurableSessionOperationResponse {
  return { version: 0, requestId: request.requestId, ok: true, result };
}

function sessionView() {
  return {
    sessionId: SESSION_ID,
    lifecycle: "running" as const,
    sessionRevision: 1,
    runtimeId: RUNTIME_ID,
    terminal: { cols: 80, rows: 24 },
    controllerAttachmentId: null,
    controllerGeneration: 0,
    nextSequence: 0,
    command: { kind: "profile" as const, profileId: "fixture-profile", rootId: "fixture-root" },
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}
