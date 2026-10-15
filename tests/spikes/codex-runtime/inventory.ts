import {
  appServer,
  arr,
  fakeEnvironment,
  obj,
  raw,
  Rpc,
  setup,
  startThread,
  str,
  summary,
  turn,
  type Obj,
} from "./harness.js";

const directory = setup("inventory");
const fixture = await fakeEnvironment(directory);
const app = await appServer(directory, fixture.env);
const rpc = await Rpc.connect(app.socket, directory, "inventory");
const results: Obj = {};
function names(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(names);
  if (value === null || typeof value !== "object") return [];
  const item = obj(value);
  return [
    ...(typeof item.name === "string" ? [item.name] : []),
    ...Object.values(item).flatMap((entry) => (typeof entry === "object" ? names(entry) : [])),
  ];
}
try {
  for (const [label, config] of Object.entries({
    default: {},
    disabled: { "features.multi_agent": false, "features.multi_agent_v2": false },
    limited: { "agents.max_threads": 1, "agents.max_depth": 1 },
    noHost: { "features.code_mode_host": false, "features.multi_agent": false },
  })) {
    const threadId = await startThread(rpc, { config });
    const before = fixture.requests.length;
    await turn(rpc, threadId, "SPIKE_TOOL_INVENTORY");
    const request = fixture.requests[before];
    const definitions = [
      request?.tools,
      ...arr(request?.input).filter((item) => obj(item).type === "additional_tools"),
    ];
    const tools = [...new Set(names(definitions))];
    results[label] = {
      toolNames: tools,
      agentTools: tools.filter((name) => /agent|spawn|message|handoff|collab|wait/.test(name)),
    };
    raw(directory, `${label}-tool-schema.json`, definitions);
    const from = rpc.frames.length;
    await turn(rpc, threadId, "SPIKE_SPAWN_CHECK");
    const activity = rpc.frames
      .slice(from)
      .filter(
        (frame) =>
          obj(frame.params?.item).type === "subAgentActivity" &&
          obj(frame.params?.item).kind === "started",
      );
    obj(results[label]).spawnedChild = activity.length > 0;
  }
  const sameConfig = { mcp_servers: {} };
  const first = await startThread(rpc, { config: sameConfig });
  await turn(rpc, first, "SPIKE_UNSAVED_COMPARISON");
  results.loadedThreadStatus = str(
    obj((await rpc.call("thread/read", { threadId: first })).thread).historyMode,
  );
  const other = await startThread(rpc);
  await turn(rpc, other, "SPIKE_INDEPENDENT_ROOT");
  const crossBefore = fixture.requests.length;
  await turn(rpc, first, `SPIKE_CROSS_THREAD=${other}`);
  const outputs = fixture.requests
    .slice(crossBefore)
    .flatMap((request) =>
      arr(request.input).filter((item) => obj(item).type === "function_call_output"),
    );
  raw(directory, "cross-thread-tool-outputs.json", outputs);
  results.nativeCrossRootToolOutputPresent = outputs.length > 0;
  results.nativeCrossRootDelivered = JSON.stringify(
    await rpc.call("thread/read", { threadId: other, includeTurns: true }),
  ).includes("SPIKE_CROSS_MESSAGE");
  results.inventoryRequests = arr(fixture.requests).length;
} catch (error) {
  results.failure = String(error);
  process.exitCode = 1;
} finally {
  rpc.close();
  await app.close();
  await fixture.close();
  summary(directory, results);
}
