import {
  CLIPBOARD_IMAGE_CHUNK_BYTES,
  MAX_TERMINAL_SCROLLBACK_ROWS,
  MAX_CLIPBOARD_IMAGE_BYTES,
  ServerWsFrameSchema,
  type LeaseAcquisition,
  type ServerWsFrame,
  type SurfaceRole,
  type TerminalRestoreProtocol,
} from "@naru/contracts";
import { createClientId } from "./client-id";

export type ConnectionState =
  "connecting" | "active" | "disconnected" | "revoked" | "authentication-required";

export interface ConnectionSnapshot {
  state: ConnectionState;
  message?: string;
  acquisition?: LeaseAcquisition;
  revocationReason?: LeaseRevocationReason;
  surfaceRole?: SurfaceRole;
  controllerPresent?: boolean;
  connectionId?: string;
  generation?: number;
}

export type LeaseRevocationReason = Extract<ServerWsFrame, { type: "lease.revoked" }>["reason"];

export type PaneFrame = Extract<
  ServerWsFrame,
  {
    type:
      | "pane.snapshot"
      | "pane.restore.preview"
      | "pane.restore.full"
      | "pane.control.state"
      | "terminal.output"
      | "terminal.exit";
  }
>;
export type ActivityFrame = Extract<ServerWsFrame, { type: "activity.changed" }>;
export type CodexIdentityFrame = Extract<ServerWsFrame, { type: "codex.session.changed" }>;
export type PaneControlFrame = Extract<
  ServerWsFrame,
  { type: "pane.control.state" | "pane.control.requested" | "pane.control.request-resolved" }
>;
export type PaneControlState = Extract<ServerWsFrame, { type: "pane.control.state" }>;

interface Attachment {
  cols: number;
  rows: number;
  sequence: number;
  restoreId: string | undefined;
  listener: (frame: PaneFrame) => void;
}

interface PendingClipboardImage {
  readonly paneId: string;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

export interface TerminalAttachment {
  input(data: string): boolean;
  pasteImage(image: Uint8Array): Promise<void>;
  resize(cols: number, rows: number): void;
  viewport(runtimeId: string, bottomOffset: number): void;
  dispose(): void;
}

export interface TerminalConnectionOptions {
  readonly checkAuthentication?: () => Promise<boolean>;
  readonly restoreProtocol?: TerminalRestoreProtocol;
}

export class TerminalConnection {
  readonly #clientId = stableClientId();
  readonly #attachments = new Map<string, Attachment>();
  readonly #statusListeners = new Set<(snapshot: ConnectionSnapshot) => void>();
  readonly #activityListeners = new Set<(frame: ActivityFrame) => void>();
  readonly #codexIdentityListeners = new Set<(frame: CodexIdentityFrame) => void>();
  readonly #paneControlListeners = new Set<(frame: PaneControlFrame) => void>();
  readonly #inputListeners = new Set<(paneId: string) => void>();
  readonly #pendingClipboardImages = new Map<string, PendingClipboardImage>();
  readonly #paneControls = new Map<string, PaneControlState>();
  readonly #checkAuthentication: (() => Promise<boolean>) | undefined;
  readonly #restoreProtocol: TerminalRestoreProtocol | undefined;
  #socket: WebSocket | undefined;
  #generation: number | undefined;
  #status: ConnectionSnapshot = { state: "connecting" };
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #presenceFlush: ReturnType<typeof setTimeout> | undefined;
  #interactionRevision = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #offlineProbe: AbortController | undefined;
  #reconnectAttempt = 0;
  #recoveryGeneration = 0;
  #disposed = false;
  #revoked = false;

  constructor(options: TerminalConnectionOptions = {}) {
    this.#checkAuthentication = options.checkAuthentication;
    this.#restoreProtocol = options.restoreProtocol;
    window.addEventListener("offline", this.#handleOffline);
    window.addEventListener("online", this.#handleOnline);
    window.addEventListener("focus", this.#handlePresenceChange);
    window.addEventListener("blur", this.#handlePresenceChange);
    window.addEventListener("pointerdown", this.#handleInteraction, true);
    window.addEventListener("keydown", this.#handleInteraction, true);
    document.addEventListener("visibilitychange", this.#handlePresenceChange);
    this.#connect();
  }

  status(): ConnectionSnapshot {
    return this.#status;
  }

  onStatus(listener: (snapshot: ConnectionSnapshot) => void): () => void {
    this.#statusListeners.add(listener);
    listener(this.#status);
    return () => this.#statusListeners.delete(listener);
  }

  onActivity(listener: (frame: ActivityFrame) => void): () => void {
    this.#activityListeners.add(listener);
    return () => this.#activityListeners.delete(listener);
  }

  onCodexIdentity(listener: (frame: CodexIdentityFrame) => void): () => void {
    this.#codexIdentityListeners.add(listener);
    return () => this.#codexIdentityListeners.delete(listener);
  }

  onPaneControl(listener: (frame: PaneControlFrame) => void): () => void {
    this.#paneControlListeners.add(listener);
    return () => this.#paneControlListeners.delete(listener);
  }

  paneControl(paneId: string): PaneControlState | undefined {
    return this.#paneControls.get(paneId);
  }

  onInput(listener: (paneId: string) => void): () => void {
    this.#inputListeners.add(listener);
    return () => this.#inputListeners.delete(listener);
  }

  input(paneId: string, data: string): boolean {
    if (!this.#canControlPane(paneId)) return false;
    if (!this.#sendWithLease({ type: "terminal.input", paneId, data })) return false;
    for (const listener of this.#inputListeners) listener(paneId);
    return true;
  }

  attach(
    paneId: string,
    cols: number,
    rows: number,
    listener: (frame: PaneFrame) => void,
  ): TerminalAttachment {
    const restoreId = this.#restoreProtocol === undefined ? undefined : createClientId();
    this.#attachments.set(paneId, { cols, rows, sequence: 0, restoreId, listener });
    this.#sendAttach(paneId);
    return {
      input: (data) => {
        return this.input(paneId, data);
      },
      pasteImage: (image) => this.#pasteImage(paneId, image),
      resize: (nextCols, nextRows) => {
        const attachment = this.#attachments.get(paneId);
        if (!attachment) return;
        attachment.cols = nextCols;
        attachment.rows = nextRows;
        if (!this.#canControlPane(paneId)) return;
        this.#sendWithLease({
          type: "terminal.resize",
          paneId,
          cols: nextCols,
          rows: nextRows,
        });
      },
      viewport: (runtimeId, bottomOffset) => {
        if (!this.#attachments.has(paneId) || !this.#canControlPane(paneId)) return;
        this.#sendWithLease({
          type: "terminal.viewport",
          paneId,
          runtimeId,
          bottomOffset: Math.min(
            MAX_TERMINAL_SCROLLBACK_ROWS,
            Math.max(0, Math.round(bottomOffset)),
          ),
        });
      },
      dispose: () => {
        if (!this.#attachments.delete(paneId)) return;
        this.#rejectClipboardImages("Pane 연결이 닫혀 이미지 붙여넣기를 중단했습니다.", paneId);
        this.#sendWithLease({ type: "pane.detach", paneId });
      },
    };
  }

  takeControl(paneId?: string): boolean {
    if (this.#status.state !== "active" || this.#status.surfaceRole !== "observer") return false;
    if (this.#status.controllerPresent === false) {
      return this.#sendWithLease({ type: "surface.acquire" });
    }
    const attachment = paneId === undefined ? undefined : this.#attachments.get(paneId);
    return this.#sendWithLease({
      type: "surface.takeover",
      target:
        paneId === undefined || attachment === undefined
          ? null
          : { paneId, cols: attachment.cols, rows: attachment.rows },
    });
  }

  preemptPaneControl(paneId: string): boolean {
    const attachment = this.#attachments.get(paneId);
    if (!attachment || !this.#isSurfaceController()) return false;
    return this.#sendWithLease({
      type: "pane.control.preempt",
      paneId,
      cols: attachment.cols,
      rows: attachment.rows,
    });
  }

  approvePaneControl(paneId: string, controlRequestId: string): boolean {
    if (!this.#canControlPane(paneId)) return false;
    return this.#sendWithLease({ type: "pane.control.approve", paneId, controlRequestId });
  }

  rejectPaneControl(paneId: string, controlRequestId: string): boolean {
    if (!this.#canControlPane(paneId)) return false;
    return this.#sendWithLease({ type: "pane.control.reject", paneId, controlRequestId });
  }

  releasePaneControl(paneId: string): boolean {
    if (!this.#canControlPane(paneId)) return false;
    return this.#sendWithLease({ type: "pane.control.release", paneId });
  }

  reconnectNow(): void {
    this.#restartConnection();
  }

  #restartConnection(): void {
    if (this.#disposed) return;
    this.#revoked = false;
    this.#recoveryGeneration += 1;
    this.#reconnectAttempt = 0;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#rejectClipboardImages("터미널 연결을 다시 여는 동안 이미지 붙여넣기를 중단했습니다.");
    const oldSocket = this.#socket;
    this.#socket = undefined;
    oldSocket?.close(1000, "Taking control again");
    this.#connect();
  }

  dispose(): void {
    this.#disposed = true;
    window.removeEventListener("offline", this.#handleOffline);
    window.removeEventListener("online", this.#handleOnline);
    window.removeEventListener("focus", this.#handlePresenceChange);
    window.removeEventListener("blur", this.#handlePresenceChange);
    window.removeEventListener("pointerdown", this.#handleInteraction, true);
    window.removeEventListener("keydown", this.#handleInteraction, true);
    document.removeEventListener("visibilitychange", this.#handlePresenceChange);
    this.#offlineProbe?.abort();
    this.#offlineProbe = undefined;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    if (this.#presenceFlush) clearTimeout(this.#presenceFlush);
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#rejectClipboardImages("터미널 연결이 닫혀 이미지 붙여넣기를 중단했습니다.");
    this.#socket?.close(1000, "Client disposed");
    this.#attachments.clear();
    this.#statusListeners.clear();
    this.#activityListeners.clear();
    this.#codexIdentityListeners.clear();
    this.#paneControlListeners.clear();
    this.#inputListeners.clear();
    this.#paneControls.clear();
  }

  #connect(): void {
    if (this.#disposed) return;
    this.#setTransitionalStatus("connecting");
    const url = new URL("/api/terminal", window.location.href);
    url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    this.#socket = socket;

    socket.addEventListener("open", () => {
      if (this.#socket === socket) this.#send({ type: "lease.acquire", clientId: this.#clientId });
    });
    socket.addEventListener("message", (event) => {
      if (this.#socket === socket && typeof event.data === "string") this.#handleFrame(event.data);
    });
    socket.addEventListener("close", (event) => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      this.#generation = undefined;
      this.#paneControls.clear();
      this.#rejectClipboardImages("서버 연결이 끊겨 이미지 붙여넣기를 중단했습니다.");
      if (this.#heartbeat) clearInterval(this.#heartbeat);
      this.#heartbeat = undefined;
      if (this.#revoked) {
        if (this.#status.state !== "revoked" && this.#status.state !== "authentication-required") {
          this.#setStatus({
            state: "revoked",
            message: "터미널 제어권이 해제되었습니다.",
          });
        }
      } else if (event.code === 4003 && isAuthenticationCloseReason(event.reason)) {
        this.#requireAuthentication();
      } else {
        this.#setTransitionalStatus("disconnected", "서버에 다시 연결하는 중입니다.");
        void this.#continueAfterAuthenticationCheck();
      }
    });
    socket.addEventListener("error", () => {
      if (this.#socket === socket) {
        this.#setTransitionalStatus("disconnected", "터미널 연결을 열지 못했습니다.");
      }
    });
  }

  #handleFrame(raw: string): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw) as unknown;
    } catch {
      this.#setTransitionalStatus("disconnected", "서버 응답 형식이 올바르지 않습니다.");
      return;
    }
    const parsed = ServerWsFrameSchema.safeParse(decoded);
    if (!parsed.success) {
      this.#setTransitionalStatus("disconnected", "서버 응답을 검증하지 못했습니다.");
      return;
    }
    const frame = parsed.data;

    switch (frame.type) {
      case "lease.granted":
        this.#generation = frame.generation;
        this.#reconnectAttempt = 0;
        this.#setStatus({
          state: "connecting",
          acquisition: frame.acquisition,
          message: acquisitionMessage(frame.acquisition),
        });
        for (const paneId of this.#attachments.keys()) this.#sendAttach(paneId);
        this.#startHeartbeat();
        break;
      case "surface.state":
        this.#generation = frame.generation;
        if (frame.role === "observer") {
          this.#rejectClipboardImages(
            "이 화면이 보기 전용으로 전환되어 이미지 붙여넣기를 중단했습니다.",
          );
        }
        this.#setStatus({
          state: "active",
          ...(frame.role === "controller" && frame.reason === "preempted"
            ? { acquisition: "takeover" as const }
            : this.#status.acquisition === undefined
              ? {}
              : { acquisition: this.#status.acquisition }),
          surfaceRole: frame.role,
          controllerPresent: frame.controllerPresent,
          connectionId: frame.connectionId,
          generation: frame.generation,
          message: surfaceMessage(frame.role, frame.controllerPresent),
        });
        break;
      case "lease.revoked":
        this.#revoked = true;
        this.#generation = undefined;
        this.#rejectClipboardImages("터미널 제어권이 해제되어 이미지 붙여넣기를 중단했습니다.");
        if (this.#heartbeat) clearInterval(this.#heartbeat);
        this.#heartbeat = undefined;
        if (frame.reason === "expired" || frame.reason === "logout") {
          this.#requireAuthentication(frame.reason);
        } else {
          this.#setStatus({
            state: "revoked",
            revocationReason: frame.reason,
            message: revocationMessage(frame.reason),
          });
        }
        break;
      case "pane.snapshot": {
        const attachment = this.#attachments.get(frame.paneId);
        if (!attachment) return;
        attachment.sequence = frame.sequence;
        attachment.listener(frame);
        break;
      }
      case "pane.restore.preview":
      case "pane.restore.full": {
        const attachment = this.#attachments.get(frame.paneId);
        if (!attachment || attachment.restoreId !== frame.restoreId) return;
        attachment.sequence = Math.max(attachment.sequence, frame.sequence);
        attachment.listener(frame);
        break;
      }
      case "pane.control.state": {
        this.#paneControls.set(frame.paneId, frame);
        this.#attachments.get(frame.paneId)?.listener(frame);
        for (const listener of this.#paneControlListeners) listener(frame);
        break;
      }
      case "pane.control.requested":
      case "pane.control.request-resolved":
        for (const listener of this.#paneControlListeners) listener(frame);
        break;
      case "terminal.output": {
        const attachment = this.#attachments.get(frame.paneId);
        if (!attachment || frame.sequence <= attachment.sequence) return;
        attachment.sequence = frame.sequence;
        attachment.listener(frame);
        break;
      }
      case "terminal.exit":
        this.#attachments.get(frame.paneId)?.listener(frame);
        break;
      case "activity.changed":
        for (const listener of this.#activityListeners) listener(frame);
        break;
      case "codex.session.changed":
        for (const listener of this.#codexIdentityListeners) listener(frame);
        break;
      case "protocol.error":
        this.#setStatus({
          ...this.#status,
          state: this.#generation ? "active" : "disconnected",
          message: frame.message,
        });
        break;
      case "clipboard.image.result": {
        const pending = this.#pendingClipboardImages.get(frame.requestId);
        if (!pending || pending.paneId !== frame.paneId) break;
        clearTimeout(pending.timeout);
        this.#pendingClipboardImages.delete(frame.requestId);
        if (frame.status === "attached") pending.resolve();
        else pending.reject(new Error(frame.message ?? "이미지를 붙여넣지 못했습니다."));
        break;
      }
      case "heartbeat.ack":
        break;
    }
  }

  #sendAttach(paneId: string): void {
    const attachment = this.#attachments.get(paneId);
    if (!attachment) return;
    this.#sendWithLease({
      type: "pane.attach",
      paneId,
      cols: attachment.cols,
      rows: attachment.rows,
      ...(this.#restoreProtocol === undefined || attachment.restoreId === undefined
        ? {}
        : { restoreProtocol: this.#restoreProtocol, restoreId: attachment.restoreId }),
    });
  }

  #sendWithLease(frame: Record<string, unknown>): boolean {
    const socket = this.#socket;
    const generation = this.#generation;
    if (!socket || socket.readyState !== WebSocket.OPEN || generation === undefined) return false;
    socket.send(JSON.stringify({ ...frame, leaseGeneration: generation }));
    return true;
  }

  #pasteImage(paneId: string, image: Uint8Array): Promise<void> {
    if (image.byteLength === 0 || image.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) {
      return Promise.reject(new Error("클립보드 이미지는 16 MiB 이하여야 합니다."));
    }
    if (!this.#canControlPane(paneId)) {
      return Promise.reject(new Error("현재 화면은 이 터미널을 제어할 수 없습니다."));
    }
    const socket = this.#socket;
    const generation = this.#generation;
    if (!socket || socket.readyState !== WebSocket.OPEN || !generation) {
      return Promise.reject(new Error("활성 터미널 연결이 필요합니다."));
    }
    const requestId = createClientId();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.#pendingClipboardImages.get(requestId);
        if (!pending) return;
        this.#pendingClipboardImages.delete(requestId);
        pending.reject(new Error("이미지 붙여넣기 시간이 초과되었습니다."));
      }, 35_000);
      this.#pendingClipboardImages.set(requestId, { paneId, resolve, reject, timeout });
      void this.#sendClipboardImage(socket, generation, requestId, paneId, image).catch((error) => {
        const pending = this.#pendingClipboardImages.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.#pendingClipboardImages.delete(requestId);
        pending.reject(
          error instanceof Error ? error : new Error("이미지 전송을 시작하지 못했습니다."),
        );
      });
    });
  }

  async #sendClipboardImage(
    socket: WebSocket,
    generation: number,
    requestId: string,
    paneId: string,
    image: Uint8Array,
  ): Promise<void> {
    this.#sendOnCurrentSocket(socket, {
      type: "clipboard.image.begin",
      requestId,
      paneId,
      leaseGeneration: generation,
      byteLength: image.byteLength,
    });
    for (let offset = 0; offset < image.byteLength; offset += CLIPBOARD_IMAGE_CHUNK_BYTES) {
      await this.#waitForClipboardBuffer(socket, requestId);
      const chunk = image.subarray(
        offset,
        Math.min(offset + CLIPBOARD_IMAGE_CHUNK_BYTES, image.byteLength),
      );
      this.#sendOnCurrentSocket(socket, {
        type: "clipboard.image.chunk",
        requestId,
        paneId,
        leaseGeneration: generation,
        offset,
        data: encodeBase64(chunk),
      });
    }
    await this.#waitForClipboardBuffer(socket, requestId);
    this.#sendOnCurrentSocket(socket, {
      type: "clipboard.image.commit",
      requestId,
      paneId,
      leaseGeneration: generation,
    });
  }

  async #waitForClipboardBuffer(socket: WebSocket, requestId: string): Promise<void> {
    while (socket.bufferedAmount > 256 * 1024) {
      if (!this.#pendingClipboardImages.has(requestId)) {
        throw new Error("이미지 붙여넣기가 중단되었습니다.");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
    }
  }

  #sendOnCurrentSocket(socket: WebSocket, frame: Record<string, unknown>): void {
    if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("터미널 연결이 변경되었습니다.");
    }
    socket.send(JSON.stringify(frame));
  }

  #rejectClipboardImages(message: string, paneId?: string): void {
    for (const [requestId, pending] of this.#pendingClipboardImages) {
      if (paneId !== undefined && pending.paneId !== paneId) continue;
      clearTimeout(pending.timeout);
      this.#pendingClipboardImages.delete(requestId);
      pending.reject(new Error(message));
    }
  }

  #send(frame: Record<string, unknown>): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(frame));
  }

  #isSurfaceController(): boolean {
    return this.#status.state === "active" && this.#status.surfaceRole === "controller";
  }

  #canControlPane(paneId: string): boolean {
    return this.#isSurfaceController() && this.#paneControls.get(paneId)?.role === "controller";
  }

  #startHeartbeat(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#sendHeartbeat();
    this.#heartbeat = setInterval(() => this.#sendHeartbeat(), 15_000);
  }

  #sendHeartbeat(): void {
    this.#sendWithLease({
      type: "heartbeat",
      sentAt: Date.now(),
      presence: {
        visible: document.visibilityState === "visible",
        focused: document.hasFocus(),
        interactionRevision: this.#interactionRevision,
      },
    });
  }

  #scheduleReconnect(): void {
    if (this.#disposed || this.#revoked || this.#reconnectTimer) return;
    const delay = Math.min(500 * 2 ** this.#reconnectAttempt, 5_000);
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#connect();
    }, delay);
  }

  async #continueAfterAuthenticationCheck(): Promise<void> {
    if (!this.#checkAuthentication) {
      this.#scheduleReconnect();
      return;
    }
    const generation = ++this.#recoveryGeneration;
    try {
      const authenticated = await this.#checkAuthentication();
      if (
        generation !== this.#recoveryGeneration ||
        this.#disposed ||
        this.#revoked ||
        this.#socket
      ) {
        return;
      }
      if (!authenticated) {
        this.#requireAuthentication();
        return;
      }
    } catch {
      if (
        generation !== this.#recoveryGeneration ||
        this.#disposed ||
        this.#revoked ||
        this.#socket
      ) {
        return;
      }
    }
    this.#scheduleReconnect();
  }

  #requireAuthentication(reason?: "expired" | "logout"): void {
    this.#revoked = true;
    this.#recoveryGeneration += 1;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#setStatus({
      state: "authentication-required",
      ...(reason === undefined ? {} : { revocationReason: reason }),
      message:
        reason === "logout"
          ? "로그아웃되어 다시 인증해야 합니다."
          : "세션이 만료되어 다시 로그인해야 합니다.",
    });
  }

  #setStatus(snapshot: ConnectionSnapshot): void {
    this.#status = snapshot;
    for (const listener of this.#statusListeners) listener(snapshot);
  }

  #setTransitionalStatus(
    state: Extract<ConnectionState, "connecting" | "disconnected">,
    message?: string,
  ): void {
    this.#setStatus({
      state,
      ...(message === undefined ? {} : { message }),
      ...(this.#status.surfaceRole === undefined ? {} : { surfaceRole: this.#status.surfaceRole }),
    });
  }

  readonly #handleOffline = (): void => {
    if (this.#disposed || this.#revoked) return;
    this.#offlineProbe?.abort();
    const probe = new AbortController();
    this.#offlineProbe = probe;
    const timeout = setTimeout(() => probe.abort(), 1_500);
    void fetch(new URL("/healthz", window.location.href), {
      cache: "no-store",
      credentials: "same-origin",
      signal: probe.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error("Naru health check failed.");
      })
      .catch(() => {
        if (this.#offlineProbe !== probe || this.#disposed || this.#revoked) return;
        if (this.#heartbeat) clearInterval(this.#heartbeat);
        this.#heartbeat = undefined;
        if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
        this.#reconnectTimer = undefined;
        const oldSocket = this.#socket;
        this.#socket = undefined;
        this.#generation = undefined;
        this.#rejectClipboardImages("네트워크가 끊겨 이미지 붙여넣기를 중단했습니다.");
        oldSocket?.close(1000, "Local server unreachable");
        this.#setTransitionalStatus("disconnected", "네트워크 연결을 기다리는 중입니다.");
      })
      .finally(() => {
        clearTimeout(timeout);
        if (this.#offlineProbe === probe) this.#offlineProbe = undefined;
      });
  };

  readonly #handleOnline = (): void => {
    if (this.#disposed || this.#revoked) return;
    this.#offlineProbe?.abort();
    this.#offlineProbe = undefined;
    if (this.#socket) return;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#reconnectAttempt = 0;
    this.#connect();
  };

  readonly #handlePresenceChange = (): void => {
    this.#sendHeartbeat();
  };

  readonly #handleInteraction = (): void => {
    this.#interactionRevision =
      this.#interactionRevision >= Number.MAX_SAFE_INTEGER ? 0 : this.#interactionRevision + 1;
    if (this.#presenceFlush) return;
    this.#sendHeartbeat();
    this.#presenceFlush = setTimeout(() => {
      this.#presenceFlush = undefined;
      this.#sendHeartbeat();
    }, 1_000);
  };
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 8192, bytes.length)));
  }
  return btoa(binary);
}

function acquisitionMessage(acquisition: LeaseAcquisition): string {
  switch (acquisition) {
    case "initial":
      return "터미널 제어 연결이 준비되었습니다.";
    case "reconnect":
      return "같은 브라우저에서 터미널 제어를 다시 연결했습니다.";
    case "takeover":
      return "이 화면으로 터미널 제어권을 가져왔습니다.";
  }
}

function surfaceMessage(role: SurfaceRole, controllerPresent: boolean): string {
  if (role === "controller") return "이 화면에서 터미널을 제어하고 있습니다.";
  return controllerPresent
    ? "다른 화면이 제어 중입니다. 이 화면은 보기 전용입니다."
    : "제어 중인 화면이 없습니다. 이 화면에서 제어를 시작할 수 있습니다.";
}

function revocationMessage(reason: LeaseRevocationReason): string {
  switch (reason) {
    case "replaced":
      return "다른 화면이 터미널 제어권을 가져갔습니다.";
    case "expired":
      return "터미널 제어권이 만료되어 입력이 중지되었습니다.";
    case "logout":
      return "로그아웃되어 터미널 입력이 중지되었습니다.";
    case "server_shutdown":
      return "서버가 종료되어 터미널 입력이 중지되었습니다.";
  }
}

function isAuthenticationCloseReason(reason: string): boolean {
  return (
    reason === "expired" ||
    reason === "logout" ||
    reason === "Authentication required" ||
    reason === "Logged out"
  );
}

function stableClientId(): string {
  const key = "naru-client-id";
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const created = createClientId();
  sessionStorage.setItem(key, created);
  return created;
}
