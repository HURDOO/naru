import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DurableSessionOperationRequestSchema } from "../../../packages/contracts/src/durable-session/v0/protocol.js";
import { DurableSessionHostConfigSchema } from "../../../apps/durable-session-host/src/config.js";
import { startDurableSessionHost } from "../../../apps/durable-session-host/src/host.js";
import { silentHostLogger } from "../../../apps/durable-session-host/src/logging.js";
import {
  createHostFixture,
  ownerCaller,
  profileCommand,
} from "../../../apps/durable-session-host/test/support.js";
import {
  appServer,
  fakeEnvironment,
  obj,
  raw,
  Rpc,
  setup,
  str,
  summary,
  turn,
  until,
  type Obj,
} from "./harness.js";

const directory = setup("durable");
const model = await fakeEnvironment(directory);
const fixture = createHostFixture();
const config = DurableSessionHostConfigSchema.parse({
  ...fixture.config,
  profiles: [
    {
      ...fixture.config.profiles[0],
      args: [
        "--import",
        import.meta.resolve("tsx"),
        fileURLToPath(new URL("./console.ts", import.meta.url)),
      ],
    },
  ],
  environmentPolicies: [
    {
      envPolicyId: "safe-env",
      inherit: [],
      values: { ...model.env, NARU_SPIKE_DIRECTORY: directory },
    },
  ],
  resourcePolicies: [{ ...fixture.config.resourcePolicies[0], stopTimeoutMs: 8000 }],
});
let host = await startDurableSessionHost(config, { logger: silentHostLogger, hostEnvironment: {} });
let rpc: Rpc | undefined;
const results: Obj = {};
const operation = async (request: Obj): Promise<Obj> => {
  const reply = await host.service.execute(
    ownerCaller(Date.now()),
    DurableSessionOperationRequestSchema.parse({ version: 0, requestId: randomUUID(), ...request }),
  );
  raw(directory, "host-operations.jsonl", {
    operation: request.operation,
    ok: reply.ok,
    ...(reply.ok ? {} : { error: reply.error }),
  });
  if (!reply.ok) return { failure: reply.error };
  return reply.result;
};
try {
  const created = obj(
    (
      await operation({
        operation: "createSession",
        idempotencyKey: randomUUID(),
        command: profileCommand(),
      })
    ).session,
  );
  const sessionId = str(created.sessionId);
  const runtimeId = str(created.runtimeId);
  if (!sessionId) throw new Error("Host create failed");
  await until(
    () => existsSync(join(directory, "bridge.json")),
    "console protocol ready",
    20_000,
  ).catch(async (error: unknown) => {
    raw(
      directory,
      "console-startup-failure.txt",
      (await host.service.terminalSnapshot(sessionId)).serializedState,
    );
    throw error;
  });
  const bridge = JSON.parse(readFileSync(join(directory, "bridge.json"), "utf8")) as {
    socket: string;
    threadId: string;
  };
  rpc = await Rpc.connect(bridge.socket, directory, "gui");
  await rpc.call("thread/resume", { threadId: bridge.threadId });
  const first = obj((await operation({ operation: "openAttachment", sessionId })).attachment);
  const second = obj((await operation({ operation: "openAttachment", sessionId })).attachment);
  const a = str(first.attachmentId);
  const b = str(second.attachmentId);
  const caller = ownerCaller(Date.now());
  const unbindA = await host.service.bindStreamAttachment(
    caller,
    sessionId,
    a,
    "spike-a",
    () => undefined,
  );
  const unbindB = await host.service.bindStreamAttachment(
    caller,
    sessionId,
    b,
    "spike-b",
    () => undefined,
  );
  await operation({
    operation: "acquireControl",
    sessionId,
    attachmentId: a,
    expectedRuntimeId: runtimeId,
    expectedControllerGeneration: 0,
    terminal: { cols: 100, rows: 30 },
  });
  const common = { sessionId, expectedRuntimeId: runtimeId, expectedControllerGeneration: 1 };
  results.observerInputError = obj(
    (
      await operation({
        operation: "sendInput",
        ...common,
        attachmentId: b,
        inputId: randomUUID(),
        data: "SPIKE_OBSERVER\n",
      })
    ).failure,
  ).code;
  await operation({
    operation: "sendInput",
    ...common,
    attachmentId: a,
    inputId: randomUUID(),
    data: '{"id":99,"method":"turn/start"}\n',
  });
  await operation({
    operation: "resizeTerminal",
    ...common,
    attachmentId: a,
    terminal: { cols: 120, rows: 40 },
  });
  const request = obj(
    (
      await operation({
        operation: "requestControl",
        sessionId,
        attachmentId: b,
        expectedControllerGeneration: 1,
      })
    ).request,
  );
  const offer = obj(
    (
      await operation({
        operation: "approveControl",
        sessionId,
        attachmentId: a,
        controlRequestId: request.controlRequestId,
        expectedControllerGeneration: 1,
      })
    ).offer,
  );
  const accepted = obj(
    (
      await operation({
        operation: "acceptControl",
        sessionId,
        attachmentId: b,
        controlOfferId: offer.controlOfferId,
        expectedRuntimeId: runtimeId,
        expectedControllerGeneration: 1,
        terminal: { cols: 90, rows: 25 },
        idempotencyKey: randomUUID(),
      })
    ).control,
  );
  results.singleControllerHandoff =
    accepted.controllerAttachmentId === b && accepted.controllerGeneration === 2;
  results.staleInputError = obj(
    (
      await operation({
        operation: "sendInput",
        ...common,
        attachmentId: a,
        inputId: randomUUID(),
        data: "SPIKE_STALE\n",
      })
    ).failure,
  ).code;
  unbindB();
  await host.service.disconnectStreamAttachment(caller, sessionId, b);
  const reattached = obj(
    (
      await operation({
        operation: "resumeAttachment",
        sessionId,
        attachmentId: b,
        expectedRuntimeId: runtimeId,
        expectedControllerGeneration: 2,
        attachmentResumeToken: second.attachmentResumeToken,
      })
    ).attachment,
  );
  results.reconnectPreservedController = reattached.role === "controller";
  results.reconnectRotatedToken = reattached.attachmentResumeToken !== second.attachmentResumeToken;
  const completed = await turn(rpc, bridge.threadId, "SPIKE_AFTER_PTY_CONTROL");
  results.protocolTurnStatus = obj(completed.params?.turn).status;
  await delay(300);
  const snapshot = await host.service.terminalSnapshot(sessionId);
  raw(directory, "console-snapshot.txt", snapshot.serializedState);
  results.consoleShowsEvents = snapshot.serializedState.includes("EVENT turn/completed");
  results.inputIgnored = snapshot.serializedState.includes("CONSOLE_INPUT_IGNORED");
  results.consoleOmitsModelText = !snapshot.serializedState.includes("SPIKE_REPLY_");
  results.geometry = snapshot.terminal;
  results.inputDidNotCreateTurn =
    rpc.frames.filter((frame) => frame.method === "turn/started").length === 1;
  unbindA();
  rpc.close();
  rpc = undefined;
  await host.close();
  host = await startDurableSessionHost(config, { logger: silentHostLogger, hostEnvironment: {} });
  const recovered = obj((await operation({ operation: "getSession", sessionId })).session);
  results.hostRestartStopped = recovered.lifecycle === "stopped" && recovered.runtimeId === null;
  const fresh = await appServer(directory, model.env);
  const recoveredRpc = await Rpc.connect(fresh.socket, directory, "recovered");
  try {
    const resumed = await recoveredRpc.call("thread/resume", { threadId: bridge.threadId });
    results.threadResumeAfterHostRestart =
      obj(resumed.thread).id === bridge.threadId &&
      JSON.stringify(resumed).includes("SPIKE_AFTER_PTY_CONTROL");
  } finally {
    recoveredRpc.close();
    await fresh.close();
  }
  results.node = process.version;
  results.nativeNodeCanonical =
    realpathSync(process.execPath) === fixture.config.profiles[0]?.executable;
} catch (error) {
  raw(directory, "failure.txt", error instanceof Error ? error.stack : String(error));
  results.failure = String(error);
  process.exitCode = 1;
} finally {
  rpc?.close();
  await host.close();
  await model.close();
  summary(directory, results);
}
