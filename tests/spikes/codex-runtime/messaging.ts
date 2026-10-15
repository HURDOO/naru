import { frameText } from "./harness.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appServer,
  arr,
  fakeEnvironment,
  obj,
  raw,
  Rpc,
  setup,
  startThread,
  str,
  summary,
  turn,
  type Frame,
  type Obj,
} from "./harness.js";

const real = process.argv.includes("--real");
if (real && process.env.NARU_SPIKE_REAL_MODEL !== "1")
  throw new Error("Set NARU_SPIKE_REAL_MODEL=1");
const directory = setup(real ? "messaging-real" : "messaging-fake");
const mailbox = join(directory, "mailbox.json");
const stub = {
  command: process.execPath,
  args: [
    "--import",
    import.meta.resolve("tsx"),
    fileURLToPath(new URL("./naru-stub.ts", import.meta.url)),
  ],
};
const configFor = (sender: string): Obj => ({
  "features.multi_agent": false,
  "mcp_servers.naru_stub": {
    ...stub,
    env: { NARU_STUB_MAILBOX: mailbox, NARU_STUB_SENDER: sender, NARU_STUB_TOKEN: randomUUID() },
  },
});
const fixture = real ? undefined : await fakeEnvironment(directory);
const app = await appServer(
  directory,
  fixture?.env ?? process.env,
  real ? ["-c", "mcp_servers={}", "-c", "features.multi_agent=false"] : [],
);
const rpc = await Rpc.connect(app.socket, directory, "messaging");
rpc.socket.on("message", (data) => {
  const frame = JSON.parse(frameText(data)) as Frame;
  if (frame.method === "mcpServer/elicitation/request" && frame.params?.serverName === "naru_stub")
    rpc.send({ id: frame.id!, result: { action: "accept", content: {} } });
});
const results: Obj = {};
async function tool(threadId: string, name: string, args: Obj = {}): Promise<Obj> {
  const result = await rpc.call("mcpServer/tool/call", {
    threadId,
    server: "naru_stub",
    tool: name,
    arguments: args,
  });
  if (result.isError) throw new Error("MCP tool error");
  return JSON.parse(str(obj(arr(result.content)[0]).text)) as Obj;
}
try {
  const a = await startThread(rpc, {
    config: configFor("agent-a"),
    developerInstructions:
      "Only use the naru_stub MCP tools for this bounded messaging experiment. No shell, files, network or other tools.",
  });
  const b = await startThread(rpc, {
    config: configFor("agent-b"),
    developerInstructions:
      "Only use the naru_stub MCP tools for this bounded messaging experiment. Preserve the exact envelope fields.",
  });
  const aInbox = await tool(a, "inbox");
  const bInbox = await tool(b, "inbox");
  results.threadConfigAccepted = true;
  results.distinctMcpProcesses = aInbox.pid !== bInbox.pid;
  results.distinctThreadEnv =
    aInbox.sender === "agent-a" &&
    bInbox.sender === "agent-b" &&
    aInbox.tokenDigest !== bInbox.tokenDigest;
  if (real) {
    const forward = await turn(
      rpc,
      a,
      '[naru-spike] Call naru_stub.send_message once with to="agent-b", verbatim="SPIKE_EXACT_MESSAGE_α\\nsecond line", origin_instruction_id="instruction-fixture-001". Copy those literal field values exactly, then stop.',
      120_000,
    );
    results.senderTurnStatus = obj(forward.params?.turn).status;
    const reply = await turn(
      rpc,
      b,
      "[naru-spike] Call naru_stub.inbox, then send the received message back to agent-a with naru_stub.send_message. Copy verbatim and origin_instruction_id exactly from the inbox result; do not summarize. Then stop.",
      120_000,
    );
    results.recipientTurnStatus = obj(reply.params?.turn).status;
  } else {
    await tool(a, "send_message", {
      to: "agent-b",
      verbatim: "SPIKE_EXACT_MESSAGE_α\nsecond line",
      origin_instruction_id: "instruction-fixture-001",
    });
    const inbox = await tool(b, "inbox");
    const message = obj(arr(inbox.messages)[0]);
    await tool(b, "send_message", {
      to: "agent-a",
      verbatim: message.verbatim,
      origin_instruction_id: message.origin_instruction_id,
    });
  }
  const finalA = await tool(a, "inbox");
  const finalB = await tool(b, "inbox");
  const outbound = obj(arr(finalB.messages)[0]);
  const inbound = obj(arr(finalA.messages)[0]);
  results.roundTrip = outbound.sender === "agent-a" && inbound.sender === "agent-b";
  results.verbatimPreserved =
    typeof outbound.verbatim === "string" && outbound.verbatim === inbound.verbatim;
  results.instructionIdPreserved =
    outbound.origin_instruction_id === "instruction-fixture-001" &&
    inbound.origin_instruction_id === outbound.origin_instruction_id;
  results.mcpProcessCount = readFileSync(`${mailbox}.processes.jsonl`, "utf8")
    .trim()
    .split("\n").length;
  results.toolCallsObserved = rpc.frames.filter(
    (frame) => frame.method === "item/completed" && obj(frame.params?.item).type === "mcpToolCall",
  ).length;
  if (!real) {
    const sharedConfig = configFor("same-config");
    const c = await startThread(rpc, { config: sharedConfig });
    const d = await startThread(rpc, { config: sharedConfig });
    const cInbox = await tool(c, "inbox");
    const dInbox = await tool(d, "inbox");
    results.identicalConfigStillSeparateProcesses =
      cInbox.pid !== dInbox.pid && cInbox.tokenDigest === dInbox.tokenDigest;
  }
} catch (error) {
  raw(directory, "failure.txt", error instanceof Error ? error.stack : String(error));
  results.failure = String(error);
  process.exitCode = 1;
} finally {
  rpc.close();
  await app.close();
  await fixture?.close();
  summary(directory, results);
}
