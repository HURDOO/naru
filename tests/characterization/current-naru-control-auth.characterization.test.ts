import type {
  FinishPasskeyAuthenticationRequest,
  Passkey,
} from "../../packages/contracts/src/index.js";
import type { PasskeyService } from "../../apps/server/src/passkeys.js";
import { describe, expect, it } from "vitest";
import {
  closeSocket,
  createCurrentNaruFixture,
  CURRENT_NARU_ORIGIN,
  loginWithPassword,
  nextServerFrame,
  nextServerFrames,
  registerProject,
  sendClientFrame,
  unsafeHeaders,
  waitFor,
  workspace,
} from "./current-naru-harness.js";

describe("current Naru lease, reconnect, restore, and auth", () => {
  it("keeps a second browser observing until explicit takeover while preserving the same PTY runtime", async () => {
    const fixture = await createCurrentNaruFixture();
    try {
      const auth = await loginWithPassword(fixture.app);
      const project = await registerProject(fixture, auth);
      const pane = workspace(fixture, project.id).panes.find(({ kind }) => kind === "codex");
      const process = fixture.launches[0]?.process;
      const first = auth.surface?.socket;
      if (!pane || !process || !first) {
        throw new Error("Current Naru did not start its first controlled Codex Pane.");
      }
      process.emitData("before reconnect\r\n");

      const firstAttach = nextServerFrames(first, 2);
      sendClientFrame(first, {
        type: "pane.attach",
        paneId: pane.id,
        leaseGeneration: 1,
        cols: 80,
        rows: 24,
      });
      const initialSnapshot = (await firstAttach).find((frame) => frame.type === "pane.snapshot");
      expect(initialSnapshot).toMatchObject({
        type: "pane.snapshot",
        paneId: pane.id,
        sequence: 1,
        cols: 80,
        rows: 24,
      });
      if (initialSnapshot?.type !== "pane.snapshot") throw new Error("Snapshot was not returned.");
      expect(initialSnapshot.serializedState).toContain("before reconnect");
      const runtimeId = initialSnapshot.runtimeId;

      const releaseWitness = await fixture.app.injectWS("/api/terminal", {
        headers: { cookie: auth.cookie, origin: CURRENT_NARU_ORIGIN },
      });
      const witnessOpened = nextServerFrames(releaseWitness, 2);
      sendClientFrame(releaseWitness, {
        type: "lease.acquire",
        clientId: "33333333-3333-4333-8333-333333333333",
      });
      expect(await witnessOpened).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "surface.state",
            generation: 1,
            role: "observer",
          }),
        ]),
      );
      const released = nextServerFrame(releaseWitness);
      await closeSocket(first);
      await expect(released).resolves.toMatchObject({
        type: "surface.state",
        generation: 2,
        role: "observer",
        controllerPresent: false,
        reason: "released",
      });
      const reconnected = await fixture.app.injectWS("/api/terminal", {
        headers: { cookie: auth.cookie, origin: CURRENT_NARU_ORIGIN },
      });
      const reconnectOpened = nextServerFrames(reconnected, 2);
      const witnessReconnected = nextServerFrame(releaseWitness);
      sendClientFrame(reconnected, {
        type: "lease.acquire",
        clientId: "11111111-1111-4111-8111-111111111111",
      });
      expect(await reconnectOpened).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "lease.granted",
            generation: 3,
            acquisition: "reconnect",
          }),
          expect.objectContaining({
            type: "surface.state",
            generation: 3,
            role: "controller",
          }),
        ]),
      );
      await expect(witnessReconnected).resolves.toMatchObject({
        type: "surface.state",
        generation: 3,
        role: "observer",
        controllerPresent: true,
        reason: "reconnect",
      });
      const reconnectAttach = nextServerFrames(reconnected, 2);
      sendClientFrame(reconnected, {
        type: "pane.attach",
        paneId: pane.id,
        leaseGeneration: 3,
        cols: 90,
        rows: 30,
      });
      expect(await reconnectAttach).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "pane.snapshot",
            runtimeId,
            sequence: 1,
            cols: 90,
            rows: 30,
          }),
        ]),
      );

      const takeover = await fixture.app.injectWS("/api/terminal", {
        headers: { cookie: auth.cookie, origin: CURRENT_NARU_ORIGIN },
      });
      const observerOpened = nextServerFrames(takeover, 2);
      sendClientFrame(takeover, {
        type: "lease.acquire",
        clientId: "22222222-2222-4222-8222-222222222222",
      });
      expect(await observerOpened).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "lease.granted",
            generation: 3,
            replacedClient: false,
          }),
          expect.objectContaining({
            type: "surface.state",
            generation: 3,
            role: "observer",
            reason: "conflict",
          }),
        ]),
      );
      expect(process.killSignals).toEqual([]);

      const observerAttach = nextServerFrames(takeover, 2);
      sendClientFrame(takeover, {
        type: "pane.attach",
        paneId: pane.id,
        leaseGeneration: 3,
        cols: 100,
        rows: 40,
      });
      expect(await observerAttach).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "pane.snapshot",
            runtimeId,
            cols: 90,
            rows: 30,
          }),
          expect.objectContaining({
            type: "pane.control.state",
            role: "observer",
          }),
        ]),
      );
      expect(process.sizes.at(-1)).toEqual([90, 30]);

      const staleInput = nextServerFrame(takeover);
      sendClientFrame(takeover, {
        type: "terminal.input",
        paneId: pane.id,
        leaseGeneration: 3,
        data: "observer input",
      });
      await expect(staleInput).resolves.toMatchObject({
        type: "protocol.error",
        code: "LEASE_REQUIRED",
      });

      const demotedFrames = nextServerFrames(reconnected, 2);
      const promotedFrames = nextServerFrames(takeover, 2);
      sendClientFrame(takeover, {
        type: "surface.takeover",
        leaseGeneration: 3,
        target: { paneId: pane.id, cols: 100, rows: 40 },
      });
      expect(await demotedFrames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "surface.state",
            generation: 4,
            role: "observer",
            reason: "preempted",
          }),
        ]),
      );
      expect(await promotedFrames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "surface.state",
            generation: 4,
            role: "controller",
            reason: "preempted",
          }),
        ]),
      );

      const demotedInput = nextServerFrame(reconnected);
      sendClientFrame(reconnected, {
        type: "terminal.input",
        paneId: pane.id,
        leaseGeneration: 4,
        data: "demoted input",
      });
      await expect(demotedInput).resolves.toMatchObject({
        type: "protocol.error",
        code: "LEASE_REQUIRED",
      });
      sendClientFrame(takeover, {
        type: "terminal.input",
        paneId: pane.id,
        leaseGeneration: 4,
        data: "current input",
      });
      await waitFor(() => process.writes.includes("current input"));
      expect(process.writes).not.toContain("observer input");
      expect(process.writes).not.toContain("demoted input");

      const liveOutput = nextServerFrame(takeover);
      process.emitData("after takeover\r\n");
      await expect(liveOutput).resolves.toMatchObject({
        type: "terminal.output",
        sequence: 2,
        data: "after takeover\r\n",
      });
      await expect(liveOutput).resolves.not.toHaveProperty("runtimeId");
      await closeSocket(releaseWitness);
      await closeSocket(reconnected);
      await closeSocket(takeover);
    } finally {
      await fixture.dispose();
    }
  });

  it("current behavior: password and passkey upgrade into the same standalone Naru cookie and logout revokes only the browser path", async () => {
    const authenticationCalls: Array<{ binding: string; origin: string }> = [];
    const passkeys: PasskeyService = {
      list: () => [],
      beginRegistration: () => Promise.reject(new Error("registration is out of scope")),
      finishRegistration: () => Promise.reject(new Error("registration is out of scope")),
      beginAuthentication: (binding, origin) => {
        authenticationCalls.push({ binding, origin });
        return Promise.resolve({
          ceremonyId: "33333333-3333-4333-8333-333333333333",
          options: {
            challenge: "current-naru-passkey-challenge",
            timeout: 60_000,
            rpId: "127.0.0.1",
            userVerification: "required",
          },
        });
      },
      finishAuthentication: (binding, origin) => {
        authenticationCalls.push({ binding, origin });
        return Promise.resolve();
      },
      rename: (): Passkey => {
        throw new Error("rename is out of scope");
      },
      delete: () => false,
    };
    const fixture = await createCurrentNaruFixture({ passkeys });
    try {
      const unauthenticated = await fixture.app.inject({ method: "GET", url: "/api/projects" });
      expect(unauthenticated.statusCode).toBe(401);
      const wrongOrigin = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: "http://attacker.invalid" },
        payload: { password: "naru-test-password" },
      });
      expect(wrongOrigin.statusCode).toBe(403);
      expect(wrongOrigin.json()).toMatchObject({ code: "ORIGIN_INVALID" });

      const passwordAuth = await loginWithPassword(fixture.app);
      expect(passwordAuth.cookie).toMatch(/^naru_test_session=/);
      const options = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/passkey/options",
        headers: { origin: CURRENT_NARU_ORIGIN },
      });
      expect(options.statusCode).toBe(200);
      const passkeyRequest: FinishPasskeyAuthenticationRequest = {
        ceremonyId: "33333333-3333-4333-8333-333333333333",
        response: {
          id: "current-naru-credential",
          rawId: "current-naru-credential",
          response: {
            clientDataJSON: "client-data",
            authenticatorData: "authenticator-data",
            signature: "signature",
            userHandle: null,
          },
          type: "public-key",
          clientExtensionResults: {},
        },
      };
      const passkeyLogin = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/passkey/verify",
        headers: { origin: CURRENT_NARU_ORIGIN },
        payload: passkeyRequest,
      });
      expect(passkeyLogin.statusCode).toBe(200);
      const setCookie = passkeyLogin.headers["set-cookie"];
      const serializedCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      const passkeyCookie = serializedCookie?.split(";")[0] ?? "";
      const passkeyCsrf = passkeyLogin.json<{ csrfToken: string }>().csrfToken;
      expect(passkeyCookie).toMatch(/^naru_test_session=/);
      expect(passkeyCookie).not.toBe(passwordAuth.cookie);
      expect(authenticationCalls).toEqual([
        { binding: "ip:127.0.0.1", origin: CURRENT_NARU_ORIGIN },
        { binding: "ip:127.0.0.1", origin: CURRENT_NARU_ORIGIN },
      ]);

      const project = await registerProject(fixture, {
        cookie: passkeyCookie,
        csrfToken: passkeyCsrf,
      });
      const running = fixture.launches.map(({ process }) => process);
      const socket = await fixture.app.injectWS("/api/terminal", {
        headers: { cookie: passkeyCookie, origin: CURRENT_NARU_ORIGIN },
      });
      const granted = nextServerFrame(socket);
      sendClientFrame(socket, {
        type: "lease.acquire",
        clientId: "44444444-4444-4444-8444-444444444444",
      });
      await expect(granted).resolves.toMatchObject({ type: "lease.granted" });
      const revoked = nextServerFrame(socket);
      const logout = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: unsafeHeaders({ cookie: passkeyCookie, csrfToken: passkeyCsrf }),
      });
      expect(logout.statusCode).toBe(204);
      await expect(revoked).resolves.toEqual({ type: "lease.revoked", reason: "logout" });
      expect(running.map(({ killSignals }) => killSignals)).toEqual([[], []]);
      expect(
        fixture.repository
          .getWorkspace(project.id)
          .panes.filter(({ status }) => status === "running"),
      ).toHaveLength(2);
    } finally {
      await fixture.dispose();
    }
  });
});
