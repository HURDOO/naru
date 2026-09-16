export const LEGACY_NARU_ROOT_CACHE_PREFIXES = ["naru-app-shell-", "naru-app-shell:/:"] as const;

export function isLegacyNaruRootCache(name: string): boolean {
  return LEGACY_NARU_ROOT_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function legacyNaruRootServiceWorkerSource(): string {
  return `/* Gateway-owned Naru legacy root service-worker retirement v1. */
const LEGACY_NARU_ROOT_CACHE_PREFIXES = ${JSON.stringify(LEGACY_NARU_ROOT_CACHE_PREFIXES)};

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => LEGACY_NARU_ROOT_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix)))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
      await self.registration.unregister();
    })(),
  );
});
`;
}
