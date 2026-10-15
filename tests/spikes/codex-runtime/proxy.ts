import { frameText } from "./harness.js";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import {
  connectCodexAppServer,
  inspectCodexAppServerEndpoint,
} from "../../../apps/server/src/codex-app-server-endpoint.js";
import { obj, raw, str, ws, type Frame, type Obj } from "./harness.js";
import type WS from "../../../apps/server/node_modules/@types/ws/index.js";

// Intentionally small allowlist. Unknown methods fail closed even for the writer.
export const reads = new Set([
  "initialize",
  "thread/read",
  "thread/list",
  "thread/loaded/list",
  "thread/turns/list",
  "thread/items/list",
  "thread/queue/list",
  "thread/goal/get",
  "thread/backgroundTerminals/list",
  "model/list",
  "config/read",
  "configRequirements/read",
  "permissionProfile/list",
  "skills/list",
  "hooks/list",
  "mcpServerStatus/list",
  "experimentalFeature/list",
  "collaborationMode/list",
  "account/read",
  "account/rateLimits/read",
]);
export const writes = new Set([
  "thread/start",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "thread/settings/update",
  "thread/name/set",
  "thread/unsubscribe",
]);
export async function startProxy(upstreamPath: string, directory: string) {
  const root = mkdtempSync("/private/tmp/naru-gate-");
  const socket = join(root, "relay.sock");
  const server = createServer();
  const webSockets = new ws.WebSocketServer({ server });
  const connections = new Set<WS>();
  const events: { channel: string; direction: string; frame: Frame }[] = [];
  const endpoint = inspectCodexAppServerEndpoint(upstreamPath);
  let writer = "gui";
  let gated = false;
  let sequence = 0;
  let activeTurn: string | null = null;
  let generation = 0;
  let targetThread: string | undefined;
  const pending = new Set<string | number>();
  const settled = new Set<string | number>();
  const inflightWrites = new Set<string>();
  const startingTurns = new Set<string>();
  let nextConnection = 0;
  webSockets.on("connection", (client, request) => {
    const connection = ++nextConnection;
    const channel = request.headers["x-naru-spike"] === "gui" ? "gui" : "tui";
    const upstream = new ws("ws://localhost/", {
      createConnection: () => connectCodexAppServer(endpoint),
    });
    connections.add(client);
    connections.add(upstream);
    const queue: string[] = [];
    const record = (direction: string, frame: Frame): void => {
      events.push({ channel, direction, frame });
      raw(directory, "proxy.jsonl", {
        sequence: ++sequence,
        generation,
        channel,
        direction,
        frame,
      });
    };
    client.on("message", (data) => {
      const frame = JSON.parse(frameText(data)) as Frame;
      record("client->proxy", frame);
      if (gated) {
        const pureResume =
          frame.method === "thread/resume" &&
          Object.keys(frame.params ?? {}).every((key) =>
            ["threadId", "excludeTurns", "initialTurnsPage"].includes(key),
          );
        const approval = !frame.method && frame.id !== undefined;
        const allowed =
          frame.method === "initialized" ||
          (frame.method && reads.has(frame.method)) ||
          pureResume ||
          (writer === channel &&
            ((frame.method && writes.has(frame.method)) || (approval && pending.has(frame.id!))));
        if (!allowed) {
          const rejection: Frame = {
            id: frame.id ?? "notification",
            error: { code: -32071, message: "NARU_SPIKE_WRITER_REQUIRED" },
          };
          record("proxy->rejected", rejection);
          client.send(JSON.stringify(rejection));
          return;
        }
        if (approval) {
          pending.delete(frame.id!);
          settled.add(frame.id!);
        }
        if (frame.method && writes.has(frame.method) && frame.id !== undefined) {
          const key = `${connection}:${frame.id}`;
          inflightWrites.add(key);
          if (
            frame.method === "turn/start" &&
            frame.params?.threadId === targetThread &&
            !activeTurn
          )
            startingTurns.add(key);
        }
      }
      if (upstream.readyState === ws.OPEN) upstream.send(frameText(data));
      else queue.push(frameText(data));
    });
    upstream.on("open", () => {
      for (const data of queue.splice(0)) upstream.send(data);
    });
    upstream.on("message", (data) => {
      const frame = JSON.parse(frameText(data)) as Frame;
      record("server->client", frame);
      if (!frame.method && frame.id !== undefined) {
        const key = `${connection}:${frame.id}`;
        inflightWrites.delete(key);
        if (frame.error) startingTurns.delete(key);
      }
      if (frame.params?.threadId === targetThread && frame.method === "turn/started") {
        activeTurn = str(obj(frame.params?.turn).id);
        startingTurns.clear();
      }
      if (
        frame.params?.threadId === targetThread &&
        frame.method === "turn/completed" &&
        activeTurn === obj(frame.params?.turn).id
      )
        activeTurn = null;
      if (frame.method && frame.id !== undefined && !settled.has(frame.id)) pending.add(frame.id);
      if (frame.method === "serverRequest/resolved") {
        const id = frame.params?.requestId as string | number;
        pending.delete(id);
        settled.add(id);
      }
      if (client.readyState === ws.OPEN) client.send(frameText(data));
    });
    client.on("error", () => upstream.close());
    upstream.on("error", () => client.close());
    client.on("close", () => {
      upstream.close();
      connections.delete(client);
    });
    upstream.on("close", () => {
      client.close();
      connections.delete(upstream);
    });
  });
  await new Promise<void>((done) => server.listen(socket, done));
  chmodSync(socket, 0o600);
  return {
    socket,
    events,
    enable: (threadId: string) => {
      targetThread = threadId;
      gated = true;
    },
    transfer: (next: string): Obj => {
      if (activeTurn || pending.size || inflightWrites.size || startingTurns.size)
        return { accepted: false, reason: activeTurn ? "turn-active" : "request-pending" };
      writer = next;
      generation += 1;
      return { accepted: true, generation };
    },
    close: async () => {
      for (const connection of connections) connection.terminate();
      webSockets.close();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
