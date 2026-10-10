import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NARU_SURFACE_CONNECTION_HEADER,
  NARU_SURFACE_GENERATION_HEADER,
  type NaruPushSubscription,
  type Pane,
  type ProjectGroup,
} from "@naru/contracts";
import type { AppConfig, AppManagedConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";
import type { ClipboardImageWriter } from "../src/clipboard-image.js";
import { ClientPresenceRegistry } from "../src/client-presence.js";
import type {
  CodexHookEvent,
  CodexSessionHookBridge,
  CodexSessionHookRegistration,
} from "../src/codex-session-hook.js";
import { NaruRepository } from "../src/database.js";
import { AppError } from "../src/errors.js";
import type { PaneLaunchResolver } from "../src/launch-profiles.js";
import { Observability, type StructuredLogEntry } from "../src/observability.js";
import { ProjectPathPolicy } from "../src/path-policy.js";
import { hashPassword } from "../src/password.js";
import type { PasskeyService } from "../src/passkeys.js";
import { PtySupervisor, type PtyProcess } from "../src/pty.js";
import { LoginRateLimiter, SessionStore } from "../src/sessions.js";

const origin = "http://127.0.0.1:5173";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Naru HTTP API", () => {
  it("reports liveness, dependency readiness, and content-free operational metrics", async () => {
    const fixture = await createFixture();
    try {
      const health = await fixture.app.inject({ method: "GET", url: "/healthz" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ status: "ok" });
      expect(health.headers["content-security-policy"]).toContain("script-src 'self'");
      expect(health.headers["content-security-policy"]).toContain("object-src 'none'");
      expect(health.headers["content-security-policy"]).not.toContain("unsafe-eval");

      const ready = await fixture.app.inject({ method: "GET", url: "/readyz" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toMatchObject({
        status: "ready",
        checks: { configuration: "ok", database: "ok" },
        metrics: {
          counters: {
            httpErrors: 0,
            loginFailures: 0,
            loginRateLimited: 0,
            loginSuccesses: 0,
            ptyLaunchFailures: 0,
            websocketTakeovers: 0,
          },
          gauges: { activePtys: 0, activeSessions: 0, activeWebSockets: 0 },
        },
      });

      const unauthenticatedSession = await fixture.app.inject({
        method: "GET",
        url: "/api/session",
      });
      expect(unauthenticatedSession.statusCode).toBe(401);
      expect(JSON.stringify(unauthenticatedSession.json())).not.toContain(fixture.projectRoot);

      const login = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { password: "naru-test-password" },
      });
      const cookie = firstHeader(login.headers["set-cookie"])?.split(";")[0] ?? "";
      expect(login.json()).toMatchObject({
        authMode: "app-managed",
        projectRoots: [fixture.projectRoot],
        capabilities: { terminalRestore: "staged-v1" },
      });
      const csrfToken = login.json<{ csrfToken: string }>().csrfToken;
      const controller = await openControllerSurface(fixture.app, cookie, csrfToken);
      await fixture.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: controller.headers,
        payload: { path: fixture.projectPath },
      });
      const socket = controller.socket;
      try {
        const active = await fixture.app.inject({ method: "GET", url: "/readyz" });
        expect(active.json()).toMatchObject({
          metrics: {
            counters: { loginSuccesses: 1 },
            gauges: { activePtys: 2, activeSessions: 1, activeWebSockets: 1 },
          },
        });
      } finally {
        socket.terminate();
      }

      vi.spyOn(fixture.repository, "isReady").mockReturnValue(false);
      const databaseFailure = await fixture.app.inject({ method: "GET", url: "/readyz" });
      expect(databaseFailure.statusCode).toBe(503);
      expect(databaseFailure.json()).toMatchObject({
        status: "not_ready",
        checks: { configuration: "ok", database: "failed" },
      });
      expect(JSON.stringify(databaseFailure.json())).not.toContain(fixture.projectPath);
      expect(JSON.stringify(databaseFailure.json())).not.toMatch(/password|secret|cookie/i);
    } finally {
      await fixture.app.close();
    }

    const invalidConfig = await createFixture({ configPatch: { projectRoots: [] } });
    try {
      const response = await invalidConfig.app.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        status: "not_ready",
        checks: { configuration: "failed", database: "ok" },
      });
    } finally {
      await invalidConfig.app.close();
    }
  });

  it("emits structured lifecycle events without request credentials", async () => {
    const entries: StructuredLogEntry[] = [];
    const observability = new Observability((entry) => entries.push(entry));
    const fixture = await createFixture({ observability });
    try {
      await fixture.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin, cookie: "naru_test_session=cookie-sentinel" },
        payload: { password: "password-sentinel" },
      });

      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "auth.login.failed", level: "warn" }),
          expect.objectContaining({ event: "http.request.failed", errorCode: "AUTH_INVALID" }),
          expect.objectContaining({ event: "http.request.completed", statusCode: 401 }),
        ]),
      );
      const serialized = JSON.stringify(entries);
      expect(serialized).not.toContain("password-sentinel");
      expect(serialized).not.toContain("cookie-sentinel");
      expect(serialized).not.toContain(fixture.projectPath);
    } finally {
      await fixture.app.close();
    }
  });

  it("keeps a missing project removable while blocking workspace and PTY use", async () => {
    const fixture = await createFixture();
    try {
      const login = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { password: "naru-test-password" },
      });
      const cookie = firstHeader(login.headers["set-cookie"])?.split(";")[0] ?? "";
      const csrfToken = login.json<{ csrfToken: string }>().csrfToken;
      const controller = await openControllerSurface(fixture.app, cookie, csrfToken);
      const unsafeHeaders = controller.headers;
      const created = await fixture.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: unsafeHeaders,
        payload: { path: fixture.projectPath },
      });
      const projectId = created.json<{ id: string }>().id;

      await rm(fixture.projectPath, { recursive: true });
      const unavailable = await fixture.app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/workspace`,
        headers: { cookie },
      });
      expect(unavailable.statusCode).toBe(404);
      expect(unavailable.json()).toMatchObject({ code: "PROJECT_MISSING" });

      const removed = await fixture.app.inject({
        method: "DELETE",
        url: `/api/projects/${projectId}`,
        headers: unsafeHeaders,
      });
      expect(removed.statusCode).toBe(204);
    } finally {
      await fixture.app.close();
    }
  });

  it("protects project mutations with password, Origin, session, and CSRF", async () => {
    const fixture = await createFixture();
    try {
      const unauthenticated = await fixture.app.inject({ method: "GET", url: "/api/projects" });
      expect(unauthenticated.statusCode).toBe(401);

      const wrongLogin = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { password: "definitely-wrong" },
      });
      expect(wrongLogin.statusCode).toBe(401);
      expect(wrongLogin.json()).toMatchObject({ code: "AUTH_INVALID" });

      const login = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { password: "naru-test-password" },
      });
      expect(login.statusCode).toBe(200);
      const setCookie = login.headers["set-cookie"];
      const serializedCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      const cookie = serializedCookie?.split(";")[0];
      const csrfToken = login.json<{ csrfToken: string }>().csrfToken;
      expect(cookie).toContain("naru_test_session=");
      expect(serializedCookie).toContain("HttpOnly");
      expect(serializedCookie).toContain("SameSite=Strict");
      expect(serializedCookie).not.toMatch(/;\s*Secure(?:;|$)/);

      const missingCsrf = await fixture.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { origin, cookie: cookie ?? "" },
        payload: { path: fixture.projectPath },
      });
      expect(missingCsrf.statusCode).toBe(403);
      expect(missingCsrf.json()).toMatchObject({ code: "CSRF_INVALID" });

      const forgedOrigin = await fixture.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: {
          origin: "http://attacker.invalid",
          cookie: cookie ?? "",
          "x-csrf-token": csrfToken,
        },
        payload: { path: fixture.projectPath },
      });
      expect(forgedOrigin.statusCode).toBe(403);
      expect(forgedOrigin.json()).toMatchObject({ code: "ORIGIN_INVALID" });

      const controller = await openControllerSurface(fixture.app, cookie ?? "", csrfToken);
      const created = await fixture.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: controller.headers,
        payload: { path: fixture.projectPath },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ name: "project", path: fixture.projectPath });
      expect(fixture.launches.map(({ file, args, cwd }) => ({ file, args, cwd }))).toEqual([
        {
          file: "/test/bin/codex",
          args: ["--profile-id", "codex-main"],
          cwd: fixture.projectPath,
        },
        {
          file: "/test/bin/codex",
          args: ["--profile-id", "codex-quick"],
          cwd: fixture.projectPath,
        },
      ]);
      const projectId = created.json<{ id: string }>().id;

      const duplicate = await fixture.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: controller.headers,
        payload: { path: fixture.projectPath },
      });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toMatchObject({ code: "PROJECT_DUPLICATE" });

      const listed = await fixture.app.inject({
        method: "GET",
        url: "/api/projects",
        headers: { cookie: cookie ?? "" },
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toHaveLength(1);

      const removed = await fixture.app.inject({
        method: "DELETE",
        url: `/api/projects/${projectId}`,
        headers: controller.headers,
      });
      expect(removed.statusCode).toBe(204);
      await expect(readFile(fixture.sentinelPath, "utf8")).resolves.toBe("keep me");

      const empty = await fixture.app.inject({
        method: "GET",
        url: "/api/projects",
        headers: { cookie: cookie ?? "" },
      });
      expect(empty.json()).toEqual([]);

      const logout = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: { origin, cookie: cookie ?? "", "x-csrf-token": csrfToken },
      });
      expect(logout.statusCode).toBe(204);
      const expired = await fixture.app.inject({
        method: "GET",
        url: "/api/session",
        headers: { cookie: cookie ?? "" },
      });
      expect(expired.statusCode).toBe(401);
    } finally {
      await fixture.app.close();
    }
  });

  it("discovers Git worktrees but creates Pane state only after an explicit protected connect", async () => {
    const fixture = await createFixture();
    try {
      runGit(fixture.projectPath, ["init", "--initial-branch=release"]);
      runGit(fixture.projectPath, ["add", "keep.txt"]);
      runGit(fixture.projectPath, [
        "-c",
        "user.name=Naru Test",
        "-c",
        "user.email=naru@example.invalid",
        "commit",
        "-m",
        "initial",
      ]);
      const linkedPath = join(fixture.projectPath, "..", "project-feature");
      runGit(fixture.projectPath, ["worktree", "add", "-b", "feature/sidebar", linkedPath]);
      const canonicalLinkedPath = await realpath(linkedPath);

      const login = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { password: "naru-test-password" },
      });
      const cookie = firstHeader(login.headers["set-cookie"])?.split(";")[0] ?? "";
      const csrfToken = login.json<{ csrfToken: string }>().csrfToken;
      const { headers: unsafeHeaders } = await openControllerSurface(
        fixture.app,
        cookie,
        csrfToken,
      );
      const created = await fixture.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: unsafeHeaders,
        payload: { path: fixture.projectPath, name: "Editor" },
      });
      expect(created.statusCode).toBe(201);
      expect(fixture.repository.listProjects()).toHaveLength(1);
      expect(fixture.launches).toHaveLength(2);

      const groupsResponse = await fixture.app.inject({
        method: "GET",
        url: "/api/project-groups",
        headers: { cookie },
      });
      expect(groupsResponse.statusCode).toBe(200);
      const group = groupsResponse.json<ProjectGroup[]>()[0]!;
      expect(group.targets).toEqual([
        expect.objectContaining({ registration: "connected", label: "release" }),
        expect.objectContaining({
          registration: "discovered",
          label: "feature/sidebar",
          path: canonicalLinkedPath,
        }),
      ]);

      const refreshWithoutCsrf = await fixture.app.inject({
        method: "POST",
        url: "/api/project-groups/refresh",
        headers: { origin, cookie },
      });
      expect(refreshWithoutCsrf.statusCode).toBe(403);
      expect(refreshWithoutCsrf.json()).toMatchObject({ code: "CSRF_INVALID" });
      const connectWithoutCsrf = await fixture.app.inject({
        method: "POST",
        url: `/api/project-groups/${group.id}/targets`,
        headers: { origin, cookie },
        payload: { path: canonicalLinkedPath },
      });
      expect(connectWithoutCsrf.statusCode).toBe(403);

      const outsidePath = join(fixture.projectRoot, "..", "outside-worktree");
      runGit(fixture.projectPath, ["worktree", "add", "-b", "feature/outside", outsidePath]);
      const outsideConnect = await fixture.app.inject({
        method: "POST",
        url: `/api/project-groups/${group.id}/targets`,
        headers: unsafeHeaders,
        payload: { path: await realpath(outsidePath) },
      });
      expect(outsideConnect.statusCode).toBe(403);
      expect(outsideConnect.json()).toMatchObject({ code: "PROJECT_OUTSIDE_ROOT" });

      const connected = await fixture.app.inject({
        method: "POST",
        url: `/api/project-groups/${group.id}/targets`,
        headers: unsafeHeaders,
        payload: { path: canonicalLinkedPath },
      });
      expect(connected.statusCode).toBe(201);
      expect(fixture.repository.listProjects()).toHaveLength(2);
      expect(fixture.launches.filter(({ cwd }) => cwd === canonicalLinkedPath)).toHaveLength(2);

      const duplicate = await fixture.app.inject({
        method: "POST",
        url: `/api/project-groups/${group.id}/targets`,
        headers: unsafeHeaders,
        payload: { path: canonicalLinkedPath },
      });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toMatchObject({ code: "PROJECT_DUPLICATE" });

      const renamed = await fixture.app.inject({
        method: "PATCH",
        url: `/api/project-groups/${group.id}`,
        headers: unsafeHeaders,
        payload: { name: "Editor worktrees" },
      });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json<ProjectGroup[]>()[0]?.name).toBe("Editor worktrees");
    } finally {
      await fixture.app.close();
    }
  });

  it("registers, manages, and authenticates passkeys through protected ceremonies", async () => {
    const passkeyId = "00000000-0000-4000-8000-000000000001";
    const registrationCeremonyId = "00000000-0000-4000-8000-000000000002";
    const authenticationCeremonyId = "00000000-0000-4000-8000-000000000003";
    let records: ReturnType<PasskeyService["list"]> = [];
    const finishAuthentication = vi.fn(() => Promise.resolve());
    const passkeys: PasskeyService = {
      list: () => records,
      beginRegistration: (sessionBinding, ceremonyOrigin) => {
        expect(sessionBinding).not.toBe("");
        expect(ceremonyOrigin).toBe(origin);
        return Promise.resolve({ ceremonyId: registrationCeremonyId, options: {} as never });
      },
      finishRegistration: (_sessionBinding, ceremonyOrigin, input) => {
        expect(ceremonyOrigin).toBe(origin);
        expect(input.ceremonyId).toBe(registrationCeremonyId);
        const passkey = {
          id: passkeyId,
          name: input.name,
          deviceType: "multiDevice" as const,
          backedUp: true,
          createdAt: "2026-08-19T00:00:00.000Z",
          updatedAt: "2026-08-19T00:00:00.000Z",
          lastUsedAt: null,
        };
        records = [passkey];
        return Promise.resolve(passkey);
      },
      beginAuthentication: (clientBinding, ceremonyOrigin) => {
        expect(clientBinding).toContain("ip:");
        expect(ceremonyOrigin).toBe(origin);
        return Promise.resolve({ ceremonyId: authenticationCeremonyId, options: {} as never });
      },
      finishAuthentication,
      rename: (id, name) => {
        const current = records.find((passkey) => passkey.id === id);
        if (!current) throw new AppError("PASSKEY_MISSING", 404, "missing");
        const renamed = { ...current, name, updatedAt: "2026-08-19T00:01:00.000Z" };
        records = [renamed];
        return renamed;
      },
      delete: (id) => {
        const found = records.some((passkey) => passkey.id === id);
        records = records.filter((passkey) => passkey.id !== id);
        return found;
      },
    };
    const fixture = await createFixture({ passkeys });
    const registrationResponse = {
      id: "credential-id",
      rawId: "credential-id",
      response: { clientDataJSON: "client-data", attestationObject: "attestation" },
      type: "public-key",
      clientExtensionResults: {},
    };
    const authenticationResponse = {
      id: "credential-id",
      rawId: "credential-id",
      response: {
        clientDataJSON: "client-data",
        authenticatorData: "authenticator-data",
        signature: "signature",
        userHandle: null,
      },
      type: "public-key",
      clientExtensionResults: {},
    };

    try {
      const unauthenticatedList = await fixture.app.inject({ method: "GET", url: "/api/passkeys" });
      expect(unauthenticatedList.statusCode).toBe(401);

      const login = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { password: "naru-test-password" },
      });
      const cookie = firstHeader(login.headers["set-cookie"])?.split(";")[0] ?? "";
      const csrfToken = login.json<{ csrfToken: string }>().csrfToken;
      const { headers: unsafeHeaders } = await openControllerSurface(
        fixture.app,
        cookie,
        csrfToken,
      );

      const missingCsrf = await fixture.app.inject({
        method: "POST",
        url: "/api/passkeys/registration/options",
        headers: { origin, cookie },
      });
      expect(missingCsrf.statusCode).toBe(403);

      const registrationOptions = await fixture.app.inject({
        method: "POST",
        url: "/api/passkeys/registration/options",
        headers: unsafeHeaders,
      });
      expect(registrationOptions).toMatchObject({ statusCode: 200 });
      expect(registrationOptions.json()).toMatchObject({ ceremonyId: registrationCeremonyId });

      const registered = await fixture.app.inject({
        method: "POST",
        url: "/api/passkeys/registration/verify",
        headers: unsafeHeaders,
        payload: {
          ceremonyId: registrationCeremonyId,
          name: "Android passkey",
          response: registrationResponse,
        },
      });
      expect(registered.statusCode).toBe(201);
      expect(registered.json()).toMatchObject({ id: passkeyId, name: "Android passkey" });

      const listed = await fixture.app.inject({
        method: "GET",
        url: "/api/passkeys",
        headers: { cookie },
      });
      expect(listed.json()).toEqual([expect.objectContaining({ id: passkeyId })]);

      const renamed = await fixture.app.inject({
        method: "PATCH",
        url: `/api/passkeys/${passkeyId}`,
        headers: unsafeHeaders,
        payload: { name: "Galaxy" },
      });
      expect(renamed.json()).toMatchObject({ name: "Galaxy" });

      const forgedOptions = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/passkey/options",
        headers: { origin: "http://attacker.invalid" },
      });
      expect(forgedOptions.statusCode).toBe(403);

      const authenticationOptions = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/passkey/options",
        headers: { origin },
      });
      expect(authenticationOptions.json()).toMatchObject({ ceremonyId: authenticationCeremonyId });

      const authenticated = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/passkey/verify",
        headers: { origin },
        payload: { ceremonyId: authenticationCeremonyId, response: authenticationResponse },
      });
      expect(authenticated.statusCode).toBe(200);
      expect(firstHeader(authenticated.headers["set-cookie"])).toContain("naru_test_session=");
      expect(finishAuthentication).toHaveBeenCalledOnce();

      const deleted = await fixture.app.inject({
        method: "DELETE",
        url: `/api/passkeys/${passkeyId}`,
        headers: unsafeHeaders,
      });
      expect(deleted.statusCode).toBe(204);
      const missing = await fixture.app.inject({
        method: "DELETE",
        url: `/api/passkeys/${passkeyId}`,
        headers: unsafeHeaders,
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: "PASSKEY_MISSING" });
    } finally {
      await fixture.app.close();
    }
  });

  it("protects per-device Web Push subscription management with session, Origin, and CSRF", async () => {
    const clientPresence = new ClientPresenceRegistry();
    const fixture = await createFixture({
      clientPresence,
      configPatch: {
        push: {
          publicKey: Buffer.alloc(65, 1).toString("base64url"),
          privateKey: Buffer.alloc(32, 2).toString("base64url"),
          subject: "https://naru.example.test",
        },
      },
    });
    try {
      expect(
        (await fixture.app.inject({ method: "GET", url: "/api/push/config" })).statusCode,
      ).toBe(401);
      expect(
        (
          await fixture.app.inject({
            method: "GET",
            url: "/api/push/projects/11111111-1111-4111-8111-111111111111/summary",
          })
        ).statusCode,
      ).toBe(401);
      const login = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { password: "naru-test-password" },
      });
      const cookie = firstHeader(login.headers["set-cookie"])?.split(";")[0] ?? "";
      const csrfToken = login.json<{ csrfToken: string }>().csrfToken;
      const { headers: unsafeHeaders } = await openControllerSurface(
        fixture.app,
        cookie,
        csrfToken,
      );

      const configuration = await fixture.app.inject({
        method: "GET",
        url: "/api/push/config",
        headers: { cookie },
      });
      expect(configuration.json()).toEqual({
        configured: true,
        publicKey: Buffer.alloc(65, 1).toString("base64url"),
        inactivityDelayMinutes: 2,
      });
      expect(JSON.stringify(configuration.json())).not.toContain("privateKey");

      const project = fixture.repository.createProject(fixture.projectPath, "editor");
      const panes = fixture.repository.getWorkspace(project.id).panes;
      fixture.repository.setPaneActivity(panes[0]?.id ?? "missing", "interaction-required");
      fixture.repository.setPaneActivity(panes[1]?.id ?? "missing", "failed");
      fixture.repository.setPaneActivity(panes[2]?.id ?? "missing", "completed");
      const summary = await fixture.app.inject({
        method: "GET",
        url: `/api/push/projects/${project.id}/summary`,
        headers: { cookie },
      });
      expect(summary.json()).toEqual({
        projectId: project.id,
        projectName: "editor",
        state: "interaction-required",
        counts: { interactionRequired: 1, failed: 1, completed: 1 },
        suppressNotification: false,
      });
      clientPresence.observe("controller", {
        visible: true,
        focused: true,
        interactionRevision: 1,
      });
      expect(
        (
          await fixture.app.inject({
            method: "GET",
            url: `/api/push/projects/${project.id}/summary`,
            headers: { cookie },
          })
        ).json(),
      ).toMatchObject({ suppressNotification: true });

      const missingConfigCsrf = await fixture.app.inject({
        method: "PATCH",
        url: "/api/push/config",
        headers: { origin, cookie },
        payload: { inactivityDelayMinutes: 5 },
      });
      expect(missingConfigCsrf.statusCode).toBe(403);
      const forgedConfigOrigin = await fixture.app.inject({
        method: "PATCH",
        url: "/api/push/config",
        headers: {
          origin: "http://attacker.invalid",
          cookie,
          "x-csrf-token": csrfToken,
        },
        payload: { inactivityDelayMinutes: 5 },
      });
      expect(forgedConfigOrigin.statusCode).toBe(403);
      const invalidConfiguration = await fixture.app.inject({
        method: "PATCH",
        url: "/api/push/config",
        headers: unsafeHeaders,
        payload: { inactivityDelayMinutes: 0 },
      });
      expect(invalidConfiguration.statusCode).toBe(400);
      const updatedConfiguration = await fixture.app.inject({
        method: "PATCH",
        url: "/api/push/config",
        headers: unsafeHeaders,
        payload: { inactivityDelayMinutes: 5 },
      });
      expect(updatedConfiguration.json()).toEqual({
        configured: true,
        publicKey: Buffer.alloc(65, 1).toString("base64url"),
        inactivityDelayMinutes: 5,
      });

      const missingCsrf = await fixture.app.inject({
        method: "POST",
        url: "/api/push/subscriptions",
        headers: { origin, cookie },
        payload: pushSubscriptionPayload(),
      });
      expect(missingCsrf.statusCode).toBe(403);
      const forgedOrigin = await fixture.app.inject({
        method: "POST",
        url: "/api/push/subscriptions",
        headers: {
          origin: "http://attacker.invalid",
          cookie,
          "x-csrf-token": csrfToken,
        },
        payload: pushSubscriptionPayload(),
      });
      expect(forgedOrigin.statusCode).toBe(403);
      const invalidEndpoint = await fixture.app.inject({
        method: "POST",
        url: "/api/push/subscriptions",
        headers: unsafeHeaders,
        payload: { ...pushSubscriptionPayload(), endpoint: "http://push.example.test/device" },
      });
      expect(invalidEndpoint.statusCode).toBe(400);

      const registered = await fixture.app.inject({
        method: "POST",
        url: "/api/push/subscriptions",
        headers: unsafeHeaders,
        payload: pushSubscriptionPayload(),
      });
      expect(registered.statusCode).toBe(201);
      const registeredBody = registered.json<NaruPushSubscription>();
      const subscriptionId = registeredBody.id;
      expect(registeredBody).toMatchObject({
        id: subscriptionId,
        name: "Windows PWA",
      });
      expect(registeredBody.endpointFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(registeredBody).not.toHaveProperty("endpoint");
      expect(registeredBody).not.toHaveProperty("p256dh");
      expect(registeredBody).not.toHaveProperty("auth");

      const listed = await fixture.app.inject({
        method: "GET",
        url: "/api/push/subscriptions",
        headers: { cookie },
      });
      expect(listed.json()).toEqual([expect.objectContaining({ id: subscriptionId })]);
      const renamed = await fixture.app.inject({
        method: "PATCH",
        url: `/api/push/subscriptions/${subscriptionId}`,
        headers: unsafeHeaders,
        payload: { name: "Galaxy PWA" },
      });
      expect(renamed.json()).toMatchObject({ name: "Galaxy PWA" });
      expect(
        (
          await fixture.app.inject({
            method: "DELETE",
            url: `/api/push/subscriptions/${subscriptionId}`,
            headers: unsafeHeaders,
          })
        ).statusCode,
      ).toBe(204);
      const missing = await fixture.app.inject({
        method: "DELETE",
        url: `/api/push/subscriptions/${subscriptionId}`,
        headers: unsafeHeaders,
      });
      expect(missing).toMatchObject({ statusCode: 404 });
      expect(missing.json()).toMatchObject({ code: "PUSH_SUBSCRIPTION_MISSING" });
    } finally {
      await fixture.app.close();
    }

    const unconfigured = await createFixture();
    try {
      const login = await unconfigured.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { password: "naru-test-password" },
      });
      const cookie = firstHeader(login.headers["set-cookie"])?.split(";")[0] ?? "";
      const csrfToken = login.json<{ csrfToken: string }>().csrfToken;
      const response = await unconfigured.app.inject({
        method: "POST",
        url: "/api/push/subscriptions",
        headers: { origin, cookie, "x-csrf-token": csrfToken },
        payload: pushSubscriptionPayload(),
      });
      expect(response).toMatchObject({ statusCode: 503 });
      expect(response.json()).toMatchObject({ code: "PUSH_NOT_CONFIGURED" });
    } finally {
      await unconfigured.app.close();
    }
  });

  it("creates, saves, and closes nested Panes with optimistic Workspace versions", async () => {
    const fixture = await createFixture();
    try {
      const login = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { password: "naru-test-password" },
      });
      const cookie = firstHeader(login.headers["set-cookie"])?.split(";")[0] ?? "";
      const csrfToken = login.json<{ csrfToken: string }>().csrfToken;
      const { headers: unsafeHeaders } = await openControllerSurface(
        fixture.app,
        cookie,
        csrfToken,
      );
      const createdProject = await fixture.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: unsafeHeaders,
        payload: { path: fixture.projectPath },
      });
      const projectId = createdProject.json<{ id: string }>().id;
      const initial = await fixture.app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/workspace`,
        headers: { cookie },
      });
      const initialWorkspace = initial.json<{
        version: number;
        activePaneId: string;
        layout: unknown;
        panes: Array<{ id: string; kind: string }>;
      }>();
      expect(initialWorkspace).toMatchObject({ version: 0 });
      expect(initialWorkspace.panes.map((pane) => pane.kind)).toEqual([
        "codex",
        "codex",
        "terminal",
      ]);

      const split = await fixture.app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/panes`,
        headers: unsafeHeaders,
        payload: {
          kind: "terminal",
          workspaceVersion: initialWorkspace.version,
          targetPaneId: initialWorkspace.activePaneId,
          direction: "vertical",
        },
      });
      expect(split.statusCode).toBe(201);
      const splitWorkspace = split.json<{
        version: number;
        activePaneId: string;
        layout: unknown;
        panes: Array<{ id: string; kind: string; status: string }>;
      }>();
      expect(splitWorkspace).toMatchObject({ version: 1 });
      expect(splitWorkspace.panes).toHaveLength(4);
      const runningPane = splitWorkspace.panes.find(
        (pane) => pane.kind === "terminal" && pane.status === "running",
      );
      expect(runningPane).toBeDefined();

      const staleSave = await fixture.app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/workspace`,
        headers: unsafeHeaders,
        payload: {
          version: 0,
          layout: initialWorkspace.layout,
          activePaneId: initialWorkspace.activePaneId,
        },
      });
      expect(staleSave.statusCode).toBe(409);
      expect(staleSave.json()).toMatchObject({ code: "LAYOUT_CONFLICT" });

      const invalidSave = await fixture.app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/workspace`,
        headers: unsafeHeaders,
        payload: {
          version: splitWorkspace.version,
          layout: { type: "pane", paneId: splitWorkspace.activePaneId },
          activePaneId: splitWorkspace.activePaneId,
        },
      });
      expect(invalidSave.statusCode).toBe(400);
      expect(invalidSave.json()).toMatchObject({ code: "REQUEST_INVALID" });

      const saved = await fixture.app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/workspace`,
        headers: unsafeHeaders,
        payload: {
          version: splitWorkspace.version,
          layout: splitWorkspace.layout,
          activePaneId: initialWorkspace.activePaneId,
        },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({
        version: 2,
        activePaneId: initialWorkspace.activePaneId,
      });

      const staleClose = await fixture.app.inject({
        method: "DELETE",
        url: `/api/panes/${runningPane?.id ?? "missing"}`,
        headers: unsafeHeaders,
        payload: { workspaceVersion: 1 },
      });
      expect(staleClose.statusCode).toBe(409);
      expect(staleClose.json()).toMatchObject({ code: "LAYOUT_CONFLICT" });

      const closed = await fixture.app.inject({
        method: "DELETE",
        url: `/api/panes/${runningPane?.id ?? "missing"}`,
        headers: unsafeHeaders,
        payload: { workspaceVersion: 2 },
      });
      expect(closed.statusCode).toBe(200);
      expect(closed.json()).toMatchObject({ version: 3 });
      expect(closed.json<{ panes: unknown[] }>().panes).toHaveLength(3);
    } finally {
      await fixture.app.close();
    }
  });

  it("serves bounded project documents and persists independent Docs and Tasks Panes", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.projectPath, "docs"));
    await writeFile(
      join(fixture.projectPath, "docs", "SPEC.md"),
      "# Product specification\n\nA concise product summary.\n\n## Behavior\n\nRead only.\n",
    );
    await writeFile(
      join(fixture.projectPath, "docs", "TASKS.md"),
      "# Work\n\n## T15. Document panes\n\n- [-] **범위**: Build Docs and Tasks.\n",
    );
    await writeFile(
      join(fixture.projectPath, "TASKS.md"),
      "# Root work\n\n## T01. Root task\n\n- [ ] **범위**: Root candidate.\n",
    );

    try {
      const login = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { password: "naru-test-password" },
      });
      const cookie = firstHeader(login.headers["set-cookie"])?.split(";")[0] ?? "";
      const csrfToken = login.json<{ csrfToken: string }>().csrfToken;
      const { headers: unsafeHeaders } = await openControllerSurface(
        fixture.app,
        cookie,
        csrfToken,
      );
      const created = await fixture.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: unsafeHeaders,
        payload: { path: fixture.projectPath },
      });
      const projectId = created.json<{ id: string }>().id;
      const initial = fixture.repository.getWorkspace(projectId);
      if (!initial.activePaneId) throw new Error("default active Pane is missing");

      const unauthorized = await fixture.app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/docs`,
      });
      expect(unauthorized.statusCode).toBe(401);

      const docs = await fixture.app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/docs`,
        headers: { cookie },
      });
      expect(docs.statusCode).toBe(200);
      expect(docs.json()).toMatchObject({
        status: "ready",
        documents: [
          { path: "docs/SPEC.md", kind: "markdown", title: "Product specification" },
          { path: "docs/TASKS.md", kind: "tasks", title: "Work" },
        ],
      });

      const tasks = await fixture.app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/tasks`,
        headers: { cookie },
      });
      expect(tasks.json()).toMatchObject({
        status: "ready",
        documents: [{ path: "TASKS.md" }, { path: "docs/TASKS.md" }],
      });
      const taskContent = await fixture.app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/document?path=${encodeURIComponent("docs/TASKS.md")}`,
        headers: { cookie },
      });
      expect(taskContent.json()).toMatchObject({
        kind: "tasks",
        tasks: {
          inProgress: [expect.objectContaining({ id: "T15", status: "in_progress" })],
        },
      });

      const firstDocsResponse = await fixture.app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/panes`,
        headers: unsafeHeaders,
        payload: {
          kind: "docs",
          selectedDocumentPath: "docs/SPEC.md",
          workspaceVersion: initial.version,
          targetPaneId: initial.activePaneId,
          direction: "horizontal",
        },
      });
      expect(firstDocsResponse.statusCode).toBe(201);
      const firstWorkspace = firstDocsResponse.json<{
        version: number;
        panes: Array<{
          id: string;
          kind: string;
          status: string;
          viewState: { selectedDocumentPath: string | null; navigationOpen: boolean };
        }>;
      }>();
      const firstDocs = firstWorkspace.panes.find((pane) => pane.kind === "docs");
      expect(firstDocs).toMatchObject({
        status: "ready",
        viewState: { selectedDocumentPath: "docs/SPEC.md", navigationOpen: true },
      });

      const secondDocsResponse = await fixture.app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/panes`,
        headers: unsafeHeaders,
        payload: {
          kind: "docs",
          selectedDocumentPath: "docs/SPEC.md",
          workspaceVersion: firstWorkspace.version,
          targetPaneId: firstDocs?.id,
          direction: "vertical",
        },
      });
      const secondWorkspace = secondDocsResponse.json<{
        version: number;
        panes: Array<{ id: string; kind: string }>;
      }>();
      expect(secondWorkspace.panes.filter((pane) => pane.kind === "docs")).toHaveLength(2);

      const tasksPaneResponse = await fixture.app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/panes`,
        headers: unsafeHeaders,
        payload: {
          kind: "tasks",
          selectedDocumentPath: "TASKS.md",
          workspaceVersion: secondWorkspace.version,
          targetPaneId: firstDocs?.id,
          direction: "horizontal",
        },
      });
      expect(tasksPaneResponse.statusCode).toBe(201);
      expect(fixture.launches).toHaveLength(2);

      const updated = await fixture.app.inject({
        method: "PATCH",
        url: `/api/panes/${firstDocs?.id ?? "missing"}/view-state`,
        headers: unsafeHeaders,
        payload: { selectedDocumentPath: "docs/TASKS.md", navigationOpen: false },
      });
      expect(updated.json()).toMatchObject({
        viewState: { selectedDocumentPath: "docs/TASKS.md", navigationOpen: false },
      });
      const persistedDocs = fixture.repository
        .getWorkspace(projectId)
        .panes.filter((pane) => pane.kind === "docs");
      expect(persistedDocs.map((pane) => pane.viewState.selectedDocumentPath)).toEqual([
        "docs/TASKS.md",
        "docs/SPEC.md",
      ]);

      const restart = await fixture.app.inject({
        method: "POST",
        url: `/api/panes/${firstDocs?.id ?? "missing"}/restart`,
        headers: unsafeHeaders,
      });
      expect(restart.statusCode).toBe(400);
      expect(restart.json()).toMatchObject({ code: "REQUEST_INVALID" });

      const wrongDocsRoot = await fixture.app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/panes`,
        headers: unsafeHeaders,
        payload: {
          kind: "docs",
          selectedDocumentPath: "TASKS.md",
          workspaceVersion: tasksPaneResponse.json<{ version: number }>().version,
          targetPaneId: firstDocs?.id,
          direction: "horizontal",
        },
      });
      expect(wrongDocsRoot.statusCode).toBe(403);
      expect(wrongDocsRoot.json()).toMatchObject({ code: "DOCS_OUTSIDE_ROOT" });
    } finally {
      await fixture.app.close();
    }
  });

  it("serves Files Panes with guarded saves and memory-only drafts", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.projectPath, "src"));
    await writeFile(join(fixture.projectPath, "src", "app.ts"), "const value = 'base';\n");
    await writeFile(join(fixture.projectPath, ".env"), "TOKEN=fake\n");

    try {
      const login = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { password: "naru-test-password" },
      });
      const cookie = firstHeader(login.headers["set-cookie"])?.split(";")[0] ?? "";
      const csrfToken = login.json<{ csrfToken: string }>().csrfToken;
      const { headers: unsafeHeaders } = await openControllerSurface(
        fixture.app,
        cookie,
        csrfToken,
      );
      const created = await fixture.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: unsafeHeaders,
        payload: { path: fixture.projectPath },
      });
      const projectId = created.json<{ id: string }>().id;
      const initial = fixture.repository.getWorkspace(projectId);

      const unauthorized = await fixture.app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/files?path=`,
      });
      expect(unauthorized.statusCode).toBe(401);

      const listing = await fixture.app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/files?path=`,
        headers: { cookie },
      });
      expect(listing.statusCode).toBe(200);
      const listingBody = listing.json<{
        path: string;
        entries: Array<{ path: string; kind: string; sensitive: boolean }>;
      }>();
      expect(listingBody.path).toBe("");
      expect(listingBody.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "src", kind: "directory" }),
          expect.objectContaining({ path: ".env", sensitive: true }),
        ]),
      );

      const paneResponse = await fixture.app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/panes`,
        headers: unsafeHeaders,
        payload: {
          kind: "files",
          selectedDocumentPath: "src/app.ts",
          workspaceVersion: initial.version,
          targetPaneId: initial.activePaneId,
          direction: "horizontal",
        },
      });
      expect(paneResponse.statusCode).toBe(201);
      const filesPane = paneResponse
        .json<{
          panes: Array<{ id: string; kind: string; status: string; launchProfile: string }>;
        }>()
        .panes.find((pane) => pane.kind === "files");
      expect(filesPane).toMatchObject({ status: "ready", launchProfile: "files-editor" });
      const codexPane = initial.panes.find(
        (candidate) => candidate.kind === "codex" && candidate.status === "running",
      );
      expect(codexPane).toBeDefined();

      const content = await fixture.app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/file?path=${encodeURIComponent("src/app.ts")}&allowSensitive=false`,
        headers: { cookie },
      });
      const base = content.json<{ revision: string; source: string }>();
      expect(base.source).toBe("const value = 'base';\n");

      const sensitiveBlocked = await fixture.app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/file?path=${encodeURIComponent(".env")}&allowSensitive=false`,
        headers: { cookie },
      });
      expect(sensitiveBlocked.statusCode).toBe(409);
      expect(sensitiveBlocked.json()).toMatchObject({
        code: "FILE_SENSITIVE_CONFIRMATION_REQUIRED",
      });

      const draft = await fixture.app.inject({
        method: "PUT",
        url: `/api/panes/${filesPane?.id ?? "missing"}/file-draft`,
        headers: unsafeHeaders,
        payload: {
          path: "src/app.ts",
          baseRevision: base.revision,
          draftSource: "const value = 'mine';\n",
          allowSensitive: false,
        },
      });
      expect(draft.statusCode).toBe(200);
      expect(draft.json()).toMatchObject({
        baseSource: "const value = 'base';\n",
        draftSource: "const value = 'mine';\n",
      });

      await writeFile(join(fixture.projectPath, "src", "app.ts"), "const value = 'theirs';\n");
      const currentContent = await fixture.app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/file?path=${encodeURIComponent("src/app.ts")}&allowSensitive=false`,
        headers: { cookie },
      });
      const current = currentContent.json<{ revision: string; source: string }>();
      const updatedDraft = await fixture.app.inject({
        method: "PUT",
        url: `/api/panes/${filesPane?.id ?? "missing"}/file-draft`,
        headers: unsafeHeaders,
        payload: {
          path: "src/app.ts",
          baseRevision: base.revision,
          draftSource: "const value = 'mine again';\n",
          allowSensitive: false,
          assistantMerge: {
            paneId: codexPane?.id,
            initialActivityEventId: codexPane?.activity.eventId,
            currentRevision: current.revision,
          },
        },
      });
      expect(updatedDraft.statusCode).toBe(200);
      expect(updatedDraft.json()).toMatchObject({
        assistantMerge: {
          paneId: codexPane?.id,
          initialActivityEventId: codexPane?.activity.eventId,
          current: { source: "const value = 'theirs';\n", revision: current.revision },
        },
      });

      const conflictedSave = await fixture.app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/file`,
        headers: unsafeHeaders,
        payload: {
          path: "src/app.ts",
          source: "const value = 'mine again';\n",
          expectedRevision: base.revision,
          allowSensitive: false,
        },
      });
      expect(conflictedSave.statusCode).toBe(409);
      expect(conflictedSave.json()).toMatchObject({ code: "FILE_CONFLICT" });
      expect(await readFile(join(fixture.projectPath, "src", "app.ts"), "utf8")).toBe(
        "const value = 'theirs';\n",
      );

      const restoredDraft = await fixture.app.inject({
        method: "GET",
        url: `/api/panes/${filesPane?.id ?? "missing"}/file-draft`,
        headers: { cookie },
      });
      expect(restoredDraft.json()).toMatchObject({
        draftSource: "const value = 'mine again';\n",
        assistantMerge: { paneId: codexPane?.id, current: { revision: current.revision } },
      });

      const removedDraft = await fixture.app.inject({
        method: "DELETE",
        url: `/api/panes/${filesPane?.id ?? "missing"}/file-draft`,
        headers: unsafeHeaders,
      });
      expect(removedDraft.statusCode).toBe(204);
      const missingDraft = await fixture.app.inject({
        method: "GET",
        url: `/api/panes/${filesPane?.id ?? "missing"}/file-draft`,
        headers: { cookie },
      });
      expect(missingDraft.statusCode).toBe(204);
    } finally {
      await fixture.app.close();
    }
  });

  it("starts a fresh Codex from an exited Pane without reusing saved resume metadata", async () => {
    const fixture = await createFixture();
    try {
      const login = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { password: "naru-test-password" },
      });
      const cookie = firstHeader(login.headers["set-cookie"])?.split(";")[0] ?? "";
      const csrfToken = login.json<{ csrfToken: string }>().csrfToken;
      const { headers: unsafeHeaders } = await openControllerSurface(
        fixture.app,
        cookie,
        csrfToken,
      );
      const created = await fixture.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: unsafeHeaders,
        payload: { path: fixture.projectPath },
      });
      const workspace = fixture.repository.getWorkspace(created.json<{ id: string }>().id);
      const codexPane = workspace.panes.find((pane) => pane.kind === "codex");
      const terminalPane = workspace.panes.find((pane) => pane.kind === "terminal");
      if (!codexPane || !terminalPane) throw new Error("default Panes are missing");

      const running = await fixture.app.inject({
        method: "POST",
        url: `/api/panes/${codexPane.id}/new-codex`,
        headers: unsafeHeaders,
      });
      expect(running.statusCode).toBe(409);

      fixture.supervisor.stop(codexPane.id);
      await vi.waitFor(() => {
        expect(fixture.repository.getPaneContext(codexPane.id)?.pane).toMatchObject({
          status: "stopped",
          activity: { state: "server-stopped" },
        });
      });
      const stoppedActivity = fixture.repository.getPaneContext(codexPane.id)?.pane.activity;
      if (!stoppedActivity) throw new Error("stopped activity is missing");
      fixture.repository.setCodexSession(
        codexPane.id,
        "33333333-3333-4333-8333-333333333333",
        true,
      );

      const fresh = await fixture.app.inject({
        method: "POST",
        url: `/api/panes/${codexPane.id}/new-codex`,
        headers: unsafeHeaders,
      });
      expect(fresh.statusCode).toBe(200);
      expect(fresh.json()).toMatchObject({
        status: "running",
        codexSessionId: null,
        codexSessionResumable: false,
        activity: {
          state: "idle",
          revision: stoppedActivity.revision + 1,
        },
      });
      expect(fresh.json<Pane>().activity.runtimeId).not.toBe(stoppedActivity.runtimeId);
      expect(fixture.launches).toHaveLength(3);

      const wrongKind = await fixture.app.inject({
        method: "POST",
        url: `/api/panes/${terminalPane.id}/new-codex`,
        headers: unsafeHeaders,
      });
      expect(wrongKind.statusCode).toBe(400);
    } finally {
      await fixture.app.close();
    }
  });

  it("starts a new Claude conversation by forgetting the stored resume target", async () => {
    const fixture = await createFixture();
    try {
      const login = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { password: "naru-test-password" },
      });
      const cookie = firstHeader(login.headers["set-cookie"])?.split(";")[0] ?? "";
      const csrfToken = login.json<{ csrfToken: string }>().csrfToken;
      const { headers: unsafeHeaders } = await openControllerSurface(
        fixture.app,
        cookie,
        csrfToken,
      );
      const created = await fixture.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: unsafeHeaders,
        payload: { path: fixture.projectPath },
      });
      const projectId = created.json<{ id: string }>().id;
      const workspace = fixture.repository.getWorkspace(projectId);
      const terminalPane = workspace.panes.find((pane) => pane.kind === "terminal");
      if (!terminalPane) throw new Error("default terminal Pane is missing");
      const claudePane = fixture.repository.createPane(projectId, {
        kind: "claude",
        workspaceVersion: workspace.version,
        targetPaneId: terminalPane.id,
        direction: "horizontal",
      });
      const conversation = "33333333-3333-4333-8333-333333333333";
      fixture.repository.beginPaneRuntime(claudePane.id, "44444444-4444-4444-8444-444444444444");
      expect(
        fixture.repository.setClaudeSessionForRuntime(
          claudePane.id,
          "44444444-4444-4444-8444-444444444444",
          conversation,
        ),
      ).toBe(true);
      const listed = await fixture.app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/workspace`,
        headers: { cookie },
      });
      expect(
        listed.json<{ panes: Pane[] }>().panes.find((pane) => pane.id === claudePane.id),
      ).toMatchObject({ claudeSessionId: conversation });

      const fresh = await fixture.app.inject({
        method: "POST",
        url: `/api/panes/${claudePane.id}/new-claude`,
        headers: unsafeHeaders,
      });
      expect(fresh.statusCode).toBe(200);
      expect(fresh.json()).toMatchObject({ status: "running", claudeSessionId: null });

      const wrongKind = await fixture.app.inject({
        method: "POST",
        url: `/api/panes/${terminalPane.id}/new-claude`,
        headers: unsafeHeaders,
      });
      expect(wrongKind.statusCode).toBe(400);
    } finally {
      await fixture.app.close();
    }
  });

  it("keeps a Project usable while exposing a specific Codex availability failure", async () => {
    const launchProfiles: PaneLaunchResolver = {
      resolve(context) {
        if (context.pane.kind === "codex") {
          throw new AppError(
            "CODEX_AUTH_REQUIRED",
            503,
            "Codex 인증이 필요합니다. Mac mini에서 codex login을 완료해 주세요.",
          );
        }
        return {
          file: "/bin/zsh",
          args: ["-l"],
          environment: { TERM: "xterm-256color" },
        };
      },
    };
    const fixture = await createFixture({ launchProfiles });
    try {
      const login = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { password: "naru-test-password" },
      });
      const cookie = firstHeader(login.headers["set-cookie"])?.split(";")[0] ?? "";
      const csrfToken = login.json<{ csrfToken: string }>().csrfToken;
      const { headers: unsafeHeaders } = await openControllerSurface(
        fixture.app,
        cookie,
        csrfToken,
      );
      const created = await fixture.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: unsafeHeaders,
        payload: { path: fixture.projectPath },
      });

      expect(created.statusCode).toBe(201);
      const projectId = created.json<{ id: string }>().id;
      const workspace = await fixture.app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/workspace`,
        headers: { cookie },
      });
      const failedPanes = workspace
        .json<{
          panes: Array<{ id: string; kind: string; status: string; lastErrorCode: string }>;
        }>()
        .panes.filter((pane) => pane.kind === "codex");
      expect(failedPanes).toHaveLength(2);
      expect(failedPanes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "error", lastErrorCode: "CODEX_AUTH_REQUIRED" }),
        ]),
      );

      const restart = await fixture.app.inject({
        method: "POST",
        url: `/api/panes/${failedPanes[0]?.id ?? "missing"}/restart`,
        headers: unsafeHeaders,
      });
      expect(restart.statusCode).toBe(503);
      expect(restart.json()).toMatchObject({ code: "CODEX_AUTH_REQUIRED" });
      expect(JSON.stringify(restart.json())).not.toMatch(/token|password|secret/i);
    } finally {
      await fixture.app.close();
    }
  });

  it("keeps conflicting browsers as observers until an explicit fenced takeover", async () => {
    const clientPresence = new ClientPresenceRegistry();
    const fixture = await createFixture({ clientPresence });
    await fixture.app.ready();
    try {
      await expect(fixture.app.injectWS("/api/terminal", { headers: { origin } })).rejects.toThrow(
        "Unexpected server response: 401",
      );

      const login = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { password: "naru-test-password" },
      });
      const setCookie = login.headers["set-cookie"];
      const serializedCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      const cookie = serializedCookie?.split(";")[0] ?? "";
      const csrfToken = login.json<{ csrfToken: string }>().csrfToken;

      await expect(
        fixture.app.injectWS("/api/terminal", {
          headers: { cookie, origin: "http://attacker.invalid" },
        }),
      ).rejects.toThrow("Unexpected server response: 403");

      const first = await fixture.app.injectWS("/api/terminal", {
        headers: { cookie, origin },
      });
      const firstOpened = nextSocketFrames(first, 2);
      first.send(
        JSON.stringify({
          type: "lease.acquire",
          clientId: "11111111-1111-4111-8111-111111111111",
        }),
      );
      const firstFrames = await within(firstOpened, "first surface did not open");
      expect(firstFrames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "lease.granted",
            generation: 1,
            replacedClient: false,
            acquisition: "initial",
          }),
          expect.objectContaining({
            type: "surface.state",
            generation: 1,
            role: "controller",
            controllerPresent: true,
          }),
        ]),
      );
      const firstSurface = requireSurfaceState(firstFrames);

      const second = await fixture.app.injectWS("/api/terminal", {
        headers: { cookie, origin },
      });
      try {
        let firstClosed = false;
        first.once("close", () => {
          firstClosed = true;
        });
        const secondOpened = nextSocketFrames(second, 2);
        second.send(
          JSON.stringify({
            type: "lease.acquire",
            clientId: "22222222-2222-4222-8222-222222222222",
          }),
        );
        const secondFrames = await within(secondOpened, "observer surface did not open");
        expect(secondFrames).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "lease.granted",
              generation: 1,
              replacedClient: false,
            }),
            expect.objectContaining({
              type: "surface.state",
              generation: 1,
              role: "observer",
              reason: "conflict",
            }),
          ]),
        );
        const secondSurface = requireSurfaceState(secondFrames);
        expect(firstClosed).toBe(false);

        const created = await fixture.app.inject({
          method: "POST",
          url: "/api/projects",
          headers: surfaceRequestHeaders(cookie, csrfToken, firstSurface),
          payload: { path: fixture.projectPath },
        });
        expect(created.statusCode).toBe(201);
        const projectId = created.json<{ id: string }>().id;
        const attachedPane = fixture.repository
          .getWorkspace(projectId)
          .panes.find((pane) => pane.kind === "codex");
        if (attachedPane === undefined) throw new Error("Fixture runtime Pane is missing.");

        const firstAttached = nextSocketFrames(first, 2);
        first.send(
          JSON.stringify({
            type: "pane.attach",
            paneId: attachedPane.id,
            leaseGeneration: 1,
            cols: 120,
            rows: 40,
          }),
        );
        const firstAttachmentFrames = await within(firstAttached, "controller Pane did not attach");
        expect(firstAttachmentFrames).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "pane.snapshot",
              paneId: attachedPane.id,
              cols: 120,
              rows: 40,
            }),
            expect.objectContaining({
              type: "pane.control.state",
              paneId: attachedPane.id,
              role: "controller",
              terminal: { cols: 120, rows: 40 },
            }),
          ]),
        );

        const secondAttached = nextSocketFrames(second, 2);
        second.send(
          JSON.stringify({
            type: "pane.attach",
            paneId: attachedPane.id,
            leaseGeneration: 1,
            cols: 52,
            rows: 18,
          }),
        );
        const observerAttachmentFrames = await within(
          secondAttached,
          "observer Pane did not attach",
        );
        expect(observerAttachmentFrames).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "pane.snapshot",
              paneId: attachedPane.id,
              cols: 120,
              rows: 40,
            }),
            expect.objectContaining({
              type: "pane.control.state",
              paneId: attachedPane.id,
              role: "observer",
              terminal: { cols: 120, rows: 40 },
            }),
          ]),
        );

        const observerMutation = await fixture.app.inject({
          method: "DELETE",
          url: `/api/projects/${projectId}`,
          headers: surfaceRequestHeaders(cookie, csrfToken, secondSurface),
        });
        expect(observerMutation.statusCode).toBe(409);
        expect(observerMutation.json()).toMatchObject({ code: "LEASE_REQUIRED" });

        const heartbeatAck = nextSocketFrame(second);
        second.send(
          JSON.stringify({
            type: "heartbeat",
            leaseGeneration: 1,
            sentAt: 122,
            presence: { visible: true, focused: true, interactionRevision: 1 },
          }),
        );
        await expect(heartbeatAck).resolves.toEqual({ type: "heartbeat.ack", sentAt: 122 });
        expect(clientPresence.hasRecentlyActiveClient(2)).toBe(true);

        const observerInput = nextSocketFrame(second);
        second.send(
          JSON.stringify({
            type: "terminal.input",
            paneId: attachedPane.id,
            leaseGeneration: 1,
            data: "whoami\r",
          }),
        );
        await expect(
          within(observerInput, "observer input was not rejected"),
        ).resolves.toMatchObject({
          type: "protocol.error",
          code: "LEASE_REQUIRED",
        });

        const firstDemoted = nextSocketFrames(first, 2);
        const secondPromoted = nextSocketFrames(second, 2);
        second.send(JSON.stringify({ type: "surface.takeover", leaseGeneration: 1, target: null }));
        const firstDemotedFrames = await within(firstDemoted, "first surface was not demoted");
        const firstDemotedState = firstDemotedFrames.find(
          (frame) => frame.type === "surface.state",
        );
        if (firstDemotedState === undefined) throw new Error("First surface state is missing.");
        expect(firstDemotedState).toMatchObject({
          type: "surface.state",
          generation: 2,
          role: "observer",
          reason: "preempted",
        });
        expect(firstDemotedFrames).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "pane.control.state",
              paneId: attachedPane.id,
              role: "observer",
              terminal: { cols: 52, rows: 18 },
            }),
          ]),
        );
        const secondPromotedFrames = await within(
          secondPromoted,
          "second surface was not promoted",
        );
        const secondPromotedState = secondPromotedFrames.find(
          (frame) => frame.type === "surface.state",
        );
        if (secondPromotedState === undefined) throw new Error("Second surface state is missing.");
        expect(secondPromotedState).toMatchObject({
          type: "surface.state",
          generation: 2,
          role: "controller",
          reason: "preempted",
        });
        expect(secondPromotedFrames).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "pane.control.state",
              paneId: attachedPane.id,
              role: "controller",
              terminal: { cols: 52, rows: 18 },
            }),
          ]),
        );

        const staleInput = nextSocketFrame(second);
        second.send(
          JSON.stringify({
            type: "terminal.input",
            paneId: attachedPane.id,
            leaseGeneration: 1,
            data: "whoami\r",
          }),
        );
        await expect(within(staleInput, "stale input was not rejected")).resolves.toMatchObject({
          type: "protocol.error",
          code: "LEASE_REQUIRED",
        });

        const demotedInput = nextSocketFrame(first);
        first.send(
          JSON.stringify({
            type: "terminal.input",
            paneId: attachedPane.id,
            leaseGeneration: 2,
            data: "stale writer\r",
          }),
        );
        await expect(within(demotedInput, "demoted input was not rejected")).resolves.toMatchObject(
          {
            type: "protocol.error",
            code: "LEASE_REQUIRED",
          },
        );

        const demotedMutation = await fixture.app.inject({
          method: "DELETE",
          url: `/api/projects/${projectId}`,
          headers: surfaceRequestHeaders(cookie, csrfToken, firstDemotedState),
        });
        expect(demotedMutation.statusCode).toBe(409);
        const promotedMutation = await fixture.app.inject({
          method: "DELETE",
          url: `/api/projects/${projectId}`,
          headers: surfaceRequestHeaders(cookie, csrfToken, secondPromotedState),
        });
        expect(promotedMutation.statusCode).toBe(204);

        const absentAck = nextSocketFrame(second);
        second.send(
          JSON.stringify({
            type: "heartbeat",
            leaseGeneration: 2,
            sentAt: 124,
            presence: { visible: false, focused: false, interactionRevision: 1 },
          }),
        );
        await expect(absentAck).resolves.toEqual({ type: "heartbeat.ack", sentAt: 124 });
        expect(clientPresence.hasRecentlyActiveClient(2)).toBe(false);

        const available = nextSocketFrames(first, 2);
        second.terminate();
        const availableFrames = await within(available, "surface availability was not published");
        expect(availableFrames.find((frame) => frame.type === "surface.state")).toMatchObject({
          type: "surface.state",
          generation: 3,
          role: "observer",
          controllerPresent: false,
          reason: "released",
        });

        const reacquired = nextSocketFrame(first);
        first.send(
          JSON.stringify({
            type: "surface.acquire",
            leaseGeneration: 3,
          }),
        );
        const reacquiredState = await within(reacquired, "available surface was not acquired");
        expect(reacquiredState).toMatchObject({
          type: "surface.state",
          generation: 4,
          role: "controller",
          reason: "acquired",
        });
      } finally {
        first.terminate();
        second.terminate();
      }
    } finally {
      await fixture.app.close();
    }
  });

  it("broadcasts acknowledged activity and restores the aggregate through REST", async () => {
    const fixture = await createFixture();
    await fixture.app.ready();
    try {
      const login = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { password: "naru-test-password" },
      });
      const cookie = firstHeader(login.headers["set-cookie"])?.split(";")[0] ?? "";
      const csrfToken = login.json<{ csrfToken: string }>().csrfToken;
      const controller = await openControllerSurface(fixture.app, cookie, csrfToken);
      const unsafeHeaders = controller.headers;
      const created = await fixture.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: unsafeHeaders,
        payload: { path: fixture.projectPath },
      });
      const projectId = created.json<{ id: string }>().id;
      const pane = fixture.repository
        .getWorkspace(projectId)
        .panes.find((candidate) => candidate.kind === "codex");
      if (!pane) throw new Error("default Codex Pane is missing");
      const completed = fixture.repository.setPaneActivity(pane.id, "completed");
      if (!completed) throw new Error("completed activity event is missing");

      const socket = controller.socket;
      try {
        const changed = nextSocketFrame(socket);
        const staleAcknowledgement = await fixture.app.inject({
          method: "POST",
          url: `/api/panes/${pane.id}/activity/acknowledge`,
          headers: unsafeHeaders,
          payload: { eventId: "22222222-2222-4222-8222-222222222222" },
        });
        expect(staleAcknowledgement.statusCode).toBe(200);
        expect(staleAcknowledgement.json()).toMatchObject({
          activity: { state: "completed", eventId: completed.eventId },
        });

        const acknowledged = await fixture.app.inject({
          method: "POST",
          url: `/api/panes/${pane.id}/activity/acknowledge`,
          headers: unsafeHeaders,
          payload: { eventId: completed.eventId },
        });
        expect(acknowledged.statusCode).toBe(200);
        expect(acknowledged.json()).toMatchObject({ activity: { state: "idle" } });
        await expect(changed).resolves.toMatchObject({
          type: "activity.changed",
          projectId,
          paneId: pane.id,
          activity: {
            state: "idle",
            runtimeId: completed.runtimeId,
            revision: completed.activity.revision + 1,
          },
          projectActivity: { state: "idle", interactionRequiredCount: 0 },
        });

        const projects = await fixture.app.inject({
          method: "GET",
          url: "/api/projects",
          headers: { cookie },
        });
        const projectList = projects.json<Array<{ id: string; activity: { state: string } }>>();
        expect(projectList.find((project) => project.id === projectId)?.activity.state).toBe(
          "idle",
        );
      } finally {
        socket.terminate();
      }
    } finally {
      await fixture.app.close();
    }
  });

  it("broadcasts Codex identity identification and transition clearing to active Web clients", async () => {
    const hooks = new AppTestCodexHookBridge();
    const fixture = await createFixture({ codexSessionHooks: hooks });
    await fixture.app.ready();
    try {
      const login = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { password: "naru-test-password" },
      });
      const cookie = firstHeader(login.headers["set-cookie"])?.split(";")[0] ?? "";
      const csrfToken = login.json<{ csrfToken: string }>().csrfToken;
      const controller = await openControllerSurface(fixture.app, cookie, csrfToken);
      try {
        const created = await fixture.app.inject({
          method: "POST",
          url: "/api/projects",
          headers: controller.headers,
          payload: { path: fixture.projectPath },
        });
        const projectId = created.json<{ id: string }>().id;
        const quick = fixture.repository
          .getWorkspace(projectId)
          .panes.find((pane) => pane.launchProfile === "codex-quick");
        if (!quick) throw new Error("Quick Codex Pane is missing");
        const sessionId = "77777777-7777-4777-8777-777777777777";

        const identified = nextSocketFrame(controller.socket);
        hooks.emit(quick.id, {
          type: "session-start",
          sessionId,
          cwd: fixture.projectPath,
          source: "startup",
        });
        await expect(identified).resolves.toMatchObject({
          type: "codex.session.changed",
          paneId: quick.id,
          runtimeId: quick.activity.runtimeId,
          session: { id: sessionId, resumable: true },
        });

        const observer = await fixture.app.injectWS("/api/terminal", {
          headers: { cookie, origin },
        });
        try {
          const replayed = nextSocketFrameMatching(
            observer,
            (frame) => frame.type === "codex.session.changed" && frame.paneId === quick.id,
          );
          observer.send(
            JSON.stringify({
              type: "lease.acquire",
              clientId: "88888888-8888-4888-8888-888888888888",
            }),
          );
          await expect(replayed).resolves.toMatchObject({
            type: "codex.session.changed",
            paneId: quick.id,
            runtimeId: quick.activity.runtimeId,
            session: { id: sessionId, resumable: true },
          });

          const cleared = nextSocketFrame(controller.socket);
          fixture.supervisor.write(quick.id, "/resume selected-thread\r");
          await expect(cleared).resolves.toMatchObject({
            type: "codex.session.changed",
            paneId: quick.id,
            runtimeId: quick.activity.runtimeId,
            session: { id: null, resumable: false },
          });
        } finally {
          observer.terminate();
        }
      } finally {
        controller.socket.terminate();
      }
    } finally {
      await fixture.app.close();
    }
  });

  it("rejects oversized HTTP and WebSocket payloads without degrading liveness", async () => {
    const fixture = await createFixture();
    await fixture.app.ready();
    try {
      const oversizedHttp = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { password: "x".repeat(129 * 1024) },
      });
      expect(oversizedHttp.statusCode).toBe(413);
      expect(oversizedHttp.json()).toMatchObject({ code: "REQUEST_INVALID" });

      const login = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { password: "naru-test-password" },
      });
      const cookie = firstHeader(login.headers["set-cookie"])?.split(";")[0] ?? "";
      const socket = await fixture.app.injectWS("/api/terminal", { headers: { cookie, origin } });
      try {
        const granted = nextSocketFrame(socket);
        socket.send(
          JSON.stringify({
            type: "lease.acquire",
            clientId: "11111111-1111-4111-8111-111111111111",
          }),
        );
        await expect(granted).resolves.toMatchObject({ type: "lease.granted" });

        const invalidInput = nextSocketFrame(socket);
        socket.send(
          JSON.stringify({
            type: "terminal.input",
            paneId: "33333333-3333-4333-8333-333333333333",
            leaseGeneration: 1,
            data: "x".repeat(65_537),
          }),
        );
        await expect(invalidInput).resolves.toMatchObject({
          type: "protocol.error",
          code: "REQUEST_INVALID",
        });

        const closed = new Promise<number>((resolve) => {
          socket.once("close", (code) => resolve(code));
        });
        socket.send("x".repeat(129 * 1024));
        await expect(closed).resolves.toBe(1009);
      } finally {
        socket.terminate();
      }

      const health = await fixture.app.inject({ method: "GET", url: "/healthz" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ status: "ok" });
    } finally {
      await fixture.app.close();
    }
  });

  it("streams a bounded PNG to the Mac clipboard before invoking Codex image paste", async () => {
    const writePng = vi.fn((image: Uint8Array) => {
      void image;
      return Promise.resolve();
    });
    const fixture = await createFixture({ clipboardImageWriter: { writePng } });
    try {
      const login = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { password: "naru-test-password" },
      });
      const cookie = firstHeader(login.headers["set-cookie"])?.split(";")[0] ?? "";
      const csrfToken = login.json<{ csrfToken: string }>().csrfToken;
      const controller = await openControllerSurface(fixture.app, cookie, csrfToken);
      const created = await fixture.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: controller.headers,
        payload: { path: fixture.projectPath },
      });
      const projectId = created.json<{ id: string }>().id;
      const workspace = fixture.repository.getWorkspace(projectId);
      const codexPane = workspace.panes.find((pane) => pane.kind === "codex");
      const terminalPane = workspace.panes.find((pane) => pane.kind === "terminal");
      if (!codexPane || !terminalPane) throw new Error("default Panes are missing");
      const write = vi.spyOn(fixture.supervisor, "write");
      const socket = controller.socket;
      try {
        const snapshot = nextSocketFrame(socket);
        socket.send(
          JSON.stringify({
            type: "pane.attach",
            paneId: codexPane.id,
            leaseGeneration: controller.generation,
            cols: 100,
            rows: 30,
          }),
        );
        await expect(snapshot).resolves.toMatchObject({
          type: "pane.snapshot",
          paneId: codexPane.id,
        });

        const image = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        );
        const requestId = "44444444-4444-4444-8444-444444444444";
        socket.send(
          JSON.stringify({
            type: "clipboard.image.begin",
            requestId,
            paneId: codexPane.id,
            leaseGeneration: 1,
            byteLength: image.byteLength,
          }),
        );
        socket.send(
          JSON.stringify({
            type: "clipboard.image.chunk",
            requestId,
            paneId: codexPane.id,
            leaseGeneration: 1,
            offset: 0,
            data: image.toString("base64"),
          }),
        );
        const attached = nextSocketFrame(socket);
        socket.send(
          JSON.stringify({
            type: "clipboard.image.commit",
            requestId,
            paneId: codexPane.id,
            leaseGeneration: 1,
          }),
        );
        await expect(attached).resolves.toMatchObject({
          type: "clipboard.image.result",
          requestId,
          paneId: codexPane.id,
          status: "attached",
        });
        expect(writePng).toHaveBeenCalledOnce();
        expect(writePng.mock.calls[0]?.[0]).toEqual(image);
        expect(write).toHaveBeenCalledWith(
          codexPane.id,
          "\u0016",
          expect.stringContaining(codexPane.id),
        );

        const rejected = nextSocketFrame(socket);
        socket.send(
          JSON.stringify({
            type: "clipboard.image.begin",
            requestId: "55555555-5555-4555-8555-555555555555",
            paneId: terminalPane.id,
            leaseGeneration: 1,
            byteLength: image.byteLength,
          }),
        );
        await expect(rejected).resolves.toMatchObject({
          type: "clipboard.image.result",
          paneId: terminalPane.id,
          status: "error",
          code: "REQUEST_INVALID",
        });

        const invalidImage = Buffer.alloc(33);
        const invalidRequestId = "66666666-6666-4666-8666-666666666666";
        socket.send(
          JSON.stringify({
            type: "clipboard.image.begin",
            requestId: invalidRequestId,
            paneId: codexPane.id,
            leaseGeneration: 1,
            byteLength: invalidImage.byteLength,
          }),
        );
        socket.send(
          JSON.stringify({
            type: "clipboard.image.chunk",
            requestId: invalidRequestId,
            paneId: codexPane.id,
            leaseGeneration: 1,
            offset: 0,
            data: invalidImage.toString("base64"),
          }),
        );
        const invalidResult = nextSocketFrame(socket);
        socket.send(
          JSON.stringify({
            type: "clipboard.image.commit",
            requestId: invalidRequestId,
            paneId: codexPane.id,
            leaseGeneration: 1,
          }),
        );
        await expect(invalidResult).resolves.toMatchObject({
          type: "clipboard.image.result",
          paneId: codexPane.id,
          status: "error",
          code: "REQUEST_INVALID",
        });
        expect(writePng).toHaveBeenCalledOnce();
      } finally {
        socket.terminate();
      }
    } finally {
      await fixture.app.close();
    }
  });

  it("rejects disallowed socket client addresses and ignores forwarded IP headers", async () => {
    const fixture = await createFixture({
      configPatch: { allowedClientIps: new Set(["10.23.45.42"]) },
    });
    try {
      const allowed = await fixture.app.inject({
        method: "GET",
        url: "/healthz",
        remoteAddress: "::ffff:10.23.45.42",
      });
      expect(allowed.statusCode).toBe(200);

      const denied = await fixture.app.inject({
        method: "GET",
        url: "/healthz",
        remoteAddress: "10.23.45.99",
        headers: { "x-forwarded-for": "10.23.45.42" },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ code: "ORIGIN_INVALID" });
    } finally {
      await fixture.app.close();
    }
  });

  it("keeps structured API errors when the production static app is enabled", async () => {
    const webDist = await mkdtemp(join(tmpdir(), "naru-static-"));
    temporaryDirectories.push(webDist);
    await writeFile(join(webDist, "index.html"), "<!doctype html><title>Legacy root Naru</title>");
    const fixture = await createFixture({ configPatch: { webDist } });
    try {
      const response = await fixture.app.inject({ method: "GET", url: "/api/session" });
      expect(response.statusCode).toBe(401);
      const payload = response.json<{ code: string; message: string; requestId: string }>();
      expect(payload).toMatchObject({
        code: "AUTH_REQUIRED",
        message: "로그인이 필요합니다.",
      });
      expect(payload.requestId).toMatch(/^req-/);
    } finally {
      await fixture.app.close();
    }
  });

  it("serves PWA metadata with update-safe cache headers", async () => {
    const webDist = await mkdtemp(join(tmpdir(), "naru-static-pwa-"));
    temporaryDirectories.push(webDist);
    await mkdir(join(webDist, "assets"));
    await writeFile(
      join(webDist, "index.html"),
      '<!doctype html><meta name="naru-app-base-path" content="/naru" /><title>Naru</title>',
    );
    await writeFile(join(webDist, "manifest.webmanifest"), '{"name":"Naru"}');
    await writeFile(join(webDist, "sw.js"), "self.addEventListener('fetch', () => {});");
    await writeFile(join(webDist, "assets", "index-12345678.js"), "export {};");
    const fixture = await createFixture({ configPatch: { webDist, appBasePath: "/naru" } });
    try {
      const worker = await fixture.app.inject({ method: "GET", url: "/sw.js" });
      expect(worker.statusCode).toBe(200);
      expect(worker.headers["cache-control"]).toBe("no-cache, no-store, must-revalidate");
      expect(worker.headers["service-worker-allowed"]).toBe("/naru/");

      const manifest = await fixture.app.inject({
        method: "GET",
        url: "/manifest.webmanifest",
      });
      expect(manifest.statusCode).toBe(200);
      expect(manifest.headers["cache-control"]).toBe("no-cache");

      const asset = await fixture.app.inject({
        method: "GET",
        url: "/assets/index-12345678.js",
      });
      expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

      const missingAsset = await fixture.app.inject({
        method: "GET",
        url: "/assets/missing-12345678.js",
      });
      expect(missingAsset.statusCode).toBe(404);
      expect(missingAsset.headers["content-type"]).toContain("application/json");
      expect(missingAsset.json()).toMatchObject({ code: "REQUEST_INVALID" });
    } finally {
      await fixture.app.close();
    }
  });

  it("sets and clears Secure cookies at an HTTPS boundary", async () => {
    const httpsOrigin = "https://naru.internal";
    const fixture = await createFixture({ origin: httpsOrigin, secureCookie: true });
    try {
      const login = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: httpsOrigin },
        payload: { password: "naru-test-password" },
      });
      const setCookie = firstHeader(login.headers["set-cookie"]);
      const cookie = setCookie?.split(";")[0] ?? "";
      const csrfToken = login.json<{ csrfToken: string }>().csrfToken;

      expect(setCookie).toMatch(/;\s*Secure(?:;|$)/);
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Strict");

      const logout = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: { origin: httpsOrigin, cookie, "x-csrf-token": csrfToken },
      });
      const clearedCookie = firstHeader(logout.headers["set-cookie"]);
      expect(clearedCookie).toMatch(/;\s*Secure(?:;|$)/);
      expect(clearedCookie).toContain("HttpOnly");
      expect(clearedCookie).toContain("SameSite=Strict");
    } finally {
      await fixture.app.close();
    }
  });

  it("returns a stable rate-limit error after repeated login failures", async () => {
    const fixture = await createFixture({ loginRateLimiter: new LoginRateLimiter(2, 60_000) });
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fixture.app.inject({
          method: "POST",
          url: "/api/auth/login",
          headers: { origin },
          payload: { password: "wrong-password" },
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({ code: "AUTH_INVALID" });
      }

      const limited = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { password: "wrong-password" },
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ code: "AUTH_RATE_LIMITED" });
    } finally {
      await fixture.app.close();
    }
  });

  it("expires one configured cookie without invalidating the other environment session", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const development = await createFixture({
      sessions: new SessionStore("naru-development-session-secret-that-is-long-enough", 100, 100),
      configPatch: { sessionCookieName: "naru_dev_session" },
    });
    const production = await createFixture({
      sessions: new SessionStore(
        "naru-production-session-secret-that-is-long-enough",
        1_000,
        1_000,
      ),
      configPatch: { sessionCookieName: "naru_session" },
    });
    try {
      const developmentLogin = await development.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { password: "naru-test-password" },
      });
      const productionLogin = await production.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { password: "naru-test-password" },
      });
      const developmentCookie =
        firstHeader(developmentLogin.headers["set-cookie"])?.split(";")[0] ?? "";
      const productionCookie =
        firstHeader(productionLogin.headers["set-cookie"])?.split(";")[0] ?? "";
      const sharedBrowserCookieHeader = `${developmentCookie}; ${productionCookie}`;

      expect(developmentCookie).toMatch(/^naru_dev_session=/);
      expect(productionCookie).toMatch(/^naru_session=/);
      expect(
        (
          await development.app.inject({
            method: "GET",
            url: "/api/session",
            headers: { cookie: sharedBrowserCookieHeader },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await production.app.inject({
            method: "GET",
            url: "/api/session",
            headers: { cookie: sharedBrowserCookieHeader },
          })
        ).statusCode,
      ).toBe(200);

      now.mockReturnValue(1_101);
      expect(
        (
          await development.app.inject({
            method: "GET",
            url: "/api/session",
            headers: { cookie: sharedBrowserCookieHeader },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await production.app.inject({
            method: "GET",
            url: "/api/session",
            headers: { cookie: sharedBrowserCookieHeader },
          })
        ).statusCode,
      ).toBe(200);
      await expect(
        development.app.injectWS("/api/terminal", {
          headers: { cookie: sharedBrowserCookieHeader, origin },
        }),
      ).rejects.toThrow("Unexpected server response: 401");
      const productionSocket = await production.app.injectWS("/api/terminal", {
        headers: { cookie: sharedBrowserCookieHeader, origin },
      });
      productionSocket.terminate();
    } finally {
      now.mockRestore();
      await Promise.all([development.app.close(), production.app.close()]);
    }
  });

  it("revokes an established WebSocket and rejects upgrades after session expiry", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const sessions = new SessionStore("naru-test-session-secret-that-is-long-enough", 100, 100);
    const fixture = await createFixture({ sessions });
    await fixture.app.ready();
    try {
      const login = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { password: "naru-test-password" },
      });
      const cookie = firstHeader(login.headers["set-cookie"])?.split(";")[0] ?? "";
      const socket = await fixture.app.injectWS("/api/terminal", { headers: { cookie, origin } });

      now.mockReturnValue(1_101);
      const revoked = nextSocketFrame(socket);
      socket.send(
        JSON.stringify({
          type: "lease.acquire",
          clientId: "11111111-1111-4111-8111-111111111111",
        }),
      );
      await expect(revoked).resolves.toMatchObject({
        type: "lease.revoked",
        reason: "expired",
      });
      socket.terminate();

      await expect(
        fixture.app.injectWS("/api/terminal", { headers: { cookie, origin } }),
      ).rejects.toThrow("Unexpected server response: 401");
    } finally {
      now.mockRestore();
      await fixture.app.close();
    }
  });
});

interface FixtureOptions {
  origin?: string;
  secureCookie?: boolean;
  sessions?: SessionStore;
  loginRateLimiter?: LoginRateLimiter;
  launchProfiles?: PaneLaunchResolver;
  observability?: Observability;
  clipboardImageWriter?: ClipboardImageWriter;
  passkeys?: PasskeyService;
  clientPresence?: ClientPresenceRegistry;
  codexSessionHooks?: CodexSessionHookBridge;
  configPatch?: Partial<AppManagedConfig>;
}

interface LaunchRecord {
  file: string;
  args: string[];
  cwd: string;
}

async function createFixture(options: FixtureOptions = {}): Promise<{
  app: Awaited<ReturnType<typeof buildApp>>;
  projectRoot: string;
  projectPath: string;
  sentinelPath: string;
  launches: LaunchRecord[];
  repository: NaruRepository;
  supervisor: PtySupervisor;
}> {
  const base = await mkdtemp(join(tmpdir(), "naru-api-"));
  temporaryDirectories.push(base);
  const root = join(base, "coding");
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  const sentinelPath = join(project, "keep.txt");
  await writeFile(sentinelPath, "keep me");
  const realRoot = await realpath(root);
  const projectPath = await realpath(project);
  const passwordHash = await hashPassword("naru-test-password", {
    N: 1024,
    salt: Buffer.alloc(16, 4),
  });
  const config: AppConfig = {
    authMode: "app-managed",
    environment: "test",
    host: "127.0.0.1",
    port: 4174,
    allowedOrigins: new Set([options.origin ?? origin]),
    projectRoots: [realRoot],
    passwordHash,
    sessionSecret: "naru-test-session-secret-that-is-long-enough",
    sessionCookieName: "naru_test_session",
    appBasePath: "/",
    dataDir: base,
    secureCookie: options.secureCookie ?? false,
    sessionRuntime: { owner: "legacy" },
    ...options.configPatch,
  };
  const repository = new NaruRepository(":memory:");
  const pathPolicy = await ProjectPathPolicy.create([realRoot]);
  const launches: LaunchRecord[] = [];
  const launchProfiles: PaneLaunchResolver = options.launchProfiles ?? {
    resolve(context) {
      return context.pane.kind === "codex"
        ? {
            file: "/test/bin/codex",
            args: ["--profile-id", context.pane.launchProfile],
            environment: { TERM: "xterm-256color" },
          }
        : {
            file: "/bin/zsh",
            args: ["-l"],
            environment: { TERM: "xterm-256color" },
          };
    },
  };
  const supervisor = new PtySupervisor(
    repository,
    (file, args, spawnOptions) => {
      launches.push({ file, args, cwd: spawnOptions.cwd });
      return new NoopPty();
    },
    launchProfiles,
    options.codexSessionHooks,
  );
  const app = await buildApp(config, {
    repository,
    pathPolicy,
    supervisor,
    ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
    ...(options.loginRateLimiter === undefined
      ? {}
      : { loginRateLimiter: options.loginRateLimiter }),
    ...(options.observability === undefined ? {} : { observability: options.observability }),
    ...(options.clipboardImageWriter === undefined
      ? {}
      : { clipboardImageWriter: options.clipboardImageWriter }),
    ...(options.passkeys === undefined ? {} : { passkeys: options.passkeys }),
    ...(options.clientPresence === undefined ? {} : { clientPresence: options.clientPresence }),
  });
  return {
    app,
    projectRoot: realRoot,
    projectPath,
    sentinelPath,
    launches,
    repository,
    supervisor,
  };
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync("/usr/bin/git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

function pushSubscriptionPayload() {
  return {
    name: "Windows PWA",
    endpoint: "https://push.example.test/device",
    expirationTime: null,
    keys: {
      p256dh: Buffer.alloc(65, 3).toString("base64url"),
      auth: Buffer.alloc(16, 4).toString("base64url"),
    },
  };
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

class AppTestCodexHookBridge implements CodexSessionHookBridge {
  readonly #registrations = new Map<
    string,
    { onEvent: (event: CodexHookEvent) => void; disposed: boolean }
  >();

  register(options: {
    paneId: string;
    runtimeId: string;
    cwd: string;
    onEvent: (event: CodexHookEvent) => void;
  }): CodexSessionHookRegistration {
    const registration = { onEvent: options.onEvent, disposed: false };
    this.#registrations.set(options.paneId, registration);
    return {
      environment: {
        NARU_CODEX_HOOK_PANE_ID: options.paneId,
        NARU_CODEX_HOOK_RUNTIME_ID: options.runtimeId,
        NARU_CODEX_HOOK_SOCKET: "/tmp/naru-app-test-hook.sock",
        NARU_CODEX_HOOK_TOKEN: "app-test-runtime-capability",
      },
      dispose: () => {
        registration.disposed = true;
      },
    };
  }

  emit(paneId: string, event: CodexHookEvent): void {
    const registration = this.#registrations.get(paneId);
    if (!registration || registration.disposed)
      throw new Error("Codex hook registration is missing");
    registration.onEvent(event);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

interface TestSocket {
  send(data: string): void;
  terminate(): void;
  once(event: "message", listener: (data: { toString(): string }) => void): void;
  on(event: "message", listener: (data: { toString(): string }) => void): void;
  off(event: "message", listener: (data: { toString(): string }) => void): void;
}

function nextSocketFrame(socket: TestSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.once("message", (data) => {
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
  });
}

function nextSocketFrameMatching(
  socket: TestSocket,
  matches: (frame: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const listener = (data: { toString(): string }): void => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      if (!matches(frame)) return;
      socket.off("message", listener);
      resolve(frame);
    };
    socket.on("message", listener);
  });
}

async function openControllerSurface(
  app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  csrfToken: string,
  requestOrigin = origin,
): Promise<{ headers: Record<string, string>; socket: TestSocket; generation: number }> {
  const socket = await app.injectWS("/api/terminal", {
    headers: { cookie, origin: requestOrigin },
  });
  const frames = nextSocketFrames(socket, 2);
  socket.send(
    JSON.stringify({
      type: "lease.acquire",
      clientId: "11111111-1111-4111-8111-111111111111",
    }),
  );
  const state = (await frames).find((frame) => frame.type === "surface.state");
  if (
    state === undefined ||
    typeof state.connectionId !== "string" ||
    typeof state.generation !== "number"
  ) {
    throw new Error("Controller surface state was not received.");
  }
  return {
    headers: {
      origin: requestOrigin,
      cookie,
      "x-csrf-token": csrfToken,
      [NARU_SURFACE_CONNECTION_HEADER]: state.connectionId,
      [NARU_SURFACE_GENERATION_HEADER]: String(state.generation),
    },
    socket,
    generation: state.generation,
  };
}

function nextSocketFrames(socket: TestSocket, count: number): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    const frames: Record<string, unknown>[] = [];
    const listener = (data: { toString(): string }): void => {
      frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
      if (frames.length < count) return;
      socket.off("message", listener);
      resolve(frames);
    };
    socket.on("message", listener);
  });
}

function requireSurfaceState(frames: readonly Record<string, unknown>[]): {
  connectionId: string;
  generation: number;
} {
  const state = frames.find((frame) => frame.type === "surface.state");
  if (
    state === undefined ||
    typeof state.connectionId !== "string" ||
    typeof state.generation !== "number"
  ) {
    throw new Error("Surface state frame is missing.");
  }
  return { connectionId: state.connectionId, generation: state.generation };
}

function surfaceRequestHeaders(
  cookie: string,
  csrfToken: string,
  state: { connectionId?: unknown; generation?: unknown },
): Record<string, string> {
  if (typeof state.connectionId !== "string" || typeof state.generation !== "number") {
    throw new Error("Surface state identity is invalid.");
  }
  return {
    origin,
    cookie,
    "x-csrf-token": csrfToken,
    [NARU_SURFACE_CONNECTION_HEADER]: state.connectionId,
    [NARU_SURFACE_GENERATION_HEADER]: String(state.generation),
  };
}

function within<T>(promise: Promise<T>, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), 1_000);
      timer.unref();
    }),
  ]);
}
