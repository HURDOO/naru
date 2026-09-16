// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalConnection, type ConnectionSnapshot, type PaneFrame } from "./terminal-connection";

const paneId = "11111111-1111-4111-8111-111111111111";
const runtimeId = "22222222-2222-4222-8222-222222222222";

describe("TerminalConnection authentication recovery", () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    sessionStorage.clear();
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const basePath = document.createElement("meta");
    basePath.name = "naru-app-base-path";
    basePath.content = "/";
    document.head.append(basePath);
  });

  afterEach(() => {
    document.querySelectorAll('meta[name="naru-app-base-path"]').forEach((node) => node.remove());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens the terminal WebSocket under the configured app base path", () => {
    const basePath = document.querySelector<HTMLMetaElement>('meta[name="naru-app-base-path"]');
    if (basePath === null) throw new Error("Fixture app base path metadata is missing.");
    basePath.content = "/naru";
    const connection = new TerminalConnection();
    expect(new URL(FakeWebSocket.instances[0]!.url).pathname).toBe("/naru/api/terminal");
    connection.dispose();
  });

  it("turns an expired established lease into a terminal authentication state without retrying", async () => {
    const checkAuthentication = vi.fn(() => Promise.resolve(true));
    const connection = new TerminalConnection({ checkAuthentication });
    const snapshots: ConnectionSnapshot[] = [];
    connection.onStatus((snapshot) => snapshots.push(snapshot));
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.receive({
      type: "lease.granted",
      generation: 1,
      replacedClient: false,
      acquisition: "initial",
    });

    socket.receive({ type: "lease.revoked", reason: "expired" });
    socket.serverClose(4003, "expired");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(snapshots.at(-1)).toMatchObject({
      state: "authentication-required",
      revocationReason: "expired",
    });
    expect(checkAuthentication).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
    connection.dispose();
  });

  it("checks the REST session after a rejected reconnect and stops when authentication is gone", async () => {
    const checkAuthentication = vi.fn(() => Promise.resolve(false));
    const connection = new TerminalConnection({ checkAuthentication });
    const snapshots: ConnectionSnapshot[] = [];
    connection.onStatus((snapshot) => snapshots.push(snapshot));

    FakeWebSocket.instances[0]!.serverClose(1006, "upgrade rejected");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(checkAuthentication).toHaveBeenCalledOnce();
    expect(snapshots.at(-1)).toMatchObject({ state: "authentication-required" });
    expect(FakeWebSocket.instances).toHaveLength(1);
    connection.dispose();
  });

  it("keeps normal reconnect behavior when the session check only has a network failure", async () => {
    const checkAuthentication = vi.fn(() => Promise.reject(new Error("network unavailable")));
    const connection = new TerminalConnection({ checkAuthentication });

    FakeWebSocket.instances[0]!.serverClose(1006, "network lost");
    await vi.advanceTimersByTimeAsync(500);

    expect(checkAuthentication).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances).toHaveLength(2);
    connection.dispose();
  });

  it("delivers current-runtime Codex identity changes independently of terminal exit frames", () => {
    const connection = new TerminalConnection();
    const changes: Array<{ id: string | null; resumable: boolean }> = [];
    connection.onCodexIdentity((frame) => changes.push(frame.session));
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.receive({
      type: "lease.granted",
      generation: 1,
      replacedClient: false,
      acquisition: "initial",
    });
    socket.receive({
      type: "codex.session.changed",
      paneId,
      runtimeId,
      updatedAt: "2026-08-21T00:01:00.000Z",
      session: { id: "33333333-3333-4333-8333-333333333333", resumable: true },
    });
    socket.receive({
      type: "codex.session.changed",
      paneId,
      runtimeId,
      updatedAt: "2026-08-21T00:02:00.000Z",
      session: { id: null, resumable: false },
    });

    expect(changes).toEqual([
      { id: "33333333-3333-4333-8333-333333333333", resumable: true },
      { id: null, resumable: false },
    ]);
    connection.dispose();
  });

  it("negotiates staged restore per attachment, rejects stale restore frames, and sends viewport state", () => {
    const connection = new TerminalConnection({ restoreProtocol: "staged-v1" });
    const frames: PaneFrame[] = [];
    const attachment = connection.attach(paneId, 80, 24, (frame) => frames.push(frame));
    const socket = FakeWebSocket.instances[0]!;
    expect(attachment.input("입력 큐 금지")).toBe(false);
    socket.open();
    socket.receive({
      type: "lease.granted",
      generation: 1,
      replacedClient: false,
      acquisition: "initial",
    });
    grantSurfaceControl(socket);
    grantPaneControl(socket);
    expect(frames.at(-1)).toMatchObject({ type: "pane.control.state", role: "controller" });
    frames.length = 0;

    const attachFrame = sentFrame(socket, "pane.attach");
    expect(attachFrame).toMatchObject({
      type: "pane.attach",
      paneId,
      restoreProtocol: "staged-v1",
      cols: 80,
      rows: 24,
    });
    expect(attachFrame.restoreId).toMatch(/^[0-9a-f-]{36}$/);
    expect(socket.sent.some((entry) => parseSentFrame(entry).type === "terminal.input")).toBe(
      false,
    );
    const restoreId = String(attachFrame.restoreId);

    socket.receive({
      type: "pane.restore.preview",
      paneId,
      sequence: 4,
      serializedState: "preview",
      runtimeId,
      restoreId: "33333333-3333-4333-8333-333333333333",
      bottomOffset: 10,
      previewBottomOffset: 8,
      cols: 80,
      rows: 24,
    });
    expect(frames).toEqual([]);

    socket.receive({
      type: "pane.restore.preview",
      paneId,
      sequence: 4,
      serializedState: "preview",
      runtimeId,
      restoreId,
      bottomOffset: 10,
      previewBottomOffset: 8,
      cols: 80,
      rows: 24,
    });
    socket.receive({
      type: "pane.restore.full",
      paneId,
      sequence: 4,
      serializedState: "full",
      runtimeId,
      restoreId,
      bottomOffset: 10,
      cols: 80,
      rows: 24,
    });
    socket.receive({ type: "terminal.output", paneId, sequence: 5, data: "live" });
    expect(frames.map((frame) => frame.type)).toEqual([
      "pane.restore.preview",
      "pane.restore.full",
      "terminal.output",
    ]);

    expect(attachment.input("한글")).toBe(true);
    attachment.viewport(runtimeId, 23.4);
    expect(sentFrame(socket, "terminal.input")).toMatchObject({ data: "한글" });
    expect(sentFrame(socket, "terminal.viewport")).toMatchObject({
      paneId,
      runtimeId,
      bottomOffset: 23,
    });
    attachment.dispose();
    connection.dispose();
  });

  it("keeps one attachment and restore identity across heartbeat cadence and reconnect", async () => {
    const connection = new TerminalConnection({ restoreProtocol: "staged-v1" });
    const snapshots: ConnectionSnapshot[] = [];
    connection.onStatus((snapshot) => snapshots.push(snapshot));
    connection.attach(paneId, 80, 24, () => undefined);
    const firstSocket = FakeWebSocket.instances[0]!;
    firstSocket.open();
    firstSocket.receive({
      type: "lease.granted",
      generation: 1,
      replacedClient: false,
      acquisition: "initial",
    });
    grantSurfaceControl(firstSocket);
    grantPaneControl(firstSocket);
    const firstRestoreId = sentFrame(firstSocket, "pane.attach").restoreId;
    const activeSnapshots = snapshots.length;

    await vi.advanceTimersByTimeAsync(45_000);
    expect(
      firstSocket.sent.filter((entry) => parseSentFrame(entry).type === "heartbeat"),
    ).toHaveLength(4);
    expect(snapshots).toHaveLength(activeSnapshots);

    firstSocket.serverClose(1006, "transient network loss");
    expect(snapshots.at(-1)).toMatchObject({
      state: "disconnected",
      surfaceRole: "controller",
    });
    await vi.advanceTimersByTimeAsync(500);
    const secondSocket = FakeWebSocket.instances[1]!;
    secondSocket.open();
    secondSocket.receive({
      type: "lease.granted",
      generation: 3,
      replacedClient: false,
      acquisition: "reconnect",
    });
    expect(snapshots.at(-1)).toMatchObject({
      state: "connecting",
      surfaceRole: "controller",
      acquisition: "reconnect",
    });
    expect(sentFrame(secondSocket, "pane.attach").restoreId).toBe(firstRestoreId);
    connection.dispose();
  });

  it("keeps an observer connected, blocks mutations, and only takes control explicitly", async () => {
    const connection = new TerminalConnection({ restoreProtocol: "staged-v1" });
    const snapshots: ConnectionSnapshot[] = [];
    const controlFrames: string[] = [];
    const paneFrames: PaneFrame[] = [];
    connection.onStatus((snapshot) => snapshots.push(snapshot));
    connection.onPaneControl((frame) => controlFrames.push(frame.type));
    const attachment = connection.attach(paneId, 80, 24, (frame) => paneFrames.push(frame));
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.receive({
      type: "lease.granted",
      generation: 1,
      replacedClient: false,
      acquisition: "initial",
    });
    socket.receive({
      type: "surface.state",
      connectionId: "33333333-3333-4333-8333-333333333333",
      generation: 1,
      role: "observer",
      controllerPresent: true,
      reason: "conflict",
    });
    socket.receive({
      type: "pane.control.state",
      paneId,
      role: "observer",
      controllerGeneration: 7,
      terminal: { cols: 120, rows: 40 },
      reason: "attached",
    });

    expect(snapshots.at(-1)).toMatchObject({
      state: "active",
      surfaceRole: "observer",
      controllerPresent: true,
      generation: 1,
    });
    expect(paneFrames.at(-1)).toMatchObject({
      type: "pane.control.state",
      role: "observer",
      terminal: { cols: 120, rows: 40 },
    });
    expect(controlFrames).toEqual(["pane.control.state"]);

    attachment.input("blocked input");
    attachment.resize(92, 30);
    attachment.viewport(runtimeId, 12);
    await expect(attachment.pasteImage(new Uint8Array([1]))).rejects.toThrow(
      "현재 화면은 이 터미널을 제어할 수 없습니다.",
    );
    expect(socket.sent.some((entry) => parseSentFrame(entry).type === "terminal.input")).toBe(
      false,
    );
    expect(socket.sent.some((entry) => parseSentFrame(entry).type === "terminal.resize")).toBe(
      false,
    );
    expect(socket.sent.some((entry) => parseSentFrame(entry).type === "terminal.viewport")).toBe(
      false,
    );

    expect(connection.takeControl(paneId)).toBe(true);
    expect(sentFrame(socket, "surface.takeover")).toMatchObject({
      leaseGeneration: 1,
      target: { paneId, cols: 92, rows: 30 },
    });
    socket.receive({
      type: "surface.state",
      connectionId: "33333333-3333-4333-8333-333333333333",
      generation: 2,
      role: "controller",
      controllerPresent: true,
      reason: "preempted",
    });
    expect(snapshots.at(-1)).toMatchObject({
      state: "active",
      surfaceRole: "controller",
      acquisition: "takeover",
    });
    grantPaneControl(socket, 8, "acquired");
    attachment.input("accepted input");
    expect(sentFrame(socket, "terminal.input")).toMatchObject({
      paneId,
      data: "accepted input",
      leaseGeneration: 2,
    });

    const controlRequestId = "44444444-4444-4444-8444-444444444444";
    socket.receive({
      type: "pane.control.requested",
      paneId,
      controlRequestId,
      controllerGeneration: 8,
      expiresAtMs: 123,
    });
    expect(connection.approvePaneControl(paneId, controlRequestId)).toBe(true);
    expect(sentFrame(socket, "pane.control.approve")).toMatchObject({
      paneId,
      controlRequestId,
      leaseGeneration: 2,
    });
    expect(controlFrames).toEqual([
      "pane.control.state",
      "pane.control.state",
      "pane.control.requested",
    ]);
    attachment.dispose();
    connection.dispose();
  });

  it("acquires an unowned surface without preempting another connection", () => {
    const connection = new TerminalConnection();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.receive({
      type: "lease.granted",
      generation: 3,
      replacedClient: false,
      acquisition: "initial",
    });
    socket.receive({
      type: "surface.state",
      connectionId: "33333333-3333-4333-8333-333333333333",
      generation: 3,
      role: "observer",
      controllerPresent: false,
      reason: "available",
    });

    expect(connection.takeControl()).toBe(true);
    expect(sentFrame(socket, "surface.acquire")).toEqual({
      type: "surface.acquire",
      leaseGeneration: 3,
    });
    expect(socket.sent.some((entry) => parseSentFrame(entry).type === "surface.takeover")).toBe(
      false,
    );
    connection.dispose();
  });

  it("creates staged restore IDs when LAN HTTP does not expose crypto.randomUUID", () => {
    vi.stubGlobal("crypto", {
      getRandomValues(bytes: Uint8Array<ArrayBuffer>) {
        bytes.fill(0xab);
        return bytes;
      },
    });
    const connection = new TerminalConnection({ restoreProtocol: "staged-v1" });
    connection.attach(paneId, 80, 24, () => undefined);
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.receive({
      type: "lease.granted",
      generation: 1,
      replacedClient: false,
      acquisition: "initial",
    });

    expect(sentFrame(socket, "lease.acquire").clientId).toBe(
      "abababab-abab-4bab-abab-abababababab",
    );
    expect(sentFrame(socket, "pane.attach").restoreId).toBe("abababab-abab-4bab-abab-abababababab");
    connection.dispose();
  });

  it("keeps legacy attach frames free of staged restore fields", () => {
    const connection = new TerminalConnection();
    connection.attach(paneId, 80, 24, () => undefined);
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.receive({
      type: "lease.granted",
      generation: 1,
      replacedClient: false,
      acquisition: "initial",
    });
    expect(sentFrame(socket, "pane.attach")).toEqual({
      type: "pane.attach",
      paneId,
      leaseGeneration: 1,
      cols: 80,
      rows: 24,
    });
    connection.dispose();
  });
});

function grantSurfaceControl(socket: FakeWebSocket, generation = 1): void {
  socket.receive({
    type: "surface.state",
    connectionId: "33333333-3333-4333-8333-333333333333",
    generation,
    role: "controller",
    controllerPresent: true,
    reason: "initial",
  });
}

function grantPaneControl(
  socket: FakeWebSocket,
  controllerGeneration = 1,
  reason: "attached" | "acquired" = "attached",
): void {
  socket.receive({
    type: "pane.control.state",
    paneId,
    role: "controller",
    controllerGeneration,
    terminal: { cols: 80, rows: 24 },
    reason,
  });
}

function sentFrame(socket: FakeWebSocket, type: string): Record<string, unknown> {
  const raw = socket.sent.findLast((entry) => parseSentFrame(entry).type === type);
  if (!raw) throw new Error(`Missing ${type} frame.`);
  return parseSentFrame(raw);
}

function parseSentFrame(raw: string): Record<string, unknown> {
  return JSON.parse(raw) as Record<string, unknown>;
}

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly sent: string[] = [];
  readyState = FakeWebSocket.CONNECTING;
  bufferedAmount = 0;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  receive(frame: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.serverClose(code, reason);
  }

  serverClose(code: number, reason: string): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  }
}
