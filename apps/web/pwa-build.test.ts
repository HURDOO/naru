import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { inflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  createServiceWorkerSource,
  PWA_CACHE_PREFIX,
  PWA_PUBLIC_ASSET_PATHS,
  renderPwaBuildMetadata,
  renderPwaManifestBasePath,
  renderPwaOriginMeta,
} from "./pwa-build";

describe("PWA build artifacts", () => {
  it("generates a versioned app-shell worker without runtime data caching", () => {
    const source = createServiceWorkerSource(
      "12345678abcdef00",
      ["/index.html", "/assets/index-12345678.js", ...PWA_PUBLIC_ASSET_PATHS],
      "/naru",
    );

    expect(source).toContain(`const CACHE_PREFIX = "${PWA_CACHE_PREFIX}" + APP_BASE_PATH + ":";`);
    expect(source).toContain('const APP_BASE_PATH = "/naru";');
    expect(source).toContain('const CACHE_NAME = CACHE_PREFIX + "12345678abcdef00";');
    expect(source).toContain('request.mode === "navigate"');
    expect(source).toContain('url.pathname.startsWith(appPath("/api/"))');
    expect(source).toContain('const GATEWAY_ROUTE_PREFIX = "/_gateway";');
    expect(source).toContain("url.pathname === GATEWAY_ROUTE_PREFIX");
    expect(source).toContain('url.pathname.startsWith(GATEWAY_ROUTE_PREFIX + "/")');
    expect(source).toContain('BLOCKED_PATHS = new Set([appPath("/healthz"), appPath("/readyz")])');
    expect(source).toContain('event.data?.type === "SKIP_WAITING"');
    expect(source).not.toContain("cache.put(");
    expect(source.match(/skipWaiting\(\)/g)).toHaveLength(1);

    const fetchHarness = workerFetchHarness(source);
    expect(fetchHarness.navigate("/_gateway")).not.toHaveBeenCalled();
    expect(fetchHarness.navigate("/_gateway/login?return=%2F")).not.toHaveBeenCalled();
    expect(fetchHarness.navigate("/naru/api/session")).not.toHaveBeenCalled();
    expect(fetchHarness.navigate("/")).not.toHaveBeenCalled();
    expect(fetchHarness.navigate("/other/")).not.toHaveBeenCalled();
    expect(fetchHarness.navigate("/naru/")).toHaveBeenCalledOnce();
  });

  it("rejects unsafe or incomplete app-shell inputs", () => {
    expect(() => createServiceWorkerSource("not-a-digest", ["/index.html"])).toThrow(/revision/);
    expect(() => createServiceWorkerSource("12345678", ["/assets/app.js"])).toThrow(/index.html/);
    expect(() =>
      createServiceWorkerSource("12345678", ["/index.html", "https://other.test/x"]),
    ).toThrow(/same-origin/);
    expect(() => createServiceWorkerSource("12345678", ["/index.html"], "/_gateway/app")).toThrow(
      /canonical|reserved Gateway/,
    );
  });

  it("deletes only obsolete caches belonging to the same app base path", async () => {
    const source = createServiceWorkerSource("12345678", ["/index.html"], "/naru");
    const harness = workerActivationHarness(source, [
      "naru-app-shell:/naru:older-a",
      "naru-app-shell:/naru:older-b",
      "naru-app-shell:/other:older-a",
      "naru-app-shell:/:legacy-root",
      "naru-app-shell:/naru:12345678",
    ]);
    await harness.activate();
    expect(harness.deleted).toEqual(["naru-app-shell:/naru:older-a"]);
  });

  it("renders a configured exact HTTPS Origin into build metadata", () => {
    const source = '<meta name="naru-canonical-origin" content="https://naru.example.test:8443" />';
    expect(renderPwaOriginMeta(source, "https://naru.fixture.invalid:9443")).toContain(
      'content="https://naru.fixture.invalid:9443"',
    );
    expect(() => renderPwaOriginMeta(source, "http://127.0.0.1:4174")).toThrow(
      /exact HTTPS hostname Origin/,
    );
    const withBase = `${source}<meta name="naru-app-base-path" content="/" />`;
    expect(
      renderPwaBuildMetadata(withBase, "https://naru.fixture.invalid:9443", "/naru"),
    ).toContain('name="naru-app-base-path" content="/naru"');
  });

  it("renders source manifests for non-root and legacy root builds", () => {
    const source = readFileSync(new URL("./public/manifest.webmanifest", import.meta.url), "utf8");
    const nonRootManifest = JSON.parse(renderPwaManifestBasePath(source, "/naru")) as {
      id: string;
      start_url: string;
      scope: string;
      icons: Array<{ src: string }>;
    };
    expect(nonRootManifest).toMatchObject({
      id: "/naru/",
      start_url: "/naru/?source=pwa",
      scope: "/naru/",
    });
    expect(nonRootManifest.icons.map(({ src }) => src)).toContain("/naru/icons/naru-192.png");

    const rootManifest = JSON.parse(renderPwaManifestBasePath(source, "/")) as {
      id: string;
      start_url: string;
      scope: string;
      icons: Array<{ src: string }>;
    };
    expect(rootManifest).toMatchObject({
      id: "/",
      start_url: "/?source=pwa",
      scope: "/",
    });
    expect(rootManifest.icons.map(({ src }) => src)).toContain("/icons/naru-192.png");
  });

  it("uses server presence and project summaries while safely replacing and routing alerts", async () => {
    const payload = {
      version: 1,
      eventId: "00000000-0000-4000-8000-000000000001",
      projectId: "00000000-0000-4000-8000-000000000002",
      paneId: "00000000-0000-4000-8000-000000000003",
      runtimeId: "00000000-0000-4000-8000-000000000004",
      eventKind: "interaction-required",
    };
    const harness = workerHarness();
    const visibleClient = {
      url: "https://naru.example.test:8443/naru/",
      visibilityState: "visible",
      focus: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn(),
    };
    harness.windows.push(visibleClient);
    harness.fetcher.mockResolvedValueOnce(
      summaryResponse(payload, "interaction-required", 2, true),
    );
    await harness.dispatch("push", {
      data: { json: () => payload },
    });
    expect(harness.showNotification).not.toHaveBeenCalled();

    harness.fetcher.mockResolvedValueOnce(
      summaryResponse(payload, "interaction-required", 2, false, "editor"),
    );
    await harness.dispatch("push", {
      data: { json: () => payload },
    });
    expect(harness.showNotification).toHaveBeenCalledWith(
      "editor · 입력 필요",
      expect.objectContaining({
        badge: "/naru/icons/naru-192.png",
        body: "2개의 작업에 입력 또는 승인이 필요합니다.",
        data: payload,
        icon: "/naru/icons/naru-192.png",
        renotify: false,
        tag: `naru:project:${payload.projectId}`,
      }),
    );
    expect(harness.fetcher).toHaveBeenLastCalledWith(
      `/naru/api/push/projects/${payload.projectId}/summary`,
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );
    expect(JSON.stringify(harness.showNotification.mock.calls[0])).not.toMatch(
      /command|terminal|transcript|secret/i,
    );

    const existingNotification = {
      data: payload,
      tag: `naru:project:${payload.projectId}`,
      close: vi.fn(),
    };
    harness.notifications.push(existingNotification);
    harness.showNotification.mockClear();
    await harness.dispatch("push", { data: { json: () => payload } });
    expect(harness.showNotification).not.toHaveBeenCalled();

    const completedPayload = {
      ...payload,
      eventId: "10000000-0000-4000-8000-000000000001",
      paneId: "10000000-0000-4000-8000-000000000003",
      runtimeId: "10000000-0000-4000-8000-000000000004",
      eventKind: "completed",
    };
    harness.fetcher.mockResolvedValueOnce(
      summaryResponse(completedPayload, "completed", 1, false, "editor\nworkspace"),
    );
    await harness.dispatch("push", { data: { json: () => completedPayload } });
    expect(existingNotification.close).not.toHaveBeenCalled();
    expect(harness.showNotification).toHaveBeenCalledWith(
      "editor workspace · 작업 완료",
      expect.objectContaining({
        body: "1개의 작업이 완료되었습니다.",
        data: completedPayload,
        renotify: false,
        tag: `naru:project:${payload.projectId}`,
      }),
    );

    const failedPayload = {
      ...completedPayload,
      eventId: "20000000-0000-4000-8000-000000000001",
      eventKind: "failed",
    };
    harness.showNotification.mockClear();
    harness.fetcher.mockResolvedValueOnce(
      summaryResponse(failedPayload, "failed", 3, false, "editor"),
    );
    await harness.dispatch("push", { data: { json: () => failedPayload } });
    expect(harness.showNotification).toHaveBeenCalledWith(
      "editor · 작업 실패",
      expect.objectContaining({
        body: "3개의 작업이 실패했습니다.",
        data: failedPayload,
        renotify: false,
        tag: `naru:project:${payload.projectId}`,
      }),
    );

    harness.showNotification.mockClear();
    harness.fetcher.mockResolvedValueOnce(summaryResponse(failedPayload, "running", 0));
    await harness.dispatch("push", {
      data: {
        json: () => ({
          ...failedPayload,
          eventId: "30000000-0000-4000-8000-000000000001",
        }),
      },
    });
    expect(existingNotification.close).toHaveBeenCalledOnce();
    expect(harness.showNotification).not.toHaveBeenCalled();

    for (const state of ["canceled", "server-stopped"] as const) {
      existingNotification.close.mockClear();
      harness.fetcher.mockResolvedValueOnce(summaryResponse(failedPayload, state, 0));
      await harness.dispatch("push", {
        data: {
          json: () => ({
            ...failedPayload,
            eventId:
              state === "canceled"
                ? "40000000-0000-4000-8000-000000000001"
                : "50000000-0000-4000-8000-000000000001",
          }),
        },
      });
      expect(existingNotification.close).toHaveBeenCalledOnce();
      expect(harness.showNotification).not.toHaveBeenCalled();
    }

    await harness.dispatch("notificationclick", {
      notification: { data: payload, close: vi.fn() },
    });
    expect(visibleClient.focus).toHaveBeenCalled();
    expect(visibleClient.postMessage).toHaveBeenCalledWith({ type: "NARU_PUSH_EVENT", payload });

    harness.windows.splice(0);
    const otherAppClient = {
      url: "https://naru.example.test:8443/other/",
      visibilityState: "visible",
      focus: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn(),
    };
    harness.windows.push(otherAppClient);
    await harness.dispatch("notificationclick", {
      notification: { data: payload, close: vi.fn() },
    });
    expect(otherAppClient.focus).not.toHaveBeenCalled();
    expect(harness.openWindow).toHaveBeenCalledWith(
      "https://naru.example.test:8443/naru/?naruProject=00000000-0000-4000-8000-000000000002&naruPane=00000000-0000-4000-8000-000000000003&naruEvent=00000000-0000-4000-8000-000000000001",
    );
  });

  it("falls back to a generic one-item notification when the summary is unavailable", async () => {
    const payload = {
      version: 1,
      eventId: "40000000-0000-4000-8000-000000000001",
      projectId: "40000000-0000-4000-8000-000000000002",
      paneId: "40000000-0000-4000-8000-000000000003",
      runtimeId: "40000000-0000-4000-8000-000000000004",
      eventKind: "completed",
    };
    const harness = workerHarness();
    harness.fetcher.mockRejectedValueOnce(new Error("offline"));

    await harness.dispatch("push", { data: { json: () => payload } });

    expect(harness.showNotification).toHaveBeenCalledWith(
      "Naru · 작업 완료",
      expect.objectContaining({ body: "1개의 작업이 완료되었습니다.", data: payload }),
    );
  });

  it("uses enlarged transparent any icons and a dark safe-area maskable icon", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("./public/manifest.webmanifest", import.meta.url), "utf8"),
    ) as {
      id: string;
      start_url: string;
      scope: string;
      display: string;
      icons: Array<{ src: string; sizes: string; purpose: string }>;
    };

    expect(manifest).toMatchObject({
      id: "/naru/",
      start_url: "/naru/?source=pwa",
      scope: "/naru/",
      display: "standalone",
    });
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sizes: "192x192", purpose: "any" }),
        expect.objectContaining({ sizes: "512x512", purpose: "any" }),
        expect.objectContaining({ sizes: "512x512", purpose: "maskable" }),
      ]),
    );
    for (const icon of manifest.icons) {
      expect(icon.src).toMatch(/^\/naru\/icons\//);
      const filename = icon.src.split("/").at(-1);
      if (!filename) throw new Error("Manifest icon is missing a filename.");
      const png = readFileSync(new URL(`./public/icons/${filename}`, import.meta.url));
      expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
      expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe(icon.sizes);
      const decoded = decodePng(png);
      if (icon.purpose === "maskable") {
        expect(decoded.colorType).toBe(2);
        for (const [x, y] of iconCorners(decoded)) {
          expect(readPixel(decoded, x, y)).toEqual([13, 16, 19, 255]);
        }
        const mark = pixelBounds(
          decoded,
          ([red, green, blue]) =>
            Math.abs(red - 13) + Math.abs(green - 16) + Math.abs(blue - 19) > 24,
        );
        expect(mark.width / decoded.width).toBeGreaterThan(0.5);
        expect(mark.height / decoded.height).toBeGreaterThan(0.58);
        expect(mark.maxRadius / decoded.width).toBeLessThanOrEqual(0.4);
      } else {
        expect(decoded.colorType).toBe(6);
        for (const [x, y] of iconCorners(decoded)) {
          expect(readPixel(decoded, x, y)[3]).toBe(0);
        }
        const mark = pixelBounds(decoded, ([, , , alpha]) => alpha > 16);
        expect(mark.width / decoded.width).toBeGreaterThan(0.68);
        expect(mark.height / decoded.height).toBeGreaterThan(0.8);
      }
    }
    const indexHtml = readFileSync(new URL("./index.html", import.meta.url), "utf8");
    expect(indexHtml).toContain('rel="icon" href="./icons/naru-192.png"');
    expect(indexHtml).toContain('rel="apple-touch-icon" href="./icons/naru-maskable-512.png"');
    expect(PWA_PUBLIC_ASSET_PATHS).not.toContain("/favicon.svg");
    expect(existsSync(new URL("./public/favicon.svg", import.meta.url))).toBe(false);
    expect(existsSync(new URL("./public/icons/naru-maskable.svg", import.meta.url))).toBe(false);
  });
});

type DecodedPng = {
  width: number;
  height: number;
  colorType: 2 | 6;
  bytesPerPixel: 3 | 4;
  pixels: Buffer;
};

function decodePng(png: Buffer): DecodedPng {
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType: 2 | 6 | undefined;
  const compressed: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || (data[9] !== 2 && data[9] !== 6) || data[12] !== 0) {
        throw new Error("PWA icons must be non-interlaced 8-bit RGB or RGBA PNG files.");
      }
      colorType = data[9];
    } else if (type === "IDAT") {
      compressed.push(data);
    }
    offset += length + 12;
  }
  if (!width || !height || !colorType || compressed.length === 0) {
    throw new Error("PWA icon is missing required PNG chunks.");
  }

  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const stride = width * bytesPerPixel;
  const scanlines = inflateSync(Buffer.concat(compressed));
  const pixels = Buffer.alloc(stride * height);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = scanlines[sourceOffset++];
    if (filter === undefined || filter > 4) throw new Error("Unsupported PNG row filter.");
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bytesPerPixel ? (pixels[y * stride + x - bytesPerPixel] ?? 0) : 0;
      const up = y > 0 ? (pixels[(y - 1) * stride + x] ?? 0) : 0;
      const upperLeft =
        y > 0 && x >= bytesPerPixel ? (pixels[(y - 1) * stride + x - bytesPerPixel] ?? 0) : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : paeth(left, up, upperLeft);
      pixels[y * stride + x] = ((scanlines[sourceOffset++] ?? 0) + predictor) & 0xff;
    }
  }
  return { width, height, colorType, bytesPerPixel, pixels };
}

function paeth(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

function readPixel(decoded: DecodedPng, x: number, y: number): [number, number, number, number] {
  const offset = (y * decoded.width + x) * decoded.bytesPerPixel;
  return [
    decoded.pixels[offset] ?? 0,
    decoded.pixels[offset + 1] ?? 0,
    decoded.pixels[offset + 2] ?? 0,
    decoded.bytesPerPixel === 4 ? (decoded.pixels[offset + 3] ?? 0) : 255,
  ];
}

function iconCorners(decoded: DecodedPng): Array<[number, number]> {
  return [
    [0, 0],
    [decoded.width - 1, 0],
    [0, decoded.height - 1],
    [decoded.width - 1, decoded.height - 1],
  ];
}

function pixelBounds(
  decoded: DecodedPng,
  includes: (pixel: [number, number, number, number]) => boolean,
): { width: number; height: number; maxRadius: number } {
  let minX = decoded.width;
  let minY = decoded.height;
  let maxX = -1;
  let maxY = -1;
  let maxRadius = 0;
  const centerX = (decoded.width - 1) / 2;
  const centerY = (decoded.height - 1) / 2;
  for (let y = 0; y < decoded.height; y += 1) {
    for (let x = 0; x < decoded.width; x += 1) {
      if (!includes(readPixel(decoded, x, y))) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxRadius = Math.max(maxRadius, Math.hypot(x - centerX, y - centerY));
    }
  }
  if (maxX < minX || maxY < minY) throw new Error("PWA icon contains no visible mark pixels.");
  return { width: maxX - minX + 1, height: maxY - minY + 1, maxRadius };
}

function workerHarness() {
  type WorkerEvent = { waitUntil?: (work: Promise<unknown>) => void } & Record<string, unknown>;
  const listeners = new Map<string, (event: WorkerEvent) => void>();
  const windows: Array<{
    url: string;
    visibilityState: string;
    focus: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
  }> = [];
  const notifications: Array<{
    data: unknown;
    tag: string;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const fetcher = vi.fn().mockRejectedValue(new Error("summary unavailable"));
  const self = {
    location: { origin: "https://naru.example.test:8443" },
    addEventListener: (type: string, listener: (event: WorkerEvent) => void) =>
      listeners.set(type, listener),
    registration: {
      getNotifications: ({ tag }: { tag?: string } = {}) =>
        Promise.resolve(
          tag === undefined ? notifications : notifications.filter((item) => item.tag === tag),
        ),
      showNotification,
    },
    clients: {
      claim: vi.fn().mockResolvedValue(undefined),
      matchAll: () => Promise.resolve(windows),
      openWindow,
    },
    skipWaiting: vi.fn().mockResolvedValue(undefined),
  };
  runInNewContext(createServiceWorkerSource("12345678", ["/index.html"], "/naru"), {
    self,
    caches: {},
    URL,
    Request,
    fetch: fetcher,
  });
  return {
    windows,
    notifications,
    showNotification,
    openWindow,
    fetcher,
    async dispatch(type: string, event: WorkerEvent): Promise<void> {
      let work: Promise<unknown> | undefined;
      listeners.get(type)?.({
        ...event,
        waitUntil: (next) => {
          work = next;
        },
      });
      await work;
    },
  };
}

function workerFetchHarness(source: string) {
  type FetchEvent = {
    request: { method: string; mode: string; url: string };
    respondWith: ReturnType<typeof vi.fn>;
  };
  let fetchListener: ((event: FetchEvent) => void) | undefined;
  const cache = { match: vi.fn().mockResolvedValue(new Response("app shell")) };
  runInNewContext(source, {
    self: {
      location: { origin: "https://naru.example.test:8443" },
      addEventListener: (type: string, listener: (event: FetchEvent) => void) => {
        if (type === "fetch") fetchListener = listener;
      },
    },
    caches: { open: vi.fn().mockResolvedValue(cache) },
    URL,
    Request,
    fetch: vi.fn(),
  });
  if (fetchListener === undefined) throw new Error("Generated worker did not register fetch.");

  return {
    navigate(path: string): ReturnType<typeof vi.fn> {
      const respondWith = vi.fn();
      fetchListener?.({
        request: {
          method: "GET",
          mode: "navigate",
          url: new URL(path, "https://naru.example.test:8443").href,
        },
        respondWith,
      });
      return respondWith;
    },
  };
}

function workerActivationHarness(source: string, cacheNames: readonly string[]) {
  type ActivateEvent = { waitUntil: (work: Promise<unknown>) => void };
  let activateListener: ((event: ActivateEvent) => void) | undefined;
  const deleted: string[] = [];
  runInNewContext(source, {
    self: {
      location: { origin: "https://naru.example.test:8443" },
      addEventListener: (type: string, listener: (event: ActivateEvent) => void) => {
        if (type === "activate") activateListener = listener;
      },
      clients: { claim: vi.fn().mockResolvedValue(undefined) },
      registration: {},
    },
    caches: {
      keys: () => Promise.resolve([...cacheNames]),
      delete: (name: string) => {
        deleted.push(name);
        return Promise.resolve(true);
      },
    },
    URL,
    Request,
    fetch: vi.fn(),
  });
  return {
    deleted,
    async activate(): Promise<void> {
      let work: Promise<unknown> | undefined;
      activateListener?.({
        waitUntil: (next) => {
          work = next;
        },
      });
      await work;
    },
  };
}

function summaryResponse(
  payload: { projectId: string },
  state:
    | "idle"
    | "running"
    | "interaction-required"
    | "completed"
    | "canceled"
    | "server-stopped"
    | "failed",
  count: number,
  suppressNotification = false,
  projectName = "editor",
) {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue({
      projectId: payload.projectId,
      projectName,
      state,
      counts: {
        interactionRequired: state === "interaction-required" ? count : 0,
        failed: state === "failed" ? count : 0,
        completed: state === "completed" ? count : 0,
      },
      suppressNotification,
    }),
  };
}
