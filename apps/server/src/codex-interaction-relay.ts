import { chmod, lstat, mkdtemp, realpath } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { WebSocketServer } from "ws";
import {
  CodexEndpointError,
  connectCodexAppServer,
  inspectCodexAppServerEndpoint,
  type CodexAppServerEndpoint,
} from "./codex-app-server-endpoint.js";
import { CodexInteractionGuardian } from "./codex-interaction-guardian.js";
import { CodexInteractionState } from "./codex-interaction-state.js";
import { requestCodexIntegration } from "./integrations/codex/client.js";
import type { CodexInteractionSnapshot } from "./integrations/codex/events.js";

const SOCKET_LIMIT_BYTES = 100;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;
const MAX_WS_CLIENTS = 4;
const SERVER_READY_MS = 10_000;
const SNAPSHOT_RETRY_MS = 1_500;
const TRANSPORT_CLOSE_GRACE_MS = 1_000;

export const NARU_CODEX_INTERACTION_RELAY_ENV = "NARU_CODEX_INTERACTION_RELAY";

export interface CodexInteractionRelayOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly bootstrap: string;
  readonly integrationSocketPath: string;
  readonly cwd: string;
  /** Internal harness entry; production uses this bundled launcher. */
  readonly guardianEntry?: string;
  readonly guardianExecArgv?: readonly string[];
}

/** Host-owned PTY wrapper. Only metadata snapshots leave this process. */
export async function runCodexInteractionRelay(
  options: CodexInteractionRelayOptions,
): Promise<number> {
  const directory = await mkdtemp("/private/tmp/naru-codex-relay-");
  const appSocket = join(directory, "app.sock");
  const relaySocket = join(directory, "relay.sock");
  const url = (path: string): string => `unix://${path}`;
  let guardian: CodexInteractionGuardian | null = null;
  let httpServer: Server | null = null;
  let wsServer: WebSocketServer | null = null;
  const sockets = new Set<WebSocket>();
  let stopped = false;
  let activeClients = 0;
  let primaryConnected = false;
  let nextChannel = 0;
  let latest: CodexInteractionSnapshot | null = null;
  let inFlight = false;
  let sendAgain = false;
  let retryTimer: NodeJS.Timeout | null = null;
  let transportCloseTimer: NodeJS.Timeout | null = null;
  let fatal: (() => void) | null = null;
  let endpoint: CodexAppServerEndpoint | null = null;
  let failureCode = "NARU_CODEX_RELAY_FAILED";
  let reportedFailure = false;
  const reportFailure = (): void => {
    if (reportedFailure) return;
    reportedFailure = true;
    // Fixed codes only. Child stderr and private endpoint paths never enter diagnostics.
    process.stderr.write(`${failureCode}\n`);
  };

  const stopChildren = (): void => {
    if (guardian !== null) void guardian.stop();
  };
  const fail = (): void => {
    if (stopped) return;
    reportFailure();
    stopped = true;
    stopChildren();
    fatal?.();
  };
  const transportClosed = (): void => {
    if (stopped || transportCloseTimer !== null) return;
    // A normal TUI quit closes its WebSocket just before the process exits.
    // Give that exit event precedence; a stranded transport still fails soon.
    transportCloseTimer = setTimeout(fail, TRANSPORT_CLOSE_GRACE_MS);
  };
  const sendLatest = async (): Promise<void> => {
    if (stopped || inFlight || latest === null) return;
    inFlight = true;
    const snapshot = latest;
    try {
      await requestCodexIntegration(options.integrationSocketPath, {
        version: 1,
        type: "interaction",
        bootstrap: options.bootstrap,
        snapshot,
      });
    } catch {
      // A restarting Naru receiver must not interrupt the Host-owned TUI.
    }
    inFlight = false;
    if (stopped) return;
    if (sendAgain || latest !== snapshot) {
      sendAgain = false;
      void sendLatest();
    }
  };
  const state = new CodexInteractionState(options.cwd, (snapshot) => {
    latest = snapshot;
    if (inFlight) sendAgain = true;
    else void sendLatest();
  });

  const forward = (
    source: WebSocket,
    destination: WebSocket,
    fromClient: boolean,
    channel: number,
    closePair: () => void,
  ): void => {
    const earlyFrames: WebSocket.RawData[] = [];
    let earlyBytes = 0;
    const deliver = (data: WebSocket.RawData): void => {
      if (destination.readyState !== WebSocket.OPEN)
        throw new Error("Relay destination is closed.");
      const encoded = rawDataBuffer(data).toString("utf8");
      const parsed: unknown = JSON.parse(encoded);
      if (fromClient) state.observeClient(parsed, channel);
      else state.observeServer(parsed, channel);
      if (destination.bufferedAmount + Buffer.byteLength(encoded) > MAX_BUFFERED_BYTES) {
        throw new Error("Relay buffer limit exceeded.");
      }
      destination.send(data, { binary: false }, (error) => {
        if (error) closePair();
      });
    };
    destination.on("open", () => {
      try {
        for (const frame of earlyFrames) deliver(frame);
        earlyFrames.length = 0;
        earlyBytes = 0;
      } catch {
        fail();
      }
    });
    source.on("message", (data, isBinary) => {
      try {
        if (isBinary) throw new Error("Invalid relay frame.");
        if (destination.readyState === WebSocket.CONNECTING) {
          const bytes = rawDataBuffer(data).byteLength;
          if (earlyBytes + bytes > MAX_BUFFERED_BYTES)
            throw new Error("Relay early-frame limit exceeded.");
          earlyFrames.push(data);
          earlyBytes += bytes;
          return;
        }
        deliver(data);
      } catch {
        fail();
      }
    });
    source.on("error", closePair);
    source.on("close", closePair);
  };

  const onSigterm = (): void => {
    // Host-requested shutdown is not a launch/transport failure.
    if (stopped) return;
    stopped = true;
    stopChildren();
    fatal?.();
  };
  const onSigint = (): void => {
    // The TUI receives terminal interrupt input. A shell signal must not
    // terminate the wrapper while the interactive child is still running.
  };
  process.on("SIGTERM", onSigterm);
  process.on("SIGHUP", onSigterm);
  process.on("SIGINT", onSigint);
  try {
    await assertPrivateDirectory(directory);
    if (
      Buffer.byteLength(appSocket) > SOCKET_LIMIT_BYTES ||
      Buffer.byteLength(relaySocket) > SOCKET_LIMIT_BYTES
    ) {
      throw new Error("Codex relay socket path is too long.");
    }
    httpServer = createServer();
    wsServer = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: MAX_MESSAGE_BYTES,
    });
    const currentWsServer = wsServer;
    httpServer.on("upgrade", (request, socket, head) => {
      if (
        activeClients >= MAX_WS_CLIENTS ||
        stopped ||
        (request.url !== "/rpc" && request.url !== "/")
      ) {
        socket.destroy();
        return;
      }
      try {
        currentWsServer.handleUpgrade(request, socket, head, (client) => {
          if (activeClients >= MAX_WS_CLIENTS || stopped) {
            client.terminate();
            return;
          }
          activeClients += 1;
          const channel = ++nextChannel;
          const primary = !primaryConnected;
          if (primary) {
            primaryConnected = true;
            if (transportCloseTimer !== null) {
              clearTimeout(transportCloseTimer);
              transportCloseTimer = null;
            }
          }
          sockets.add(client);
          const server = new WebSocket("ws://localhost/", {
            createConnection: () => {
              if (endpoint === null) throw new CodexEndpointError();
              try {
                return connectCodexAppServer(endpoint);
              } catch {
                failureCode = "NARU_CODEX_ENDPOINT_REJECTED";
                throw new CodexEndpointError();
              }
            },
            handshakeTimeout: SERVER_READY_MS,
            perMessageDeflate: false,
            maxPayload: MAX_MESSAGE_BYTES,
          });
          sockets.add(server);
          server.on("error", (error) => {
            failureCode =
              error instanceof CodexEndpointError
                ? "NARU_CODEX_ENDPOINT_REJECTED"
                : "NARU_CODEX_APP_SERVER_CONNECTION_FAILED";
          });
          let closed = false;
          const closePair = (): void => {
            if (closed) return;
            closed = true;
            activeClients -= 1;
            state.closeChannel(channel);
            sockets.delete(client);
            sockets.delete(server);
            client.terminate();
            server.terminate();
            if (primary) {
              primaryConnected = false;
              transportClosed();
            }
          };
          forward(client, server, true, channel, closePair);
          forward(server, client, false, channel, closePair);
        });
      } catch {
        socket.destroy();
        fail();
      }
    });
    await new Promise<void>((resolve, reject) => {
      httpServer!.once("error", reject);
      httpServer!.listen(relaySocket, () => resolve());
    });
    await chmod(relaySocket, 0o600);
    await assertPrivateSocket(relaySocket);

    const childEnvironment = { ...options.environment, [NARU_CODEX_INTERACTION_RELAY_ENV]: "1" };
    guardian = new CodexInteractionGuardian(fail, options.guardianEntry, options.guardianExecArgv);
    guardian.onExit("app-server", () => {
      failureCode = "NARU_CODEX_APP_SERVER_EXITED";
      fail();
    });
    let finishTui: ((code: number) => void) | null = null;
    const tuiExit = new Promise<number>((resolve) => {
      finishTui = resolve;
    });
    fatal = () => finishTui?.(1);
    guardian.onExit("tui", (code, signal) => {
      if (!stopped && (code !== 0 || signal !== null)) {
        failureCode = "NARU_CODEX_TUI_EXITED";
        reportFailure();
      }
      stopped = true;
      finishTui?.(signal === null ? (code ?? 1) : 1);
    });
    await guardian.start(
      "app-server",
      options.executable,
      appServerArguments(options.args, url(appSocket)),
      options.cwd,
      childEnvironment,
    );
    endpoint = await waitForSocket(appSocket, () => stopped);
    if (stopped) throw new Error("Codex app server stopped.");
    state.start();
    retryTimer = setInterval(() => {
      if (inFlight) sendAgain = true;
      else void sendLatest();
    }, SNAPSHOT_RETRY_MS);
    await guardian.start(
      "tui",
      options.executable,
      ["--remote", url(relaySocket), ...remoteTuiArguments(options.args)],
      options.cwd,
      childEnvironment,
    );
    return await tuiExit;
  } catch (error) {
    if (error instanceof CodexEndpointError) failureCode = error.message;
    else if (error instanceof Error && error.message === "NARU_CODEX_APP_SERVER_TIMEOUT")
      failureCode = error.message;
    fail();
    return 1;
  } finally {
    stopped = true;
    if (retryTimer !== null) clearInterval(retryTimer);
    if (transportCloseTimer !== null) clearTimeout(transportCloseTimer);
    process.off("SIGTERM", onSigterm);
    process.off("SIGHUP", onSigterm);
    process.off("SIGINT", onSigint);
    if (guardian !== null) await guardian.stop();
    for (const socket of sockets) socket.terminate();
    wsServer?.close();
    if (httpServer !== null)
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
  }
}

export function appServerArguments(args: readonly string[], appServerUrl: string): string[] {
  const overrides: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--config") {
      const value = args[++index];
      if (value === undefined) throw new Error("Codex profile config is incomplete.");
      overrides.push("--config", value);
    } else if (arg === "--model" || arg === "--sandbox" || arg === "--ask-for-approval") {
      const value = args[++index];
      if (value === undefined) throw new Error("Codex profile option is incomplete.");
      const key =
        arg === "--model" ? "model" : arg === "--sandbox" ? "sandbox_mode" : "approval_policy";
      overrides.push("--config", `${key}=${JSON.stringify(value)}`);
    }
  }
  return [...overrides, "app-server", "--listen", appServerUrl];
}

/** The remote TUI cannot carry permission overrides through /resume. */
export function remoteTuiArguments(args: readonly string[]): string[] {
  const remote: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--sandbox" || arg === "--ask-for-approval") {
      if (args[++index] === undefined) throw new Error("Codex permission option is incomplete.");
      continue;
    }
    if (arg !== undefined) remote.push(arg);
  }
  return remote;
}

async function waitForSocket(
  path: string,
  stopped: () => boolean,
): Promise<CodexAppServerEndpoint> {
  const deadline = Date.now() + SERVER_READY_MS;
  let publicationObserved = false;
  while (!stopped() && Date.now() < deadline) {
    try {
      if (!publicationObserved) {
        // Older CLIs bind first, then publish final permissions asynchronously.
        // Do not declare readiness in that publication window; never connect until validated.
        await lstat(path);
        publicationObserved = true;
        await delay(50);
        continue;
      }
      return inspectCodexAppServerEndpoint(path);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      await delay(50);
    }
  }
  throw new Error("NARU_CODEX_APP_SERVER_TIMEOUT");
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o077) {
    throw new Error("Codex relay directory is not private.");
  }
  if ((await realpath(path)) !== path) throw new Error("Codex relay directory is not canonical.");
}

async function assertPrivateSocket(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || stat.mode & 0o077) {
    throw new Error("Codex relay socket is not private.");
  }
  if ((await realpath(path)) !== path) throw new Error("Codex relay socket is not canonical.");
}

function rawDataBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
