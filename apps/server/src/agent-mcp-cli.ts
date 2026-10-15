import { createInterface } from "node:readline";
import {
  callAgentSocket,
  NARU_AGENT_CAPABILITY_ENV,
  NARU_AGENT_SOCKET_ENV,
} from "./agent-platform/agent-socket.js";
import { mcpToolDefinitions } from "./agent-platform/tools.js";

/**
 * stdio MCP server that Naru injects into the agent sessions it launches (AP-D004). It holds no
 * state and no authority of its own: every call is forwarded with this session's capability.
 */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

const socketPath = process.env[NARU_AGENT_SOCKET_ENV];
const capability = process.env[NARU_AGENT_CAPABILITY_ENV];
const tools = mcpToolDefinitions();
// Only advertised tools are forwarded; hook-only socket tools stay unreachable from MCP.
const advertised = new Set(tools.map((tool) => tool.name));

interface JsonRpcRequest {
  readonly id?: string | number | null;
  readonly method?: unknown;
  readonly params?: {
    readonly protocolVersion?: unknown;
    readonly name?: unknown;
    readonly arguments?: unknown;
  };
}

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toolResult(value: unknown, isError: boolean) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function callTool(name: unknown, args: unknown) {
  if (socketPath === undefined || capability === undefined) {
    return toolResult({ code: "UNAVAILABLE", message: "This session has no Naru binding." }, true);
  }
  if (typeof name !== "string" || !advertised.has(name)) {
    return toolResult({ code: "UNKNOWN_TOOL", message: "No such Naru tool." }, true);
  }
  const argumentsObject =
    typeof args === "object" && args !== null && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  try {
    const reply = await callAgentSocket(socketPath, {
      version: 1,
      capability,
      tool: name,
      arguments: argumentsObject,
    });
    return reply.ok ? toolResult(reply.result, false) : toolResult(reply, true);
  } catch (error) {
    return toolResult(
      {
        code: "UNAVAILABLE",
        message: error instanceof Error ? error.message : "Naru is unavailable.",
      },
      true,
    );
  }
}

async function handle(request: JsonRpcRequest): Promise<void> {
  if (request.id === undefined || request.id === null) return; // notifications
  const { id } = request;
  switch (request.method) {
    case "initialize": {
      const requested = request.params?.protocolVersion;
      write({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion:
            typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
              ? requested
              : DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "naru", version: "1.0.0" },
          instructions:
            "Naru records the user's verbatim instructions and your delegations. Read the " +
            "applicable user instructions before planning, cite origin instruction IDs, ask the " +
            "human through request_human_handoff instead of guessing, and never type secrets.",
        },
      });
      return;
    }
    case "tools/list":
      write({ jsonrpc: "2.0", id, result: { tools } });
      return;
    case "tools/call":
      write({
        jsonrpc: "2.0",
        id,
        result: await callTool(request.params?.name, request.params?.arguments),
      });
      return;
    case "ping":
      write({ jsonrpc: "2.0", id, result: {} });
      return;
    default:
      write({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  void handle(request);
});
