/**
 * AP-T14 acceptance: ClaudeRunner with the user-installed Claude Agent SDK (AP-D012) and the real
 * CLI, wired to a real AgentPlatformCore, AgentSocketServer, Naru MCP bin and bridge hooks.
 * Requires NARU_SPIKE_REAL_MODEL=1, NARU_SPIKE_CLAUDE and NARU_SPIKE_CLAUDE_SDK (path to sdk.mjs).
 * Raw output stays in the owner-only experiments directory; stdout prints booleans only.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Actor } from "../../../packages/contracts/src/naru-agent/v1/index.js";
import type { AgentRuntimeEvent } from "../../../apps/server/src/agent-runtime/adapter.js";
import {
  AgentPlatformCore,
  nativeSessionName,
} from "../../../apps/server/src/agent-platform/core.js";
import {
  AgentSocketServer,
  NARU_AGENT_CAPABILITY_ENV,
  NARU_AGENT_SOCKET_ENV,
} from "../../../apps/server/src/agent-platform/agent-socket.js";
import { naruClaudeHookSettings } from "../../../apps/server/src/agent-runtime/claude/hook-settings.js";
import {
  ClaudeRunner,
  type ClaudeRunnerPlan,
} from "../../../apps/server/src/agent-runtime/claude/runner.js";
import { loadClaudeSdk } from "../../../apps/server/src/agent-runtime/claude/sdk-port.js";
import { NaruRepository } from "../../../apps/server/src/database.js";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "../../..");
const HUMAN: Actor = { kind: "human" };
const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`Set ${name}.`);
  return value;
};
if (process.env.NARU_SPIKE_REAL_MODEL !== "1") throw new Error("Set NARU_SPIKE_REAL_MODEL=1.");
const claude = required("NARU_SPIKE_CLAUDE");
const sdk = await loadClaudeSdk(required("NARU_SPIKE_CLAUDE_SDK"));
const root = resolve(repositoryRoot, "../../experiments/naru-agent-spikes/agent-platform");
const workspace = resolve(root, "runner-workspace");
if (!existsSync(resolve(workspace, ".git"))) {
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  writeFileSync(resolve(workspace, "README.md"), "naru runner spike workspace\n");
}
rmSync(resolve(workspace, "runner-approval.txt"), { force: true });

const repository = new NaruRepository(":memory:");
const project = repository.createProject(workspace, "runner-spike");
const core = new AgentPlatformCore(repository.agentPlatform);
let ordinal = 0;
const ctx = (actor: Actor) => ({
  actor,
  idempotencyKey: `c0000000-0000-4000-8000-${String(++ordinal).padStart(12, "0")}`,
});
const worker = core.registerAgentSession(ctx(HUMAN), {
  projectId: project.id,
  role: "worker",
  runtime: "claude",
  native: false,
  observation: "transcript",
  conversationWriter: "orchestrator",
}).id;
core.createHumanInstruction(ctx(HUMAN), {
  scope: { kind: "project", projectId: project.id },
  verbatim: "[naru-spike] runner goal marker RUNNERMARK42",
});
const socketDirectory = mkdtempSync("/private/tmp/naru-runner-");
const server = new AgentSocketServer(socketDirectory, core);
await server.start();
const capability = core.issueAgentCapability(HUMAN, worker);
const tsx = pathToFileURL(resolve(repositoryRoot, "node_modules/tsx/dist/loader.mjs")).href;
const environment: Record<string, string> = {
  HOME: required("HOME"),
  USER: required("USER"),
  LOGNAME: required("USER"),
  PATH: `${dirname(claude)}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  LANG: "en_US.UTF-8",
  SHELL: "/bin/zsh",
};
const plan = (resumeRef: string | null): ClaudeRunnerPlan => ({
  executable: claude,
  cwd: workspace,
  model: "sonnet",
  resumeRef,
  nativeName: nativeSessionName(worker),
  settings: naruClaudeHookSettings({
    runner: process.execPath,
    runnerArgs: ["--import", tsx],
    entry: resolve(repositoryRoot, "apps/server/src/agent-hook-cli.ts"),
    socketPath: server.socketPath,
    capability,
    mode: "runner",
  }),
  mcpServers: {
    naru: {
      type: "stdio",
      command: process.execPath,
      args: ["--import", tsx, resolve(repositoryRoot, "apps/server/src/agent-mcp-cli.ts")],
      env: { [NARU_AGENT_SOCKET_ENV]: server.socketPath, [NARU_AGENT_CAPABILITY_ENV]: capability },
    },
  },
  instructions:
    "You are a Naru-managed worker in an automated spike. Follow instructions literally.",
  permissionMode: "default",
  environment,
});

const results: Record<string, unknown> = {};
const approvalsSeen: string[] = [];
function attach(runner: ClaudeRunner, events: AgentRuntimeEvent[]) {
  runner.onEvent((event) => {
    events.push(event);
    if (event.type === "approval-requested") {
      approvalsSeen.push(event.kind);
      // The person approves everything except the sleep command, which gets interrupted instead.
      setTimeout(() => runner.respondApproval(event.requestId, "approve"), 200);
    }
  });
}
async function waitFor(
  events: AgentRuntimeEvent[],
  predicate: (event: AgentRuntimeEvent) => boolean,
  ms = 240_000,
) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (events.some(predicate)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return false;
}
const endedCount = (events: AgentRuntimeEvent[]) =>
  events.filter((event) => event.type === "turn-ended").length;

try {
  const events: AgentRuntimeEvent[] = [];
  const runner = new ClaudeRunner(sdk, plan(null));
  attach(runner, events);
  runner.start();
  runner.sendTurn(
    "[naru-spike] Call the naru MCP tool get_applicable_user_instructions with no arguments, then " +
      "reply with only the marker word that starts with RUNNERMARK.",
  );
  await waitFor(events, (event) => event.type === "turn-ended");
  results.conversationReady = events.some((event) => event.type === "conversation-ready");
  results.turn1 = events.find((event) => event.type === "turn-ended");
  results.eventsHaveNoMarker = !JSON.stringify(events).includes("RUNNERMARK42");

  runner.sendTurn(
    "Create a file named runner-approval.txt containing exactly OK. Then reply DONE.",
  );
  await waitFor(events, () => endedCount(events) >= 2);
  results.fileWrittenAfterApproval = existsSync(resolve(workspace, "runner-approval.txt"));

  // Interrupt while the model is still generating a long answer (no tool approval involved).
  runner.sendTurn("Write a 3000-word essay about the history of computer terminals. No tools.");
  await new Promise((resolveWait) => setTimeout(resolveWait, 6_000));
  results.busyBeforeInterrupt = runner.busy;
  await runner.interrupt();
  await waitFor(events, () => endedCount(events) >= 3, 120_000);
  results.turn3 = events.filter((event) => event.type === "turn-ended")[2];
  results.approvalKinds = [...new Set(approvalsSeen)];

  const history = await runner.readHistory(null);
  results.historyItems = history.items.length;
  results.historyHasMarker = JSON.stringify(history.items).includes("RUNNERMARK42");
  const sessionId = runner.runtimeSessionRef;
  await runner.stop();
  results.exited = events.at(-1);

  const resumedEvents: AgentRuntimeEvent[] = [];
  const resumed = new ClaudeRunner(sdk, plan(sessionId));
  attach(resumed, resumedEvents);
  resumed.start();
  resumed.sendTurn(
    "Which marker word did you reply with earlier in this conversation? Reply with it only.",
  );
  await waitFor(resumedEvents, (event) => event.type === "turn-ended");
  results.resumedSameSession = resumed.runtimeSessionRef === sessionId;
  results.resumedTurn = resumedEvents.find((event) => event.type === "turn-ended");
  const resumedHistory = await resumed.readHistory(null);
  results.resumedRemembered = JSON.stringify(resumedHistory.items.slice(-4)).includes(
    "RUNNERMARK42",
  );
  await resumed.stop();
} finally {
  await server.close();
  repository.close();
  rmSync(socketDirectory, { recursive: true, force: true });
  console.log(JSON.stringify(results, null, 2));
}
