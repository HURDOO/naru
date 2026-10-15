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
  str,
  summary,
  Tui,
  turn,
  until,
  type Obj,
} from "./harness.js";
import { startProxy } from "./proxy.js";

const directory = setup("shared");
const results: Obj = {};
const fixture = await fakeEnvironment(directory);
const app = await appServer(directory, fixture.env);
const proxy = await startProxy(app.socket, directory);
const gui = await Rpc.connect(proxy.socket, directory, "gui", true);
let tui: Tui | undefined;
try {
  const threadId = await startThread(gui);
  await turn(gui, threadId, "SPIKE_GUI_FIRST");
  tui = new Tui(directory, fixture.env, ["--remote", `unix://${proxy.socket}`, "resume", threadId]);
  await until(
    () =>
      proxy.events.find(
        (event) => event.channel === "tui" && event.frame.method === "thread/resume",
      ),
    "TUI resumes same thread",
  );
  await delay(1500);
  raw(directory, "screen-resumed.txt", tui.screen());
  const from = proxy.events.length;
  const guiFrom = gui.frames.length;
  const started = await gui.call("turn/start", {
    threadId,
    input: [{ type: "text", text: "SPIKE_SLOW_GUI_LIVE" }],
  });
  await gui.event("item/agentMessage/delta", guiFrom);
  await delay(350);
  raw(directory, "screen-live.txt", tui.screen());
  results.tuiLiveGuiDelta = tui.screen().includes("SPIKE_REPLY_2");
  results.tuiReceivedGuiDelta = proxy.events
    .slice(from)
    .some((event) => event.channel === "tui" && event.frame.method === "item/agentMessage/delta");
  results.tuiReceivedGuiTurnStarted = proxy.events
    .slice(from)
    .some((event) => event.channel === "tui" && event.frame.method === "turn/started");
  await tui.input("SPIKE_CONCURRENT_TUI");
  await gui.event("turn/completed", guiFrom);
  await delay(1200);
  const starts = proxy.events
    .slice(from)
    .filter(
      (event) =>
        event.direction === "client->proxy" &&
        event.frame.method === "turn/start" &&
        event.frame.params?.threadId === threadId,
    );
  results.nativeConcurrent = starts.map((event) => {
    const reply = proxy.events.find(
      (candidate) =>
        candidate.channel === event.channel &&
        candidate.direction === "server->client" &&
        !candidate.frame.method &&
        candidate.frame.id === event.frame.id,
    );
    return {
      channel: event.channel,
      method: event.frame.method,
      error: reply?.frame.error?.code,
      turnIdMatches: obj(reply?.frame.result?.turn).id === obj(started.turn).id,
    };
  });
  results.directInputShape = starts
    .filter((event) => event.channel === "tui")
    .map((event) => ({
      method: event.frame.method,
      fields: Object.keys(event.frame.params ?? {}),
      inputFields: arr(event.frame.params?.input).map((item) => Object.keys(obj(item))),
    }));
  proxy.enable(threadId);
  const gateFrom = proxy.events.length;
  await tui.input("SPIKE_DENIED_TUI");
  await delay(600);
  results.observerWriteDenied = proxy.events
    .slice(gateFrom)
    .some((event) => event.direction === "proxy->rejected" && event.frame.error?.code === -32071);
  results.unknownDenied = (await gui.request("spike/unknown")).error?.code === -32071;
  results.settingsDenied =
    (await gui.request("config/value/write", { keyPath: "spike", value: true })).error?.code ===
    -32071;
  const boundary = gui.frames.length;
  const active = await gui.call("turn/start", {
    threadId,
    input: [{ type: "text", text: "SPIKE_SLOW_WAIT_HANDOFF" }],
  });
  await gui.event("turn/started", boundary);
  results.activeTransfer = proxy.transfer("tui");
  await gui.event("turn/completed", boundary);
  results.waitTransfer = proxy.transfer("tui");
  results.oldGuiDenied =
    (
      await gui.request("turn/start", {
        threadId,
        input: [{ type: "text", text: "SPIKE_DENIED_GUI" }],
      })
    ).error?.code === -32071;
  results.observerRead = Boolean(
    (await gui.call("thread/read", { threadId, includeTurns: true })).thread,
  );
  const tuiTurnFrom = gui.frames.length;
  await tui.input("SPIKE_TUI_WRITER");
  await gui.event("turn/completed", tuiTurnFrom);
  results.tuiWriterObservedByGui = true;
  results.returnToGui = proxy.transfer("gui");
  const interruptFrom = gui.frames.length;
  const interrupt = await gui.call("turn/start", {
    threadId,
    input: [{ type: "text", text: "SPIKE_SLOW_INTERRUPT" }],
  });
  await gui.event(
    "item/agentMessage/delta",
    interruptFrom,
    (params) => params.threadId === threadId,
  );
  await gui.call("turn/interrupt", { threadId, turnId: str(obj(interrupt.turn).id) });
  const completed = await gui.event("turn/completed", interruptFrom);
  results.interruptStatus = obj(completed.params?.turn).status;
  results.interruptTransfer = proxy.transfer("tui");
  results.finalTransfer = proxy.transfer("gui");
  await turn(gui, threadId, "SPIKE_GUI_RETURN");
  const read = await gui.call("thread/read", { threadId, includeTurns: true });
  results.sameThread = obj(read.thread).id === threadId;
  results.turnCount = arr(obj(read.thread).turns).length;
  results.waitTurnWasDistinct = obj(active.turn).id !== obj(started.turn).id;
  raw(directory, "screen-final.txt", tui.screen());
  results.directInputShape = proxy.events
    .filter(
      (event) =>
        event.channel === "tui" &&
        event.direction === "client->proxy" &&
        event.frame.method === "turn/start" &&
        event.frame.params?.threadId === threadId,
    )
    .map((event) => ({
      method: event.frame.method,
      fields: Object.keys(event.frame.params ?? {}),
      inputFields: arr(event.frame.params?.input).map((item) => Object.keys(obj(item))),
    }));
  const peerA = await Rpc.connect(app.socket, directory, "native-a");
  const peerB = await Rpc.connect(app.socket, directory, "native-b");
  try {
    const nativeThread = await startThread(peerA);
    await turn(peerA, nativeThread, "SPIKE_NATIVE_SEED");
    await peerB.call("thread/resume", { threadId: nativeThread });
    const nativeFrom = peerA.frames.length;
    const first = await peerA.call("turn/start", {
      threadId: nativeThread,
      input: [{ type: "text", text: "SPIKE_SLOW_NATIVE" }],
    });
    await peerA.event("item/agentMessage/delta", nativeFrom);
    const second = await peerB.request("turn/start", {
      threadId: nativeThread,
      input: [{ type: "text", text: "SPIKE_NATIVE_CONCURRENT" }],
    });
    results.nativePeerError = second.error?.code ?? null;
    results.nativePeerSameTurn = obj(second.result?.turn).id === obj(first.turn).id;
    await peerA.event("turn/completed", nativeFrom);
    results.nativePeerBothInputs = ["SPIKE_SLOW_NATIVE", "SPIKE_NATIVE_CONCURRENT"].every(
      (marker) => JSON.stringify(peerA.frames).includes(marker),
    );
  } finally {
    peerA.close();
    peerB.close();
  }
} catch (error) {
  raw(directory, "failure.txt", String(error));
  results.failure = String(error);
  if (tui) raw(directory, "screen-failure.txt", tui.screen());
  process.exitCode = 1;
} finally {
  await tui?.close();
  gui.close();
  await proxy.close();
  await app.close();
  await fixture.close();
  summary(directory, results);
}
