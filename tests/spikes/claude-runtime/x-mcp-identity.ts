import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  logDirectory,
  report,
  resultText,
  runPrint,
  spikeEnvironment,
  userMessageLine,
} from "./common.js";
import { ISOLATED_SETTING_SOURCES } from "./hooks.js";

/**
 * Additional check (b): can each Claude session get its own MCP server process with its own
 * session token? Case A/B pass the token in the per-session `--mcp-config` env and run
 * concurrently; case C sets it only on the Claude process env to see whether MCP servers inherit it.
 */
const model = process.env.NARU_SPIKE_MODEL ?? "sonnet";
const stub = fileURLToPath(new URL("./mcp-identity-stub.mjs", import.meta.url));
const stubLog = join(logDirectory(), "x-mcp-identity.stub.jsonl");
const hash = (token: string): string =>
  createHash("sha256").update(token).digest("hex").slice(0, 12);
const prompt =
  "[naru-spike] Call the naru_stub whoami tool once and reply with its exact output only.";

function mcpConfig(env: Record<string, string>): string {
  return JSON.stringify({
    mcpServers: {
      naru_stub: {
        command: process.execPath,
        args: [stub],
        env: { NARU_SPIKE_STUB_LOG: stubLog, ...env },
      },
    },
  });
}

async function session(
  label: string,
  configEnv: Record<string, string>,
  processEnv: Record<string, string>,
) {
  return runPrint({
    label,
    args: [
      ...ISOLATED_SETTING_SOURCES,
      "--model",
      model,
      "--input-format",
      "stream-json",
      "--mcp-config",
      mcpConfig(configEnv),
      "--allowedTools",
      "mcp__naru_stub__whoami",
    ],
    environment: spikeEnvironment(processEnv),
    input: [{ afterMs: 0, line: userMessageLine(prompt) }],
    closeInputWhen: (event) => event.type === "result",
  });
}

const tokenA = randomBytes(16).toString("hex");
const tokenB = randomBytes(16).toString("hex");
const tokenC = randomBytes(16).toString("hex");
const [runA, runB] = await Promise.all([
  session("x-mcp-identity-a", { NARU_SPIKE_AGENT_TOKEN: tokenA }, {}),
  session("x-mcp-identity-b", { NARU_SPIKE_AGENT_TOKEN: tokenB }, {}),
]);
const runC = await session("x-mcp-identity-c", {}, { NARU_SPIKE_AGENT_TOKEN: tokenC });
const pid = (text: string): string | undefined => /pid=(\d+)/.exec(text)?.[1];
const textA = resultText(runA);
const textB = resultText(runB);
const textC = resultText(runC);
report("X-b.mcp-identity", {
  aSeesOwnIdentity: textA.includes(hash(tokenA)),
  aSeesOther: textA.includes(hash(tokenB)),
  bSeesOwnIdentity: textB.includes(hash(tokenB)),
  bSeesOther: textB.includes(hash(tokenA)),
  separateStubProcesses: pid(textA) !== undefined && pid(textA) !== pid(textB),
  processEnvInheritedByStub: textC.includes(hash(tokenC)),
  cIdentityNone: textC.includes("identity=none"),
});
