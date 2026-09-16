import { afterEach, describe, expect, it, vi } from "vitest";
import { NaruApi } from "./api";
import { PUBLIC_PWA_BUILD_FIXTURE_ORIGIN } from "./public-build-config";

describe("NaruApi authentication expiry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears the client session and notifies listeners for protected AUTH_REQUIRED responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(401, {
        code: "AUTH_REQUIRED",
        message: "로그인이 필요합니다.",
        requestId: "request-auth-required",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new NaruApi();
    const listener = vi.fn();
    api.onAuthenticationRequired(listener);

    await expect(api.projects()).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      status: 401,
    });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("does not treat invalid login credentials as an expired authenticated session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(401, {
          code: "AUTH_INVALID",
          message: "비밀번호를 확인해 주세요.",
          requestId: "request-auth-invalid",
        }),
      ),
    );
    const api = new NaruApi();
    const listener = vi.fn();
    api.onAuthenticationRequired(listener);

    await expect(api.login("incorrect-password")).rejects.toMatchObject({
      code: "AUTH_INVALID",
      status: 401,
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it("normalizes a Gateway authentication envelope into the app login boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(401, {
          version: 1,
          ok: false,
          error: {
            code: "AUTHENTICATION_REQUIRED",
            message: "Gateway authentication is required.",
          },
          requestId: "request-gateway-auth-required",
        }),
      ),
    );
    const api = new NaruApi();
    const listener = vi.fn();
    api.onAuthenticationRequired(listener);

    await expect(api.session()).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      status: 401,
      requestId: "request-gateway-auth-required",
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(api.authMode()).toBe("gateway-managed");
  });

  it("retains an advertised terminal restore capability only for the current session", () => {
    const api = new NaruApi();
    api.setSession({
      authenticated: true,
      authMode: "app-managed",
      csrfToken: "restore-csrf",
      expiresAt: "2026-08-21T00:00:00.000Z",
      projectRoots: ["/srv/workstation/projects"],
      capabilities: { terminalRestore: "staged-v1" },
    });
    expect(api.terminalRestoreProtocol()).toBe("staged-v1");
    expect(api.projectRoots()).toEqual(["/srv/workstation/projects"]);
    api.clearSession();
    expect(api.terminalRestoreProtocol()).toBeUndefined();
    expect(api.projectRoots()).toEqual([]);
  });

  it("uses protected project-group refresh, rename, and explicit target connection endpoints", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, []))
      .mockResolvedValueOnce(jsonResponse(200, []))
      .mockResolvedValueOnce(jsonResponse(200, []))
      .mockResolvedValueOnce(jsonResponse(201, {}));
    vi.stubGlobal("fetch", fetchMock);
    const api = new NaruApi();
    api.setSession({
      authenticated: true,
      authMode: "app-managed",
      csrfToken: "project-group-csrf",
      expiresAt: "2026-08-21T00:00:00.000Z",
      projectRoots: ["/srv/workstation/projects"],
    });
    api.setControlSurface({
      connectionId: "11111111-1111-4111-8111-111111111111",
      generation: 4,
    });

    await api.projectGroups();
    await api.refreshProjectGroups();
    await api.renameProjectGroup("group-id", "Editor");
    await api.connectProjectTarget("group-id", "/coding/editor-feature");

    expect(request(fetchMock, 0)).toMatchObject({ path: "/api/project-groups", method: "GET" });
    expect(request(fetchMock, 1)).toMatchObject({
      path: "/api/project-groups/refresh",
      method: "POST",
      csrf: "project-group-csrf",
    });
    expect(request(fetchMock, 2)).toMatchObject({
      path: "/api/project-groups/group-id",
      method: "PATCH",
      csrf: "project-group-csrf",
      surfaceConnection: undefined,
      surfaceGeneration: undefined,
      body: JSON.stringify({ name: "Editor" }),
    });
    expect(request(fetchMock, 3)).toMatchObject({
      path: "/api/project-groups/group-id/targets",
      method: "POST",
      csrf: "project-group-csrf",
      surfaceConnection: "11111111-1111-4111-8111-111111111111",
      surfaceGeneration: "4",
      body: JSON.stringify({ path: "/coding/editor-feature" }),
    });
  });

  it("blocks lifecycle mutations locally without a control surface", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, []));
    vi.stubGlobal("fetch", fetchMock);
    const api = new NaruApi();
    api.setSession({
      authenticated: true,
      authMode: "app-managed",
      csrfToken: "observer-csrf",
      expiresAt: "2026-08-21T00:00:00.000Z",
      projectRoots: ["/srv/workstation/projects"],
    });

    await expect(api.createProject("/coding/observer")).rejects.toMatchObject({
      code: "LEASE_REQUIRED",
      status: 409,
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await api.renameProjectGroup("group-id", "Observer-safe label");
    expect(request(fetchMock, 0)).toMatchObject({
      path: "/api/project-groups/group-id",
      method: "PATCH",
      csrf: "observer-csrf",
      surfaceConnection: undefined,
      surfaceGeneration: undefined,
    });
  });

  it("uses only the namespaced Gateway CSRF for gateway-managed mutation and logout", async () => {
    stubPwaOrigin(PUBLIC_PWA_BUILD_FIXTURE_ORIGIN, "/naru");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          authenticated: true,
          authMode: "gateway-managed",
          projectRoots: ["/srv/workstation/projects"],
          capabilities: { terminalRestore: "staged-v1" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          csrfToken: "gateway-csrf",
          session: { browserOrigin: PUBLIC_PWA_BUILD_FIXTURE_ORIGIN },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, []))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new NaruApi();

    await api.session();
    await api.refreshProjectGroups();
    await api.logout();

    expect(request(fetchMock, 0)).toMatchObject({ path: "/naru/api/session", method: "GET" });
    expect(request(fetchMock, 1)).toMatchObject({ path: "/_gateway/session", method: "GET" });
    expect(request(fetchMock, 2)).toMatchObject({
      path: "/naru/api/project-groups/refresh",
      method: "POST",
      gatewayCsrf: "gateway-csrf",
    });
    expect(request(fetchMock, 2).csrf).toBeUndefined();
    expect(request(fetchMock, 3)).toMatchObject({
      path: "/_gateway/logout",
      method: "POST",
      gatewayCsrf: "gateway-csrf",
      body: JSON.stringify({}),
    });
  });

  it("rejects a Gateway session whose Origin drifts from rendered PWA metadata", async () => {
    stubPwaOrigin("https://custom.tailnet.ts.net");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          authenticated: true,
          authMode: "gateway-managed",
          projectRoots: ["/srv/workstation/projects"],
          capabilities: { terminalRestore: "staged-v1" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          csrfToken: "gateway-csrf",
          session: { browserOrigin: PUBLIC_PWA_BUILD_FIXTURE_ORIGIN },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(new NaruApi().session()).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      status: 502,
    });
  });
});

function request(fetchMock: ReturnType<typeof vi.fn>, index: number) {
  const call = fetchMock.mock.calls[index];
  if (!call) throw new Error(`Missing fetch call ${index}.`);
  const [path, init] = call as [string, RequestInit];
  const headers = new Headers(init.headers);
  return {
    path,
    method: init.method ?? "GET",
    csrf: headers.get("x-csrf-token") ?? undefined,
    gatewayCsrf: headers.get("x-workstation-gateway-csrf") ?? undefined,
    surfaceConnection: headers.get("x-naru-surface-connection") ?? undefined,
    surfaceGeneration: headers.get("x-naru-surface-generation") ?? undefined,
    body: init.body,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubPwaOrigin(origin: string, appBasePath = "/"): void {
  vi.stubGlobal("window", { location: { origin } });
  vi.stubGlobal("document", {
    querySelectorAll: (selector: string) => {
      const content = selector.includes("naru-app-base-path") ? appBasePath : origin;
      return [
        {
          getAttribute: (name: string) => (name === "content" ? content : null),
        },
      ];
    },
  });
}
