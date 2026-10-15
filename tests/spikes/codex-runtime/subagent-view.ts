/**
 * V04b: reproduce `/subagents` → NARU_CODEX_RELAY_FAILED with installed Codex 0.162.1.
 * Viewing a native subagent makes the TUI `thread/resume` the child thread. The production relay
 * state tracker receives that real response; before the fix it rejected any thread with a parent.
 * Uses the synthetic model fixture (no real model, no credentials).
 */
import { CodexInteractionState } from "../../../apps/server/src/codex-interaction-state.js";
import {
  appServer,
  fakeEnvironment,
  obj,
  Rpc,
  setup,
  startThread,
  str,
  summary,
  workspace,
} from "./harness.js";

const directory = setup("subagent-view");
const fixture = await fakeEnvironment(directory);
const app = await appServer(directory, fixture.env);
const parent = await Rpc.connect(app.socket, directory, "parent");
const viewer = await Rpc.connect(app.socket, directory, "viewer");
const results: Record<string, unknown> = {};
try {
  const parentId = await startThread(parent);
  await parent.call("turn/start", {
    threadId: parentId,
    input: [{ type: "text", text: "SPIKE_SPAWN_CHECK SPIKE_SUBAGENT_VIEW" }],
  });
  const activity = await parent.event(
    "item/started",
    0,
    (params) => obj(params.item).type === "subAgentActivity" && obj(params.item).kind === "started",
  );
  const childId = str(obj(activity.params?.item).agentThreadId);
  await parent.event("item/agentMessage/delta", 0, (params) => params.threadId === childId);
  // A thread is resumable by another client only after its first turn is persisted (V02).
  const resumedParent = await viewer.call("thread/resume", { threadId: parentId });
  const resumedChild = await viewer.call("thread/resume", { threadId: childId });
  results.childHasParent = obj(resumedChild.thread).parentThreadId === parentId;

  // Feed the real frames through the relay's tracker exactly as the TUI channel would.
  const state = new CodexInteractionState(workspace, () => undefined);
  state.observeClient({ id: 1, method: "thread/resume", params: { threadId: parentId } });
  state.observeServer({ id: 1, result: resumedParent });
  state.observeClient({ id: 2, method: "thread/resume", params: { threadId: childId } });
  try {
    state.observeServer({ id: 2, result: resumedChild });
    results.childResumeKeepsRelay = true;
  } catch (error) {
    results.childResumeKeepsRelay = false;
    results.error = error instanceof Error ? error.message : "unknown";
  }
  // The Pane must stay bound to the user's thread, not the subagent's.
  state.observeClient({
    id: 3,
    method: "turn/start",
    params: { threadId: parentId, input: [] },
  });
  results.parentStillTracked = true;
} finally {
  summary(directory, results);
  console.log(JSON.stringify(results));
  parent.close();
  viewer.close();
  await app.close();
  await fixture.close();
}
