import { EventEmitter, once } from "node:events";
import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { GatewayWebSocketRegistry } from "../src/websocket-registry.js";

class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readyState = this.OPEN;
  closes: { code: number; reason: string }[] = [];

  close(code: number, reason: string): void {
    this.readyState = this.CLOSING;
    this.closes.push({ code, reason });
    this.emit("close", code, Buffer.from(reason));
  }
}

describe("Gateway WebSocket revocation registry", () => {
  it("closes connections at session expiry and never extends identity past its deadline", async () => {
    const now = Date.now();
    const registry = new GatewayWebSocketRegistry(() => now);
    const socket = new FakeWebSocket();
    registry.register({
      socket: socket as unknown as WebSocket,
      sessionId: "session-expiry-fixture",
      appId: "fixture-app",
      deadline: now + 5,
    });
    const close = once(socket, "close");
    await close;
    expect(socket.closes).toEqual([{ code: 4003, reason: "Session expired" }]);
    expect(registry.size).toBe(0);
  });

  it("closes only matching sessions or app routes", () => {
    const now = Date.now();
    const registry = new GatewayWebSocketRegistry(() => now);
    const first = new FakeWebSocket();
    const second = new FakeWebSocket();
    registry.register({
      socket: first as unknown as WebSocket,
      sessionId: "session-one",
      appId: "app-one",
      deadline: now + 60_000,
    });
    registry.register({
      socket: second as unknown as WebSocket,
      sessionId: "session-two",
      appId: "app-two",
      deadline: now + 60_000,
    });
    registry.closeSession("session-one");
    expect(first.closes).toHaveLength(1);
    expect(second.closes).toHaveLength(0);
    registry.closeApp("app-two");
    expect(second.closes).toEqual([{ code: 1012, reason: "App route unavailable" }]);
    expect(registry.size).toBe(0);
  });
});
