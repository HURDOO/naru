import { execFileSync } from "node:child_process";
import { report, resultText, runPrint, userMessageLine, type PrintRun } from "./common.js";
import {
  ISOLATED_SETTING_SOURCES,
  captureHookSettings,
  payloadShape,
  readHookPayloads,
} from "./hooks.js";

/**
 * V05: native subagent observability through the official print/stream-json surface.
 * L1 lifecycle (task_* system events, SubagentStart/Stop hooks), L2 live transcript
 * (--forward-subagent-text child messages carrying parent_tool_use_id), L3 a client message sent
 * while the subagent runs, L4 whether the subagent gets its own process/PTY, and suppression via
 * --disallowedTools.
 */
const model = process.env.NARU_SPIKE_MODEL ?? "sonnet";
const hookEvents = ["SubagentStart", "SubagentStop", "PreToolUse", "UserPromptSubmit"];
const interjectMarker = `KIWI${Date.now().toString(36).toUpperCase()}`;
const task =
  "[naru-spike] Use the Task tool with the general-purpose subagent. Instruct the subagent to: " +
  "1) run `ls -la`, 2) read README.md, 3) run `git log --oneline`, 4) report the number of files " +
  "and the commit count in one sentence. After the subagent returns, reply with its sentence.";

function descendants(pid: number | undefined): string[] {
  if (pid === undefined) return [];
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().split(/\s+/, 3))
    .filter((parts) => parts.length === 3)
    .map(([child, parent, command]) => ({
      child: Number(child),
      parent: Number(parent),
      command: command ?? "",
    }));
  const found: string[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const row of rows) {
      if (row.parent !== current) continue;
      found.push(row.command.split("/").at(-1) ?? row.command);
      queue.push(row.child);
    }
  }
  return found;
}

function analyze(run: PrintRun): Record<string, unknown> {
  const events = run.events;
  const taskStarted = events.find(
    (event) => event.value.type === "system" && event.value.subtype === "task_started",
  );
  const taskToolUse = taskStarted?.value.tool_use_id;
  const childEvents = events.filter((event) => typeof event.value.parent_tool_use_id === "string");
  const toolResult = events.find((event) => {
    if (event.value.type !== "user" || typeof event.value.parent_tool_use_id === "string")
      return false;
    const content = (event.value.message as { content?: unknown } | undefined)?.content;
    return (
      Array.isArray(content) &&
      content.some((block) => (block as { tool_use_id?: unknown }).tool_use_id === taskToolUse)
    );
  });
  const childTextEvents = childEvents.filter((event) => {
    const content = (event.value.message as { content?: unknown } | undefined)?.content;
    return (
      Array.isArray(content) &&
      content.some((block) => (block as { type?: unknown }).type === "text")
    );
  });
  const subtypes = [
    ...new Set(
      events
        .filter((event) => event.value.type === "system")
        .map((event) => String(event.value.subtype)),
    ),
  ];
  const init = events.find((event) => event.value.subtype === "init")?.value;
  const tools = Array.isArray(init?.tools) ? (init.tools as string[]) : [];
  return {
    exitCode: run.exitCode,
    initHasTaskTool: tools.includes("Task") || tools.includes("Agent"),
    taskStartedAtMs: taskStarted?.receivedAtMs,
    taskStartedFields: taskStarted === undefined ? [] : Object.keys(taskStarted.value).sort(),
    subagentType: taskStarted?.value.subagent_type,
    childEventCount: childEvents.length,
    childTextEventCount: childTextEvents.length,
    childParentMatchesTaskToolUse:
      childEvents.length > 0 &&
      childEvents.every((event) => event.value.parent_tool_use_id === taskToolUse),
    firstChildAtMs: childEvents[0]?.receivedAtMs,
    lastChildAtMs: childEvents.at(-1)?.receivedAtMs,
    taskResultAtMs: toolResult?.receivedAtMs,
    childEventsBeforeResult: childEvents.filter(
      (event) => event.receivedAtMs < (toolResult?.receivedAtMs ?? Infinity),
    ).length,
    systemSubtypes: subtypes,
    taskProgressCount: events.filter((event) => event.value.subtype === "task_progress").length,
    taskNotification: events.some((event) => event.value.subtype === "task_notification"),
  };
}

// Traced run with a client interjection while the subagent is running.
let interjectedAtMs: number | undefined;
let processesDuringSubagent: string[] = [];
const traced = await runPrint({
  label: "v05-subagent-traced",
  args: [
    ...ISOLATED_SETTING_SOURCES,
    "--model",
    model,
    "--input-format",
    "stream-json",
    "--forward-subagent-text",
    "--include-hook-events",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Bash(ls *) Bash(git log *) Read Task",
    "--settings",
    captureHookSettings("v05-subagent-traced", hookEvents),
  ],
  input: [{ afterMs: 0, line: userMessageLine(task) }],
  closeInputWhen: (event) => event.type === "result",
  onEvent: (event, control) => {
    if (
      event.type === "system" &&
      event.subtype === "task_started" &&
      interjectedAtMs === undefined
    ) {
      interjectedAtMs = control.elapsedMs;
      processesDuringSubagent = descendants(control.pid);
      control.write(
        userMessageLine(
          `[naru-spike] When you give your final reply, append the word ${interjectMarker}.`,
        ),
      );
    }
  },
});
const finalText = resultText(traced);
const hooks = readHookPayloads("v05-subagent-traced");
const subagentStart = hooks.find((payload) => payload.hook_event_name === "SubagentStart");
const subagentStop = hooks.find((payload) => payload.hook_event_name === "SubagentStop");
const childMentionsInterject = traced.events.some(
  (event) =>
    typeof event.value.parent_tool_use_id === "string" &&
    JSON.stringify(event.value).includes(interjectMarker),
);
report("V05.traced", {
  ...analyze(traced),
  interjectedAtMs,
  interjectionReachedMainReply: finalText.includes(interjectMarker),
  interjectionVisibleToSubagent: childMentionsInterject,
  userPromptSubmitCount: hooks.filter((payload) => payload.hook_event_name === "UserPromptSubmit")
    .length,
  processesDuringSubagent: [...new Set(processesDuringSubagent)],
  subagentStartShape: subagentStart === undefined ? null : payloadShape(subagentStart),
  subagentStopShape: subagentStop === undefined ? null : payloadShape(subagentStop),
  hookAgentIdMatchesStartStop:
    subagentStart?.agent_id !== undefined && subagentStart.agent_id === subagentStop?.agent_id,
  sessionId: traced.sessionId === undefined ? null : "<uuid>",
});
process.stdout.write(
  `${JSON.stringify({ item: "V05.traced-session", sessionId: traced.sessionId })}\n`,
);

// Suppression: deny the subagent tool and ask for it anyway.
const suppressed = await runPrint({
  label: "v05-subagent-suppressed",
  args: [
    ...ISOLATED_SETTING_SOURCES,
    "--model",
    model,
    "--disallowedTools",
    "Task Agent",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Bash(ls *) Bash(git log *) Read",
    "--input-format",
    "stream-json",
  ],
  // Variadic tool lists would swallow a trailing positional prompt, so send it over stdin.
  input: [{ afterMs: 0, line: userMessageLine(task) }],
  closeInputWhen: (event) => event.type === "result",
});
report("V05.suppressed", {
  ...analyze(suppressed),
  anyTaskStarted: suppressed.events.some((event) => event.value.subtype === "task_started"),
});
