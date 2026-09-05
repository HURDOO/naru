import type { GatewayAppRegistration, GatewayManagedAppRegistration } from "./config.js";

export class GatewayAppRegistry {
  readonly #apps: ReadonlyMap<string, GatewayAppRegistration>;
  readonly #managed: readonly GatewayManagedAppRegistration[];

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

  matchManaged(pathname: string): GatewayManagedAppRegistration | undefined {
    return this.#managed.find(
      (app) =>
        app.routePrefix === "/" ||
        pathname === app.routePrefix ||
        pathname.startsWith(`${app.routePrefix}/`),
    );
  }
}
