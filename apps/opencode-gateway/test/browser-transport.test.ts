import { describe, expect, it, vi } from "vitest";
import {
  createGatewayFetch,
  createPrefixedFetch,
  loadGatewayProjectRoots,
  gatewayProjectScope,
  gatewayProjectContains,
  gatewayProjectFolders,
} from "../src/browser-transport.js";

const origin = "https://naru.example.test";
describe("OpenCode Gateway browser transport", () => {
  it("searches approved roots by folder name or full path without browsing the OS root", async () => {
    await loadGatewayProjectRoots(
      () =>
        Promise.resolve(
          Response.json({
            version: 1,
            defaultDirectory: "/fixture/projects/repo",
            roots: ["/fixture/projects", "/other/approved"],
          }),
        ),
      `${origin}/omo/api/_naru/project-roots`,
    );
    expect(gatewayProjectFolders()).toEqual([
      "/fixture/projects/repo",
      "/fixture/projects",
      "/other/approved",
    ]);
    expect(gatewayProjectFolders("repo")).toEqual(["/fixture/projects/repo"]);
    expect(gatewayProjectScope("repo", "/fixture")).toEqual({
      directory: "/fixture/projects",
      path: "repo",
    });
    expect(gatewayProjectScope("/fixture/projects/repo/", "/fixture")).toEqual({
      directory: "/fixture/projects",
      path: "repo",
    });
    expect(gatewayProjectScope("~/projects/repo", "/fixture")).toEqual({
      directory: "/fixture/projects",
      path: "repo",
    });
    expect(gatewayProjectScope("/other/approved/repo", "/fixture")).toEqual({
      directory: "/other/approved",
      path: "repo",
    });
    for (const path of [
      "/",
      "/fixture",
      "/fixture/projects-evil/repo",
      "/fixture/projects/../../secret",
    ])
      expect(gatewayProjectScope(path, "/fixture")).toBeUndefined();
    expect(gatewayProjectContains("/fixture/projects/repo")).toBe(true);
    expect(gatewayProjectContains("/fixture/projects/../secret")).toBe(false);
  });

  it("fails closed when approved folder metadata is malformed or denied", async () => {
    await expect(
      loadGatewayProjectRoots(
        () =>
          Promise.resolve(
            Response.json({
              version: 1,
              defaultDirectory: "/outside",
              roots: ["/fixture/projects"],
            }),
          ),
        `${origin}/omo/api/_naru/project-roots`,
      ),
    ).rejects.toThrow();
    expect(gatewayProjectFolders()).toEqual([]);
    await expect(
      loadGatewayProjectRoots(
        () => Promise.resolve(new Response(null, { status: 401 })),
        `${origin}/omo/api/_naru/project-roots`,
      ),
    ).rejects.toThrow();
    expect(gatewayProjectScope("repo", "/fixture")).toBeUndefined();
  });
  it("keeps absolute V2 endpoint descriptors under this app prefix", async () => {
    const paths: string[] = [];
    const fetch = createPrefixedFetch(`${origin}/omo/api`, (input) => {
      paths.push(new Request(input).url);
      return Promise.resolve(Response.json({}));
    });
    await fetch(`${origin}/api/event`);
    await fetch(`${origin}/omo/api/global/health`);
    expect(paths).toEqual([`${origin}/omo/api/api/event`, `${origin}/omo/api/global/health`]);
    expect(() => fetch("https://other.example.test/api/event")).toThrow("Origin");
  });
  it("keeps tokens in memory, adds CSRF for writes, and refuses other app/origin requests", async () => {
    const requests: Request[] = [];
    const transport = createGatewayFetch({
      origin,
      apiPrefix: "/omo/api",
      authenticationRequired: vi.fn(),
      fetch: (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Promise.resolve(
          request.url.endsWith("/_gateway/session")
            ? Response.json({ csrfToken: "fixture-csrf", session: { browserOrigin: origin } })
            : Response.json({ ok: true }),
        );
      },
    });
    await transport.fetch(`${origin}/omo/api/session`, {
      method: "POST",
      body: "fixture",
      headers: { authorization: "Basic untrusted" },
    });
    expect(requests[1]?.headers.get("x-workstation-gateway-csrf")).toBe("fixture-csrf");
    expect(requests[1]?.headers.get("authorization")).toBeNull();
    await expect(transport.fetch(`${origin}/naru/api/panes`)).rejects.toThrow();
    await expect(transport.fetch("https://other.example.test/omo/api/session")).rejects.toThrow();
  });
  it("refreshes only explicit gateway CSRF rejections, without retrying application denial", async () => {
    let sessions = 0;
    let writes = 0;
    const transport = createGatewayFetch({
      origin,
      apiPrefix: "/omo/api",
      authenticationRequired: vi.fn(),
      fetch: (input) => {
        const request = new Request(input);
        if (request.url.endsWith("/_gateway/session"))
          return Promise.resolve(
            Response.json({
              csrfToken: `fixture-${++sessions}`,
              session: { browserOrigin: origin },
            }),
          );
        writes += 1;
        return Promise.resolve(
          writes === 1
            ? Response.json({ error: { code: "CSRF_DENIED" } }, { status: 403 })
            : Response.json({ error: { code: "PROJECT_DENIED" } }, { status: 403 }),
        );
      },
    });
    expect(
      (await transport.fetch(`${origin}/omo/api/session`, { method: "POST", body: "fixture" }))
        .status,
    ).toBe(403);
    expect(sessions).toBe(2);
    expect(writes).toBe(2);
  });
  it("rejects a session from another Origin and hands expired authentication back to Gateway", async () => {
    const expired = vi.fn();
    const transport = createGatewayFetch({
      origin,
      apiPrefix: "/omo/api",
      authenticationRequired: expired,
      fetch: () => Promise.resolve(Response.json({}, { status: 401 })),
    });
    await expect(transport.connect()).rejects.toThrow();
    expect(expired).toHaveBeenCalledOnce();
    const mismatch = createGatewayFetch({
      origin,
      apiPrefix: "/omo/api",
      authenticationRequired: expired,
      fetch: () =>
        Promise.resolve(
          Response.json({
            csrfToken: "fixture",
            session: { browserOrigin: "https://other.example.test" },
          }),
        ),
    });
    await expect(mismatch.connect()).rejects.toThrow("Origin");
  });
});
