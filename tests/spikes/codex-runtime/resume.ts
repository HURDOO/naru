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
  stop,
  str,
  summary,
  Tui,
  turn,
  until,
  type Obj,
} from "./harness.js";

const directory = setup("resume");
const fixture = await fakeEnvironment(directory);
const results: Obj = {};
let app = await appServer(directory, fixture.env);
let gui = await Rpc.connect(app.socket, directory, "gui-a");
let tui: Tui | undefined;
try {
  const threadId = await startThread(gui);
  await turn(gui, threadId, "SPIKE_GUI_BEFORE_RELEASE");
  const before = await gui.call("thread/read", { threadId, includeTurns: true });
  gui.close();
  await app.close();
  app = await appServer(directory, fixture.env);
  tui = new Tui(directory, fixture.env, ["--remote", `unix://${app.socket}`, "resume", threadId]);
  await until(() => tui?.screen().includes("SPIKE_REPLY_1"), "TUI restored first response");
  await tui.input("SPIKE_TUI_AFTER_RELEASE");
  await until(() => tui?.screen().includes("SPIKE_REPLY_2"), "TUI completes resumed turn");
  await delay(500);
  raw(directory, "screen-tui-resumed.txt", tui.screen());
  await tui.close();
  tui = undefined;
  await app.close();
  app = await appServer(directory, fixture.env);
  gui = await Rpc.connect(app.socket, directory, "gui-b");
  const resumed = await gui.call("thread/resume", { threadId });
  results.sameThread = obj(resumed.thread).id === threadId;
  results.beforeTurns = arr(obj(before.thread).turns).length;
  results.afterTuiTurns = arr(obj(resumed.thread).turns).length;
  results.tuiMessageRecovered = JSON.stringify(resumed).includes("SPIKE_TUI_AFTER_RELEASE");
  results.tuiResponseRecovered = JSON.stringify(resumed).includes("SPIKE_REPLY_2");
  await turn(gui, threadId, "SPIKE_GUI_RETURN_AFTER_RELEASE");
  results.invalidResumeError = (
    await gui.request("thread/resume", { threadId: "00000000-0000-4000-8000-000000000000" })
  ).error?.code;
  results.validThreadSurvivesInvalidResume =
    obj((await gui.call("thread/read", { threadId, includeTurns: true })).thread).id === threadId;
  // API pagination is the supported reconstruction path for paginated threads.
  const paginated = await startThread(gui, { historyMode: "paginated" });
  await turn(gui, paginated, "SPIKE_PAGE_ONE");
  await turn(gui, paginated, "SPIKE_PAGE_TWO");
  gui.close();
  await app.close();
  app = await appServer(directory, fixture.env);
  gui = await Rpc.connect(app.socket, directory, "gui-c");
  await gui.call("thread/resume", { threadId: paginated, excludeTurns: true });
  const pages: Obj[] = [];
  let cursor: unknown = undefined;
  for (let page = 0; page < 10; page++) {
    const result = await gui.call("thread/turns/list", {
      threadId: paginated,
      limit: 1,
      sortDirection: "asc",
      itemsView: "full",
      ...(cursor ? { cursor } : {}),
    });
    pages.push(result);
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  raw(directory, "api-history-pages.json", pages);
  results.paginatedPages = pages.length;
  results.paginatedApiRecoversBothInputs = ["SPIKE_PAGE_ONE", "SPIKE_PAGE_TWO"].every((marker) =>
    JSON.stringify(pages).includes(marker),
  );
  results.paginatedItemTypes = [
    ...new Set(
      pages.flatMap((page) =>
        arr(page.data).flatMap((entry) => arr(obj(entry).items).map((item) => obj(item).type)),
      ),
    ),
  ];
  await gui.call("thread/resume", { threadId });
  tui = new Tui(directory, fixture.env, ["--remote", `unix://${app.socket}`, "resume", threadId]);
  await until(
    () => tui?.screen().includes("SPIKE_GUI_RETURN_AFTER_RELEASE"),
    "TUI attached for failure injection",
  );
  const killFrom = gui.frames.length;
  await tui.input("SPIKE_SLOW_TUI_KILL");
  await gui.event("turn/started", killFrom);
  await tui.close(true);
  tui = undefined;
  const afterKill = await gui.event("turn/completed", killFrom);
  results.tuiKillBackendStatus = obj(afterKill.params?.turn).status;
  const crashFrom = gui.frames.length;
  await gui.call("turn/start", {
    threadId,
    input: [{ type: "text", text: "SPIKE_SLOW_APP_CRASH" }],
  });
  await gui.event("item/agentMessage/delta", crashFrom);
  await stop(app.child, "SIGKILL");
  gui.close();
  app = await appServer(directory, fixture.env);
  gui = await Rpc.connect(app.socket, directory, "gui-d");
  const recovered = await gui.call("thread/resume", { threadId });
  const lastTurn = obj(arr(obj(recovered.thread).turns).at(-1));
  results.crashSameThread = obj(recovered.thread).id === threadId;
  results.crashLastStatus = lastTurn.status;
  results.crashLastItemTypes = arr(lastTurn.items).map((item) => obj(item).type);
  results.crashInputPersisted = JSON.stringify(recovered).includes("SPIKE_SLOW_APP_CRASH");
  const recoveredTurn = await turn(gui, threadId, "SPIKE_POST_CRASH_CONTINUE");
  results.postCrashTurnStatus = obj(recoveredTurn.params?.turn).status;
  results.recoveredHistoryMode = str(obj(recovered.thread).historyMode);
} catch (error) {
  raw(directory, "failure.txt", String(error));
  results.failure = String(error);
  process.exitCode = 1;
  if (tui) raw(directory, "screen-failure.txt", tui.screen());
} finally {
  await tui?.close();
  gui.close();
  await app.close();
  await fixture.close();
  summary(directory, results);
}
