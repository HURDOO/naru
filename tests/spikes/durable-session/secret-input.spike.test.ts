/**
 * V10: 실제 PTY의 echo-off 비밀번호 프롬프트에 controller가 입력한 값이 observer stream, snapshot,
 * event journal에 남는지 확인한다. 실제 PTY가 필요하므로 `NARU_SPIKE_ACTUAL_PTY=1`에서만 실행한다.
 * 비밀값은 식별 불가능한 fixture 문자열이다.
 */
import { describe, expect, it } from "vitest";
import type {
  AttachmentLease,
  DurableSessionCallerContext,
  DurableSessionEvent,
  DurableSessionOperationResponse,
  DurableSessionOperationResult,
  SessionId,
} from "../../../packages/contracts/src/durable-session/v0/index.js";
import { DurableSessionHostConfigSchema } from "../../../apps/durable-session-host/src/config.js";
import { HostCommandPolicy } from "../../../apps/durable-session-host/src/command-policy.js";
import { MemoryMetadataRepository } from "../../../apps/durable-session-host/src/metadata.js";
import { NodePtyRuntimePort } from "../../../apps/durable-session-host/src/runtime.js";
import { SessionService } from "../../../apps/durable-session-host/src/session-service.js";
import {
  createHostFixture,
  FakeClock,
  FakeIds,
  ownerCaller,
  profileCommand,
} from "../../../apps/durable-session-host/test/support.js";

const SECRET = "fixture-secret-7Q9";
const VISIBLE = "fixture-visible-K2";
const SCRIPT = [
  'read -r -s -p "Password: " secret',
  'printf "\\nLEN=%s\\n" "${#secret}"',
  'read -r -p "Visible: " visible',
  'printf "GOT=%s\\n" "$visible"',
  "sleep 30",
].join("; ");

describe.skipIf(process.env.NARU_SPIKE_ACTUAL_PTY !== "1")(
  "V10 secret input on an actual PTY",
  () => {
    it("keeps an echo-off answer out of observer streams, snapshots and the event journal", async () => {
      const fixture = createHostFixture();
      const profile = fixture.config.profiles[0];
      const resource = fixture.config.resourcePolicies[0];
      if (profile === undefined || resource === undefined) throw new Error("fixture missing");
      const config = DurableSessionHostConfigSchema.parse({
        ...fixture.config,
        profiles: [
          { ...profile, executable: "/bin/bash", args: ["--noprofile", "--norc", "-c", SCRIPT] },
        ],
        resourcePolicies: [
          { ...resource, allowedExecutables: [...resource.allowedExecutables, "/bin/bash"] },
        ],
      });
      const clock = new FakeClock();
      const service = new SessionService({
        metadata: new MemoryMetadataRepository(),
        runtime: new NodePtyRuntimePort(),
        commandPolicy: new HostCommandPolicy(config, {}),
        sessionLimit: config.sessionLimit,
        idempotencyTtlMs: config.idempotencyTtlMs,
        maxAttachmentsPerSession: config.maxAttachmentsPerSession,
        attachmentQueueBytes: config.attachmentQueueBytes,
        eventJournalLimit: config.eventJournalLimit,
        inputDedupeTtlMs: config.inputDedupeTtlMs,
        inputDedupeLimit: config.inputDedupeLimit,
        expirySweepIntervalMs: config.expirySweepIntervalMs,
        clock,
        ids: new FakeIds(),
      });
      await service.initialize();
      const human = ownerCaller(clock.value);
      const agentObserver: DurableSessionCallerContext = {
        ...ownerCaller(clock.value),
        subject: "agent:fixture-observer",
        capabilities: ["session:observe"],
      };
      try {
        const sessionId = (
          await ok(
            service.execute(human, {
              version: 0,
              requestId: uuid(1),
              operation: "createSession",
              idempotencyKey: uuid(2),
              command: profileCommand(),
            }),
            "createSession",
          )
        ).session.sessionId;
        const controller = await open(service, human, sessionId, 3);
        const observer = await open(service, agentObserver, sessionId, 4);
        const controllerEvents: DurableSessionEvent[] = [];
        const observerEvents: DurableSessionEvent[] = [];
        await collect(service, human, sessionId, controller, "controller", controllerEvents);
        await collect(service, agentObserver, sessionId, observer, "observer", observerEvents);
        const acquired = await ok(
          service.execute(human, {
            version: 0,
            requestId: uuid(5),
            operation: "acquireControl",
            sessionId,
            attachmentId: controller.attachmentId,
            expectedRuntimeId: controller.runtimeId,
            expectedControllerGeneration: 0,
            terminal: { cols: 80, rows: 24 },
          }),
          "acquireControl",
        );
        const generation = acquired.control.controllerGeneration;
        const send = (ordinal: number, data: string) =>
          ok(
            service.execute(human, {
              version: 0,
              requestId: uuid(ordinal),
              operation: "sendInput",
              sessionId,
              attachmentId: controller.attachmentId,
              expectedRuntimeId: controller.runtimeId,
              expectedControllerGeneration: generation,
              inputId: uuid(ordinal + 100),
              data,
            }),
            "sendInput",
          );

        await waitForScreen(service, sessionId, "Password:");
        await send(6, `${SECRET}\r`);
        await waitForScreen(service, sessionId, `LEN=${SECRET.length}`);
        await waitForScreen(service, sessionId, "Visible:");
        await send(7, `${VISIBLE}\r`);
        await waitForScreen(service, sessionId, `GOT=${VISIBLE}`);
        await drain(service, controller, "controller", controllerEvents);
        await drain(service, observer, "observer", observerEvents);

        const snapshot = await service.terminalSnapshot(sessionId);
        const journal = await ok(
          service.execute(human, {
            version: 0,
            requestId: uuid(8),
            operation: "readEvents",
            sessionId,
            limit: 1_000,
          }),
          "readEvents",
        );
        const surfaces = {
          observerStream: JSON.stringify(observerEvents),
          controllerStream: JSON.stringify(controllerEvents),
          snapshot: snapshot.serializedState,
          journal: JSON.stringify(journal.events),
        };
        for (const [surface, text] of Object.entries(surfaces)) {
          expect({ surface, leaked: text.includes(SECRET) }).toEqual({ surface, leaked: false });
        }
        // Echo-on input is visible to every observer: secure input cannot hide what the program
        // itself prints, so the agent must hand off before a secret prompt that echoes.
        expect(surfaces.observerStream.includes(VISIBLE)).toBe(true);
        expect(surfaces.snapshot.includes(VISIBLE)).toBe(true);
      } finally {
        await service.shutdown();
      }
    }, 20_000);
  },
);

async function open(
  service: SessionService,
  caller: DurableSessionCallerContext,
  sessionId: SessionId,
  ordinal: number,
): Promise<AttachmentLease> {
  return (
    await ok(
      service.execute(caller, {
        version: 0,
        requestId: uuid(ordinal),
        operation: "openAttachment",
        sessionId,
      }),
      "openAttachment",
    )
  ).attachment;
}

async function collect(
  service: SessionService,
  caller: DurableSessionCallerContext,
  sessionId: SessionId,
  attachment: AttachmentLease,
  streamId: string,
  target: DurableSessionEvent[],
): Promise<void> {
  await service.bindStreamAttachment(caller, sessionId, attachment.attachmentId, streamId, () => {
    void drain(service, attachment, streamId, target);
  });
  await drain(service, attachment, streamId, target);
}

async function drain(
  service: SessionService,
  attachment: AttachmentLease,
  streamId: string,
  target: DurableSessionEvent[],
): Promise<void> {
  for (;;) {
    const event = await service.takeStreamEvent(attachment.attachmentId, streamId);
    if (event === null) return;
    target.push(event);
  }
}

async function waitForScreen(
  service: SessionService,
  sessionId: SessionId,
  text: string,
): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if ((await service.terminalSnapshot(sessionId)).serializedState.includes(text)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Screen did not show the expected fixture marker: ${text}`);
}

async function ok<T extends DurableSessionOperationResult["operation"]>(
  promise: Promise<DurableSessionOperationResponse>,
  operation: T,
): Promise<Extract<DurableSessionOperationResult, { operation: T }>> {
  const response = await promise;
  if (!response.ok || response.result.operation !== operation) {
    throw new Error(`Expected successful ${operation}: ${JSON.stringify(response)}`);
  }
  return response.result as Extract<DurableSessionOperationResult, { operation: T }>;
}

function uuid(ordinal: number): string {
  return `41000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
}
