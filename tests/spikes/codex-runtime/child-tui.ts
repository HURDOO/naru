import { setTimeout as delay } from "node:timers/promises";
import {
  appServer,
  fakeEnvironment,
  obj,
  raw,
  Rpc,
  setup,
  startThread,
  str,
  summary,
  Tui,
  until,
  type Obj,
} from "./harness.js";
import { startProxy } from "./proxy.js";

const directory = setup("child-tui");
const fixture = await fakeEnvironment(directory);
const app = await appServer(directory, fixture.env);
const proxy = await startProxy(app.socket, directory);
const parent = await Rpc.connect(app.socket, directory, "parent");
const observer = await Rpc.connect(app.socket, directory, "child");
let tui: Tui | undefined;
const results: Obj = {};
try {
  const parentId = await startThread(parent);
  await parent.call("turn/start", {
    threadId: parentId,
    input: [{ type: "text", text: "SPIKE_SPAWN_CHECK SPIKE_CHILD_TUI" }],
  });
  const activity = await parent.event(
    "item/started",
    0,
    (params) => obj(params.item).type === "subAgentActivity" && obj(params.item).kind === "started",
  );
  const childId = str(obj(activity.params?.item).agentThreadId);
  await parent.event("item/agentMessage/delta", 0, (params) => params.threadId === childId);
  const resumed = await observer.call("thread/resume", { threadId: childId });
  results.canAcceptDirectInput = obj(resumed.thread).canAcceptDirectInput;
  const delta = await observer.event(
    "item/agentMessage/delta",
    0,
    (params) => params.threadId === childId,
  );
  tui = new Tui(directory, fixture.env, ["--remote", `unix://${proxy.socket}`, "resume", childId]);
  await until(
    () =>
      proxy.events.some(
        (event) =>
          event.frame.method === "thread/resume" && event.frame.params?.threadId === childId,
      ),
    "child TUI resumes same id",
  );
  await until(
    () => tui?.screen().includes(str(delta.params?.delta)),
    "child delta visible in actual TUI",
  );
  results.remoteTuiObservedChild = true;
  results.newObserverPtyCreated = true;
  raw(directory, "child-tui-live.txt", tui.screen());
  await tui.input("SPIKE_CHILD_TUI_DIRECT_INPUT");
  await delay(400);
  results.tuiWriteAttempts = proxy.events.filter(
    (event) =>
      event.direction === "client->proxy" &&
      event.frame.method === "turn/start" &&
      event.frame.params?.threadId === childId,
  ).length;
  results.tuiWriteErrors = proxy.events
    .filter((event) => event.direction === "server->client" && event.frame.error)
    .map((event) => event.frame.error?.code);
  const direct = await observer.request("turn/start", {
    threadId: childId,
    input: [{ type: "text", text: "SPIKE_CHILD_API_DIRECT_INPUT" }],
  });
  results.directInputError = direct.error?.code ?? null;
  await observer.event("turn/completed", 0, (params) => params.threadId === childId);
  results.inputRecorded = JSON.stringify(
    await observer.call("thread/read", { threadId: childId, includeTurns: true }),
  ).includes("SPIKE_CHILD_TUI_DIRECT_INPUT");
  raw(directory, "child-tui-final.txt", tui.screen());
} catch (error) {
  raw(directory, "failure.txt", String(error));
  if (tui) raw(directory, "child-tui-failure.txt", tui.screen());
  results.failure = String(error);
  process.exitCode = 1;
} finally {
  await tui?.close();
  parent.close();
  observer.close();
  await proxy.close();
  await app.close();
  await fixture.close();
  summary(directory, results);
}
