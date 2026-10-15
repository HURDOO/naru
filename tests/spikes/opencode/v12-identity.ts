import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SPIKE_MODEL,
  SpikeClient,
  report,
  sessionOf,
  spikeConfig,
  waitFor,
  type OpenCodeEvent,
} from "./client.js";

/**
 * V12 identity, policy and injection checks against a spike server started with
 * naru-observer-plugin.mjs and naru-stub-mcp.mjs (see README). Reads the plugin/MCP JSONL logs from
 * OPENCODE_SPIKE_LOG_DIR and prints only booleans and key names.
 */
interface ToolPart {
  readonly type: string;
  readonly tool?: string;
  readonly state?: { readonly status?: string; readonly output?: string; readonly error?: string };
}
interface Message {
  readonly info: { readonly role: string };
  readonly parts: readonly ToolPart[];
}

const config = spikeConfig();
const client = new SpikeClient(config, "v12-identity");
const events: OpenCodeEvent[] = [];
const stream = client.subscribe("/event", (event) => events.push(event));
await stream.ready;
const readJsonl = (name: string) => {
  try {
    return readFileSync(join(config.logDirectory, name), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
};
const run = async (title: string, text: string) => {
  const session = await client.api<{ id: string }>("POST", "/session", {
    title,
    permission: [{ permission: "bash", pattern: "*", action: "allow" }],
  });
  const started = Date.now();
  await client.api("POST", `/session/${session.id}/prompt_async`, {
    model: SPIKE_MODEL,
    parts: [{ type: "text", text }],
  });
  await waitFor(
    () =>
      events.find(
        (event) =>
          event.type === "session.idle" &&
          sessionOf(event) === session.id &&
          (event.receivedAt ?? 0) >= started,
      ),
    240_000,
    "idle",
  );
  const messages = await client.api<Message[]>("GET", `/session/${session.id}/message`);
  const tools = messages.flatMap((message) => message.parts.filter((part) => part.type === "tool"));
  return { id: session.id, tools };
};

const results: Record<string, unknown> = {};
try {
  const identity = await run(
    "[naru-spike] v12 identity",
    "[naru-spike] Do these in order: call the naru_whoami tool; call the whoami tool of the naru_stub MCP server; " +
      "use the bash tool to run exactly: echo SESSION=$NARU_SPIKE_SESSION. Then reply with exactly OK.",
  );
  const whoami = identity.tools.find((tool) => tool.tool === "naru_whoami");
  const stub = identity.tools.find((tool) => tool.tool?.includes("naru_stub"));
  const bash = identity.tools.find((tool) => tool.tool === "bash");
  const pluginLog = readJsonl("plugin.jsonl");
  const mcpLog = readJsonl("mcp.jsonl").filter((record) => record.event === "call");
  results.pluginToolBoundToCallingSession =
    whoami?.state?.output?.includes(`session=${identity.id}`) ?? false;
  results.pluginHookSawWhoami = pluginLog.some(
    (record) => record.hook === "tool.naru_whoami" && record.sessionID === identity.id,
  );
  results.mcpToolName = stub?.tool ?? null;
  results.mcpCallReceived = stub?.state?.status ?? null;
  results.mcpMetaKeys = mcpLog.at(-1)?.metaKeys ?? null;
  results.mcpMetaCarriesSessionId = JSON.stringify(mcpLog.at(-1)?.meta ?? null).includes(
    identity.id,
  );
  results.shellEnvInjectedSessionId =
    bash?.state?.output?.includes(`SESSION=${identity.id}`) ?? false;
  results.chatMessageHookFired = pluginLog.some(
    (record) => record.hook === "chat.message" && record.sessionID === identity.id,
  );
  results.toolBeforeHookTools = [
    ...new Set(
      pluginLog
        .filter(
          (record) => record.hook === "tool.execute.before" && record.sessionID === identity.id,
        )
        .map((record) => record.tool),
    ),
  ];

  const policy = await run(
    "[naru-spike] v12 policy",
    "[naru-spike] Call the webfetch tool once for https://example.invalid/naru-spike. " +
      "Report the exact error text you receive, then reply with exactly DONE.",
  );
  // The server must be started with NARU_SPIKE_BLOCK_TOOLS=webfetch for this check.
  const denied = policy.tools.find((tool) => tool.tool === "webfetch");
  results.policyDenyStatus = denied?.state?.status ?? "not-called";
  results.policyDenyMessageSurfaced =
    `${denied?.state?.error ?? ""}${denied?.state?.output ?? ""}`.includes("NARU_POLICY_DENIED");

  // Runtime MCP registration scope: add an MCP for this directory instance and compare another.
  await client.api("POST", "/mcp", {
    name: "naru_runtime",
    config: {
      type: "local",
      command: [
        process.env.OPENCODE_SPIKE_NODE ?? "/opt/homebrew/bin/node",
        join(import.meta.dirname, "naru-stub-mcp.mjs"),
      ],
      environment: {
        NARU_SPIKE_MCP_TAG: "runtime-added",
        NARU_SPIKE_MCP_LOG: join(config.logDirectory, "mcp.jsonl"),
      },
    },
  });
  const here = await client.api<Record<string, unknown>>("GET", "/mcp");
  const other = new SpikeClient(
    { ...config, directory: process.env.OPENCODE_SPIKE_OTHER_DIRECTORY ?? config.directory },
    "v12-identity-other",
  );
  const there = await other.api<Record<string, unknown>>("GET", "/mcp");
  results.runtimeMcpVisibleInSameDirectory = "naru_runtime" in here;
  results.runtimeMcpVisibleInOtherDirectory = "naru_runtime" in there;
} finally {
  report("results", results);
  stream.close();
}
