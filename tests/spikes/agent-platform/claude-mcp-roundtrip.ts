/**
 * Real-model check that the installed Claude Code CLI can use the Naru MCP bin (AP-T11):
 * a worker reads the verbatim user instruction and an orchestrator records a delegation that Naru
 * binds to the orchestrator's capability. Requires NARU_SPIKE_REAL_MODEL=1 and NARU_SPIKE_CLAUDE.
 * Raw CLI output stays in the owner-only experiments directory; stdout prints booleans only.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Actor } from "../../../packages/contracts/src/naru-agent/v1/index.js";
import { AgentPlatformCore } from "../../../apps/server/src/agent-platform/core.js";
import {
  AgentSocketServer,
  NARU_AGENT_CAPABILITY_ENV,
  NARU_AGENT_SOCKET_ENV,
} from "../../../apps/server/src/agent-platform/agent-socket.js";
import { NaruRepository } from "../../../apps/server/src/database.js";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "../../..");
const HUMAN: Actor = { kind: "human" };
const DELEGATION = "공식 확장 지점만 사용해 구현하라.";

if (process.env.NARU_SPIKE_REAL_MODEL !== "1" || !process.env.NARU_SPIKE_CLAUDE) {
  throw new Error("Set NARU_SPIKE_REAL_MODEL=1 and NARU_SPIKE_CLAUDE to run this spike.");
}
const claude = process.env.NARU_SPIKE_CLAUDE;
const runDirectory = resolve(
  process.env.NARU_SPIKE_LOG_DIR ??
    resolve(repositoryRoot, "../../experiments/naru-agent-spikes/agent-platform"),
  "runs",
  `claude-mcp-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
mkdirSync(resolve(runDirectory, "workspace"), { recursive: true, mode: 0o700 });

const repository = new NaruRepository(":memory:");
const project = repository.createProject("/tmp/naru-spike-mcp-project", "spike");
const core = new AgentPlatformCore(repository.agentPlatform);
let ordinal = 0;
const ctx = () => ({
  actor: HUMAN,
  idempotencyKey: `70000000-0000-4000-8000-${String(++ordinal).padStart(12, "0")}`,
});
const register = (role: "project-orchestrator" | "worker") =>
  core.registerAgentSession(ctx(), {
    projectId: project.id,
    role,
    runtime: "claude",
    native: false,
    observation: "transcript",
    conversationWriter: "orchestrator",
  }).id;
const orchestrator = register("project-orchestrator");
const worker = register("worker");
const goal = core.createHumanInstruction(ctx(), {
  scope: { kind: "project", projectId: project.id },
  verbatim: "Kiro 기존 에이전트에 Hook/MCP로 가이드를 연결해 줘. (naru-spike marker 7Q)",
});
const server = new AgentSocketServer(runDirectory, core);
await server.start();

async function runClaude(name: string, token: string, tool: string, prompt: string) {
  const mcpConfig = resolve(runDirectory, `${name}.mcp.json`);
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        naru: {
          command: process.execPath,
          args: [
            "--import",
            pathToFileURL(resolve(repositoryRoot, "node_modules/tsx/dist/loader.mjs")).href,
            resolve(repositoryRoot, "apps/server/src/agent-mcp-cli.ts"),
          ],
          env: { [NARU_AGENT_SOCKET_ENV]: server.socketPath, [NARU_AGENT_CAPABILITY_ENV]: token },
        },
      },
    }),
    { mode: 0o600 },
  );
  const environment: Record<string, string> = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
  for (const key of ["HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "SHELL"]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  // Async on purpose: the Naru socket server lives in this process and must keep serving.
  const child = spawn(
    claude,
    [
      "-p",
      "--output-format",
      "json",
      "--model",
      "sonnet",
      "--mcp-config",
      mcpConfig,
      "--strict-mcp-config",
      // Variadic flag: the prompt goes through stdin so it is not taken as a tool name.
      "--allowedTools",
      `mcp__naru__${tool}`,
    ],
    { cwd: resolve(runDirectory, "workspace"), env: environment, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  child.stdin.end(prompt);
  const timer = setTimeout(() => child.kill(), 240_000);
  const status = await new Promise<number | null>((resolveExit) => child.on("close", resolveExit));
  clearTimeout(timer);
  writeFileSync(resolve(runDirectory, `${name}.stdout.json`), stdout, { mode: 0o600 });
  writeFileSync(resolve(runDirectory, `${name}.stderr.log`), stderr, { mode: 0o600 });
  return { status, stdout };
}

try {
  const read = await runClaude(
    "worker-read",
    core.issueAgentCapability(HUMAN, worker),
    "get_applicable_user_instructions",
    "[naru-spike] Call the naru tool get_applicable_user_instructions with no arguments. " +
      "Reply with only the marker that appears inside the instruction text, e.g. 'marker XX'.",
  );
  const delegate = await runClaude(
    "orchestrator-delegate",
    core.issueAgentCapability(HUMAN, orchestrator),
    "delegate",
    "[naru-spike] Call the naru tool delegate exactly once with these arguments: " +
      JSON.stringify({
        scope_kind: "agent",
        project_id: project.id,
        agent_session_id: worker,
        origin_user_instruction_id: goal.id,
        verbatim: DELEGATION,
      }) +
      ". Then reply DONE.",
  );
  const delegations = core
    .getApplicableInstructions(HUMAN, { projectId: project.id, agentSessionId: worker })
    .filter((instruction) => instruction.author.kind === "agent");
  const recorded = repository.agentPlatform
    .readEvents({ afterSeq: 0, limit: 100 })
    .filter((event) => event.type === "instruction.created" && event.actor.kind === "agent")
    .map((event) => repository.agentPlatform.getInstruction(event.subjectId));
  const summary = {
    runDirectory: runDirectory.split("/").slice(-1)[0],
    workerExit: read.status,
    workerSawVerbatimInstruction: read.stdout.includes("7Q"),
    orchestratorExit: delegate.status,
    delegationRecorded: recorded.length === 1,
    delegationBoundToOrchestrator:
      recorded[0]?.author.kind === "agent" && recorded[0].author.agentSessionId === orchestrator,
    delegationVerbatimPreserved: recorded[0]?.verbatim === DELEGATION,
    delegationCitesOrigin: recorded[0]?.originUserInstructionId === goal.id,
    humanOnlyListUnchanged: delegations.length === 0,
  };
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await server.close();
  repository.close();
}
