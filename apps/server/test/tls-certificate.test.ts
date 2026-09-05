import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { connect, type SecureContextOptions, type TLSSocket } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig, TlsConfig } from "../src/config.js";
import { NaruRepository } from "../src/database.js";
import { ProjectPathPolicy } from "../src/path-policy.js";
import { PtySupervisor, type PtyProcess } from "../src/pty.js";
import { SessionStore } from "../src/sessions.js";
import {
  readTlsCertificateGeneration,
  TlsCertificateError,
  TlsCertificateManager,
  type TlsCertificateEvent,
} from "../src/tls-certificate.js";
import { createTestTlsState, type TestTlsState } from "./tls-fixture.js";

const serverName = "naru.example.test";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("TLS certificate generation validation", () => {
  it("loads a private generation that matches the configured DNS name and key", () => {
    const state = trackedTlsState();
    const generation = state.createGeneration("generation-a");
    state.publish(generation.generation);

    const material = readTlsCertificateGeneration(tlsConfig(state));

    expect(material).toMatchObject({
      generation: "generation-a",
      fingerprint256: generation.fingerprint256,
    });
    expect(material.privateKey.toString("utf8")).toContain("PRIVATE KEY");
    expect(material.certificateChain.toString("utf8")).toContain("CERTIFICATE");
  });

  it("rejects permissive files, symlinks, hostname mismatch, and key mismatch", () => {
    const permissionsState = trackedTlsState();
    const permissionsGeneration = permissionsState.createGeneration("permissions");
    permissionsState.publish(permissionsGeneration.generation);
    chmodSync(permissionsGeneration.certificateFile, 0o640);
    expectTlsError(
      () => readTlsCertificateGeneration(tlsConfig(permissionsState)),
      "TLS_CERTIFICATE_INVALID",
    );

    chmodSync(permissionsGeneration.certificateFile, 0o600);
    const certificateContents = readFileSync(permissionsGeneration.certificateFile);
    const realCertificate = `${permissionsGeneration.certificateFile}.real`;
    writeFileSync(realCertificate, certificateContents, { mode: 0o600 });
    unlinkSync(permissionsGeneration.certificateFile);
    symlinkSync(realCertificate, permissionsGeneration.certificateFile);
    expectTlsError(
      () => readTlsCertificateGeneration(tlsConfig(permissionsState)),
      "TLS_CERTIFICATE_INVALID",
    );

    const hostnameState = trackedTlsState();
    const hostnameGeneration = hostnameState.createGeneration("wrong-host", "other.example");
    hostnameState.publish(hostnameGeneration.generation);
    expectTlsError(
      () => readTlsCertificateGeneration(tlsConfig(hostnameState)),
      "TLS_CERTIFICATE_HOSTNAME_MISMATCH",
    );

    const keyState = trackedTlsState();
    const generationA = keyState.createGeneration("key-a");
    const generationB = keyState.createGeneration("key-b");
    copyFileSync(generationA.privateKeyFile, generationB.privateKeyFile);
    chmodSync(generationB.privateKeyFile, 0o600);
    keyState.publish(generationB.generation);
    expectTlsError(() => readTlsCertificateGeneration(tlsConfig(keyState)), "TLS_KEY_MISMATCH");
  });
});

describe("TLS certificate hot reload", () => {
  it("switches a valid generation and keeps the prior context after a rejected generation", () => {
    const state = trackedTlsState();
    const generationA = state.createGeneration("generation-a");
    const generationB = state.createGeneration("generation-b");
    const rejected = state.createGeneration("generation-rejected");
    state.publish(generationA.generation);
    const events: TlsCertificateEvent[] = [];
    const contexts: SecureContextOptions[] = [];
    const manager = new TlsCertificateManager(tlsConfig(state), {
      eventSink: (event) => events.push(event),
    });

    manager.loadInitial();
    manager.start({ setSecureContext: (options: SecureContextOptions) => contexts.push(options) });
    state.publish(generationB.generation);

    expect(manager.reloadNow()).toBe("reloaded");
    expect(contexts).toHaveLength(1);
    expect(manager.status()).toMatchObject({
      status: "ok",
      generation: generationB.generation,
      fingerprint256: generationB.fingerprint256,
      lastReload: "reloaded",
    });

    writeFileSync(rejected.certificateFile, "not a certificate\n", { mode: 0o600 });
    state.publish(rejected.generation);
    expect(manager.reloadNow()).toBe("rejected");
    expect(contexts).toHaveLength(1);
    expect(manager.status()).toMatchObject({
      status: "ok",
      generation: generationB.generation,
      fingerprint256: generationB.fingerprint256,
      lastReload: "rejected",
      lastReloadErrorCode: "TLS_CERTIFICATE_INVALID",
    });
    expect(events).toEqual([
      expect.objectContaining({ event: "tls.certificate.reloaded", level: "info" }),
      expect.objectContaining({
        event: "tls.certificate.reload_rejected",
        level: "warn",
        fields: {
          errorCode: "TLS_CERTIFICATE_INVALID",
          generation: rejected.generation,
        },
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain(state.root);
    expect(JSON.stringify(events)).not.toContain("PRIVATE KEY");
    manager.stop();
  });

  it("serves new TLS handshakes without restarting Fastify or an active PTY", async () => {
    const state = trackedTlsState();
    const generationA = state.createGeneration("generation-a");
    const generationB = state.createGeneration("generation-b");
    state.publish(generationA.generation);
    const projectRoot = `${state.root}/projects`;
    const projectPath = `${projectRoot}/naru`;
    mkdirSync(projectPath, { recursive: true, mode: 0o700 });
    const repository = new NaruRepository(":memory:");
    const pathPolicy = await ProjectPathPolicy.create([projectRoot]);
    const supervisor = new PtySupervisor(repository, () => new NoopPty());
    const project = repository.createProject(realpathSync(projectPath), "naru");
    const pane = repository
      .getWorkspace(project.id)
      .panes.find((candidate) => candidate.kind === "terminal");
    if (pane === undefined) throw new Error("TLS integration fixture has no terminal pane.");
    supervisor.start(pane.id);
    const config: AppConfig = {
      authMode: "app-managed",
      environment: "test",
      host: "127.0.0.1",
      port: 8443,
      allowedOrigins: new Set([`https://${serverName}:8443`]),
      projectRoots: [projectRoot],
      passwordHash: "configured-hash",
      sessionSecret: "a-session-secret-that-is-at-least-32-chars",
      sessionCookieName: "naru_test_session",
      dataDir: `${state.root}/data`,
      secureCookie: true,
      sessionRuntime: { owner: "legacy" },
      tls: tlsConfig(state),
    };
    const manager = new TlsCertificateManager(config.tls as TlsConfig);
    const sessions = new SessionStore(config.sessionSecret);
    const session = sessions.create();
    const app = await buildApp(config, {
      repository,
      pathPolicy,
      supervisor,
      sessions,
      tlsCertificateManager: manager,
    });
    let existingWebSocket: TLSSocket | undefined;

    try {
      await within(app.listen({ host: config.host, port: 0 }), "HTTPS listen");
      const address = app.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("TLS integration server has no TCP address.");
      }

      existingWebSocket = await within(connectTls(address.port), "initial TLS handshake");
      expect(existingWebSocket.getPeerCertificate().fingerprint256).toBe(
        generationA.fingerprint256,
      );
      await within(upgradeWebSocket(existingWebSocket, session.token), "WSS upgrade");

      state.publish(generationB.generation);
      expect(manager.reloadNow()).toBe("reloaded");
      expect(supervisor.isRunning(pane.id)).toBe(true);

      const newConnection = await within(connectTls(address.port), "reloaded TLS handshake");
      expect(newConnection.getPeerCertificate().fingerprint256).toBe(generationB.fingerprint256);
      newConnection.destroy();

      const framePromise = readWebSocketText(existingWebSocket);
      sendWebSocketText(
        existingWebSocket,
        JSON.stringify({ type: "lease.acquire", clientId: randomUUID() }),
      );
      expect(JSON.parse(await within(framePromise, "WSS frame after reload"))).toMatchObject({
        type: "lease.granted",
        acquisition: "initial",
      });
      expect(existingWebSocket.destroyed).toBe(false);
      const ready = await app.inject({ method: "GET", url: "/readyz" });
      expect(ready.json()).toMatchObject({
        status: "ready",
        checks: { tls: "ok" },
        tlsCertificate: {
          generation: generationB.generation,
          fingerprint256: generationB.fingerprint256,
        },
        metrics: { gauges: { activePtys: 1, activeWebSockets: 1 } },
      });
      expect(supervisor.isRunning(pane.id)).toBe(true);
      existingWebSocket.destroy();
      existingWebSocket = undefined;
    } finally {
      existingWebSocket?.destroy();
      await within(app.close(), "Fastify close");
    }
  });
});

function trackedTlsState(): TestTlsState {
  const state = createTestTlsState(serverName);
  temporaryDirectories.push(state.root);
  return state;
}

function tlsConfig(state: TestTlsState): TlsConfig {
  return {
    stateDirectory: state.stateDirectory,
    serverNames: [serverName],
    reloadIntervalMs: 300_000,
  };
}

function expectTlsError(action: () => unknown, code: TlsCertificateError["code"]): void {
  try {
    action();
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(TlsCertificateError);
    expect(error).toMatchObject({ code });
  }
}

function connectTls(port: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    const socket = connect(
      {
        host: "127.0.0.1",
        port,
        servername: serverName,
        rejectUnauthorized: false,
        minVersion: "TLSv1.2",
      },
      () => {
        socket.off("error", onError);
        resolve(socket);
      },
    );
    socket.once("error", onError);
  });
}

function upgradeWebSocket(socket: TLSSocket, sessionToken: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let response = Buffer.alloc(0);
    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer): void => {
      response = Buffer.concat([response, chunk]);
      const headerEnd = response.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      cleanup();
      const headers = response.subarray(0, headerEnd).toString("utf8");
      if (!headers.startsWith("HTTP/1.1 101 ")) {
        reject(new Error("WSS upgrade failed."));
        return;
      }
      if (response.byteLength !== headerEnd + 4) {
        reject(new Error("WSS upgrade returned an unexpected early frame."));
        return;
      }
      resolve();
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.write(
      [
        "GET /api/terminal HTTP/1.1",
        `Host: ${serverName}:8443`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
        "Sec-WebSocket-Version: 13",
        `Origin: https://${serverName}:8443`,
        `Cookie: naru_test_session=${sessionToken}`,
        "",
        "",
      ].join("\r\n"),
    );
  });
}

function sendWebSocketText(socket: TLSSocket, text: string): void {
  const payload = Buffer.from(text, "utf8");
  if (payload.byteLength > 125) throw new Error("Test WebSocket frame is too large.");
  const mask = randomBytes(4);
  const frame = Buffer.alloc(2 + mask.byteLength + payload.byteLength);
  frame[0] = 0x81;
  frame[1] = 0x80 | payload.byteLength;
  mask.copy(frame, 2);
  for (let index = 0; index < payload.byteLength; index += 1) {
    frame[6 + index] = (payload[index] as number) ^ (mask[index % 4] as number);
  }
  socket.write(frame);
}

function readWebSocketText(socket: TLSSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    let frame = Buffer.alloc(0);
    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer): void => {
      frame = Buffer.concat([frame, chunk]);
      if (frame.byteLength < 2) return;
      const encodedLength = (frame[1] as number) & 0x7f;
      const headerLength = encodedLength === 126 ? 4 : 2;
      if (encodedLength === 127) {
        cleanup();
        reject(new Error("Test WebSocket frame is too large."));
        return;
      }
      if (frame.byteLength < headerLength) return;
      const payloadLength = encodedLength === 126 ? frame.readUInt16BE(2) : encodedLength;
      if (frame.byteLength < headerLength + payloadLength) return;
      cleanup();
      if (((frame[0] as number) & 0x0f) !== 0x1 || ((frame[1] as number) & 0x80) !== 0) {
        reject(new Error("Expected an unmasked WebSocket text frame."));
        return;
      }
      resolve(frame.subarray(headerLength, headerLength + payloadLength).toString("utf8"));
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

function within<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} timed out.`)), 2_000);
    timeout.unref();
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(`${label} failed.`));
      },
    );
  });
}

class NoopPty implements PtyProcess {
  readonly pid = 1;
  #onExit: ((event: { exitCode: number; signal?: number }) => void) | undefined;

  onData(): { dispose(): void } {
    return { dispose: () => undefined };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.#onExit = listener;
    return { dispose: () => (this.#onExit = undefined) };
  }

  write(): void {}
  resize(): void {}

  kill(): void {
    this.#onExit?.({ exitCode: 0, signal: 1 });
  }
}
