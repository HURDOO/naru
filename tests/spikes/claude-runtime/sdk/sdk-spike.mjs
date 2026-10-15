/* global process, setTimeout */
// Claude Agent SDK 0.3.296 spike (CLI 2.1.296). Copy this directory to a scratch location outside
// the repository, run `npm install`, then run with a clean env (no parent Claude Code variables):
//   env -i HOME=$HOME USER=$USER PATH=/usr/bin:/bin TMPDIR=$TMPDIR NARU_SPIKE_CLAUDE=<claude.exe> \
//     NARU_SPIKE_WORKSPACE=<scratch git repo> NARU_SPIKE_LOG_DIR=<owner-only log dir> \
//     [V03_SESSION=<uuid>] [V05_SESSION=<uuid>] [ONLY=models|v03|history|subagents|approval|stop|observe] \
//     node sdk-spike.mjs
// Prints redacted JSON results; raw messages go to NARU_SPIKE_LOG_DIR/sdk-*.jsonl.
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  getSessionMessages,
  getSubagentMessages,
  listSessions,
  listSubagents,
  query,
} from "@anthropic-ai/claude-agent-sdk";

const claude = process.env.NARU_SPIKE_CLAUDE;
const workspace = process.env.NARU_SPIKE_WORKSPACE;
const logs = process.env.NARU_SPIKE_LOG_DIR;
const env = {
  HOME: process.env.HOME,
  USER: process.env.USER,
  LOGNAME: process.env.USER,
  PATH: `${dirname(claude)}:${dirname(process.execPath)}:/usr/bin:/bin`,
  LANG: "en_US.UTF-8",
  TMPDIR: process.env.TMPDIR,
  SHELL: "/bin/zsh",
};
const base = {
  pathToClaudeCodeExecutable: claude,
  cwd: workspace,
  env,
  model: "sonnet",
  settingSources: ["project", "local"],
  strictMcpConfig: true,
};
const report = (item, values) => process.stdout.write(`${JSON.stringify({ item, ...values })}\n`);
const reversed = (value) => [...value.toLowerCase()].reverse().join("");
const code = (prefix) => `${prefix}${randomBytes(3).toString("hex").toUpperCase()}`;

async function run(label, prompt, options, onMessage) {
  const path = join(logs, `${label}.jsonl`);
  writeFileSync(path, "", { mode: 0o600 });
  const q = query({ prompt, options: { ...base, ...options } });
  const messages = [];
  const started = Date.now();
  for await (const message of q) {
    appendFileSync(path, `${JSON.stringify(message)}\n`);
    messages.push({ at: Date.now() - started, message });
    await onMessage?.(message, q);
  }
  const result = messages.find((entry) => entry.message.type === "result")?.message;
  const init = messages.find((entry) => entry.message.subtype === "init")?.message;
  return {
    messages,
    result,
    sessionId: init?.session_id,
    text: typeof result?.result === "string" ? result.result : "",
  };
}

function textOf(sessionMessage) {
  const content = sessionMessage.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (block.type === "text" ? block.text : "")).join(" ");
}

const only = process.env.ONLY;
const want = (name) => only === undefined || only === name;

// (d) models and account plan via control requests.
if (want("models")) {
  let models = [];
  let account = {};
  await run("sdk-models", "[naru-spike] Reply only OK.", {}, async (message, q) => {
    if (message.subtype === "init" && models.length === 0) {
      models = await q.supportedModels();
      account = await q.accountInfo();
    }
  });
  report("X-d.models", {
    models: models.map((model) => ({
      value: model.value,
      resolvedModel: model.resolvedModel,
      effort: model.supportedEffortLevels,
    })),
    accountKeys: Object.keys(account).sort(),
    subscriptionType: account.subscriptionType,
  });
}

// V03 via SDK: SDK create -> CLI print resume -> SDK resume; same session id; history via getSessionMessages.
if (want("v03")) {
  const sessionId = randomUUID();
  const first = code("SDKA");
  const second = code("CLIB");
  const one = await run("sdk-v03-1", `[naru-spike] Remember codeword ${first}. Reply only OK.`, {
    sessionId,
  });
  const cli = spawnSync(
    claude,
    [
      "-p",
      "--setting-sources",
      "project,local",
      "--model",
      "sonnet",
      "--resume",
      sessionId,
      `[naru-spike] Remember codeword ${second}. Reply only OK.`,
    ],
    { cwd: workspace, env, encoding: "utf8" },
  );
  const three = await run(
    "sdk-v03-3",
    "[naru-spike] List both codewords reversed in lowercase, space separated.",
    { resume: sessionId },
  );
  const history = await getSessionMessages(sessionId, { dir: workspace });
  report("V03.sdk-roundtrip", {
    createdWithRequestedId: one.sessionId === sessionId,
    cliResumeExit: cli.status,
    sdkResumeSameId: three.sessionId === sessionId,
    recalledFirst: three.text.toLowerCase().includes(reversed(first)),
    recalledSecondFromCli: three.text.toLowerCase().includes(reversed(second)),
    historyMessageCount: history.length,
    historyRoles: history.map((entry) => entry.type).join(","),
    historyHasCliTurn: history.some((entry) => textOf(entry).includes(second)),
  });
}

// (c) history of the earlier V03 print -> TUI -> print session, read only through the SDK API.
if (want("history") && process.env.V03_SESSION) {
  const history = await getSessionMessages(process.env.V03_SESSION, { dir: workspace });
  const listed = await listSessions({ dir: workspace });
  report("X-c.history", {
    messageCount: history.length,
    hasTuiTurn: history.some((entry) =>
      textOf(entry).includes("Write the first codeword reversed"),
    ),
    entryKeys: history[0] ? Object.keys(history[0]).sort() : [],
    listedSessionCount: listed.length,
    listedHasSession: listed.some((entry) => entry.sessionId === process.env.V03_SESSION),
    listedEntryKeys: listed[0] ? Object.keys(listed[0]).sort() : [],
  });
}

// V05 after the fact: subagent transcript through listSubagents/getSubagentMessages.
if (want("subagents") && process.env.V05_SESSION) {
  const agents = await listSubagents(process.env.V05_SESSION, { dir: workspace });
  const messages = agents[0]
    ? await getSubagentMessages(process.env.V05_SESSION, agents[0], { dir: workspace })
    : [];
  report("V05.subagent-history", {
    subagentCount: agents.length,
    firstSubagentMessageCount: messages.length,
  });
}

// External approval: canUseTool decides Bash from the host.
if (want("approval")) {
  const decisions = [];
  const approval = await run(
    "sdk-approval",
    "[naru-spike] Run the shell command `touch naru-approval-one.txt` and then `touch naru-approval-two.txt`, then say DONE.",
    {
      permissionMode: "default",
      canUseTool: async (toolName, input) => {
        decisions.push({
          toolName,
          command: typeof input.command === "string" ? input.command.slice(0, 40) : undefined,
        });
        if (decisions.length === 1)
          return { behavior: "deny", message: "Denied by naru spike host" };
        return { behavior: "allow", updatedInput: input };
      },
    },
  );
  report("X.approval", {
    canUseToolCalls: decisions.length,
    toolNames: [...new Set(decisions.map((entry) => entry.toolName))],
    permissionDenials: Array.isArray(approval.result?.permission_denials)
      ? approval.result.permission_denials.length
      : null,
  });
}

// Background subagent stop from the host (L3-like control).
if (want("stop")) {
  let stopRequested = false;
  let stopResult = "not-called";
  const events = [];
  await run(
    "sdk-stop-task",
    "[naru-spike] Use the Task tool with run_in_background set to true to start a general-purpose subagent. Tell the subagent to use the Read tool on README.md forty separate times, one call at a time, and then report DONE. While it runs, wait for its completion notification, then report the notification status.",
    { permissionMode: "default", allowedTools: ["Read", "Task"], maxTurns: 12 },
    async (message, q) => {
      if (message.subtype === "task_started")
        events.push(`started:${message.task_type}:${message.is_backgrounded}`);
      if (message.subtype === "task_progress") events.push("progress");
      if (message.subtype === "task_updated" && message.patch?.status)
        events.push(`updated:${message.patch.status}`);
      if (message.subtype === "task_notification") events.push(`notification:${message.status}`);
      if (
        message.subtype === "task_started" &&
        message.task_type === "local_agent" &&
        !stopRequested
      ) {
        stopRequested = true;
        setTimeout(() => {
          q.stopTask(message.task_id).then(
            () => {
              stopResult = "ok";
              events.push("stopTask-called");
            },
            (error) => {
              stopResult = `error:${String(error?.message ?? error).slice(0, 60)}`;
            },
          );
        }, 1_000);
      }
    },
  );
  report("V05.stop-task", {
    stopResult,
    events: events.filter(
      (entry, index) => entry !== "progress" || events[index - 1] !== "progress",
    ),
  });
}

// Read-only observer: does getSessionMessages see a writer's turn progress before the turn ends?
if (want("observe")) {
  const sessionId = randomUUID();
  const counts = [];
  let finished = false;
  const poll = (async () => {
    const started = Date.now();
    while (!finished) {
      const history = await getSessionMessages(sessionId, { dir: workspace }).catch(() => []);
      counts.push({ at: Date.now() - started, count: history.length });
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  })();
  const writer = await run(
    "sdk-observe-writer",
    "[naru-spike] Use the Read tool on README.md six separate times, one call at a time, saying one short sentence between calls, then reply DONE.",
    { sessionId, permissionMode: "default", allowedTools: ["Read"] },
  );
  finished = true;
  await poll;
  const resultAt = writer.messages.find((entry) => entry.message.type === "result")?.at ?? 0;
  const before = counts.filter((entry) => entry.at < resultAt - 500).map((entry) => entry.count);
  report("X-c.observe-while-writing", {
    resultAtMs: resultAt,
    distinctCountsBeforeResult: [...new Set(before)],
    finalCount: counts.at(-1)?.count,
  });
}
