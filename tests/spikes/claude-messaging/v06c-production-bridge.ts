// V06c: V06b again, but with the production pieces instead of a stub: AgentPlatformCore,
// AgentSocketServer, the agent-hook-cli bin and naruClaudeHookSettings. Real `claude -p` sessions.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Actor } from "../../../packages/contracts/src/naru-agent/v1/index.js";
import {
  AgentPlatformCore,
  nativeSessionName,
} from "../../../apps/server/src/agent-platform/core.js";
import { AgentSocketServer } from "../../../apps/server/src/agent-platform/agent-socket.js";
import { naruClaudeHookSettings } from "../../../apps/server/src/agent-runtime/claude/hook-settings.js";
import { NaruRepository } from "../../../apps/server/src/database.js";
import { ClaudeSpikeProcess, toolResults, toolUses, type StreamEvent } from "./claude-process.js";
import { spikeSettings } from "./hook-settings.js";
import { REPO_ROOT, runDirectory } from "./spike-env.js";

const HUMAN: Actor = { kind: "human" };
const run = runDirectory("v06c");
const repository = new NaruRepository(":memory:");
const project = repository.createProject("/tmp/naru-v06c-project", "v06c");
const core = new AgentPlatformCore(repository.agentPlatform);
let ordinal = 0;
const ctx = (actor: Actor) => ({
  actor,
  idempotencyKey: `b0000000-0000-4000-8000-${String(++ordinal).padStart(12, "0")}`,
});
const register = (role: "project-orchestrator" | "worker") =>
  core.registerAgentSession(ctx(HUMAN), {
    projectId: project.id,
    role,
    runtime: "claude",
    native: false,
    observation: "transcript",
    conversationWriter: "orchestrator",
  }).id;
const a = register("project-orchestrator");
const b = register("worker");
const goal = core.createHumanInstruction(ctx(HUMAN), {
  scope: { kind: "project", projectId: project.id },
  verbatim: "[naru-spike] v06c goal",
}).id;
const task = core.createTask(ctx({ kind: "agent", agentSessionId: a }), {
  projectId: project.id,
  title: "coordinate",
  purpose: "",
  completionCriteria: [],
  originInstructionId: goal,
});
core.updateTask(ctx(HUMAN), {
  taskId: task.id,
  expectedRevision: task.revision,
  assigneeAgentSessionId: a,
  status: "running",
});
const socketDirectory = mkdtempSync("/private/tmp/naru-v06c-");
const server = new AgentSocketServer(socketDirectory, core);
await server.start();
const tsx = pathToFileURL(resolve(REPO_ROOT, "node_modules/tsx/dist/loader.mjs")).href;
const settingsFor = (agentId: string) =>
  naruClaudeHookSettings({
    runner: process.execPath,
    runnerArgs: ["--import", tsx],
    entry: resolve(REPO_ROOT, "apps/server/src/agent-hook-cli.ts"),
    socketPath: server.socketPath,
    capability: core.issueAgentCapability(HUMAN, agentId),
    mode: "runner",
  });

const processes: ClaudeSpikeProcess[] = [];
const start = (options: ConstructorParameters<typeof ClaudeSpikeProcess>[0]) => {
  const child = new ClaudeSpikeProcess(options);
  processes.push(child);
  return child;
};
// Only turns that actually ran count; a hook-blocked prompt yields a result with num_turns 0 whose
// text repeats the blocked prompt.
const texts = (events: readonly StreamEvent[]) =>
  events
    .filter((event) => event.type === "result" && Number(event.num_turns ?? 0) > 0)
    .map((event) => (typeof event.result === "string" ? event.result : ""));
const sendResult = (child: ClaudeSpikeProcess, marker: string): string => {
  const use = toolUses(child.events).find(
    (entry) => entry.name === "SendMessage" && JSON.stringify(entry.input).includes(marker),
  );
  return use === undefined ? "no-send" : (toolResults(child.events).get(use.id) ?? "no-result");
};
const nameA = nativeSessionName(a);
const nameB = nativeSessionName(b);
const summary: Record<string, unknown> = { nameA, nameB };
try {
  const sa = start({ name: nameA, runDirectory: run, settings: settingsFor(a) });
  const sb = start({ name: nameB, runDirectory: run, settings: settingsFor(b) });
  const sc = start({
    name: "naru-spike-bridge-c",
    runDirectory: run,
    settings: spikeSettings({
      role: "naru-spike-bridge-c",
      runDirectory: run,
      inbound: "refuse",
      sendAllow: `^${nameB}$`,
    }),
  });
  sb.send(
    `[naru-spike] You are ${nameB}, a receiver in an automated messaging test. Reply READY. When a ` +
      "message from another session arrives, reply exactly ACK: followed by its first line. Never " +
      "send messages yourself.",
  );
  sa.send(`[naru-spike] You are ${nameA} in an automated messaging test. Reply READY.`);
  sc.send("[naru-spike] You are naru-spike-bridge-c in an automated messaging test. Reply READY.");
  await Promise.all([
    sa.waitForResults(1, 120_000),
    sb.waitForResults(1, 120_000),
    sc.waitForResults(1, 120_000),
  ]);
  const sendTo = (child: ClaudeSpikeProcess, target: string, text: string) =>
    child.send(
      `Use the SendMessage tool exactly once to send this exact message to the session named ${target}: ` +
        `"${text}". Do not retry if it is denied. Then reply DONE.`,
    );

  sendTo(sa, nameB, "PROD-PING-1");
  await sa.waitForResults(2, 180_000);
  await sb.waitFor(
    (events) => texts(events).some((text) => text.includes("PROD-PING-1")),
    120_000,
    "ack1",
  );
  const recorded = core
    .getApplicableInstructions(HUMAN, { projectId: project.id, agentSessionId: b })
    .concat();
  const delivered = repository.agentPlatform
    .readEvents({ afterSeq: 0, limit: 200 })
    .filter((event) => event.type === "instruction.delivered");
  const instruction =
    delivered[0] === undefined
      ? null
      : core.getAgentSession(HUMAN, a) &&
        repository.agentPlatform.getInstruction(delivered[0].subjectId);
  summary.step1 = {
    receiverActed: texts(sb.events).some(
      (text) => text.includes("ACK") && text.includes("PROD-PING-1"),
    ),
    deliveredEvents: delivered.length,
    authorIsSender: instruction?.author.kind === "agent" && instruction.author.agentSessionId === a,
    originIsTaskGoal: instruction?.originUserInstructionId === goal,
    verbatimKept: instruction?.verbatim?.includes("PROD-PING-1") ?? false,
    humanOnlyListUnaffected: recorded.every((entry) => entry.author.kind === "human"),
  };

  sendTo(sa, "naru-spike-bridge-c", "PROD-PING-2");
  await sa.waitForResults(3, 180_000);
  summary.step2 = { senderToolResult: sendResult(sa, "PROD-PING-2").slice(0, 120) };

  const before = sb.results().length;
  sendTo(sc, nameB, "PROD-INTRUDER-3");
  await sc.waitForResults(2, 180_000);
  await sb.waitFor(
    (events) => events.filter((e) => e.type === "result").length > before,
    60_000,
    "blocked",
  );
  summary.step3 = {
    receiverActedOnIntruder: texts(sb.events).some((text) => text.includes("INTRUDER")),
  };

  core.setHumanHold(ctx(HUMAN), { agentSessionId: b, held: true, reason: "takeover" });
  sendTo(sa, nameB, "PROD-PING-4");
  await sa.waitForResults(4, 180_000);
  summary.step4 = { senderToolResult: sendResult(sa, "PROD-PING-4").slice(0, 120) };
  core.setHumanHold(ctx(HUMAN), { agentSessionId: b, held: false, reason: "release" });

  await server.close();
  sendTo(sa, nameB, "PROD-PING-5");
  await sa.waitForResults(5, 180_000);
  summary.step5 = {
    senderToolResult: sendResult(sa, "PROD-PING-5").slice(0, 120),
    receiverActed: texts(sb.events).some((text) => text.includes("PROD-PING-5")),
  };
} finally {
  for (const child of processes) await child.close();
  await server.close();
  repository.close();
  rmSync(socketDirectory, { recursive: true, force: true });
  writeFileSync(resolve(run, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(summary, null, 2));
}
