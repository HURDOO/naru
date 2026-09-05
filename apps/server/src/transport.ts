import type { ServerWsFrame } from "@naru/contracts";

const MAX_SOCKET_BUFFER = 1024 * 1024;

export interface SocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export function sendFrame(socket: SocketLike, frame: ServerWsFrame): void {
  if (socket.readyState !== 1) return;
  const serializedFrame = JSON.stringify(frame);
  if (socket.bufferedAmount + Buffer.byteLength(serializedFrame, "utf8") > MAX_SOCKET_BUFFER) {
    const fallback: ServerWsFrame = {
      type: "protocol.error",
      code: "WS_BACKPRESSURE",
      message: "연결이 출력을 따라가지 못해 다시 동기화해야 합니다.",
    };
    const serializedFallback = JSON.stringify(fallback);
    if (
      socket.bufferedAmount + Buffer.byteLength(serializedFallback, "utf8") <=
      MAX_SOCKET_BUFFER
    ) {
      socket.send(serializedFallback);
    }
    socket.close(4008, "Backpressure");
    return;
  }
  socket.send(serializedFrame);
}
