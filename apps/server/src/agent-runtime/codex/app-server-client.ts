import WebSocket from "ws";
import {
  connectCodexAppServer,
  type CodexAppServerEndpoint,
} from "../../codex-app-server-endpoint.js";

const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;

export type JsonRpcId = string | number;

export interface JsonRpcFrame {
  readonly id?: JsonRpcId;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

export class CodexRpcError extends Error {
  constructor(
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "CodexRpcError";
  }
}

/**
 * Naru's own JSON-RPC client to a Codex app-server (the relay's GUI channel, AP-D011 A). It connects
 * to the validated physical socket, never through the mutable alias, like the TUI's channel.
 */
export class CodexAppServerClient {
  readonly #socket: WebSocket;
  readonly #pending = new Map<
    JsonRpcId,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  readonly #notificationListeners = new Set<(method: string, params: unknown) => void>();
  readonly #requestListeners = new Set<(id: JsonRpcId, method: string, params: unknown) => void>();
  readonly #closeListeners = new Set<() => void>();
  #nextId = 1;
  #closed = false;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      let frame: JsonRpcFrame;
      try {
        frame = JSON.parse(rawText(data)) as JsonRpcFrame;
      } catch {
        return;
      }
      this.#receive(frame);
    });
    socket.on("close", () => this.#close());
    socket.on("error", () => this.#close());
  }

  static async connect(endpoint: CodexAppServerEndpoint): Promise<CodexAppServerClient> {
    const socket = new WebSocket("ws://localhost/", {
      createConnection: () => connectCodexAppServer(endpoint),
      perMessageDeflate: false,
      maxPayload: MAX_MESSAGE_BYTES,
      handshakeTimeout: 10_000,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const client = new CodexAppServerClient(socket);
    await client.request("initialize", {
      clientInfo: { name: "naru_relay", version: "0.1" },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized");
    return client;
  }

  get closed(): boolean {
    return this.#closed;
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) return Promise.reject(new CodexRpcError(undefined, "closed"));
    const id = `naru-${this.#nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CodexRpcError(undefined, "timeout"));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
      this.#send({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.#send(params === undefined ? { method } : { method, params });
  }

  /** Answers a request the app-server sent to this client (an approval). */
  respond(id: JsonRpcId, result: unknown): void {
    this.#send({ id, result });
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  onRequest(listener: (id: JsonRpcId, method: string, params: unknown) => void): () => void {
    this.#requestListeners.add(listener);
    return () => this.#requestListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  close(): void {
    this.#socket.terminate();
    this.#close();
  }

  #send(frame: Record<string, unknown>): void {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) return;
    this.#socket.send(JSON.stringify(frame));
  }

  #receive(frame: JsonRpcFrame): void {
    if (frame.id !== undefined && frame.method === undefined) {
      const pending = this.#pending.get(frame.id);
      if (pending === undefined) return;
      this.#pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.error !== undefined) {
        pending.reject(new CodexRpcError(frame.error.code, frame.error.message ?? "error"));
      } else {
        pending.resolve(frame.result);
      }
      return;
    }
    if (frame.method === undefined) return;
    if (frame.id !== undefined) {
      for (const listener of this.#requestListeners) listener(frame.id, frame.method, frame.params);
      return;
    }
    for (const listener of this.#notificationListeners) listener(frame.method, frame.params);
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CodexRpcError(undefined, "closed"));
    }
    this.#pending.clear();
    for (const listener of this.#closeListeners) listener();
  }
}

function rawText(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}
