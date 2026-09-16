import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  isLegacyNaruRootCache,
  legacyNaruRootServiceWorkerSource,
} from "../src/legacy-root-service-worker.js";

describe("Gateway legacy Naru root service-worker retirement", () => {
  it("recognizes only legacy and current root-scoped Naru cache namespaces", () => {
    expect(isLegacyNaruRootCache("naru-app-shell-deadbeef")).toBe(true);
    expect(isLegacyNaruRootCache("naru-app-shell:/:deadbeef")).toBe(true);
    expect(isLegacyNaruRootCache("naru-app-shell:/naru:deadbeef")).toBe(false);
    expect(isLegacyNaruRootCache("other-app-shell:/:deadbeef")).toBe(false);
  });

  it("immediately activates, removes only Naru root caches, releases clients, and unregisters", async () => {
    const source = legacyNaruRootServiceWorkerSource();
    const handlers = new Map<
      string,
      (event: { waitUntil(promise: Promise<unknown>): void }) => void
    >();
    const deleted: string[] = [];
    const skipWaiting = vi.fn().mockResolvedValue(undefined);
    const claim = vi.fn().mockResolvedValue(undefined);
    const unregister = vi.fn().mockResolvedValue(true);
    runInNewContext(source, {
      caches: {
        keys: () =>
          Promise.resolve([
            "naru-app-shell-old",
            "naru-app-shell:/:root",
            "naru-app-shell:/naru:keep",
            "other-app-shell:/:keep",
          ]),
        delete: (name: string) => {
          deleted.push(name);
          return Promise.resolve(true);
        },
      },
      self: {
        addEventListener: (
          name: string,
          handler: (event: { waitUntil(promise: Promise<unknown>): void }) => void,
        ) => handlers.set(name, handler),
        skipWaiting,
        clients: { claim },
        registration: { unregister },
      },
    });

    const dispatch = async (name: string): Promise<void> => {
      const handler = handlers.get(name);
      if (handler === undefined) throw new Error(`Missing ${name} handler.`);
      const promises: Promise<unknown>[] = [];
      handler({ waitUntil: (promise) => promises.push(promise) });
      await Promise.all(promises);
    };
    await dispatch("install");
    await dispatch("activate");

    expect(skipWaiting).toHaveBeenCalledOnce();
    expect(deleted).toEqual(["naru-app-shell-old", "naru-app-shell:/:root"]);
    expect(claim).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledOnce();
    expect(source).not.toContain('self.addEventListener("fetch"');
    expect(handlers.has("fetch")).toBe(false);
  });
});
