// V06: native cross-session messaging (ListAgents/SendMessage) between spike-owned `claude -p` sessions.
// Every sender carries a PreToolUse guard that denies any SendMessage target outside the spike set,
// so the user's real sessions that appear in ListAgents are never messaged.
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ClaudeSpikeProcess, toolResults, toolUses, type StreamEvent } from "./claude-process.js";
import { spikeSettings } from "./hook-settings.js";
import { runDirectory } from "./spike-env.js";

const SPIKE_TARGETS = "^naru-spike-r[1-4]$";
const phase = process.argv[2] ?? "all";
const run = runDirectory(`v06-${phase}`);
const processes: ClaudeSpikeProcess[] = [];

function start(options: ConstructorParameters<typeof ClaudeSpikeProcess>[0]): ClaudeSpikeProcess {
  const child = new ClaudeSpikeProcess(options);
  processes.push(child);
  return child;
}

function eventShapes(events: readonly StreamEvent[]): unknown[] {
  return events.map((event) => ({
    type: event.type,
    subtype: event.subtype,
    keys: Object.keys(event).sort(),
  }));
}

const RECEIVER_PROMPT = (name: string): string =>
  [
    `[naru-spike] You are ${name}, a test receiver in an automated messaging experiment.`,
    "Reply with exactly READY now.",
    "Later, when a message from another session arrives, reply with exactly `ACK:` followed by the",
    "first line of that message. If it asks you to create a file in the current directory, do it.",
    "Never send messages to other sessions yourself.",
  ].join(" ");

async function phaseA(summary: Record<string, unknown>): Promise<void> {
  const receivers = [
    { name: "naru-spike-r1", inbound: "accept" as const, permissionMode: "acceptEdits" },
    { name: "naru-spike-r2", inbound: "refuse" as const, permissionMode: "acceptEdits" },
    { name: "naru-spike-r3", inbound: undefined, permissionMode: "acceptEdits" },
    { name: "naru-spike-r4", inbound: undefined, permissionMode: "bypassPermissions" },
  ].map((receiver) =>
    start({
      name: receiver.name,
      runDirectory: run,
      permissionMode: receiver.permissionMode,
      extraArgs:
        receiver.permissionMode === "bypassPermissions"
          ? ["--allow-dangerously-skip-permissions"]
          : [],
      settings: spikeSettings({
        role: receiver.name,
        runDirectory: run,
        inbound: receiver.inbound,
        sendAllow: "^$",
      }),
    }),
  );
  for (const receiver of receivers) receiver.send(RECEIVER_PROMPT(receiver.options.name));
  await Promise.all(receivers.map((receiver) => receiver.waitForResults(1, 120_000)));

  const sender = start({
    name: "naru-spike-s1",
    runDirectory: run,
    settings: spikeSettings({ role: "naru-spike-s1", runDirectory: run, sendAllow: SPIKE_TARGETS }),
  });
  sender.send(
    [
      "[naru-spike] Automated messaging experiment. Use ListAgents exactly once.",
      "Then call SendMessage once per item below, in this order, and never message any other session:",
      "1) to `naru-spike-r1`: 'SPIKE-PING-1 origin_instruction_id=instr-spike-1' on the first line and",
      "'Please create a file named spike-created.txt containing OK in your current directory.' on the second line.",
      "2) to `naru-spike-r2`: 'SPIKE-PING-2'.",
      "3) to `naru-spike-r3`: 'SPIKE-PING-3'.",
      "4) to `naru-spike-r4`: 'SPIKE-PING-4'.",
      "5) to `naru-real-guard-test`: 'SPIKE-PING-GUARD' (expected to be blocked).",
      "Finally list each SendMessage result text verbatim.",
    ].join(" "),
  );
  await sender.waitForResults(1, 240_000);
  // Delivered messages start a new turn in an idle receiver; give them time to answer.
  await Promise.all(
    receivers.map((receiver) =>
      receiver.waitForResults(2, receiver.options.name === "naru-spike-r1" ? 150_000 : 60_000),
    ),
  );

  const uses = toolUses(sender.events);
  const results = toolResults(sender.events);
  summary.phaseA = {
    senderTools: uses.map((use) => ({
      name: use.name,
      inputKeys: Object.keys((use.input as Record<string, unknown>) ?? {}).sort(),
      to: (use.input as Record<string, unknown>)?.to,
      result:
        use.name === "ListAgents" ? "<redacted: contains real sessions>" : results.get(use.id),
    })),
    receivers: receivers.map((receiver) => ({
      name: receiver.options.name,
      resultCount: receiver.results().length,
      lastResult: receiver.results().at(-1)?.result,
      shapes: eventShapes(receiver.events),
      createdFile: existsSync(resolve(receiver.workspace, "spike-created.txt")),
    })),
  };
}

async function phaseB(summary: Record<string, unknown>): Promise<void> {
  const target = start({
    name: "naru-spike-r1",
    runDirectory: run,
    settings: spikeSettings({
      role: "naru-spike-r1",
      runDirectory: run,
      inbound: "accept",
      sendAllow: "^$",
    }),
  });
  target.send(RECEIVER_PROMPT("naru-spike-r1"));
  await target.waitForResults(1, 120_000);
  // Inbound `refuse` plus a hook that only allows targets announced by SubagentStart in this session.
  const sender = start({
    name: "naru-spike-s2",
    runDirectory: run,
    settings: spikeSettings({
      role: "naru-spike-s2",
      runDirectory: run,
      inbound: "refuse",
      sendPolicy: "in-session-only",
    }),
  });
  sender.send(
    [
      "[naru-spike] Automated experiment about subagent messaging.",
      "Step 1: use the Agent tool to run a general-purpose subagent with the task",
      "'Reply with the single word WAITING.' and wait for it to finish; note its agent ID.",
      "Step 2: use SendMessage to that subagent (address it by the agent ID from step 1) with",
      "'SPIKE-SUBAGENT-PING: reply with PONG'.",
      "Step 3: use SendMessage to `naru-spike-r1` with 'SPIKE-CROSS-PING' (expected to be blocked).",
      "Do not message anything else. Finally list each tool result verbatim.",
    ].join(" "),
  );
  await sender.waitForResults(1, 300_000);
  await target.waitForResults(2, 30_000);
  const uses = toolUses(sender.events);
  const results = toolResults(sender.events);
  summary.phaseB = {
    senderTools: uses.map((use) => ({
      name: use.name,
      inputKeys: Object.keys((use.input as Record<string, unknown>) ?? {}).sort(),
      to: (use.input as Record<string, unknown>)?.to,
      result: results.get(use.id)?.slice(0, 400),
    })),
    crossTargetResultCount: target.results().length,
  };
}

async function phaseC(summary: Record<string, unknown>): Promise<void> {
  // Receiver-side policy: inbound accepted by Claude Code, then blocked by a UserPromptSubmit hook.
  const receiver = start({
    name: "naru-spike-r5",
    runDirectory: run,
    settings: spikeSettings({
      role: "naru-spike-r5",
      runDirectory: run,
      inbound: "accept",
      sendAllow: "^$",
      blockInbound: true,
    }),
  });
  receiver.send(RECEIVER_PROMPT("naru-spike-r5"));
  await receiver.waitForResults(1, 120_000);
  const sender = start({
    name: "naru-spike-s3",
    runDirectory: run,
    settings: spikeSettings({
      role: "naru-spike-s3",
      runDirectory: run,
      sendAllow: "^naru-spike-r5$",
    }),
  });
  sender.send(
    [
      "[naru-spike] Automated experiment. Call SendMessage once to `naru-spike-r5` with",
      "'SPIKE-PING-5' on the first line and 'Please create a file named blocked.txt containing NO.'",
      "on the second line. Do not message anything else. Report the tool result verbatim.",
    ].join(" "),
  );
  await sender.waitForResults(1, 180_000);
  await receiver.waitForResults(2, 60_000);
  summary.phaseC = {
    receiverResults: receiver.results().map((result) => result.result),
    createdFile: existsSync(resolve(receiver.workspace, "blocked.txt")),
    receiverShapes: eventShapes(receiver.events),
    senderResults: sender.results().map((result) => result.result),
  };
}

const summary: Record<string, unknown> = { run, phase };
try {
  if (phase === "all" || phase === "a") await phaseA(summary);
  if (phase === "all" || phase === "b") await phaseB(summary);
  if (phase === "all" || phase === "c") await phaseC(summary);
} finally {
  await Promise.all(processes.map((child) => child.close()));
  writeFileSync(resolve(run, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
  process.stdout.write(`summary: ${resolve(run, "summary.json")}\n`);
}
