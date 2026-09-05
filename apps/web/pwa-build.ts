import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WORKSTATION_GATEWAY_BROWSER_ROUTE_PREFIX } from "@naru/contracts/workstation-gateway/v1";
import type { Plugin } from "vite";
import { PUBLIC_PWA_BUILD_FIXTURE_ORIGIN } from "./src/public-build-config.js";

export const PWA_CACHE_PREFIX = "naru-app-shell-";

export const PWA_PUBLIC_ASSETS = [
  "/manifest.webmanifest",
  "/icons/naru-192.png",
  "/icons/naru-512.png",
  "/icons/naru-maskable-512.png",
  "/fonts/d2coding/D2Coding-Regular.ttf",
  "/fonts/d2coding/D2Coding-Bold.ttf",
] as const;

export function pwaServiceWorkerPlugin(
  publicDirectory: string,
  canonicalOrigin = PUBLIC_PWA_BUILD_FIXTURE_ORIGIN,
): Plugin {
  const renderedOrigin = validatePwaBuildOrigin(canonicalOrigin);
  return {
    name: "naru-pwa-service-worker",
    apply: "build",
    transformIndexHtml(source) {
      return renderPwaOriginMeta(source, renderedOrigin);
    },
    generateBundle(_options, bundle) {
      const hash = createHash("sha256");
      hash.update(renderedOrigin);
      const bundlePaths = Object.keys(bundle)
        .filter((filename) => !filename.endsWith(".map") && filename !== "sw.js")
        .sort();

      for (const filename of bundlePaths) {
        const output = bundle[filename];
        if (!output) continue;
        hash.update(filename);
        hash.update(output.type === "chunk" ? output.code : output.source);
      }
      hash.update("/index.html");
      hash.update(readFileSync(join(publicDirectory, "..", "index.html")));
      for (const pathname of PWA_PUBLIC_ASSETS) {
        hash.update(pathname);
        hash.update(readFileSync(join(publicDirectory, pathname.slice(1))));
      }

      const revision = hash.digest("hex").slice(0, 20);
      const appShellPaths = [
        "/index.html",
        ...bundlePaths.map((filename) => `/${filename}`),
        ...PWA_PUBLIC_ASSETS,
      ].sort();
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: createServiceWorkerSource(revision, appShellPaths),
      });
    },
  };
}

export function renderPwaOriginMeta(source: string, canonicalOrigin: string): string {
  const origin = validatePwaBuildOrigin(canonicalOrigin);
  const pattern = /<meta\s+name=["']naru-canonical-origin["']\s+content=["']([^"']*)["']\s*\/?>/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error("Web source must contain exactly one Naru canonical Origin meta tag.");
  }
  pattern.lastIndex = 0;
  return source.replace(
    pattern,
    `<meta name="naru-canonical-origin" content="${escapeHtmlAttribute(origin)}" />`,
  );
}

function validatePwaBuildOrigin(value: string): string {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error("NARU_PWA_BUILD_ORIGIN must be one exact HTTPS Origin.");
  }
  if (
    origin.protocol !== "https:" ||
    origin.origin !== value ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    origin.hostname === "localhost" ||
    origin.hostname.startsWith("[") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(origin.hostname) ||
    origin.hostname.endsWith(".")
  ) {
    throw new Error("NARU_PWA_BUILD_ORIGIN must be one exact HTTPS hostname Origin.");
  }
  return origin.origin;
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

export function createServiceWorkerSource(
  revision: string,
  appShellPaths: readonly string[],
): string {
  if (!/^[a-f0-9]{8,64}$/.test(revision)) {
    throw new Error("PWA revision must be a lowercase hexadecimal digest.");
  }
  const paths = [...new Set(appShellPaths)].sort();
  if (!paths.includes("/index.html")) throw new Error("PWA app shell must include index.html.");
  if (paths.some((pathname) => !pathname.startsWith("/") || pathname.startsWith("//"))) {
    throw new Error("PWA app shell paths must be same-origin absolute paths.");
  }

  return `/* Naru generated service worker. Build revision: ${revision} */
const CACHE_PREFIX = ${JSON.stringify(PWA_CACHE_PREFIX)};
const CACHE_NAME = CACHE_PREFIX + ${JSON.stringify(revision)};
const INDEX_PATH = "/index.html";
const GATEWAY_ROUTE_PREFIX = ${JSON.stringify(WORKSTATION_GATEWAY_BROWSER_ROUTE_PREFIX)};
const APP_SHELL_PATHS = new Set(${JSON.stringify(paths)});
const BLOCKED_PATHS = new Set(["/healthz", "/readyz"]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(
        [...APP_SHELL_PATHS].map(
          (pathname) => new Request(pathname, { cache: "reload", credentials: "same-origin" }),
        ),
      ),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const shellCaches = (await caches.keys()).filter((name) => name.startsWith(CACHE_PREFIX));
      const previousCache = shellCaches.filter((name) => name !== CACHE_NAME).at(-1);
      await Promise.all(
        shellCaches
          .filter((name) => name !== CACHE_NAME && name !== previousCache)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
  }
});

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openNotificationTarget(event.notification.data));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (
    url.pathname === "/api" ||
    url.pathname.startsWith("/api/") ||
    url.pathname === GATEWAY_ROUTE_PREFIX ||
    url.pathname.startsWith(GATEWAY_ROUTE_PREFIX + "/") ||
    BLOCKED_PATHS.has(url.pathname)
  ) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(caches.open(CACHE_NAME).then((cache) => cache.match(INDEX_PATH)));
    return;
  }

  if (!APP_SHELL_PATHS.has(url.pathname)) return;
  event.respondWith(matchVersionedShell(request));
});

async function matchVersionedShell(request) {
  const current = await caches.open(CACHE_NAME);
  const currentMatch = await current.match(request, { ignoreSearch: false });
  if (currentMatch) return currentMatch;

  const shellCaches = (await caches.keys())
    .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
    .reverse();
  for (const cacheName of shellCaches) {
    const match = await caches.match(request, { cacheName, ignoreSearch: false });
    if (match) return match;
  }
  return fetch(request);
}

async function handlePush(event) {
  let payload;
  try {
    payload = event.data?.json();
  } catch {
    return;
  }
  if (!isPushPayload(payload)) return;

  const tag = "naru:project:" + payload.projectId;
  const existing = await self.registration.getNotifications({ tag });
  if (existing.some((notification) => notification.data?.eventId === payload.eventId)) return;

  const summary = await loadPushProjectSummary(payload.projectId);
  if (summary?.suppressNotification) {
    for (const notification of existing) notification.close();
    return;
  }
  const state = summary?.state ?? payload.eventKind;
  if (
    state === "idle" ||
    state === "running" ||
    state === "canceled" ||
    state === "server-stopped"
  ) {
    for (const notification of existing) notification.close();
    return;
  }
  const projectName = normalizedProjectName(summary?.projectName) ?? "Naru";
  const count = summary === null ? 1 : summaryCount(summary, state);
  const presentation = notificationPresentation(projectName, state, count);
  await self.registration.showNotification(presentation.title, {
    body: presentation.body,
    badge: "/icons/naru-192.png",
    icon: "/icons/naru-192.png",
    tag,
    renotify: false,
    data: payload,
  });
}

async function loadPushProjectSummary(projectId) {
  try {
    const response = await fetch("/api/push/projects/" + projectId + "/summary", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const value = await response.json();
    return isPushProjectSummary(value, projectId) ? value : null;
  } catch {
    return null;
  }
}

function notificationPresentation(projectName, state, count) {
  return {
    completed: {
      title: projectName + " · 작업 완료",
      body: count + "개의 작업이 완료되었습니다.",
    },
    "interaction-required": {
      title: projectName + " · 입력 필요",
      body: count + "개의 작업에 입력 또는 승인이 필요합니다.",
    },
    failed: {
      title: projectName + " · 작업 실패",
      body: count + "개의 작업이 실패했습니다.",
    },
  }[state];
}

function summaryCount(summary, state) {
  const count = {
    completed: summary.counts.completed,
    "interaction-required": summary.counts.interactionRequired,
    failed: summary.counts.failed,
  }[state];
  return Math.max(1, count);
}

function normalizedProjectName(value) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\\s+/g, " ").trim().slice(0, 120);
  return normalized.length > 0 ? normalized : null;
}

function isPushProjectSummary(value, projectId) {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).length === 5 &&
    value.projectId === projectId &&
    typeof value.projectName === "string" &&
    value.projectName.length >= 1 &&
    value.projectName.length <= 120 &&
    [
      "idle",
      "running",
      "interaction-required",
      "completed",
      "canceled",
      "server-stopped",
      "failed",
    ].includes(value.state) &&
    isPushProjectCounts(value.counts) &&
    typeof value.suppressNotification === "boolean"
  );
}

function isPushProjectCounts(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).length === 3 &&
    isNotificationCount(value.interactionRequired) &&
    isNotificationCount(value.failed) &&
    isNotificationCount(value.completed)
  );
}

function isNotificationCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

async function openNotificationTarget(payload) {
  if (!isPushPayload(payload)) return;
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const client = windows.find((candidate) => {
    try {
      return new URL(candidate.url).origin === self.location.origin;
    } catch {
      return false;
    }
  });
  if (client) {
    await client.focus();
    client.postMessage({ type: "NARU_PUSH_EVENT", payload });
    return;
  }

  const url = new URL("/", self.location.origin);
  url.searchParams.set("naruProject", payload.projectId);
  url.searchParams.set("naruPane", payload.paneId);
  url.searchParams.set("naruEvent", payload.eventId);
  await self.clients.openWindow(url.href);
}

function isPushPayload(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).length === 6 &&
    value.version === 1 &&
    isUuid(value.eventId) &&
    isUuid(value.projectId) &&
    isUuid(value.paneId) &&
    isUuid(value.runtimeId) &&
    ["completed", "interaction-required", "failed"].includes(value.eventKind)
  );
}

function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
`;
}
