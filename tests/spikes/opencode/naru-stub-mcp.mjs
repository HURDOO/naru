#!/usr/bin/env node
/* global process */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

/**
 * Minimal stdio MCP server for the V12 spike. Exposes `whoami`, which echoes the env-injected
 * identity tag and records which request metadata (`_meta`) keys OpenCode sends with a call.
 */
const file = process.env.NARU_SPIKE_MCP_LOG;
const tag = process.env.NARU_SPIKE_MCP_TAG ?? "unset";
const log = (record) => {
  if (file)
    appendFileSync(
      file,
      `${JSON.stringify({ t: Date.now(), pid: process.pid, tag, ...record })}\n`,
    );
};
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

log({ event: "start" });
createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "naru-spike-stub", version: "0.0.0" },
      },
    });
  } else if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "whoami",
            description: "Return the identity tag this MCP server process was started with.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      },
    });
  } else if (message.method === "tools/call") {
    log({
      event: "call",
      tool: message.params?.name,
      metaKeys: Object.keys(message.params?._meta ?? {}),
      meta: message.params?._meta ?? null,
    });
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: `NARU_MCP_TAG ${tag}` }] },
    });
  } else if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not supported" } });
  }
});
