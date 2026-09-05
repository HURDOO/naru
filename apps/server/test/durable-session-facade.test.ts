import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  DurableSessionOperationRequest,
  DurableSessionOperationResult,
  SessionView,
} from "@naru/contracts/durable-session/v0";
import {
  DurableHostSessionFacade,
  type DurableSessionRuntimeUnavailableReason,
  type DurableSessionStreamBinding,
  type DurableSessionStreamPort,
} from "../src/durable-session-facade.js";
import {
  DurableSessionHostOperationError,
  DurableSessionHostTransportError,
  type DurableHostConfig,
  type DurableSessionLifecycleClient,
} from "../src/durable-session-host-client.js";
import { NaruRepository } from "../src/database.js";
import { AppError } from "../src/errors.js";
import type { SessionFrameListener } from "../src/session-facade.js";
import type { ServerWsFrame } from "@naru/contracts";
import type { IntegrationDescriptor } from "@naru/contracts/durable-session/v0";
import type { CodexLaunchPlan, NaruCodexIntegrationPort } from "../src/integrations/codex/port.js";
import type { CodexIntegrationEventV1 } from "../src/integrations/codex/events.js";

describe("Durable Host Naru Session facade", () => {
  it("recovers an ambiguous create after a Naru restart with the same idempotency key", async () => {
    const repository = new NaruRepository(":memory:", { sessionOwner: "durable-host" });
    const paneId = terminalPane(repository);
    const lifecycle = new FakeLifecycleClient();
    lifecycle.failAfterNextCreate = true;
    const first = facade(repository, lifecycle);

    await expect(first.start(paneId)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    const pending = repository.getPaneSessionLink(paneId);
    expect(pending).toMatchObject({
      state: "pending",
      pendingOperation: "create",
      sessionId: null,
    });
    expect(lifecycle.createCount).toBe(1);

    const restarted = facade(repository, lifecycle);
    await restarted.reconcile();

    expect(lifecycle.createCount).toBe(1);
    expect(lifecycle.createKeys).toEqual([pending?.operationKey, pending?.operationKey]);
    expect(repository.getPaneSessionLink(paneId)).toMatchObject({
      state: "linked",
      pendingOperation: null,
      sessionId: lifecycle.session.sessionId,
      expectedRuntimeId: null,
      expectedSessionRevision: null,
    });
    expect(repository.getPaneContext(paneId)?.pane.status).toBe("running");
    repository.close();
  });

  it("fails stopped instead of duplicating an ambiguous create after Host idempotency expiry", async () => {
    const repository = new NaruRepository(":memory:", { sessionOwner: "durable-host" });
    const paneId = terminalPane(repository);
    const lifecycle = new FakeLifecycleClient();
    lifecycle.failAfterNextCreate = true;
    await expect(facade(repository, lifecycle).start(paneId)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    const pending = repository.getPaneSessionLink(paneId);
    if (pending === undefined) throw new Error("Ambiguous create fence is missing.");
    const afterExpiry = Date.parse(pending.updatedAt) + hostConfig().idempotencyTtlMs + 1;
    const restarted = new DurableHostSessionFacade(
      repository,
      hostConfig(),
      lifecycle,
      new FakeStreamPort(),
      () => afterExpiry,
    );

    await restarted.reconcile();

    expect(lifecycle.createCount).toBe(1);
    expect(repository.getPaneSessionLink(paneId)).toMatchObject({
      state: "missing",
      sessionId: null,
      lastErrorCode: "INTERNAL_ERROR",
    });
    expect(repository.getPaneContext(paneId)?.pane.status).toBe("stopped");
    await expect(restarted.start(paneId)).rejects.toMatchObject({
      code: "REQUEST_INVALID",
      statusCode: 409,
    });
    expect(lifecycle.createCount).toBe(1);
    repository.close();
  });

  it("reattaches linked metadata without spawning a duplicate and leaves Host sessions alive on shutdown", async () => {
    const repository = new NaruRepository(":memory:", { sessionOwner: "durable-host" });
    const paneId = terminalPane(repository);
    const lifecycle = new FakeLifecycleClient();
    const initial = facade(repository, lifecycle);
    await initial.start(paneId, 120, 40);

    const link = repository.getPaneSessionLink(paneId);
    const runtimeId = lifecycle.session.runtimeId;
    const sessionRevision = lifecycle.session.sessionRevision;
    const restarted = facade(repository, lifecycle);
    await restarted.reconcile();
    await restarted.shutdown();

    expect(lifecycle.createCount).toBe(1);
    expect(lifecycle.operations).toEqual(["createSession", "getSession"]);
    expect(repository.getPaneSessionLink(paneId)).toMatchObject({
      sessionId: link?.sessionId,
      expectedRuntimeId: null,
      expectedSessionRevision: null,
    });
    expect(lifecycle.session).toMatchObject({ runtimeId, sessionRevision });
    expect(lifecycle.operations).not.toContain("stopSession");
    repository.close();
  });

  it("executes create, stop, start and stop-forget in exact Host order", async () => {
    const repository = new NaruRepository(":memory:", { sessionOwner: "durable-host" });
    const paneId = terminalPane(repository);
    const lifecycle = new FakeLifecycleClient();
    const target = facade(repository, lifecycle);

    await target.start(paneId);
    await target.stop(paneId);
    await target.restart(paneId);
    await target.remove(paneId);

    expect(lifecycle.operations).toEqual([
      "createSession",
      "getSession",
      "stopSession",
      "getSession",
      "startSession",
      "getSession",
      "stopSession",
      "forgetSession",
    ]);
    expect(repository.getPaneSessionLink(paneId)).toBeUndefined();
    expect(lifecycle.sessions.size).toBe(0);
    repository.close();
  });

  it("uses a runtime-only Codex descriptor and recreates a Host Session for semantic recovery", async () => {
    const repository = new NaruRepository(":memory:", { sessionOwner: "durable-host" });
    const paneId = codexPane(repository);
    const lifecycle = new FakeLifecycleClient();
    const stream = new FakeStreamPort();
    const integration = new FakeCodexIntegration();
    const target = new DurableHostSessionFacade(
      repository,
      hostConfig(),
      lifecycle,
      stream,
      Date.now,
      integration,
    );
    const identityChanges: Array<{ sessionId: string | null; runtimeId: string }> = [];
    target.onCodexIdentity((change) =>
      identityChanges.push({ sessionId: change.sessionId, runtimeId: change.runtimeId }),
    );

    await target.start(paneId);
    const firstRuntimeId = lifecycle.session.runtimeId as string;
    repository.beginPaneRuntime(paneId, firstRuntimeId);
    repository.setCodexSessionForRuntime(
      paneId,
      firstRuntimeId,
      "88888888-8888-4888-8888-888888888888",
      false,
    );
    expect(integration.preflighted).toEqual([paneId]);
    const firstBinding = repository.getPaneSessionLink(paneId)?.integrationBindingId;
    expect(firstBinding).toMatch(/^[0-9a-f-]{36}$/);
    expect(lifecycle.createCommands[0]).toMatchObject({
      kind: "profile",
      profileId: "codex-main",
      integration: {
        kind: "codex",
        config: { policyRef: "fixture-codex-v0", bindingId: firstBinding },
      },
    });
    expect(integration.bound).toEqual([
      { paneId, sessionId: lifecycle.session.sessionId, runtimeId: lifecycle.session.runtimeId },
    ]);
    expect(stream.calls[0]).toMatchObject({
      type: "attach",
      attachmentKey: `codex-integration:${paneId}`,
    });

    await target.write(paneId, "hello");
    expect(integration.inputs).toEqual([
      { paneId, runtimeId: lifecycle.session.runtimeId, data: "hello" },
    ]);
    await target.stop(paneId);
    await target.restart(paneId);

    const secondBinding = repository.getPaneSessionLink(paneId)?.integrationBindingId;
    expect(secondBinding).not.toBe(firstBinding);
    expect(lifecycle.createCount).toBe(2);
    expect(lifecycle.operations).not.toContain("startSession");
    expect(lifecycle.operations).toContain("forgetSession");
    expect(integration.stopping).toHaveLength(1);
    expect(integration.preflighted).toEqual([paneId, paneId]);
    expect(repository.getPaneContext(paneId)?.pane.codexSessionId).toBeNull();
    expect(identityChanges.at(-1)).toEqual({ sessionId: null, runtimeId: firstRuntimeId });
    repository.close();
  });

  it("projects identified and cleared Codex identity without enriching generic Host exit events", async () => {
    const repository = new NaruRepository(":memory:", { sessionOwner: "durable-host" });
    const paneId = codexPane(repository);
    const lifecycle = new FakeLifecycleClient();
    const integration = new FakeCodexIntegration();
    const target = new DurableHostSessionFacade(
      repository,
      hostConfig(),
      lifecycle,
      new FakeStreamPort(),
      Date.now,
      integration,
    );
    const changes: Array<{ sessionId: string | null; runtimeId: string }> = [];
    target.onCodexIdentity((change) =>
      changes.push({ sessionId: change.sessionId, runtimeId: change.runtimeId }),
    );

    await target.start(paneId);
    const session = lifecycle.session;
    const runtimeId = session.runtimeId as string;
    const codexSessionId = "99999999-9999-4999-8999-999999999999";
    expect(changes).toEqual([]);

    repository.beginPaneRuntime(paneId, runtimeId);
    expect(repository.setCodexSessionForRuntime(paneId, runtimeId, codexSessionId, true)).toBe(
      true,
    );
    integration.emit({
      version: 1,
      integrationKind: "codex",
      eventKind: "session.identified",
      paneId,
      hostSessionId: session.sessionId,
      runtimeId,
      occurredAtMs: Date.now(),
      codexSessionId,
      source: "startup",
      resumable: true,
    });
    expect(repository.setCodexSessionForRuntime(paneId, runtimeId, null, false)).toBe(true);
    integration.emit({
      version: 1,
      integrationKind: "codex",
      eventKind: "session.cleared",
      paneId,
      hostSessionId: session.sessionId,
      runtimeId,
      occurredAtMs: Date.now(),
      source: "transition",
    });

    expect(changes.slice(-2)).toEqual([
      { sessionId: codexSessionId, runtimeId },
      { sessionId: null, runtimeId },
    ]);
    await target.shutdown();
    repository.close();
  });

  it("surfaces a Naru-owned Codex preflight error before creating Host state", async () => {
    const repository = new NaruRepository(":memory:", { sessionOwner: "durable-host" });
    const paneId = codexPane(repository);
    const lifecycle = new FakeLifecycleClient();
    const integration = new FakeCodexIntegration();
    integration.preflightError = new AppError(
      "CODEX_AUTH_REQUIRED",
      503,
      "Codex authentication is unavailable.",
    );
    const target = new DurableHostSessionFacade(
      repository,
      hostConfig(),
      lifecycle,
      new FakeStreamPort(),
      Date.now,
      integration,
    );

    await expect(target.start(paneId)).rejects.toMatchObject({ code: "CODEX_AUTH_REQUIRED" });
    expect(lifecycle.operations).toEqual([]);
    expect(repository.getPaneSessionLink(paneId)).toBeUndefined();
    expect(repository.getPaneContext(paneId)?.pane).toMatchObject({
      status: "error",
      lastErrorCode: "CODEX_AUTH_REQUIRED",
      activity: { state: "failed", runtimeId: null },
    });
    repository.close();
  });

  it("does not project input that the Host stream rejects into Codex semantics", async () => {
    const repository = new NaruRepository(":memory:", { sessionOwner: "durable-host" });
    const paneId = codexPane(repository);
    const lifecycle = new FakeLifecycleClient();
    const stream = new FakeStreamPort();
    const integration = new FakeCodexIntegration();
    const target = new DurableHostSessionFacade(
      repository,
      hostConfig(),
      lifecycle,
      stream,
      Date.now,
      integration,
    );
    await target.start(paneId);
    stream.writeError = new Error("stale controller generation");

    await expect(target.write(paneId, "/new\r")).rejects.toThrow(/stale controller/);
    expect(integration.inputs).toEqual([]);
    repository.close();
  });

  it("cancels a stopping semantic marker after an authoritative Host rejection", async () => {
    const repository = new NaruRepository(":memory:", { sessionOwner: "durable-host" });
    const paneId = codexPane(repository);
    const lifecycle = new FakeLifecycleClient();
    const integration = new FakeCodexIntegration();
    const target = new DurableHostSessionFacade(
      repository,
      hostConfig(),
      lifecycle,
      new FakeStreamPort(),
      Date.now,
      integration,
    );
    await target.start(paneId);
    lifecycle.stopError = new DurableSessionHostOperationError({
      code: "SESSION_REVISION_STALE",
      message: "Session revision is stale.",
    });

    await expect(target.stop(paneId)).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    expect(integration.stopping).toHaveLength(1);
    expect(integration.canceledStopping).toEqual(integration.stopping);
    repository.close();
  });

  it("preserves the legacy rejection when restart is requested for a running Pane", async () => {
    const repository = new NaruRepository(":memory:", { sessionOwner: "durable-host" });
    const paneId = terminalPane(repository);
    const lifecycle = new FakeLifecycleClient();
    const target = facade(repository, lifecycle);
    await target.start(paneId);

    await expect(target.restart(paneId)).rejects.toMatchObject({
      code: "REQUEST_INVALID",
      statusCode: 409,
    });
    expect(lifecycle.operations).toEqual(["createSession", "getSession"]);
    expect(lifecycle.createCount).toBe(1);
    repository.close();
  });

  it("marks a missing Host Session honestly stopped instead of spawning a replacement", async () => {
    const repository = new NaruRepository(":memory:", { sessionOwner: "durable-host" });
    const paneId = terminalPane(repository);
    const lifecycle = new FakeLifecycleClient();
    const target = facade(repository, lifecycle);
    await target.start(paneId);
    lifecycle.sessions.clear();

    await target.reconcile();

    expect(lifecycle.createCount).toBe(1);
    expect(repository.getPaneSessionLink(paneId)).toMatchObject({
      state: "missing",
      lastErrorCode: "SESSION_NOT_FOUND",
      expectedRuntimeId: null,
    });
    expect(repository.getPaneContext(paneId)?.pane.status).toBe("stopped");
    repository.close();
  });

  it("projects a Host-restarted Codex runtime as server-stopped without a synthetic exit", async () => {
    const repository = new NaruRepository(":memory:", { sessionOwner: "durable-host" });
    const paneId = codexPane(repository);
    const lifecycle = new FakeLifecycleClient();
    const stream = new FakeStreamPort();
    const integration = new FakeCodexIntegration();
    const target = new DurableHostSessionFacade(
      repository,
      hostConfig(),
      lifecycle,
      stream,
      Date.now,
      integration,
    );
    await target.start(paneId);
    const runtimeId = lifecycle.session.runtimeId;
    if (runtimeId === null) throw new Error("Fixture runtime is missing.");
    repository.beginPaneRuntime(paneId, runtimeId);
    const stopped = {
      ...lifecycle.session,
      lifecycle: "stopped" as const,
      runtimeId: null,
      sessionRevision: lifecycle.session.sessionRevision + 1,
    };
    lifecycle.session = stopped;
    lifecycle.sessions.set(stopped.sessionId, stopped);

    stream.runtimeUnavailable(`codex-integration:${paneId}`, "SESSION_NOT_RUNNING");

    await vi.waitFor(() => {
      expect(repository.getPaneContext(paneId)?.pane).toMatchObject({
        status: "stopped",
        activity: { state: "server-stopped", runtimeId },
      });
      expect(target.isRunning(paneId)).toBe(false);
    });
    expect(integration.disposed).toEqual([{ paneId, runtimeId }]);
    expect(stream.calls.filter((call) => call.type === "detach")).toHaveLength(1);
    await expect(target.readiness()).resolves.toBe(true);

    await target.shutdown();
    repository.close();
  });

  it("delegates browser terminal traffic through the T07 stream port", async () => {
    const repository = new NaruRepository(":memory:", { sessionOwner: "durable-host" });
    const paneId = terminalPane(repository);
    const lifecycle = new FakeLifecycleClient();
    const stream = new FakeStreamPort();
    const target = facade(repository, lifecycle, stream);
    await target.start(paneId);

    const detach = await target.attach(paneId, 90, 28, () => undefined);
    await target.write(paneId, "hello");
    await target.resize(paneId, 100, 30);
    await target.updateViewport(paneId, lifecycle.session.runtimeId as string, 12);
    detach();

    expect(stream.calls.map((call) => call.type)).toEqual([
      "attach",
      "write",
      "resize",
      "viewport",
      "detach",
    ]);
    expect(stream.calls[0]).toMatchObject({
      paneId,
      sessionId: lifecycle.session.sessionId,
      runtimeId: lifecycle.session.runtimeId,
    });
    repository.close();
  });

  it("blocks new Host runtimes when the T07 stream boundary is only partially installed", async () => {
    const repository = new NaruRepository(":memory:", { sessionOwner: "durable-host" });
    const paneId = terminalPane(repository);
    const lifecycle = new FakeLifecycleClient();
    const target = new DurableHostSessionFacade(repository, hostConfig(), lifecycle);

    await expect(target.start(paneId)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      statusCode: 503,
    });
    expect(lifecycle.operations).toEqual([]);
    expect(repository.getPaneSessionLink(paneId)).toBeUndefined();
    repository.close();
  });

  it("refreshes Naru app state from Host truth after a streamed terminal exit", async () => {
    const repository = new NaruRepository(":memory:", { sessionOwner: "durable-host" });
    const paneId = terminalPane(repository);
    const lifecycle = new FakeLifecycleClient();
    const stream = new FakeStreamPort();
    const target = facade(repository, lifecycle, stream);
    await target.start(paneId);
    await target.attach(paneId, 100, 30, () => undefined);

    lifecycle.exit(7);
    stream.exit(paneId, 7);
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

    expect(target.isRunning(paneId)).toBe(false);
    expect(repository.getPaneContext(paneId)?.pane).toMatchObject({
      status: "exited",
      exitCode: 7,
    });
    expect(lifecycle.operations).toEqual(["createSession", "getSession"]);
    repository.close();
  });

  it("reopens Naru around the same Host runtime and sequence without exiting or respawning it", async () => {
    const filename = join(mkdtempSync(join(tmpdir(), "naru-t06-restart-")), "naru.sqlite");
    const lifecycle = new FakeLifecycleClient();
    const stream = new FakeStreamPort();
    const firstRepository = new NaruRepository(filename, { sessionOwner: "durable-host" });
    const paneId = terminalPane(firstRepository);
    const first = facade(firstRepository, lifecycle, stream);
    await first.start(paneId);
    const before: ServerWsFrame[] = [];
    (await first.attach(paneId, 100, 30, (frame) => before.push(frame)))();
    const identity = firstRepository.getPaneSessionLink(paneId);
    const runtimeId = lifecycle.session.runtimeId;
    const sessionRevision = lifecycle.session.sessionRevision;

    await first.shutdown();
    firstRepository.close();

    const restartedRepository = new NaruRepository(filename, { sessionOwner: "durable-host" });
    const restarted = facade(restartedRepository, lifecycle, stream);
    await restarted.reconcile();
    const after: ServerWsFrame[] = [];
    (await restarted.attach(paneId, 100, 30, (frame) => after.push(frame)))();

    expect(lifecycle.createCount).toBe(1);
    expect(lifecycle.operations).toEqual(["createSession", "getSession"]);
    expect(restartedRepository.getPaneSessionLink(paneId)).toMatchObject({
      sessionId: identity?.sessionId,
      expectedRuntimeId: null,
      expectedSessionRevision: null,
    });
    expect(lifecycle.session).toMatchObject({ runtimeId, sessionRevision });
    expect(before[0]).toMatchObject({
      type: "pane.snapshot",
      runtimeId,
      sequence: 42,
    });
    expect(after[0]).toMatchObject({
      type: "pane.snapshot",
      runtimeId,
      sequence: 42,
    });
    expect(lifecycle.operations).not.toContain("stopSession");
    restartedRepository.close();
  });
});

class FakeLifecycleClient implements DurableSessionLifecycleClient {
  readonly operations: DurableSessionOperationRequest["operation"][] = [];
  readonly createKeys: string[] = [];
  readonly sessions = new Map<string, SessionView>();
  readonly createResults = new Map<string, SessionView>();
  readonly createCommands: Array<
    Extract<DurableSessionOperationRequest, { operation: "createSession" }>["command"]
  > = [];
  createCount = 0;
  failAfterNextCreate = false;
  stopError: DurableSessionHostOperationError | null = null;
  session = sessionView();

  exit(exitCode: number): void {
    void exitCode;
    const session = {
      ...this.session,
      lifecycle: "exited" as const,
      runtimeId: null,
      sessionRevision: this.session.sessionRevision + 1,
    };
    this.session = session;
    this.sessions.set(session.sessionId, session);
  }

  readiness(): Promise<boolean> {
    return Promise.resolve(true);
  }

  execute(request: DurableSessionOperationRequest): Promise<DurableSessionOperationResult> {
    return Promise.resolve(this.#execute(request));
  }

  #execute(request: DurableSessionOperationRequest): DurableSessionOperationResult {
    this.operations.push(request.operation);
    switch (request.operation) {
      case "createSession": {
        this.createKeys.push(request.idempotencyKey);
        this.createCommands.push(request.command);
        let session = this.createResults.get(request.idempotencyKey);
        if (session === undefined) {
          this.createCount += 1;
          session = sessionView();
          this.session = session;
          this.sessions.set(session.sessionId, session);
          this.createResults.set(request.idempotencyKey, session);
        }
        if (this.failAfterNextCreate) {
          this.failAfterNextCreate = false;
          throw new DurableSessionHostTransportError();
        }
        return { operation: "createSession", session };
      }
      case "getSession":
        return { operation: "getSession", session: this.#require(request.sessionId) };
      case "startSession": {
        const current = this.#require(request.sessionId);
        const session = {
          ...current,
          lifecycle: "running" as const,
          runtimeId: randomUUID(),
          sessionRevision: current.sessionRevision + 1,
        };
        this.session = session;
        this.sessions.set(session.sessionId, session);
        return { operation: "startSession", session };
      }
      case "stopSession": {
        if (this.stopError !== null) throw this.stopError;
        const current = this.#require(request.sessionId);
        const session = {
          ...current,
          lifecycle: "stopped" as const,
          runtimeId: null,
          sessionRevision: current.sessionRevision + 1,
        };
        this.session = session;
        this.sessions.set(session.sessionId, session);
        return { operation: "stopSession", session };
      }
      case "forgetSession":
        this.#require(request.sessionId);
        this.sessions.delete(request.sessionId);
        return { operation: "forgetSession", forgotten: true };
      default:
        throw new Error(`Unexpected test operation: ${request.operation}`);
    }
  }

  #require(sessionId: string): SessionView {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new DurableSessionHostOperationError({
        code: "SESSION_NOT_FOUND",
        message: "Session was not found.",
      });
    }
    return session;
  }
}

class FakeStreamPort implements DurableSessionStreamPort {
  readonly calls: Array<Record<string, unknown> & { type: string }> = [];
  readonly listeners = new Map<string, SessionFrameListener>();
  readonly runtimeUnavailableListeners = new Map<
    string,
    (reason: DurableSessionRuntimeUnavailableReason) => void
  >();
  writeError: Error | null = null;

  readiness(): boolean {
    return true;
  }

  attach(
    binding: DurableSessionStreamBinding,
    _columns: number,
    _rows: number,
    listener: SessionFrameListener,
    _restoreProtocol?: unknown,
    _restoreId?: string,
    _desiredControl?: boolean,
    onRuntimeUnavailable?: (reason: DurableSessionRuntimeUnavailableReason) => void,
  ): Promise<() => void> {
    this.calls.push({ type: "attach", ...binding });
    this.listeners.set(binding.paneId, listener);
    if (onRuntimeUnavailable !== undefined) {
      this.runtimeUnavailableListeners.set(binding.attachmentKey, onRuntimeUnavailable);
    }
    listener({
      type: "pane.snapshot",
      paneId: binding.paneId,
      runtimeId: binding.runtimeId,
      sequence: 42,
      serializedState: "host-owned-state",
      cols: 100,
      rows: 30,
    });
    return Promise.resolve(() => {
      this.listeners.delete(binding.paneId);
      this.runtimeUnavailableListeners.delete(binding.attachmentKey);
      this.calls.push({ type: "detach" });
    });
  }

  exit(paneId: string, exitCode: number): void {
    this.listeners.get(paneId)?.({ type: "terminal.exit", paneId, exitCode });
  }

  runtimeUnavailable(attachmentKey: string, reason: DurableSessionRuntimeUnavailableReason): void {
    const listener = this.runtimeUnavailableListeners.get(attachmentKey);
    if (listener === undefined) throw new Error("Runtime-unavailable listener is missing.");
    listener(reason);
  }

  write(binding: DurableSessionStreamBinding, data: string): void {
    if (this.writeError !== null) throw this.writeError;
    this.calls.push({ type: "write", ...binding, data });
  }

  resize(binding: DurableSessionStreamBinding, columns: number, rows: number): void {
    this.calls.push({ type: "resize", ...binding, columns, rows });
  }

  updateViewport(
    binding: DurableSessionStreamBinding,
    runtimeId: string,
    bottomOffset: number,
  ): void {
    this.calls.push({ type: "viewport", ...binding, runtimeId, bottomOffset });
  }

  setControlDesired(
    binding: DurableSessionStreamBinding,
    desired: boolean,
    columns: number,
    rows: number,
  ): void {
    this.calls.push({ type: "control-desired", ...binding, desired, columns, rows });
  }

  preemptControl(binding: DurableSessionStreamBinding, columns: number, rows: number): void {
    this.calls.push({ type: "preempt", ...binding, columns, rows });
  }

  approveControl(binding: DurableSessionStreamBinding, controlRequestId: string): void {
    this.calls.push({ type: "approve", ...binding, controlRequestId });
  }

  rejectControl(binding: DurableSessionStreamBinding, controlRequestId: string): void {
    this.calls.push({ type: "reject", ...binding, controlRequestId });
  }

  releaseControl(binding: DurableSessionStreamBinding): void {
    this.calls.push({ type: "release", ...binding });
  }

  async shutdown(): Promise<void> {
    await Promise.resolve();
  }
}

class FakeCodexIntegration implements NaruCodexIntegrationPort {
  readonly preflighted: string[] = [];
  readonly bound: Array<{ paneId: string; sessionId: string; runtimeId: string | null }> = [];
  readonly inputs: Array<{ paneId: string; runtimeId: string; data: string }> = [];
  readonly stopping: Array<{ paneId: string; runtimeId: string }> = [];
  readonly canceledStopping: Array<{ paneId: string; runtimeId: string }> = [];
  readonly disposed: Array<{ paneId: string; runtimeId: string }> = [];
  readonly eventListeners = new Set<(event: CodexIntegrationEventV1) => void>();
  preflightError: Error | null = null;

  descriptor(bindingId: string): IntegrationDescriptor {
    return {
      kind: "codex",
      config: { policyRef: "fixture-codex-v0", bindingId },
    };
  }

  preflight(paneId: string): void {
    this.preflighted.push(paneId);
    if (this.preflightError !== null) throw this.preflightError;
  }

  launch(): CodexLaunchPlan {
    throw new Error("Fake facade test does not launch through the integration socket.");
  }

  acceptHook(): boolean {
    return false;
  }

  bindRuntime(paneId: string, session: SessionView): void {
    this.bound.push({ paneId, sessionId: session.sessionId, runtimeId: session.runtimeId });
  }

  observeInput(paneId: string, runtimeId: string, data: string): void {
    this.inputs.push({ paneId, runtimeId, data });
  }

  observeOutput(): void {}

  observeExit(): void {}

  markStopping(paneId: string, runtimeId: string): void {
    this.stopping.push({ paneId, runtimeId });
  }

  cancelStopping(paneId: string, runtimeId: string): void {
    this.canceledStopping.push({ paneId, runtimeId });
  }

  disposeRuntime(paneId: string, runtimeId: string): void {
    this.disposed.push({ paneId, runtimeId });
  }

  onActivity(): () => void {
    return () => undefined;
  }

  onEvent(listener: (event: CodexIntegrationEventV1) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  emit(event: CodexIntegrationEventV1): void {
    for (const listener of this.eventListeners) listener(event);
  }
}

function terminalPane(repository: NaruRepository): string {
  const project = repository.createProject("/safe/project", "project");
  const pane = repository
    .getWorkspace(project.id)
    .panes.find((candidate) => candidate.kind === "terminal");
  if (pane === undefined) throw new Error("Fixture terminal Pane is missing.");
  return pane.id;
}

function codexPane(repository: NaruRepository): string {
  const project = repository.createProject("/safe/project", "project");
  const pane = repository
    .getWorkspace(project.id)
    .panes.find((candidate) => candidate.launchProfile === "codex-main");
  if (pane === undefined) throw new Error("Fixture Codex Pane is missing.");
  return pane.id;
}

function facade(
  repository: NaruRepository,
  lifecycle: FakeLifecycleClient,
  stream: DurableSessionStreamPort = new FakeStreamPort(),
): DurableHostSessionFacade {
  return new DurableHostSessionFacade(repository, hostConfig(), lifecycle, stream);
}

function hostConfig(): DurableHostConfig {
  return {
    owner: "durable-host",
    socketPath: "/safe/host.sock",
    credentialFile: "/safe/credential",
    appId: "naru",
    subject: "local-owner",
    callerTtlMs: 60_000,
    idempotencyTtlMs: 30_000,
    profileIds: ["shell", "codex-main", "codex-quick"],
    roots: [{ rootId: "safe", path: "/safe" }],
  };
}

function sessionView(): SessionView {
  const now = Date.now();
  return {
    sessionId: randomUUID(),
    lifecycle: "running",
    sessionRevision: 1,
    runtimeId: randomUUID(),
    terminal: { cols: 100, rows: 30 },
    controllerAttachmentId: null,
    controllerGeneration: 0,
    nextSequence: 0,
    command: { kind: "profile", profileId: "shell", rootId: "safe" },
    createdAtMs: now,
    updatedAtMs: now,
  };
}
