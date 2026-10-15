import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  appServer,
  arr,
  fakeEnvironment,
  obj,
  raw,
  Rpc,
  setup,
  startThread,
  summary,
  turn,
  type Obj,
} from "./harness.js";
import { startProxy } from "./proxy.js";

const directory = setup("approval");
const extra = [
  "[mcp_servers.naru_stub]",
  `command = ${JSON.stringify(process.execPath)}`,
  `args = ${JSON.stringify(["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("./naru-stub.ts", import.meta.url))])}`,
  "[mcp_servers.naru_stub.env]",
  `NARU_STUB_MAILBOX = ${JSON.stringify(join(directory, "mailbox.json"))}`,
  'NARU_STUB_SENDER = "approval-fixture"',
  'NARU_STUB_ELICIT = "1"',
].join("\n");
const fixture = await fakeEnvironment(directory, extra);
const app = await appServer(directory, fixture.env);
const first = await Rpc.connect(app.socket, directory, "first");
const second = await Rpc.connect(app.socket, directory, "second");
const results: Obj = {};
try {
  const threadId = await startThread(first);
  await turn(first, threadId, "SPIKE_APPROVAL_SEED");
  const from = first.frames.length;
  await second.call("thread/resume", { threadId });
  await first.call("turn/start", { threadId, input: [{ type: "text", text: "SPIKE_ELICIT" }] });
  const request = await first.event("mcpServer/elicitation/request", 0, () => true, 30_000);
  await delay(300);
  const peer = second.frames.find((frame) => frame.method === "mcpServer/elicitation/request");
  results.initiatorReceived = true;
  results.observerReceived = Boolean(peer);
  results.sameRequestId = request.id === peer?.id;
  first.send({ id: request.id!, result: { action: "accept", content: { choice: "Proceed" } } });
  if (peer?.id !== undefined)
    second.send({ id: peer.id, result: { action: "decline", content: null } });
  const elicitation = await first.event(
    "mcpServer/elicitation/request",
    0,
    (params) => obj(params._meta).codex_requires_user_input === true,
  );
  await delay(200);
  const otherElicitation = second.frames.find(
    (frame) =>
      frame.method === "mcpServer/elicitation/request" &&
      obj(frame.params?._meta).codex_requires_user_input === true,
  );
  results.explicitElicitationBroadcast = Boolean(otherElicitation);
  first.send({ id: elicitation.id!, result: { action: "accept", content: { choice: "Proceed" } } });
  if (otherElicitation)
    second.send({ id: otherElicitation.id!, result: { action: "decline", content: null } });
  const completed = await first.event("turn/completed", from);
  await delay(300);
  results.turnStatus = obj(completed.params?.turn).status;
  results.resolvedOnFirst = first.frames.some((frame) => frame.method === "serverRequest/resolved");
  results.resolvedOnSecond = second.frames.some(
    (frame) => frame.method === "serverRequest/resolved",
  );
  results.duplicateResponseErrors = second.frames
    .filter((frame) => frame.error)
    .map((frame) => frame.error?.code);
  first.close();
  second.close();
  const proxy = await startProxy(app.socket, directory);
  const writer = await Rpc.connect(proxy.socket, directory, "gui", true);
  const spectator = await Rpc.connect(proxy.socket, directory, "observer", true);
  try {
    await writer.call("thread/resume", { threadId });
    proxy.enable(threadId);
    results.gateObserverCanSubscribe = Boolean(
      (await spectator.call("thread/resume", { threadId })).thread,
    );
    results.gateResumeOverrideDenied =
      (await spectator.request("thread/resume", { threadId, model: "different-model" })).error
        ?.code === -32071;
    await writer.call("turn/start", {
      threadId,
      input: [{ type: "text", text: "SPIKE_ELICIT_GATE" }],
    });
    const gateRequest = await writer.event("mcpServer/elicitation/request");
    await spectator.event("mcpServer/elicitation/request");
    spectator.send({ id: gateRequest.id!, result: { action: "decline", content: null } });
    await delay(100);
    results.gateApprovalDenied = spectator.frames.some(
      (frame) => frame.error?.code === -32071 && frame.id === gateRequest.id,
    );
    results.gatePendingTransferDenied = proxy.transfer("tui").accepted === false;
    writer.send({
      id: gateRequest.id!,
      result: { action: "accept", content: { choice: "Proceed" } },
    });
    writer.send({
      id: gateRequest.id!,
      result: { action: "accept", content: { choice: "Proceed" } },
    });
    if (!obj(gateRequest.params?._meta).codex_requires_user_input) {
      const nested = await writer.event(
        "mcpServer/elicitation/request",
        0,
        (params) => obj(params._meta).codex_requires_user_input === true,
      );
      writer.send({ id: nested.id!, result: { action: "accept", content: { choice: "Proceed" } } });
    }
    const gateCompleted = await writer.event("turn/completed");
    results.gateCompleted = obj(gateCompleted.params?.turn).status === "completed";
    results.gateDuplicateApprovalDenied = writer.frames.some(
      (frame) => frame.error?.code === -32071 && frame.id === gateRequest.id,
    );
  } finally {
    writer.close();
    spectator.close();
    await proxy.close();
  }
  await app.close();
  const recoveredApp = await appServer(directory, fixture.env);
  const recoveredRpc = await Rpc.connect(recoveredApp.socket, directory, "history");
  try {
    const recovered = await recoveredRpc.call("thread/resume", { threadId });
    const items = arr(obj(recovered.thread).turns).flatMap((entry) => arr(obj(entry).items));
    const toolItems = items.map(obj).filter((item) => item.type === "mcpToolCall");
    results.restartedHistoryHasMcpTool = toolItems.length > 0;
    results.restartedMcpItemFields = Object.keys(toolItems[0] ?? {});
    results.restartedHistoryHasMcpResult = toolItems.some(
      (item) => item.result !== null && item.result !== undefined,
    );
  } finally {
    recoveredRpc.close();
    await recoveredApp.close();
  }
} catch (error) {
  raw(directory, "failure.txt", String(error));
  results.failure = String(error);
  process.exitCode = 1;
} finally {
  first.close();
  second.close();
  await app.close();
  await fixture.close();
  summary(directory, results);
}
