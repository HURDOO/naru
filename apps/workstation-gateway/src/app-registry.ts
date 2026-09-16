import type { GatewayAppRegistration, GatewayManagedAppRegistration } from "./config.js";

export type GatewayAppInventoryState = "enabled" | "disabled" | "unavailable";

export interface GatewayAppInventoryItem {
  readonly appId: string;
  readonly mode: GatewayAppRegistration["mode"];
  readonly state: GatewayAppInventoryState;
  readonly href?: string;
}

export class GatewayAppRegistry {
  readonly #apps: ReadonlyMap<string, GatewayAppRegistration>;
  readonly #managed: readonly GatewayManagedAppRegistration[];
  readonly #unavailable = new Set<string>();

  constructor(apps: readonly GatewayAppRegistration[]) {
    this.#apps = new Map(apps.map((app) => [app.appId, structuredClone(app)]));
    this.#managed = apps
      .filter(
        (app): app is GatewayManagedAppRegistration =>
          app.mode === "gateway-managed" && app.enabled,
      )
      .map((app) => structuredClone(app));
  }

  list(): readonly GatewayAppRegistration[] {
    return [...this.#apps.values()].map((app) => structuredClone(app));
  }

  get(appId: string): GatewayAppRegistration | undefined {
    const app = this.#apps.get(appId);
    return app === undefined ? undefined : structuredClone(app);
  }

  inventory(): readonly GatewayAppInventoryItem[] {
    return [...this.#apps.values()].map((app) => ({
      appId: app.appId,
      mode: app.mode,
      state: !app.enabled
        ? "disabled"
        : this.#unavailable.has(app.appId)
          ? "unavailable"
          : "enabled",
      ...(app.enabled
        ? {
            href:
              app.mode === "gateway-managed" && app.routePrefix !== "/"
                ? `${app.routePrefix}/`
                : app.mode === "gateway-managed"
                  ? app.routePrefix
                  : app.origin,
          }
        : {}),
    }));
  }

  markAvailable(appId: string): void {
    this.#unavailable.delete(appId);
  }

  markUnavailable(appId: string): void {
    const app = this.#apps.get(appId);
    if (app?.mode === "gateway-managed" && app.enabled) this.#unavailable.add(appId);
  }

  matchManaged(pathname: string): GatewayManagedAppRegistration | undefined {
    return this.#managed.find(
      (app) =>
        app.routePrefix === "/" ||
        pathname === app.routePrefix ||
        pathname.startsWith(`${app.routePrefix}/`),
    );
  }
}
