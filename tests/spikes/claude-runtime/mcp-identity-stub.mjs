#!/usr/bin/env node
/* global process */
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

/**
 * Minimal stdio MCP server for identity-binding spikes. `whoami` reports a short hash of the
 * NARU_SPIKE_AGENT_TOKEN env value this process was started with, plus its pid. The token itself is
 * never printed. Optional NARU_SPIKE_STUB_LOG receives one JSON line per tool call.
 */
const token = process.env.NARU_SPIKE_AGENT_TOKEN ?? "";
const identity =
  token === "" ? "none" : createHash("sha256").update(token).digest("hex").slice(0, 12);

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = request;
  if (id === undefined) return;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "naru-identity-stub", version: "0.0.1" },
      },
    });
  } else if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "whoami",
            description: "Returns the agent identity bound to this MCP server process.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      },
    });
  } else if (method === "tools/call" && params?.name === "whoami") {
    const text = `identity=${identity} pid=${process.pid} ppid=${process.ppid}`;
    const logPath = process.env.NARU_SPIKE_STUB_LOG;
    if (logPath !== undefined && logPath !== "") {
      appendFileSync(
        logPath,
        `${JSON.stringify({ identity, pid: process.pid, ppid: process.ppid, at: Date.now() })}\n`,
      );
    }
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
  } else if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
  } else {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  }
});
