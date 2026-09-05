import type {
  DurableSessionCallerContext,
  DurableSessionCapability,
  DurableSessionError,
  DurableSessionOperationRequest,
} from "@naru/contracts/durable-session/v0";

export type DurableSessionAuthorizationDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly error: DurableSessionError };

export function authorizeDurableSessionOperation(
  caller: DurableSessionCallerContext,
  request: DurableSessionOperationRequest,
  nowMs: number,
): DurableSessionAuthorizationDecision {
  if (nowMs >= caller.expiresAtMs)
    return denied("CAPABILITY_REQUIRED", "Caller context has expired.");

  if (request.operation === "createSession") {
    const rootDecision = requireScope(
      caller.rootScope,
      request.command.cwd.rootId,
      "ROOT_BOUNDARY_VIOLATION",
    );
    if (!rootDecision.allowed) return rootDecision;
    if (request.command.kind === "profile") {
      const capabilityDecision = requireCapabilities(caller, [
        "session:create:profile",
        "profile:use",
      ]);
      if (!capabilityDecision.allowed) return capabilityDecision;
      return requireScope(caller.profileScope, request.command.profileId, "COMMAND_POLICY_DENIED");
    }
    return requireCapabilities(caller, ["session:create:arbitrary"]);
  }

  const sessionId = "sessionId" in request ? request.sessionId : undefined;
  if (sessionId !== undefined) {
    const scopeDecision = requireScope(caller.sessionScope, sessionId, "CAPABILITY_REQUIRED");
    if (!scopeDecision.allowed) return scopeDecision;
  }

  return requireCapabilities(caller, requiredCapabilitiesForOperation(request));
}

export function requiredCapabilitiesForOperation(
  request: DurableSessionOperationRequest,
): readonly DurableSessionCapability[] {
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
    case "acquireControl":
    case "requestControl":
    case "approveControl":
    case "rejectControl":
    case "acceptControl":
    case "releaseControl":
    case "sendInput":
    case "resizeTerminal":
      return ["control:request"];
    case "startSession":
      return ["session:start"];
    case "stopSession":
      return ["session:stop"];
    case "forgetSession":
      return ["session:forget"];
    case "preemptControl":
      return ["control:preempt"];
    default:
      return assertNever(request);
  }
}

function requireCapabilities(
  caller: DurableSessionCallerContext,
  required: readonly DurableSessionCapability[],
): DurableSessionAuthorizationDecision {
  const granted = new Set(caller.capabilities);
  const missing = required.find((capability) => !granted.has(capability));
  return missing === undefined
    ? { allowed: true }
    : denied("CAPABILITY_REQUIRED", `Required capability is missing: ${missing}.`);
}

function requireScope(
  scope: { readonly kind: "all" } | { readonly kind: "ids"; readonly ids: readonly string[] },
  id: string,
  code: DurableSessionError["code"],
): DurableSessionAuthorizationDecision {
  return scope.kind === "all" || scope.ids.includes(id)
    ? { allowed: true }
    : denied(code, "Requested resource is outside the caller scope.");
}

function denied(
  code: DurableSessionError["code"],
  message: string,
): DurableSessionAuthorizationDecision {
  return { allowed: false, error: { code, message } };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled DurableSession operation: ${JSON.stringify(value)}`);
}
