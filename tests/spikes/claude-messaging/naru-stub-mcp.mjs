#!/usr/bin/env node
/* global process */
// Minimal stdio MCP server (newline-delimited JSON-RPC 2.0, no SDK) standing in for Naru-managed
// messaging. The sender identity comes only from the per-session token in the server's env, never
// from tool arguments. Messages are kept in an owner-only JSON file outside the repository.
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";

const storePath = process.env.NARU_STUB_STORE;
const registryPath = process.env.NARU_STUB_REGISTRY;
const sessionToken = process.env.NARU_STUB_SESSION_TOKEN;

function boundIdentity() {
  if (!registryPath || !sessionToken || !existsSync(registryPath)) return null;
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  return registry.tokens?.[sessionToken] ?? null;
}

function withStore(mutate) {
  const lock = `${storePath}.lock`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      break;
    } catch {
      if (attempt > 200) throw new Error("store lock timeout");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    const store = existsSync(storePath)
      ? JSON.parse(readFileSync(storePath, "utf8"))
      : { messages: [], calls: [] };
    const result = mutate(store);
    writeFileSync(`${storePath}.tmp`, JSON.stringify(store, null, 2), { mode: 0o600 });
    renameSync(`${storePath}.tmp`, storePath);
    return result;
  } finally {
    rmSync(lock, { force: true });
  }
}

const TOOLS = [
  {
    name: "send_message",
    description:
      "Send a message to another Naru-managed agent. The sender is bound by Naru; do not pass it.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient agent ID" },
        verbatim: { type: "string", description: "Exact message text" },
        origin_instruction_id: { type: "string", description: "Original user instruction ID" },
      },
      required: ["to", "verbatim", "origin_instruction_id"],
      additionalProperties: false,
    },
  },
  {
    name: "inbox",
    description: "Read and acknowledge messages addressed to this agent.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function text(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError } : {}),
  };
}

function callTool(name, args) {
  const identity = boundIdentity();
  const record = (outcome) =>
    withStore((store) => {
      store.calls.push({
        at: new Date().toISOString(),
        identity,
        tool: name,
        argKeys: Object.keys(args ?? {}).sort(),
        outcome,
      });
    });
  if (identity === null) {
    record("unbound");
    return text({ error: "NARU_STUB_UNBOUND_SESSION" }, true);
  }
  if (name === "send_message") {
    const allowed = new Set(["to", "verbatim", "origin_instruction_id"]);
    const unexpected = Object.keys(args ?? {}).filter((key) => !allowed.has(key));
    if (unexpected.length > 0) {
      record(`rejected-unexpected:${unexpected.join(",")}`);
      return text({ error: "NARU_STUB_UNEXPECTED_FIELD", fields: unexpected }, true);
    }
    for (const key of allowed) {
      if (typeof args[key] !== "string" || args[key] === "") {
        record(`rejected-missing:${key}`);
        return text({ error: "NARU_STUB_INVALID_FIELD", field: key }, true);
      }
    }
    const message = {
      id: randomUUID(),
      from: identity,
      to: args.to,
      verbatim: args.verbatim,
      origin_instruction_id: args.origin_instruction_id,
      created_at: new Date().toISOString(),
      delivered_at: null,
    };
    withStore((store) => store.messages.push(message));
    record("sent");
    return text({ ok: true, message_id: message.id, from: identity });
  }
  if (name === "inbox") {
    const delivered = withStore((store) => {
      const now = new Date().toISOString();
      const mine = store.messages.filter((m) => m.to === identity && m.delivered_at === null);
      for (const message of mine) message.delivered_at = now;
      return mine.map(({ id, from, verbatim, origin_instruction_id, created_at }) => ({
        id,
        from,
        verbatim,
        origin_instruction_id,
        created_at,
      }));
    });
    record(`inbox:${delivered.length}`);
    return text({ messages: delivered });
  }
  return text({ error: "NARU_STUB_UNKNOWN_TOOL" }, true);
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = request;
  if (id === undefined) return; // notifications
  if (method === "initialize") {
    withStore((store) => {
      store.calls.push({
        at: new Date().toISOString(),
        identity: boundIdentity(),
        tool: "initialize",
        requestedProtocolVersion: params?.protocolVersion ?? null,
      });
    });
    respond(id, {
      // The stub implements only this revision; the client may still request a newer one.
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "naru-stub", version: "0.0.1" },
    });
  } else if (method === "tools/list") {
    respond(id, { tools: TOOLS });
  } else if (method === "tools/call") {
    respond(id, callTool(params?.name, params?.arguments ?? {}));
  } else if (method === "ping") {
    respond(id, {});
  } else {
    fail(id, -32601, "Method not found");
  }
});
