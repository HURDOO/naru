import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

type Obj = Record<string, unknown>;
const mailbox = process.env.NARU_STUB_MAILBOX;
const sender = process.env.NARU_STUB_SENDER;
if (!mailbox || !sender) throw new Error("Explicit fixture mailbox and sender required");
process.umask(0o077);
mkdirSync(dirname(mailbox), { recursive: true, mode: 0o700 });
const diagnostic = {
  sender,
  pid: process.pid,
  tokenDigest: createHash("sha256")
    .update(process.env.NARU_STUB_TOKEN ?? "")
    .digest("hex"),
};
appendFileSync(`${mailbox}.processes.jsonl`, `${JSON.stringify(diagnostic)}\n`, { mode: 0o600 });
const send = (value: Obj): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
};
let elicitationCall: unknown;
async function handle(message: Obj): Promise<void> {
  const params = (message.params ?? {}) as Obj;
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "naru_stub", version: "0.1.0" },
      },
    });
  } else if (message.method === "tools/list") {
    send({
      id: message.id,
      result: {
        tools: [
          {
            name: "send_message",
            description:
              "Send an exact fixture message with its original instruction ID to another agent.",
            inputSchema: {
              type: "object",
              properties: {
                to: { type: "string" },
                verbatim: { type: "string" },
                origin_instruction_id: { type: "string" },
              },
              required: ["to", "verbatim", "origin_instruction_id"],
              additionalProperties: false,
            },
          },
          {
            name: "inbox",
            description:
              "Read messages addressed to this agent, preserving sender, verbatim and original instruction ID.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      },
    });
  } else if (message.method === "tools/call") {
    if (process.env.NARU_STUB_ELICIT === "1") {
      elicitationCall = message.id;
      send({
        id: "spike-elicitation",
        method: "elicitation/create",
        params: {
          _meta: { codex_requires_user_input: true },
          message: "Synthetic fixture choice",
          requestedSchema: {
            type: "object",
            properties: { choice: { type: "string", enum: ["Proceed", "Cancel"] } },
            required: ["choice"],
          },
        },
      });
      return;
    }
    const lock = `${mailbox}.lock`;
    let locked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        mkdirSync(lock, { mode: 0o700 });
        locked = true;
        break;
      } catch {
        await delay(20);
      }
    }
    if (!locked) throw new Error("Mailbox busy");
    try {
      const messages = existsSync(mailbox!)
        ? (JSON.parse(readFileSync(mailbox!, "utf8")) as Obj[])
        : [];
      let output: unknown;
      if (params.name === "send_message") {
        const args = (params.arguments ?? {}) as Obj;
        if (
          ![args.to, args.verbatim, args.origin_instruction_id].every(
            (value) => typeof value === "string",
          )
        )
          throw new Error("Invalid message envelope");
        const envelope = {
          id: randomUUID(),
          sender,
          to: args.to,
          verbatim: args.verbatim,
          origin_instruction_id: args.origin_instruction_id,
        };
        messages.push(envelope);
        const temporary = `${mailbox}.${process.pid}.pending`;
        writeFileSync(temporary, JSON.stringify(messages), { mode: 0o600 });
        renameSync(temporary, mailbox!);
        output = envelope;
      } else if (params.name === "inbox")
        output = { messages: messages.filter((message) => message.to === sender), ...diagnostic };
      else throw new Error("Unknown tool");
      send({
        id: message.id,
        result: { content: [{ type: "text", text: JSON.stringify(output) }] },
      });
    } finally {
      // This is a synchronization lock, not cleanup of retained experiment artifacts.
      rmdirSync(lock);
    }
  } else if (message.id === "spike-elicitation") {
    send({
      id: elicitationCall,
      result: { content: [{ type: "text", text: "Synthetic fixture choice handled" }] },
    });
  } else if (message.id !== undefined)
    send({ id: message.id, error: { code: -32601, message: "Unknown method" } });
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line) as Obj;
  void handle(message).catch(() =>
    send({ id: message.id, error: { code: -32603, message: "Fixture operation failed" } }),
  );
});
