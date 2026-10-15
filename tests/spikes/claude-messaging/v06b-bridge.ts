// V06b: native Claude↔Claude messaging governed by a Naru bridge (sender PreToolUse authorizes and
// records; receiver UserPromptSubmit verifies against the record and the sender's PID). The bridge
// here is an in-process stub of the future Naru endpoint. Every target outside the spike sessions is
// refused before the bridge is asked, so the user's real sessions are never messaged.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ClaudeSpikeProcess, toolResults, toolUses, type StreamEvent } from "./claude-process.js";
import { spikeSettings } from "./hook-settings.js";
import { nodeCommand, runDirectory } from "./spike-env.js";

interface Member {
  readonly agentId: string;
  readonly name: string;
  pid?: number | undefined;
}
interface Record_ {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly body: string;
  status: "authorized" | "delivered";
}

const run = runDirectory("v06b");
const socketDirectory = mkdtempSync("/private/tmp/naru-bridge-");
const socketPath = join(socketDirectory, "b.sock");
const members = new Map<string, Member>([
  [randomUUID(), { agentId: "agent-a", name: "naru-spike-bridge-a" }],
  [randomUUID(), { agentId: "agent-b", name: "naru-spike-bridge-b" }],
]);
const tokenOf = (agentId: string) =>
  [...members.entries()].find(([, member]) => member.agentId === agentId)![0];
const held = new Set<string>();
const records: Record_[] = [];
const decisions: { type: string; allow: boolean; reason?: string }[] = [];

function handle(request: {
  type?: string;
  capability?: string;
  to?: string;
  message?: string;
  prompt?: string;
}) {
  const caller = members.get(request.capability ?? "");
  if (caller === undefined) return { allow: false, reason: "unknown Naru capability" };
  if (request.type === "authorize") {
    const recipient = [...members.values()].find((member) => member.name === request.to);
    if (recipient === undefined) return { allow: false, reason: "not a Naru-managed session" };
    if (held.has(recipient.agentId)) {
      return { allow: false, reason: "AGENT_HELD_BY_HUMAN: a person is working with this agent" };
    }
    records.push({
      id: randomUUID(),
      from: caller.agentId,
      to: recipient.agentId,
      body: String(request.message ?? "").trim(),
      status: "authorized",
    });
    return { allow: true };
  }
  if (request.type === "deliver") {
    const prompt = String(request.prompt ?? "");
    const pid = Number(/from="uds:[^"]*?(\d+)\.sock"/u.exec(prompt)?.[1] ?? Number.NaN);
    const body = prompt
      .replace(/^<cross-session-message[^>]*>\s*/u, "")
      .replace(/\s*<\/cross-session-message>\s*$/u, "")
      .trim();
    const record = records.find(
      (entry) =>
        entry.status === "authorized" &&
        entry.to === caller.agentId &&
        body.includes(entry.body) &&
        [...members.values()].find((member) => member.agentId === entry.from)?.pid === pid,
    );
    if (record === undefined) return { allow: false, reason: "no authorized Naru record" };
    record.status = "delivered";
    return { allow: true };
  }
  return { allow: false, reason: "unknown request" };
}

const server: Server = createServer((connection) => {
  let buffer = "";
  connection.on("data", (data) => {
    buffer += data.toString("utf8");
    const newline = buffer.indexOf("\n");
    if (newline === -1) return;
    const request = JSON.parse(buffer.slice(0, newline)) as Parameters<typeof handle>[0];
    const decision = handle(request);
    decisions.push({ type: String(request.type), ...decision });
    connection.end(JSON.stringify(decision));
  });
});
await new Promise<void>((done) => server.listen(socketPath, done));

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
function bridgeSettings(token: string, inbound: "accept" | "refuse") {
  const command = [
    `NARU_BRIDGE_SOCKET=${quote(socketPath)}`,
    `NARU_BRIDGE_CAPABILITY=${quote(token)}`,
    `NARU_BRIDGE_HOOK_LOG=${quote(resolve(run, "bridge-hooks.jsonl"))}`,
    nodeCommand("bridge-hook.mjs"),
  ].join(" ");
  return {
    crossSessionInbound: inbound,
    hooks: {
      PreToolUse: [{ matcher: "SendMessage", hooks: [{ type: "command", command }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command }] }],
    },
  };
}

const processes: ClaudeSpikeProcess[] = [];
const start = (options: ConstructorParameters<typeof ClaudeSpikeProcess>[0]) => {
  const child = new ClaudeSpikeProcess(options);
  processes.push(child);
  return child;
};
const resultTexts = (events: readonly StreamEvent[]) =>
  events
    .filter((event) => event.type === "result")
    .map((event) => (typeof event.result === "string" ? event.result : ""));
const sendResult = (child: ClaudeSpikeProcess, marker: string): string => {
  const use = toolUses(child.events).find(
    (entry) => entry.name === "SendMessage" && JSON.stringify(entry.input).includes(marker),
  );
  return use === undefined ? "no-send" : (toolResults(child.events).get(use.id) ?? "no-result");
};

const summary: Record<string, unknown> = {};
try {
  const a = start({
    name: "naru-spike-bridge-a",
    runDirectory: run,
    settings: bridgeSettings(tokenOf("agent-a"), "refuse"),
  });
  const b = start({
    name: "naru-spike-bridge-b",
    runDirectory: run,
    settings: bridgeSettings(tokenOf("agent-b"), "accept"),
  });
  const c = start({
    name: "naru-spike-bridge-c",
    runDirectory: run,
    // Unmanaged sender: no bridge hook, only a guard that allows targeting the spike receiver.
    settings: spikeSettings({
      role: "naru-spike-bridge-c",
      runDirectory: run,
      inbound: "refuse",
      sendAllow: "^naru-spike-bridge-b$",
    }),
  });
  members.get(tokenOf("agent-a"))!.pid = a.pid;
  members.get(tokenOf("agent-b"))!.pid = b.pid;

  b.send(
    "[naru-spike] You are naru-spike-bridge-b, a receiver in an automated messaging test. Reply " +
      "READY now. When a message from another session arrives, reply exactly ACK: followed by its " +
      "first line. Never send messages yourself.",
  );
  a.send("[naru-spike] You are naru-spike-bridge-a in an automated messaging test. Reply READY.");
  c.send("[naru-spike] You are naru-spike-bridge-c in an automated messaging test. Reply READY.");
  await Promise.all([
    a.waitForResults(1, 120_000),
    b.waitForResults(1, 120_000),
    c.waitForResults(1, 120_000),
  ]);
  const sendTo = (child: ClaudeSpikeProcess, target: string, text: string) =>
    child.send(
      `Use the SendMessage tool exactly once to send this exact message to the session named ${target}: ` +
        `"${text}". Do not retry if it is denied. Then reply DONE.`,
    );

  // 1. Managed → managed: authorized, recorded, delivered and acted on.
  sendTo(a, "naru-spike-bridge-b", "BRIDGE-PING-1");
  await a.waitForResults(2, 180_000);
  await b.waitFor(
    (events) => resultTexts(events).some((text) => text.includes("BRIDGE-PING-1")),
    120_000,
    "ack1",
  );
  const first = records.find((record) => record.body.includes("BRIDGE-PING-1"));
  const origin = b.events
    .filter((event) => event.type === "result")
    .map((event) => event.origin as Record<string, unknown> | undefined)
    .find((value) => value !== undefined);
  summary.step1 = {
    recordedFrom: first?.from ?? null,
    status: first?.status ?? null,
    receiverActed: resultTexts(b.events).some(
      (text) => text.includes("ACK") && text.includes("BRIDGE-PING-1"),
    ),
    originPidMatchesSender: origin?.verifiedPeerPid === a.pid,
    originPidPresent: typeof origin?.verifiedPeerPid === "number" && origin.verifiedPeerPid !== 0,
  };

  // 2. Managed → unmanaged target: denied at the sender, nothing recorded.
  sendTo(a, "naru-spike-bridge-c", "BRIDGE-PING-2");
  await a.waitForResults(3, 180_000);
  summary.step2 = {
    senderToolResult: sendResult(a, "BRIDGE-PING-2").slice(0, 120),
    recorded: records.some((record) => record.body.includes("BRIDGE-PING-2")),
  };

  // 3. Unmanaged sender (no bridge) → managed receiver: blocked at the receiver.
  const bResultsBefore = b.results().length;
  sendTo(c, "naru-spike-bridge-b", "BRIDGE-INTRUDER-3");
  await c.waitForResults(2, 180_000);
  await b.waitFor(
    (events) => events.filter((e) => e.type === "result").length > bResultsBefore,
    60_000,
    "blocked",
  );
  summary.step3 = {
    senderSent: sendResult(c, "BRIDGE-INTRUDER-3").slice(0, 80),
    receiverActedOnIntruder: resultTexts(b.events).some(
      (text) => text.includes("ACK") && text.includes("INTRUDER"),
    ),
    bridgeRejectedInbound: decisions.some((d) => d.type === "deliver" && !d.allow),
  };

  // 4. Receiver held by a human: denied at the sender.
  held.add("agent-b");
  sendTo(a, "naru-spike-bridge-b", "BRIDGE-PING-4");
  await a.waitForResults(4, 180_000);
  summary.step4 = { senderToolResult: sendResult(a, "BRIDGE-PING-4").slice(0, 120) };
  held.delete("agent-b");

  // 5. Bridge unavailable: fail closed.
  await new Promise<void>((done) => server.close(() => done()));
  sendTo(a, "naru-spike-bridge-b", "BRIDGE-PING-5");
  await a.waitForResults(5, 180_000);
  summary.step5 = {
    senderToolResult: sendResult(a, "BRIDGE-PING-5").slice(0, 120),
    receiverActed: resultTexts(b.events).some((text) => text.includes("BRIDGE-PING-5")),
  };
} finally {
  for (const child of processes) await child.close();
  if (server.listening) await new Promise<void>((done) => server.close(() => done()));
  rmSync(socketDirectory, { recursive: true, force: true });
  writeFileSync(resolve(run, "summary.json"), JSON.stringify({ summary, decisions }, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(summary, null, 2));
}
