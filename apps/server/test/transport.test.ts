import { describe, expect, it } from "vitest";
import { ServerWsFrameSchema } from "@naru/contracts";
import { sendFrame, type SocketLike } from "../src/transport.js";

class FakeSocket implements SocketLike {
  readonly sent: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];

  constructor(
    readonly readyState: number,
    readonly bufferedAmount: number,
  ) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ ...(code === undefined ? {} : { code }), ...(reason ? { reason } : {}) });
  }
}

describe("WebSocket transport", () => {
  it("sends runtime-valid server frames to a responsive client", () => {
    const socket = new FakeSocket(1, 0);
    sendFrame(socket, { type: "heartbeat.ack", sentAt: 123 });

    expect(socket.sent).toHaveLength(1);
    expect(ServerWsFrameSchema.parse(JSON.parse(socket.sent[0] ?? ""))).toEqual({
      type: "heartbeat.ack",
      sentAt: 123,
    });
    expect(socket.closes).toEqual([]);
  });

  it("distinguishes a slow client and closes it with an explicit resync error", () => {
    const socket = new FakeSocket(1, 1024 * 1024 - 256);
    sendFrame(socket, {
      type: "terminal.output",
      paneId: "11111111-1111-4111-8111-111111111111",
      sequence: 1,
      data: "x".repeat(1_024),
    });

    expect(socket.sent).toHaveLength(1);
    expect(ServerWsFrameSchema.parse(JSON.parse(socket.sent[0] ?? ""))).toMatchObject({
      type: "protocol.error",
      code: "WS_BACKPRESSURE",
    });
    expect(socket.closes).toEqual([{ code: 4008, reason: "Backpressure" }]);
  });

  it("does not grow an already saturated queue to send the resync error", () => {
    const socket = new FakeSocket(1, 1024 * 1024);
    sendFrame(socket, {
      type: "terminal.output",
      paneId: "11111111-1111-4111-8111-111111111111",
      sequence: 1,
      data: "output",
    });

    expect(socket.sent).toEqual([]);
    expect(socket.closes).toEqual([{ code: 4008, reason: "Backpressure" }]);
  });

  it("does not enqueue frames after the socket has stopped being open", () => {
    const socket = new FakeSocket(3, 0);
    sendFrame(socket, { type: "heartbeat.ack", sentAt: 123 });
    expect(socket.sent).toEqual([]);
  });
});
