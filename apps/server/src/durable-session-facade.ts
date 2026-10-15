import { randomUUID } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import {
  type CommandSpecV0,
  type DurableSessionErrorCode,
  type SessionView,
} from "@naru/contracts/durable-session/v0";
import type { ServerWsFrame, TerminalRestoreProtocol } from "@naru/contracts";
import type {
  DurableHostConfig,
  DurableSessionLifecycleClient,
} from "./durable-session-host-client.js";
import {
  DurableSessionHostOperationError,
  operationRequestBase,
} from "./durable-session-host-client.js";
import type { NaruRepository, PaneSessionLink, PaneSessionOperation } from "./database.js";
import { AppError } from "./errors.js";
import type { NaruCodexIntegrationPort } from "./integrations/codex/port.js";
import type { NaruClaudeIntegrationPort } from "./integrations/claude/port.js";
import { CLAUDE_AGENT_LAUNCH_PROFILE } from "./launch-profiles.js";
import type {
  NaruSessionFacade,
  SessionActivityListener,
  SessionAttachmentOptions,
  SessionCodexIdentityChange,
  SessionCodexIdentityListener,
  SessionFrameListener,
} from "./session-facade.js";

const DEFAULT_COLUMNS = 100;
const DEFAULT_ROWS = 30;
const TERMINAL_STOP_WAIT_MS = 5_000;
const TERMINAL_STOP_POLL_MS = 50;

export interface DurableSessionStreamBinding {
  readonly paneId: string;
  readonly sessionId: string;
  readonly runtimeId: string;
  readonly sessionRevision: number;
  readonly attachmentKey: string;
}

export type DurableSessionRuntimeUnavailableReason =
  "SESSION_NOT_FOUND" | "SESSION_NOT_RUNNING" | "RUNTIME_STALE";

/** T07/T08 supply this port; no Naru browser route depends on their physical transport. */
export interface DurableSessionStreamPort {
  readiness(): boolean | Promise<boolean>;
  attach(
    binding: DurableSessionStreamBinding,
    columns: number,
    rows: number,
    listener: SessionFrameListener,
    restoreProtocol?: TerminalRestoreProtocol,
    restoreId?: string,
    desiredControl?: boolean,
    onRuntimeUnavailable?: (reason: DurableSessionRuntimeUnavailableReason) => void,
  ): Promise<() => void>;
  write(binding: DurableSessionStreamBinding, data: string): void | Promise<void>;
  resize(binding: DurableSessionStreamBinding, columns: number, rows: number): void | Promise<void>;
  updateViewport(
    binding: DurableSessionStreamBinding,
    runtimeId: string,
    bottomOffset: number,
  ): void | Promise<void>;
  setControlDesired(
    binding: DurableSessionStreamBinding,
    desired: boolean,
    columns: number,
    rows: number,
  ): void | Promise<void>;
  preemptControl(
    binding: DurableSessionStreamBinding,
    columns: number,
    rows: number,
  ): void | Promise<void>;
  approveControl(
    binding: DurableSessionStreamBinding,
    controlRequestId: string,
  ): void | Promise<void>;
  rejectControl(
    binding: DurableSessionStreamBinding,
    controlRequestId: string,
  ): void | Promise<void>;
  releaseControl(binding: DurableSessionStreamBinding): void | Promise<void>;
  shutdown(): Promise<void>;
}

export class UnavailableDurableSessionStreamPort implements DurableSessionStreamPort {
  readiness(): boolean {
    return false;
  }

  attach(): Promise<() => void> {
    return Promise.reject(streamUnavailable());
  }

  write(): never {
    throw streamUnavailable();
  }

  resize(): never {
    throw streamUnavailable();
  }

  updateViewport(): never {
    throw streamUnavailable();
  }

  setControlDesired(): never {
    throw streamUnavailable();
  }

  preemptControl(): never {
    throw streamUnavailable();
  }

  approveControl(): never {
    throw streamUnavailable();
  }

  rejectControl(): never {
    throw streamUnavailable();
  }

  releaseControl(): never {
    throw streamUnavailable();
  }

  async shutdown(): Promise<void> {
    await Promise.resolve();
  }
}

export class DurableHostSessionFacade implements NaruSessionFacade {
  readonly #activityListeners = new Set<SessionActivityListener>();
  readonly #codexIdentityListeners = new Set<SessionCodexIdentityListener>();
  readonly #paneBarriers = new Map<string, Promise<void>>();
  readonly #sessionViews = new Map<string, SessionView>();
  readonly #integrationObservers = new Map<
    string,
    { readonly runtimeId: string; readonly dispose: () => void }
  >();
  readonly #removeIntegrationActivityListener: (() => void) | null;
  readonly #removeIntegrationEventListener: (() => void) | null;
  readonly #removeClaudeActivityListener: (() => void) | null;

  constructor(
    private readonly repository: NaruRepository,
    private readonly config: DurableHostConfig,
    private readonly lifecycle: DurableSessionLifecycleClient,
    private readonly stream: DurableSessionStreamPort = new UnavailableDurableSessionStreamPort(),
    private readonly now: () => number = Date.now,
    private readonly codexIntegration?: NaruCodexIntegrationPort,
    private readonly integrationTransport?: { close(): Promise<void> },
    private readonly claudeIntegration?: NaruClaudeIntegrationPort,
  ) {
    this.#removeIntegrationActivityListener =
      codexIntegration?.onActivity((change) => this.#emitActivity(change)) ?? null;
    this.#removeIntegrationEventListener =
      codexIntegration?.onEvent((event) => {
        if (event.eventKind === "session.identified") {
          this.#emitCodexIdentityForRuntime(
            event.paneId,
            event.runtimeId,
            event.codexSessionId,
            event.resumable,
          );
        } else if (event.eventKind === "session.cleared") {
          this.#emitCodexIdentityForRuntime(event.paneId, event.runtimeId, null, false);
        }
      }) ?? null;
    this.#removeClaudeActivityListener =
      claudeIntegration?.onActivity((change) => this.#emitActivity(change)) ?? null;
  }

  async reconcile(): Promise<void> {
    for (const link of this.repository.listPaneSessionLinks()) {
      await this.#enqueue(link.paneId, async () => {
        try {
          if (link.pendingOperation !== null) {
            if (link.pendingOperation === "create" || link.pendingOperation === "start") {
              await this.#requireStartReady();
            }
            await this.#recoverPending(link);
            return;
          }
          if (link.sessionId === null || link.state === "missing") return;
          await this.#refresh(link.paneId, link.sessionId);
        } catch (error) {
          if (error instanceof AppError && error.code === "PTY_NOT_RUNNING") return;
          throw error;
        }
      });
    }
  }

  async readiness(): Promise<boolean> {
    const [lifecycleReady, streamReady] = await Promise.all([
      this.lifecycle.readiness(),
      this.stream.readiness(),
    ]);
    return lifecycleReady && streamReady;
  }

  count(): number {
    return [...this.#sessionViews.values()].filter(isLiveSession).length;
  }

  isRunning(paneId: string): boolean {
    const session = this.#sessionViews.get(paneId);
    return session !== undefined && isLiveSession(session);
  }

  onActivity(listener: SessionActivityListener): () => void {
    this.#activityListeners.add(listener);
    return () => this.#activityListeners.delete(listener);
  }

  onCodexIdentity(listener: SessionCodexIdentityListener): () => void {
    this.#codexIdentityListeners.add(listener);
    return () => this.#codexIdentityListeners.delete(listener);
  }

  acknowledgeCompleted(paneId: string, eventId: string): void {
    const change = this.repository.acknowledgeCompletedActivity(paneId, eventId);
    if (change) this.#emitActivity(change);
  }

  start(paneId: string, columns = DEFAULT_COLUMNS, rows = DEFAULT_ROWS): Promise<void> {
    return this.#enqueue(paneId, () => this.#start(paneId, columns, rows, false));
  }

  attach(
    paneId: string,
    columns: number,
    rows: number,
    listener: (frame: ServerWsFrame) => void,
    restoreProtocol?: TerminalRestoreProtocol,
    restoreId?: string,
    options?: SessionAttachmentOptions,
  ): Promise<() => void> {
    return this.#enqueueResult(paneId, async () => {
      const binding = this.#runningBinding(paneId, options?.attachmentKey);
      return this.stream.attach(
        binding,
        columns,
        rows,
        (frame) => {
          if (frame.type === "terminal.exit") {
            this.#sessionViews.delete(paneId);
            this.repository.setPaneStatus(
              paneId,
              "exited",
              frame.exitCode,
              null,
              new Date().toISOString(),
            );
            void this.#enqueue(paneId, async () => {
              const link = this.repository.getPaneSessionLink(paneId);
              if (link?.sessionId === null || link?.sessionId === undefined) return;
              try {
                await this.#refresh(paneId, link.sessionId);
              } catch {
                // The Host view remains authoritative and the next operation retries this refresh.
              }
            });
          }
          listener(frame);
        },
        restoreProtocol,
        restoreId,
        options?.control !== "observer",
        (reason) => this.#handleRuntimeUnavailable(binding, reason),
      );
    });
  }

  write(paneId: string, data: string, attachmentKey?: string): Promise<void> {
    return this.#enqueue(paneId, async () => {
      const binding = this.#runningBinding(paneId, attachmentKey);
      await this.stream.write(binding, data);
      this.codexIntegration?.observeInput(paneId, binding.runtimeId, data);
    });
  }

  resize(paneId: string, columns: number, rows: number, attachmentKey?: string): Promise<void> {
    return this.#enqueue(paneId, () =>
      this.stream.resize(this.#runningBinding(paneId, attachmentKey), columns, rows),
    );
  }

  updateViewport(
    paneId: string,
    runtimeId: string,
    bottomOffset: number,
    attachmentKey?: string,
  ): Promise<void> {
    return this.#enqueue(paneId, () =>
      this.stream.updateViewport(
        this.#runningBinding(paneId, attachmentKey),
        runtimeId,
        bottomOffset,
      ),
    );
  }

  setControlDesired(
    paneId: string,
    desired: boolean,
    columns: number,
    rows: number,
    attachmentKey?: string,
  ): Promise<void> {
    return this.#enqueue(paneId, () =>
      this.stream.setControlDesired(
        this.#runningBinding(paneId, attachmentKey),
        desired,
        columns,
        rows,
      ),
    );
  }

  preemptControl(
    paneId: string,
    columns: number,
    rows: number,
    attachmentKey?: string,
  ): Promise<void> {
    return this.#enqueue(paneId, () =>
      this.stream.preemptControl(this.#runningBinding(paneId, attachmentKey), columns, rows),
    );
  }

  approveControl(paneId: string, controlRequestId: string, attachmentKey?: string): Promise<void> {
    return this.#enqueue(paneId, () =>
      this.stream.approveControl(this.#runningBinding(paneId, attachmentKey), controlRequestId),
    );
  }

  rejectControl(paneId: string, controlRequestId: string, attachmentKey?: string): Promise<void> {
    return this.#enqueue(paneId, () =>
      this.stream.rejectControl(this.#runningBinding(paneId, attachmentKey), controlRequestId),
    );
  }

  releaseControl(paneId: string, attachmentKey?: string): Promise<void> {
    return this.#enqueue(paneId, () =>
      this.stream.releaseControl(this.#runningBinding(paneId, attachmentKey)),
    );
  }

  restart(paneId: string): Promise<void> {
    return this.#enqueue(paneId, () => this.#start(paneId, DEFAULT_COLUMNS, DEFAULT_ROWS, true));
  }

  startNewCodex(paneId: string): Promise<void> {
    return this.#enqueue(paneId, async () => {
      await this.#requireStartReady();
      const context = this.repository.getPaneContext(paneId);
      if (!context) throw new AppError("PANE_MISSING", 404, "Pane을 찾을 수 없습니다.");
      if (context.pane.kind !== "codex") {
        throw new AppError(
          "REQUEST_INVALID",
          400,
          "Codex Pane에서만 새 세션을 시작할 수 있습니다.",
        );
      }
      await this.#remove(paneId);
      this.repository.setCodexSession(paneId, null, false);
      this.#emitCurrentCodexIdentity(paneId);
      await this.#create(paneId, DEFAULT_COLUMNS, DEFAULT_ROWS);
    });
  }

  startNewClaude(paneId: string): Promise<void> {
    return this.#enqueue(paneId, async () => {
      await this.#requireStartReady();
      const context = this.repository.getPaneContext(paneId);
      if (!context) throw new AppError("PANE_MISSING", 404, "Pane을 찾을 수 없습니다.");
      if (context.pane.kind !== "claude") {
        throw new AppError(
          "REQUEST_INVALID",
          400,
          "Claude Pane에서만 새 대화를 시작할 수 있습니다.",
        );
      }
      await this.#remove(paneId);
      this.repository.clearClaudeSession(paneId);
      await this.#create(paneId, DEFAULT_COLUMNS, DEFAULT_ROWS);
    });
  }

  stop(paneId: string): Promise<void> {
    return this.#enqueue(paneId, () => this.#stop(paneId));
  }

  remove(paneId: string): Promise<void> {
    return this.#enqueue(paneId, () => this.#remove(paneId));
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(this.#paneBarriers.values());
    this.#removeIntegrationActivityListener?.();
    this.#removeIntegrationEventListener?.();
    this.#removeClaudeActivityListener?.();
    for (const observer of this.#integrationObservers.values()) observer.dispose();
    this.#integrationObservers.clear();
    await this.integrationTransport?.close();
    await this.stream.shutdown();
    this.#activityListeners.clear();
    this.#codexIdentityListeners.clear();
  }

  async #create(paneId: string, columns: number, rows: number): Promise<void> {
    const context = this.repository.getPaneContext(paneId);
    if (!context) throw new AppError("PANE_MISSING", 404, "Pane을 찾을 수 없습니다.");
    const integration =
      context.pane.kind === "codex"
        ? this.codexIntegration
        : context.pane.kind === "claude"
          ? this.claudeIntegration
          : undefined;
    if (integration !== undefined) {
      try {
        integration.preflight(paneId);
      } catch (error) {
        const normalized = toAppError(error);
        this.repository.setPaneStatus(paneId, "error", null, normalized.code);
        const change = this.repository.setPaneActivity(paneId, "failed");
        if (change !== null) this.#emitActivity(change);
        throw normalized;
      }
    }
    const integrationBindingId = integration === undefined ? undefined : randomUUID();
    const pending = this.repository.preparePaneSessionOperation(
      paneId,
      "create",
      null,
      integrationBindingId,
    );
    const operationKey = requireOperationKey(pending, "create");
    let created: SessionView;
    try {
      const result = await this.lifecycle.execute({
        ...operationRequestBase(),
        operation: "createSession",
        idempotencyKey: operationKey,
        command: this.#command(
          context.projectPath,
          hostProfileId(context.pane.launchProfile),
          columns,
          rows,
          pending.integrationBindingId,
        ),
      });
      if (result.operation !== "createSession") throw new Error("Unexpected Host operation.");
      this.repository.completePaneSessionOperation(paneId, "create", operationKey, result.session);
      this.#sessionViews.set(paneId, result.session);
      created = result.session;
    } catch (error) {
      this.#recordOperationFailure(paneId, "create", operationKey, error);
      throw toAppError(error);
    }
    await this.#bindAgentRuntime(paneId, created);
  }

  async #start(
    paneId: string,
    columns: number,
    rows: number,
    rejectRunning: boolean,
  ): Promise<void> {
    await this.#requireStartReady();
    let link = this.repository.getPaneSessionLink(paneId);
    if (link?.pendingOperation !== null && link?.pendingOperation !== undefined) {
      await this.#recoverPending(link);
      link = this.repository.getPaneSessionLink(paneId);
    }
    if (link?.state === "missing") {
      if (link.lastErrorCode === "INTERNAL_ERROR") {
        throw new AppError(
          "REQUEST_INVALID",
          409,
          "이전 Session 생성 결과가 불명확하여 자동 재시작할 수 없습니다.",
        );
      }
      this.repository.deletePaneSessionLink(paneId);
      this.#sessionViews.delete(paneId);
      link = undefined;
    }
    if (link === undefined) {
      await this.#create(paneId, columns, rows);
      return;
    }
    const session = await this.#refresh(paneId, requireSessionId(link));
    if (isLiveSession(session)) {
      if (rejectRunning) {
        throw new AppError("REQUEST_INVALID", 409, "실행 중인 Pane은 재시작할 수 없습니다.");
      }
      return;
    }
    const context = this.repository.getPaneContext(paneId);
    if (context?.pane.kind === "claude" && this.claudeIntegration !== undefined) {
      await this.#remove(paneId);
      await this.#create(paneId, columns, rows);
      return;
    }
    if (context?.pane.kind === "codex" && this.codexIntegration !== undefined) {
      await this.#remove(paneId);
      const stopped = this.repository.getPaneContext(paneId)?.pane;
      if (
        stopped?.codexSessionId !== null &&
        stopped?.codexSessionId !== undefined &&
        !stopped.codexSessionResumable
      ) {
        this.repository.setCodexSession(paneId, null, false);
        this.#emitCurrentCodexIdentity(paneId);
      }
      await this.#create(paneId, columns, rows);
      return;
    }
    await this.#startExisting(link, session);
  }

  async #startExisting(link: PaneSessionLink, current?: SessionView): Promise<void> {
    const sessionId = requireSessionId(link);
    const revision = current?.sessionRevision ?? requireExpectedSessionRevision(link);
    const pending = this.repository.preparePaneSessionOperation(link.paneId, "start", {
      sessionRevision: revision,
    });
    const operationKey = requireOperationKey(pending, "start");
    try {
      const result = await this.lifecycle.execute({
        ...operationRequestBase(),
        operation: "startSession",
        sessionId,
        expectedSessionRevision: revision,
        idempotencyKey: operationKey,
      });
      if (result.operation !== "startSession") throw new Error("Unexpected Host operation.");
      this.repository.completePaneSessionOperation(
        link.paneId,
        "start",
        operationKey,
        result.session,
      );
      this.#sessionViews.set(link.paneId, result.session);
      await this.#bindAgentRuntime(link.paneId, result.session);
    } catch (error) {
      this.#recordOperationFailure(link.paneId, "start", operationKey, error);
      throw toAppError(error);
    }
  }

  async #stop(paneId: string): Promise<void> {
    let link = this.repository.getPaneSessionLink(paneId);
    if (link === undefined || link.state === "missing") return;
    if (link.pendingOperation !== null) {
      await this.#recoverPending(link);
      link = this.repository.getPaneSessionLink(paneId);
      if (link === undefined || link.state === "missing") return;
    }
    const session = await this.#refresh(paneId, requireSessionId(link));
    if (!isLiveSession(session) || session.lifecycle === "stopping") return;
    const sessionId = requireSessionId(link);
    const runtimeId = requireViewRuntimeId(session);
    this.codexIntegration?.markStopping(paneId, runtimeId);
    this.claudeIntegration?.markStopping(paneId, runtimeId);
    const revision = session.sessionRevision;
    const pending = this.repository.preparePaneSessionOperation(paneId, "stop", {
      sessionRevision: revision,
      runtimeId,
    });
    const operationKey = requireOperationKey(pending, "stop");
    try {
      const result = await this.lifecycle.execute({
        ...operationRequestBase(),
        operation: "stopSession",
        sessionId,
        expectedSessionRevision: revision,
        expectedRuntimeId: runtimeId,
        idempotencyKey: operationKey,
      });
      if (result.operation !== "stopSession") throw new Error("Unexpected Host operation.");
      this.repository.completePaneSessionOperation(paneId, "stop", operationKey, result.session);
      this.#sessionViews.set(paneId, result.session);
    } catch (error) {
      if (error instanceof DurableSessionHostOperationError) {
        this.codexIntegration?.cancelStopping(paneId, runtimeId);
        this.claudeIntegration?.cancelStopping(paneId, runtimeId);
      }
      this.#recordOperationFailure(paneId, "stop", operationKey, error);
      throw toAppError(error);
    }
  }

  async #remove(paneId: string): Promise<void> {
    await this.#stop(paneId);
    const link = this.repository.getPaneSessionLink(paneId);
    if (link === undefined) return;
    if (link.state === "missing") {
      this.repository.deletePaneSessionLink(paneId);
      this.#sessionViews.delete(paneId);
      this.#disposeIntegrationObserver(paneId);
      return;
    }
    const session = await this.#waitForTerminal(
      link,
      this.#sessionViews.get(paneId) ?? (await this.#refresh(paneId, requireSessionId(link))),
    );
    const sessionId = requireSessionId(link);
    const revision = session.sessionRevision;
    const pending = this.repository.preparePaneSessionOperation(paneId, "forget", {
      sessionRevision: revision,
    });
    const operationKey = requireOperationKey(pending, "forget");
    try {
      const result = await this.lifecycle.execute({
        ...operationRequestBase(),
        operation: "forgetSession",
        sessionId,
        expectedSessionRevision: revision,
      });
      if (result.operation !== "forgetSession" || !result.forgotten) {
        throw new Error("Unexpected Host operation.");
      }
      this.repository.completePaneSessionForget(paneId, operationKey);
      this.#sessionViews.delete(paneId);
      this.#disposeIntegrationObserver(paneId);
    } catch (error) {
      this.#recordOperationFailure(paneId, "forget", operationKey, error);
      if (isHostError(error, "SESSION_NOT_FOUND")) return;
      throw toAppError(error);
    }
  }

  async #recoverPending(link: PaneSessionLink): Promise<void> {
    const operation = link.pendingOperation;
    const operationKey = link.operationKey;
    if (operation === null || operationKey === null) return;
    switch (operation) {
      case "create":
        if (!this.#canRecoverCreate(link)) {
          this.repository.markPaneSessionMissing(link.paneId, "INTERNAL_ERROR");
          this.#sessionViews.delete(link.paneId);
          throw new AppError(
            "PTY_NOT_RUNNING",
            409,
            "Session 생성 복구 기한이 지나 중복 생성을 차단했습니다.",
          );
        }
        await this.#create(link.paneId, DEFAULT_COLUMNS, DEFAULT_ROWS);
        return;
      case "start":
        await this.#startExisting(link);
        return;
      case "stop": {
        const sessionId = requireSessionId(link);
        const runtimeId = requireExpectedRuntimeId(link);
        const revision = requireExpectedSessionRevision(link);
        try {
          const result = await this.lifecycle.execute({
            ...operationRequestBase(),
            operation: "stopSession",
            sessionId,
            expectedSessionRevision: revision,
            expectedRuntimeId: runtimeId,
            idempotencyKey: operationKey,
          });
          if (result.operation !== "stopSession") throw new Error("Unexpected Host operation.");
          this.repository.completePaneSessionOperation(
            link.paneId,
            "stop",
            operationKey,
            result.session,
          );
          this.#sessionViews.set(link.paneId, result.session);
          return;
        } catch (error) {
          this.#recordOperationFailure(link.paneId, "stop", operationKey, error);
          throw toAppError(error);
        }
      }
      case "forget": {
        try {
          const result = await this.lifecycle.execute({
            ...operationRequestBase(),
            operation: "forgetSession",
            sessionId: requireSessionId(link),
            expectedSessionRevision: requireExpectedSessionRevision(link),
          });
          if (result.operation !== "forgetSession") throw new Error("Unexpected Host operation.");
          this.repository.completePaneSessionForget(link.paneId, operationKey);
          this.#sessionViews.delete(link.paneId);
          return;
        } catch (error) {
          this.#recordOperationFailure(link.paneId, "forget", operationKey, error);
          if (isHostError(error, "SESSION_NOT_FOUND")) return;
          throw toAppError(error);
        }
      }
    }
  }

  async #refresh(paneId: string, sessionId: string): Promise<SessionView> {
    try {
      const result = await this.lifecycle.execute({
        ...operationRequestBase(),
        operation: "getSession",
        sessionId,
      });
      if (result.operation !== "getSession") throw new Error("Unexpected Host operation.");
      this.repository.syncPaneSession(paneId, result.session);
      this.#sessionViews.set(paneId, result.session);
      await this.#bindAgentRuntime(paneId, result.session);
      return result.session;
    } catch (error) {
      if (isHostError(error, "SESSION_NOT_FOUND")) {
        this.repository.markPaneSessionMissing(paneId, "SESSION_NOT_FOUND");
        this.#sessionViews.delete(paneId);
        this.#disposeIntegrationObserver(paneId);
      }
      throw toAppError(error);
    }
  }

  #handleRuntimeUnavailable(
    binding: DurableSessionStreamBinding,
    reason: DurableSessionRuntimeUnavailableReason,
  ): void {
    void this.#enqueue(binding.paneId, async () => {
      const current = this.#sessionViews.get(binding.paneId);
      const link = this.repository.getPaneSessionLink(binding.paneId);
      if (
        current?.sessionId !== binding.sessionId ||
        current.runtimeId !== binding.runtimeId ||
        link?.state !== "linked" ||
        link.sessionId !== binding.sessionId
      ) {
        return;
      }

      this.#disposeIntegrationObserver(binding.paneId, binding.runtimeId);
      this.codexIntegration?.disposeRuntime(binding.paneId, binding.runtimeId);
      this.claudeIntegration?.disposeRuntime(binding.paneId, binding.runtimeId);

      if (reason === "SESSION_NOT_FOUND") {
        this.#markRuntimeServerStopped(binding);
        this.repository.markPaneSessionMissing(binding.paneId, reason);
        this.#sessionViews.delete(binding.paneId);
        return;
      }

      let session: SessionView;
      try {
        const result = await this.lifecycle.execute({
          ...operationRequestBase(),
          operation: "getSession",
          sessionId: binding.sessionId,
        });
        if (result.operation !== "getSession") throw new Error("Unexpected Host operation.");
        session = result.session;
        this.repository.syncPaneSession(binding.paneId, session);
      } catch (error) {
        this.#markRuntimeServerStopped(binding);
        this.#sessionViews.delete(binding.paneId);
        if (isHostError(error, "SESSION_NOT_FOUND")) {
          this.repository.markPaneSessionMissing(binding.paneId, "SESSION_NOT_FOUND");
        }
        return;
      }

      this.#sessionViews.set(binding.paneId, session);
      if (isLiveSession(session)) {
        await this.#bindAgentRuntime(binding.paneId, session);
        return;
      }
      this.#markRuntimeServerStopped(binding);
    }).catch(() => {
      // A later reconcile or Pane operation retries Host truth without reviving this runtime.
    });
  }

  #markRuntimeServerStopped(binding: DurableSessionStreamBinding): void {
    this.repository.setPaneStatusForRuntime(
      binding.paneId,
      binding.runtimeId,
      "stopped",
      null,
      null,
      new Date().toISOString(),
    );
    const change = this.repository.setPaneActivityForRuntime(
      binding.paneId,
      binding.runtimeId,
      "server-stopped",
    );
    if (change !== null) this.#emitActivity(change);
  }

  async #waitForTerminal(link: PaneSessionLink, initial: SessionView): Promise<SessionView> {
    const deadline = Date.now() + TERMINAL_STOP_WAIT_MS;
    let current = initial;
    while (isLiveSession(current)) {
      if (Date.now() >= deadline) {
        throw new AppError("REQUEST_INVALID", 409, "Session 종료가 아직 완료되지 않았습니다.");
      }
      await delay(TERMINAL_STOP_POLL_MS);
      current = await this.#refresh(link.paneId, requireSessionId(link));
    }
    return current;
  }

  #recordOperationFailure(
    paneId: string,
    operation: PaneSessionOperation,
    operationKey: string,
    error: unknown,
  ): void {
    if (!(error instanceof DurableSessionHostOperationError)) return;
    if (error.hostError.code === "SESSION_NOT_FOUND") {
      if (operation === "forget") {
        this.repository.completePaneSessionForget(paneId, operationKey);
        this.#sessionViews.delete(paneId);
        return;
      }
      this.repository.markPaneSessionMissing(paneId, error.hostError.code);
      this.#sessionViews.delete(paneId);
      return;
    }
    this.repository.clearPaneSessionOperation(
      paneId,
      operation,
      operationKey,
      error.hostError.code,
    );
    if (
      error.hostError.code === "SESSION_NOT_RUNNING" ||
      error.hostError.code === "SESSION_STATE_INVALID" ||
      error.hostError.code === "RUNTIME_STALE" ||
      error.hostError.code === "SESSION_REVISION_STALE"
    ) {
      this.#sessionViews.delete(paneId);
    }
    if (operation === "create") {
      this.repository.setPaneStatus(paneId, "error", null, "PTY_SPAWN_FAILED");
    }
  }

  #command(
    projectPath: string,
    profileId: string,
    columns: number,
    rows: number,
    integrationBindingId: string | null,
  ): CommandSpecV0 {
    const root = [...this.config.roots]
      .sort((left, right) => right.path.length - left.path.length)
      .find((candidate) => isWithin(projectPath, candidate.path));
    if (root === undefined) {
      throw new AppError("PROJECT_OUTSIDE_ROOT", 403, "프로젝트가 Host root 범위를 벗어났습니다.");
    }
    const relativePath = relative(root.path, projectPath).split(sep).join("/");
    if (profileId === "claude-code" && this.claudeIntegration === undefined) {
      throw new AppError(
        "CLAUDE_EXECUTABLE_MISSING",
        503,
        "Claude Host 통합이 설정되지 않았습니다.",
      );
    }
    const integration =
      integrationBindingId === null
        ? undefined
        : profileId === "claude-code"
          ? this.claudeIntegration?.descriptor(integrationBindingId)
          : this.codexIntegration?.descriptor(integrationBindingId);
    return {
      kind: "profile",
      profileId,
      cwd: { rootId: root.rootId, relativePath },
      terminal: { cols: columns, rows, term: "xterm-256color" },
      ...(integration === undefined ? {} : { integration }),
    };
  }

  async #bindAgentRuntime(paneId: string, session: SessionView): Promise<void> {
    const pane = this.repository.getPaneContext(paneId)?.pane;
    if (session.lifecycle !== "running" || session.runtimeId === null || pane === undefined) return;
    if (pane.kind === "codex" && this.codexIntegration !== undefined) {
      this.codexIntegration.bindRuntime(paneId, session);
    } else if (pane.kind === "claude" && this.claudeIntegration !== undefined) {
      this.claudeIntegration.bindRuntime(paneId, session);
    } else {
      return;
    }
    if (pane.kind === "codex" && pane.codexSessionId !== null) {
      this.#emitCodexIdentityForRuntime(
        paneId,
        session.runtimeId,
        pane.codexSessionId,
        pane.codexSessionResumable,
      );
    }
    const runtimeId = session.runtimeId;
    const existing = this.#integrationObservers.get(paneId);
    if (existing?.runtimeId === runtimeId) return;
    existing?.dispose();
    const binding: DurableSessionStreamBinding = {
      paneId,
      sessionId: session.sessionId,
      runtimeId,
      sessionRevision: session.sessionRevision,
      attachmentKey: `${pane.kind}-integration:${paneId}`,
    };
    const dispose = await this.stream.attach(
      binding,
      DEFAULT_COLUMNS,
      DEFAULT_ROWS,
      (frame) => {
        if (frame.type === "terminal.output") {
          this.codexIntegration?.observeOutput(paneId, runtimeId, frame.data);
          return;
        }
        if (frame.type === "terminal.exit") {
          this.codexIntegration?.observeExit(paneId, runtimeId, frame.exitCode);
          this.claudeIntegration?.observeExit(paneId, runtimeId, frame.exitCode);
          this.codexIntegration?.disposeRuntime(paneId, runtimeId);
          this.claudeIntegration?.disposeRuntime(paneId, runtimeId);
          const current = this.#integrationObservers.get(paneId);
          if (current?.runtimeId === runtimeId) {
            current.dispose();
            this.#integrationObservers.delete(paneId);
          }
        }
      },
      undefined,
      undefined,
      false,
      (reason) => this.#handleRuntimeUnavailable(binding, reason),
    );
    this.#integrationObservers.set(paneId, { runtimeId, dispose });
  }

  #disposeIntegrationObserver(paneId: string, runtimeId?: string): void {
    const observer = this.#integrationObservers.get(paneId);
    if (runtimeId !== undefined && observer?.runtimeId !== runtimeId) return;
    observer?.dispose();
    this.#integrationObservers.delete(paneId);
  }

  #emitActivity(change: Parameters<SessionActivityListener>[0]): void {
    for (const listener of this.#activityListeners) listener(change);
  }

  #emitCodexIdentity(change: SessionCodexIdentityChange): void {
    for (const listener of this.#codexIdentityListeners) listener(change);
  }

  #emitCodexIdentityForRuntime(
    paneId: string,
    runtimeId: string,
    sessionId: string | null,
    resumable: boolean,
  ): void {
    const pane = this.repository.getPaneContext(paneId)?.pane;
    if (pane?.activity.runtimeId !== runtimeId) return;
    this.#emitCodexIdentity({ paneId, runtimeId, sessionId, resumable, updatedAt: pane.updatedAt });
  }

  #emitCurrentCodexIdentity(paneId: string): void {
    const pane = this.repository.getPaneContext(paneId)?.pane;
    const runtimeId = pane?.activity.runtimeId;
    if (runtimeId === null || runtimeId === undefined || pane === undefined) return;
    this.#emitCodexIdentity({
      paneId,
      runtimeId,
      sessionId: pane.codexSessionId,
      resumable: pane.codexSessionResumable,
      updatedAt: pane.updatedAt,
    });
  }

  #runningBinding(paneId: string, attachmentKey = paneId): DurableSessionStreamBinding {
    const link = this.repository.getPaneSessionLink(paneId);
    const session = this.#sessionViews.get(paneId);
    if (link?.state !== "linked" || session?.lifecycle !== "running") {
      throw new AppError("PTY_NOT_RUNNING", 409, "실행 중인 Pane이 아닙니다.");
    }
    return {
      paneId,
      sessionId: requireSessionId(link),
      runtimeId: requireViewRuntimeId(session),
      sessionRevision: session.sessionRevision,
      attachmentKey,
    };
  }

  #canRecoverCreate(link: PaneSessionLink): boolean {
    const startedAt = Date.parse(link.updatedAt);
    if (!Number.isFinite(startedAt)) return false;
    const safetyMarginMs = Math.min(1_000, Math.floor(this.config.idempotencyTtlMs / 10));
    return this.now() < startedAt + this.config.idempotencyTtlMs - safetyMarginMs;
  }

  #enqueue(paneId: string, operation: () => void | Promise<void>): Promise<void> {
    return this.#enqueueResult(paneId, operation);
  }

  async #requireStartReady(): Promise<void> {
    const [lifecycleReady, streamReady] = await Promise.all([
      this.lifecycle.readiness(),
      this.stream.readiness(),
    ]);
    if (!lifecycleReady || !streamReady) {
      throw new AppError("INTERNAL_ERROR", 503, "DurableSession runtime이 준비되지 않았습니다.");
    }
  }

  #enqueueResult<T>(paneId: string, operation: () => T | Promise<T>): Promise<T> {
    const previous = this.#paneBarriers.get(paneId) ?? Promise.resolve();
    const result = previous.then(operation);
    const barrier = result.then(
      () => undefined,
      () => undefined,
    );
    this.#paneBarriers.set(paneId, barrier);
    void barrier.finally(() => {
      if (this.#paneBarriers.get(paneId) === barrier) this.#paneBarriers.delete(paneId);
    });
    return result;
  }
}

function requireOperationKey(link: PaneSessionLink, operation: PaneSessionOperation): string {
  if (link.pendingOperation !== operation || link.operationKey === null) {
    throw new AppError("REQUEST_INVALID", 409, "Pane Session 전환 상태가 올바르지 않습니다.");
  }
  return link.operationKey;
}

/**
 * A managed Claude agent Pane runs under the Host's `claude-code` profile and integration policy;
 * Naru decides what the launcher starts (runner or TUI), so Host configuration is unchanged.
 */
function hostProfileId(launchProfile: string): string {
  return launchProfile === CLAUDE_AGENT_LAUNCH_PROFILE ? "claude-code" : launchProfile;
}

function requireSessionId(link: PaneSessionLink): string {
  if (link.sessionId === null) throw new AppError("PTY_NOT_RUNNING", 409, "Session이 없습니다.");
  return link.sessionId;
}

function requireExpectedRuntimeId(link: PaneSessionLink): string {
  if (link.expectedRuntimeId === null) {
    throw new AppError("PTY_NOT_RUNNING", 409, "Runtime fence가 없습니다.");
  }
  return link.expectedRuntimeId;
}

function requireExpectedSessionRevision(link: PaneSessionLink): number {
  if (link.expectedSessionRevision === null) {
    throw new AppError("PTY_NOT_RUNNING", 409, "Session revision fence가 없습니다.");
  }
  return link.expectedSessionRevision;
}

function requireViewRuntimeId(session: SessionView): string {
  if (session.runtimeId === null) {
    throw new AppError("PTY_NOT_RUNNING", 409, "Runtime이 없습니다.");
  }
  return session.runtimeId;
}

function isLiveSession(session: SessionView): boolean {
  return (
    session.lifecycle === "creating" ||
    session.lifecycle === "running" ||
    session.lifecycle === "stopping"
  );
}

function isWithin(path: string, root: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix))
  );
}

function isHostError(error: unknown, code: DurableSessionErrorCode): boolean {
  return error instanceof DurableSessionHostOperationError && error.hostError.code === code;
}

function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (!(error instanceof DurableSessionHostOperationError)) {
    return new AppError("INTERNAL_ERROR", 503, "DurableSession Host에 연결할 수 없습니다.");
  }
  switch (error.hostError.code) {
    case "SESSION_NOT_FOUND":
    case "SESSION_NOT_RUNNING":
      return new AppError("PTY_NOT_RUNNING", 409, "실행 중인 Pane이 아닙니다.");
    case "SESSION_STATE_INVALID":
    case "RUNTIME_STALE":
    case "SESSION_REVISION_STALE":
    case "CONTROL_HELD":
    case "CONTROL_GENERATION_STALE":
    case "ATTACHMENT_NOT_FOUND":
    case "ATTACHMENT_NOT_CONTROLLER":
    case "ATTACHMENT_RESUME_REJECTED":
    case "RESYNC_REQUIRED":
      return new AppError("REQUEST_INVALID", 409, "Host Session 상태가 변경되었습니다.");
    case "REQUEST_INVALID":
    case "PROTOCOL_VERSION_UNSUPPORTED":
      return new AppError("REQUEST_INVALID", 400, "Host 요청이 올바르지 않습니다.");
    case "COMMAND_POLICY_DENIED":
    case "ROOT_BOUNDARY_VIOLATION":
    case "SESSION_LIMIT_REACHED":
      return new AppError("PTY_SPAWN_FAILED", 503, "Host에서 Pane 프로세스를 시작하지 못했습니다.");
    default:
      return new AppError("INTERNAL_ERROR", 503, "DurableSession Host 요청이 거부되었습니다.");
  }
}

function streamUnavailable(): AppError {
  return new AppError("INTERNAL_ERROR", 503, "DurableSession stream 연결이 준비되지 않았습니다.");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
