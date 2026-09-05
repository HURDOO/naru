import type {
  DurableSessionCallerContext,
  DurableSessionCapability,
  DurableSessionOperationRequest,
} from "@naru/contracts/durable-session/v0";
import type { CliCommand, CliConnectionOptions } from "./arguments.js";

const MINIMUM_CALLER_TTL_MS = 10_000;
const CALLER_RESPONSE_SLACK_MS = 5_000;

export function callerContextForRequest(
  connection: CliConnectionOptions,
  request: DurableSessionOperationRequest,
  nowMs: number,
): DurableSessionCallerContext {
  const requestSessionId = "sessionId" in request ? request.sessionId : undefined;
  const sessionScope =
    requestSessionId === undefined
      ? { kind: "all" as const }
      : { kind: "ids" as const, ids: [requestSessionId] };
  const profileScope =
    request.operation === "createSession" && request.command.kind === "profile"
      ? { kind: "ids" as const, ids: [request.command.profileId] }
      : { kind: "all" as const };
  const rootScope =
    request.operation === "createSession"
      ? { kind: "ids" as const, ids: [request.command.cwd.rootId] }
      : { kind: "all" as const };
  return {
    appId: connection.appId,
    subject: connection.subject,
    capabilities: capabilitiesForRequest(request),
    sessionScope,
    profileScope,
    rootScope,
    expiresAtMs:
      nowMs +
      Math.max(
        connection.callerTtlMs,
        request.operation === "waitForEvents"
          ? request.timeoutMs + CALLER_RESPONSE_SLACK_MS
          : MINIMUM_CALLER_TTL_MS,
      ),
  };
}

export function callerContextForInteractiveSession(
  connection: CliConnectionOptions,
  command: Extract<CliCommand, { readonly name: "attach" | "control" }>,
  nowMs: number,
): DurableSessionCallerContext {
  return {
    appId: connection.appId,
    subject: connection.subject,
    capabilities: [
      "session:observe",
      "control:request",
      ...(command.name === "control" ? (["control:preempt"] as const) : []),
    ],
    sessionScope: { kind: "ids", ids: [command.sessionId] },
    profileScope: { kind: "all" },
    rootScope: { kind: "all" },
    expiresAtMs: nowMs + connection.callerTtlMs,
  };
}

function capabilitiesForRequest(
  request: DurableSessionOperationRequest,
): DurableSessionCapability[] {
  if (request.operation === "createSession") {
    return request.command.kind === "profile"
      ? ["session:create:profile", "profile:use"]
      : ["session:create:arbitrary"];
  }
  switch (request.operation) {
    case "listSessions":
    case "getSession":
    case "openAttachment":
    case "resumeAttachment":
    case "closeAttachment":
    case "requestSnapshot":
    case "resyncAttachment":
    case "readEvents":
    case "waitForEvents":
      return ["session:observe"];
    case "startSession":
      return ["session:start"];
    case "stopSession":
      return ["session:stop"];
    case "forgetSession":
      return ["session:forget"];
    case "preemptControl":
      return ["control:preempt"];
    case "acquireControl":
    case "requestControl":
    case "approveControl":
    case "rejectControl":
    case "acceptControl":
    case "releaseControl":
    case "sendInput":
    case "resizeTerminal":
      return ["control:request"];
  }
}
