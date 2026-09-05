import type { WebSocket } from "ws";

interface ActiveGatewaySocket {
  readonly socket: WebSocket;
  readonly sessionId: string;
  readonly appId: string;
  deadline: number;
  timer: NodeJS.Timeout;
}

export class GatewayWebSocketRegistry {
  readonly #active = new Set<ActiveGatewaySocket>();

  constructor(private readonly now: () => number = Date.now) {}

  register(input: {
    socket: WebSocket;
    sessionId: string;
    appId: string;
    deadline: number;
  }): () => void {
    const record: ActiveGatewaySocket = {
      ...input,
      timer: setTimeout(() => this.#expire(record), millisecondsUntil(input.deadline, this.now())),
    };
    record.timer.unref();
    this.#active.add(record);
    const cleanup = (): void => {
      clearTimeout(record.timer);
      this.#active.delete(record);
    };
    input.socket.once("close", cleanup);
    return cleanup;
  }

  refreshSession(sessionId: string, deadline: number): void {
    for (const record of this.#active) {
      if (record.sessionId !== sessionId) continue;
      clearTimeout(record.timer);
      record.deadline = deadline;
      record.timer = setTimeout(
        () => this.#expire(record),
        millisecondsUntil(deadline, this.now()),
      );
      record.timer.unref();
    }
  }

  closeSession(sessionId: string, reason = "Session revoked"): void {
    for (const record of [...this.#active]) {
      if (record.sessionId === sessionId) this.#close(record, 4003, reason);
    }
  }

  closeApp(appId: string): void {
    for (const record of [...this.#active]) {
      if (record.appId === appId) this.#close(record, 1012, "App route unavailable");
    }
  }

  closeAll(): void {
    for (const record of [...this.#active]) this.#close(record, 1012, "Gateway stopping");
  }

  get size(): number {
    return this.#active.size;
  }

  #expire(record: ActiveGatewaySocket): void {
    if (!this.#active.has(record)) return;
    this.#close(record, 4003, "Session expired");
  }

  #close(record: ActiveGatewaySocket, code: number, reason: string): void {
    clearTimeout(record.timer);
    this.#active.delete(record);
    if (record.socket.readyState < record.socket.CLOSING) record.socket.close(code, reason);
  }
}

function millisecondsUntil(deadline: number, now: number): number {
  return Math.max(0, Math.min(deadline - now, 2_147_483_647));
}
