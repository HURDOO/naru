import type { AgentRuntimeEvent } from "./agent-runtime/adapter.js";
import {
  NARU_RUNTIME_SOCKET_ENV,
  NARU_RUNTIME_TOKEN_ENV,
  type NaruMessage,
  type RunnerPlan,
} from "./agent-runtime/channel-protocol.js";
import { ClaudeRunner } from "./agent-runtime/claude/runner.js";
import { loadClaudeSdk } from "./agent-runtime/claude/sdk-port.js";
import { RunnerChannelClient } from "./agent-runtime/runner-channel.js";

/**
 * Host-owned process for one Naru-managed Claude agent (AP-D011). Its terminal is an observation
 * console (lifecycle lines only, never conversation text); the conversation protocol runs over the
 * SDK's pipes and Naru's private channel, not the PTY. It survives Naru restarts and reconnects.
 */
const socketPath = process.env[NARU_RUNTIME_SOCKET_ENV];
const token = process.env[NARU_RUNTIME_TOKEN_ENV];
if (socketPath === undefined || token === undefined) {
  process.stderr.write("NARU_RUNTIME_UNAVAILABLE\n");
  process.exit(1);
}
// The token authenticates this process only; nothing it starts inherits it. The same goes for the
// Pane's integration bootstrap, which only the TUI form's activity hooks use.
delete process.env[NARU_RUNTIME_TOKEN_ENV];
delete process.env[NARU_RUNTIME_SOCKET_ENV];
delete process.env.NARU_CLAUDE_HOOK_BOOTSTRAP;

let runner: ClaudeRunner | null = null;
let starting = false;
const pendingApprovals = new Set<string>();

const console_ = (line: string): void => {
  process.stdout.write(`[naru ${new Date().toISOString().slice(11, 19)}] ${line}\n`);
};

const channel = new RunnerChannelClient({
  socketPath,
  token,
  state: () => ({
    started: runner !== null,
    runtimeSessionRef: runner?.runtimeSessionRef ?? null,
    busy: runner?.busy ?? false,
    pendingApprovals: [...pendingApprovals],
  }),
  onMessage: (message) => void handle(message),
});

async function handle(message: NaruMessage): Promise<void> {
  switch (message.type) {
    case "plan":
      if ("runtime" in message.plan) {
        console_("plan for another runtime");
        await shutdown(1);
        return;
      }
      if (runner === null && !starting) await start(message.plan);
      return;
    case "send":
      try {
        runner?.sendTurn(message.text);
      } catch {
        channel.send({ type: "error", requestId: null, code: "RUNNER_STOPPED" });
      }
      return;
    case "interrupt":
      await runner?.interrupt();
      return;
    case "approval":
      runner?.respondApproval(message.requestId, message.decision);
      return;
    case "history":
      try {
        const page = await (runner?.readHistory(message.cursor) ??
          Promise.resolve({ items: [], nextCursor: null }));
        channel.send({
          type: "history",
          requestId: message.requestId,
          items: [...page.items],
          nextCursor: page.nextCursor,
        });
      } catch {
        channel.send({ type: "error", requestId: message.requestId, code: "HISTORY_FAILED" });
      }
      return;
    case "stop":
    case "rejected":
      console_(message.type === "stop" ? "stop requested by Naru" : "launch rejected by Naru");
      await shutdown(message.type === "stop" ? 0 : 1);
      return;
    case "ack":
    case "writer":
      // Naru gates Claude's writers itself (stop-resume); the runner has no TUI to fence.
      return;
  }
}

async function start(plan: RunnerPlan): Promise<void> {
  starting = true;
  try {
    const sdk = await loadClaudeSdk(plan.sdkEntry);
    // Claude inherits the Host's environment policy; the plan adds to it, never the reverse.
    runner = new ClaudeRunner(sdk, {
      ...plan,
      environment: { ...inheritedEnvironment(), ...plan.environment },
    });
    runner.onEvent((event) => {
      observe(event);
      channel.emit(event);
      if (event.type === "exited") void shutdown(event.reason === "stopped" ? 0 : 1);
    });
    runner.start();
    console_(
      `Claude agent ready · model ${plan.model} · observation console (no conversation text)`,
    );
  } catch {
    console_("NARU_CLAUDE_SDK_UNAVAILABLE");
    channel.emit({ type: "exited", reason: "crashed" });
    await shutdown(1);
  } finally {
    starting = false;
  }
}

function observe(event: AgentRuntimeEvent): void {
  switch (event.type) {
    case "conversation-ready":
      console_("conversation ready");
      return;
    case "turn-started":
      console_("turn started");
      return;
    case "turn-ended":
      console_(`turn ${event.outcome}`);
      return;
    case "approval-requested":
      pendingApprovals.add(event.requestId);
      console_(`waiting for approval in Naru (${event.kind})`);
      return;
    case "approval-resolved":
      pendingApprovals.delete(event.requestId);
      console_("approval resolved");
      return;
    case "child-started":
      console_("subagent started (observe only)");
      return;
    case "child-ended":
      console_("subagent finished");
      return;
    case "user-prompt":
      return;
    case "exited":
      console_(`runner ${event.reason}`);
  }
}

function inheritedEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

let exiting = false;
async function shutdown(code: number): Promise<void> {
  if (exiting) return;
  exiting = true;
  await runner?.stop();
  await channel.drain(3_000);
  channel.stop();
  process.exit(code);
}

process.on("SIGTERM", () => void shutdown(0));
process.on("SIGHUP", () => void shutdown(0));
// Ctrl+C typed by an observer-turned-controller must not kill the agent silently.
process.on("SIGINT", () => console_("interrupt the turn from Naru; Ctrl+C is ignored here"));
channel.start();
