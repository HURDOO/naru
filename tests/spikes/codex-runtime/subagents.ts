import {
  appServer,
  arr,
  obj,
  raw,
  Rpc,
  setup,
  startThread,
  str,
  summary,
  turn,
  until,
  type Obj,
} from "./harness.js";

if (process.env.NARU_SPIKE_REAL_MODEL !== "1")
  throw new Error("Set NARU_SPIKE_REAL_MODEL=1 for authorized real-model verification");
const directory = setup("subagents");
const app = await appServer(directory, process.env, [
  "-c",
  "features.multi_agent=true",
  "-c",
  "features.multi_agent_v2=false",
  "-c",
  "agents.max_threads=2",
  "-c",
  "mcp_servers={}",
]);
const rpc = await Rpc.connect(app.socket, directory, "native");
const observer = await Rpc.connect(app.socket, directory, "child-observer");
const results: Obj = {};
try {
  const catalog = await rpc.call("model/list", { includeHidden: false });
  results.modelCatalog = arr(catalog.data).map((entry) => ({
    id: obj(entry).id,
    model: obj(entry).model,
    isDefault: obj(entry).isDefault,
  }));
  const parent = await startThread(rpc, {
    developerInstructions:
      "This is an authorized, bounded runtime protocol experiment. Use only native subagent tools and a short /bin/sleep command in the scratch workspace. No file edits, network tools, or external MCP tools. Spawn exactly one child only when requested.",
  });
  await rpc.call("turn/start", {
    threadId: parent,
    input: [
      {
        type: "text",
        text: "[naru-spike] Verify native subagent lifecycle. Spawn exactly one child with task: emit a short progress message, run /bin/sleep 15, then report completion. Parent must wait for this child and close it after completion. Do not perform any other work.",
      },
    ],
    effort: "low",
  });
  const childEvent = await until(
    () =>
      rpc.frames.find(
        (frame) =>
          obj(frame.params?.item).type === "subAgentActivity" &&
          str(obj(frame.params?.item).agentThreadId) !== "",
      ),
    "native child starts",
    180_000,
  );
  const child = str(obj(childEvent.params?.item).agentThreadId);
  results.parentActivityContainsChildId = Boolean(child);
  const resumed = await observer.request("thread/resume", { threadId: child });
  results.childResumeError = resumed.error?.code ?? null;
  results.canAcceptDirectInput = obj(resumed.result?.thread).canAcceptDirectInput;
  results.childHasParentId = obj(resumed.result?.thread).parentThreadId === parent;
  results.childSourceKind = Object.keys(obj(obj(resumed.result?.thread).source));
  const active = await observer
    .event(
      "item/started",
      0,
      (params) => params.threadId === child && obj(params.item).type === "commandExecution",
      120_000,
    )
    .catch(() => undefined);
  results.childCommandLive = Boolean(active);
  const injection = await observer.request("turn/start", {
    threadId: child,
    input: [
      {
        type: "text",
        text: "[naru-spike] Direct child intervention: include the marker CHILD_DIRECT_ACK in the completion, with no additional work.",
      },
    ],
  });
  results.directChildInputError = injection.error?.code ?? null;
  if (injection.error) {
    const activeTurn = observer.frames.findLast(
      (frame) => frame.method === "turn/started" && frame.params?.threadId === child,
    );
    const turnId = str(obj(activeTurn?.params?.turn).id) || str(active?.params?.turnId);
    const steer = await observer.request("turn/steer", {
      threadId: child,
      expectedTurnId: turnId,
      input: [{ type: "text", text: "[naru-spike] Child intervention marker CHILD_DIRECT_ACK." }],
    });
    results.directChildSteerError = steer.error?.code ?? null;
  }
  await rpc.event("turn/completed", 0, (params) => params.threadId === parent, 180_000);
  results.childLiveDelta = observer.frames.some(
    (frame) => frame.method === "item/agentMessage/delta" && frame.params?.threadId === child,
  );
  results.childDirectAck = JSON.stringify(observer.frames).includes("CHILD_DIRECT_ACK");
  results.parentToolKinds = [
    ...new Set(
      rpc.frames
        .filter(
          (frame) =>
            frame.method === "item/completed" &&
            obj(frame.params?.item).type === "collabAgentToolCall",
        )
        .map((frame) => obj(frame.params?.item).tool),
    ),
  ];
  results.childClosedEvent = rpc.frames.some(
    (frame) => frame.method === "thread/closed" && frame.params?.threadId === child,
  );
  const childRead = await rpc.request("thread/read", { threadId: child, includeTurns: true });
  results.childHistoryViaApi =
    !childRead.error && arr(obj(childRead.result?.thread).turns).length > 0;
  results.realModelTurnStatus = obj(
    rpc.frames.findLast(
      (frame) => frame.method === "turn/completed" && frame.params?.threadId === parent,
    )?.params?.turn,
  ).status;
  const disabled = await startThread(rpc, {
    config: { "features.multi_agent": false },
    developerInstructions:
      "Runtime capability probe only. Do not use shell, files, MCP or network. State whether the native spawn_agent tool is available. Do not spawn.",
  });
  const disabledFrom = rpc.frames.length;
  await turn(
    rpc,
    disabled,
    "[naru-spike] Is the native spawn_agent tool available to you in this thread? Answer AVAILABLE or UNAVAILABLE; do not emulate it or run other tools.",
    120_000,
  );
  results.disabledReportedUnavailable = rpc.frames
    .slice(disabledFrom)
    .some(
      (frame) =>
        frame.method === "item/completed" &&
        obj(frame.params?.item).type === "agentMessage" &&
        str(obj(frame.params?.item).text).includes("UNAVAILABLE"),
    );
} catch (error) {
  raw(directory, "failure.txt", error instanceof Error ? error.stack : String(error));
  results.failure = String(error);
  process.exitCode = 1;
} finally {
  rpc.close();
  observer.close();
  await app.close();
  summary(directory, results);
}
