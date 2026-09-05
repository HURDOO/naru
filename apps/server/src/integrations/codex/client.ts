import { createConnection } from "node:net";
import {
  CodexIntegrationReplySchema,
  type CodexIntegrationReply,
  type CodexIntegrationRequest,
} from "./protocol.js";

const MAX_REPLY_BYTES = 64 * 1024;
const SOCKET_TIMEOUT_MS = 5_000;

export async function requestCodexIntegration(
  socketPath: string,
  request: CodexIntegrationRequest,
): Promise<CodexIntegrationReply | null> {
  if (Buffer.byteLength(socketPath) > 100) return null;
  const payload = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(payload) > 32 * 1024) return null;
  return new Promise<CodexIntegrationReply | null>((resolve) => {
    const socket = createConnection(socketPath);
    let reply = Buffer.alloc(0);
    let completed = false;
    const finish = (value: unknown): void => {
      if (completed) return;
      completed = true;
      socket.destroy();
      try {
        const parsed = CodexIntegrationReplySchema.safeParse(value);
        resolve(parsed.success ? parsed.data : null);
      } catch {
        resolve(null);
      }
    };
    socket.setTimeout(SOCKET_TIMEOUT_MS);
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk: Buffer) => {
      if (reply.length + chunk.length > MAX_REPLY_BYTES) {
        finish(null);
        return;
      }
      reply = Buffer.concat([reply, chunk]);
      const newline = reply.indexOf(0x0a);
      if (newline === -1) return;
      if (
        reply
          .subarray(newline + 1)
          .toString("utf8")
          .trim() !== ""
      ) {
        finish(null);
        return;
      }
      try {
        finish(JSON.parse(reply.subarray(0, newline).toString("utf8")) as unknown);
      } catch {
        finish(null);
      }
    });
    socket.once("timeout", () => finish(null));
    socket.once("error", () => finish(null));
    socket.once("end", () => finish(null));
    socket.once("close", () => finish(null));
  });
}
