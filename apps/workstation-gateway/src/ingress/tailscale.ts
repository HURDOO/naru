import { z } from "zod";
import { canonicalJson, digestValue } from "./canonical.js";
import type { ExternalCommandRunner } from "./process-runner.js";
import { NodeExternalCommandRunner } from "./process-runner.js";
import type { TailscaleRouteResource, TailscaleServeRoute, TailscaleState } from "./model.js";

const JsonObjectSchema = z.record(z.string(), z.unknown());

export interface TailscalePort {
  inspect(): Promise<TailscaleState>;
  enable(resource: TailscaleRouteResource): Promise<void>;
  disable(resource: TailscaleRouteResource): Promise<void>;
}

export class TailscaleCliAdapter implements TailscalePort {
  readonly #readRunner: ExternalCommandRunner;
  readonly #mutationRunner: ExternalCommandRunner;

  constructor(
    readonly executable: string,
    runner?: ExternalCommandRunner,
  ) {
    this.#readRunner = runner ?? new NodeExternalCommandRunner();
    this.#mutationRunner = runner ?? new NodeExternalCommandRunner({ timeoutMs: 30_000 });
  }

  async inspect(): Promise<TailscaleState> {
    const version = await this.#readJson(["version", "--json"], "version");
    const status = await this.#readJson(["status", "--json"], "status");
    const serve = await this.#readJson(["serve", "status", "--json"], "serve status");
    const funnel = await this.#readJson(["funnel", "status", "--json"], "funnel status");
    return parseTailscaleState(version, status, serve, funnel);
  }

  async enable(resource: TailscaleRouteResource): Promise<void> {
    await this.#mutate(tailscaleEnableArguments(resource));
  }

  async disable(resource: TailscaleRouteResource): Promise<void> {
    await this.#mutate(tailscaleDisableArguments(resource));
  }

  async #readJson(args: readonly string[], label: string): Promise<unknown> {
    const result = await this.#readRunner.run(this.executable, args);
    if (result.exitCode !== 0) {
      throw new Error(`Tailscale ${label} failed with exit status ${result.exitCode}.`);
    }
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch {
      throw new Error(`Tailscale ${label} did not return valid JSON.`);
    }
  }

  async #mutate(args: readonly string[]): Promise<void> {
    assertAllowedMutationArguments(args);
    const result = await this.#mutationRunner.run(this.executable, args);
    if (result.exitCode !== 0) {
      throw new Error(`Tailscale route mutation failed with exit status ${result.exitCode}.`);
    }
  }
}

export function tailscaleEnableArguments(resource: TailscaleRouteResource): readonly string[] {
  assertResource(resource);
  return [
    "serve",
    "--bg",
    `--https=${resource.httpsPort}`,
    `--set-path=${resource.mountPath}`,
    resource.proxy,
  ];
}

export function tailscaleDisableArguments(resource: TailscaleRouteResource): readonly string[] {
  assertResource(resource);
  return ["serve", `--https=${resource.httpsPort}`, `--set-path=${resource.mountPath}`, "off"];
}

export function assertAllowedMutationArguments(args: readonly string[]): void {
  const enablePort = Number((args[2] ?? "").replace("--https=", ""));
  const disablePort = Number((args[1] ?? "").replace("--https=", ""));
  const validEnable =
    args.length === 5 &&
    args[0] === "serve" &&
    args[1] === "--bg" &&
    /^--https=\d{1,5}$/.test(args[2] ?? "") &&
    Number.isInteger(enablePort) &&
    enablePort >= 1 &&
    enablePort <= 65_535 &&
    args[3] === "--set-path=/" &&
    isExactLoopbackProxy(args[4] ?? "");
  const validDisable =
    args.length === 4 &&
    args[0] === "serve" &&
    /^--https=\d{1,5}$/.test(args[1] ?? "") &&
    Number.isInteger(disablePort) &&
    disablePort >= 1 &&
    disablePort <= 65_535 &&
    args[2] === "--set-path=/" &&
    args[3] === "off";
  if (!validEnable && !validDisable) {
    throw new Error("Tailscale mutation is outside the exact Serve route allowlist.");
  }
  for (const forbidden of ["reset", "set-config", "up", "down", "login", "logout", "funnel"]) {
    if (args.includes(forbidden)) throw new Error(`Forbidden Tailscale mutation: ${forbidden}.`);
  }
}

export function parseTailscaleState(
  versionValue: unknown,
  statusValue: unknown,
  serveValue: unknown,
  funnelValue: unknown,
): TailscaleState {
  const versionObject = JsonObjectSchema.parse(versionValue);
  const status = JsonObjectSchema.parse(statusValue);
  const serve = JsonObjectSchema.parse(serveValue);
  const funnel = JsonObjectSchema.parse(funnelValue);
  const version = findVersionString(versionObject);
  if (version === undefined)
    throw new Error("Tailscale version JSON has no supported semantic version field.");

  const backendState = typeof status.BackendState === "string" ? status.BackendState : undefined;
  if (backendState === undefined) throw new Error("Tailscale status JSON has no BackendState.");
  const self = JsonObjectSchema.safeParse(status.Self);
  const selfDnsName =
    self.success && typeof self.data.DNSName === "string"
      ? self.data.DNSName.replace(/\.$/, "").toLowerCase()
      : undefined;
  const httpsEnabled = self.success ? hasHttpsCapability(self.data) : false;
  const addresses =
    self.success && Array.isArray(self.data.TailscaleIPs)
      ? self.data.TailscaleIPs.filter((entry): entry is string => typeof entry === "string")
      : [];

  const serveParsed = parseServeConfig(serve, "background");
  const funnelParsed = parseServeConfig(funnel, "background");
  const funnelKeys = new Set(
    funnelParsed.routes.filter((route) => route.funnel).map((route) => routeKey(route)),
  );
  const routes = serveParsed.routes.map((route) =>
    funnelKeys.has(routeKey(route)) && !route.funnel ? { ...route, funnel: true } : route,
  );
  for (const funnelRoute of funnelParsed.routes) {
    if (!routes.some((route) => routeKey(route) === routeKey(funnelRoute))) {
      routes.push({ ...funnelRoute, funnel: true });
    }
  }
  routes.sort((left, right) => routeKey(left).localeCompare(routeKey(right)));

  return {
    available: true,
    version,
    backendState,
    httpsEnabled,
    ...(selfDnsName === undefined ? {} : { selfDnsName }),
    selfAddresses: addresses,
    routes,
    diagnostics: [...serveParsed.diagnostics, ...funnelParsed.diagnostics],
  };
}

export function tailscaleStateFingerprint(state: TailscaleState): string {
  return digestValue({
    available: state.available,
    version: state.version,
    backendState: state.backendState,
    httpsEnabled: state.httpsEnabled,
    selfDnsName: state.selfDnsName,
    selfAddresses: [...state.selfAddresses].sort(),
    routes: [...state.routes].sort((left, right) => routeKey(left).localeCompare(routeKey(right))),
  });
}

export function unrelatedStateFingerprint(
  state: TailscaleState,
  resource: TailscaleRouteResource,
): string {
  const targetKey = resourceKey(resource);
  return digestValue({
    version: state.version,
    backendState: state.backendState,
    httpsEnabled: state.httpsEnabled,
    selfDnsName: state.selfDnsName,
    selfAddresses: [...state.selfAddresses].sort(),
    routes: state.routes
      .filter((route) => routeKey(route) !== targetKey)
      .sort((left, right) => routeKey(left).localeCompare(routeKey(right))),
  });
}

function hasHttpsCapability(self: Record<string, unknown>): boolean {
  const capabilities = Array.isArray(self.Capabilities)
    ? self.Capabilities.filter((entry): entry is string => typeof entry === "string")
    : [];
  const capMap = JsonObjectSchema.safeParse(self.CapMap);
  const names = new Set([...capabilities, ...(capMap.success ? Object.keys(capMap.data) : [])]);
  return names.has("https");
}

export function matchingRoute(
  state: TailscaleState,
  resource: TailscaleRouteResource,
): TailscaleServeRoute | undefined {
  return state.routes.find(
    (route) =>
      route.source === "background" &&
      route.hostPort.toLowerCase() === resource.hostPort.toLowerCase() &&
      route.mountPath === resource.mountPath &&
      route.protocol === "https" &&
      route.proxy === resource.proxy,
  );
}

export function conflictingRoutes(
  state: TailscaleState,
  resource: TailscaleRouteResource,
): readonly TailscaleServeRoute[] {
  return state.routes.filter(
    (route) =>
      (route.hostPort.toLowerCase() === resource.hostPort.toLowerCase() &&
        (route.source !== "background" ||
          route.mountPath !== resource.mountPath ||
          route.protocol !== "https" ||
          route.proxy !== resource.proxy)) ||
      (route.hostPort === `*:${resource.httpsPort}` && route.source !== "service"),
  );
}

export function isSupportedTailscaleVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 1 || (major === 1 && minor >= 52);
}

function parseServeConfig(
  value: Record<string, unknown>,
  source: TailscaleServeRoute["source"],
): { routes: TailscaleServeRoute[]; diagnostics: string[] } {
  const routes: TailscaleServeRoute[] = [];
  const diagnostics: string[] = [];
  const tcp = parseObjectMap(value.TCP, "TCP");
  const allowFunnel = parseBooleanMap(value.AllowFunnel, "AllowFunnel");
  const web = parseObjectMap(value.Web, "Web");

  for (const [hostPort, webValue] of Object.entries(web)) {
    const webConfig = JsonObjectSchema.parse(webValue);
    const handlers = parseObjectMap(webConfig.Handlers, `Web.${hostPort}.Handlers`);
    const port = parseHostPort(hostPort).port;
    const tcpHandler = tcp[String(port)];
    const protocol = webProtocol(tcpHandler);
    for (const [mountPath, handlerValue] of Object.entries(handlers)) {
      const handler = JsonObjectSchema.parse(handlerValue);
      const proxy = typeof handler.Proxy === "string" ? handler.Proxy : unsupportedHandler(handler);
      routes.push({
        hostPort: hostPort.toLowerCase(),
        mountPath,
        proxy,
        protocol,
        funnel: allowFunnel[hostPort] === true,
        source,
      });
    }
  }

  for (const [portText, handlerValue] of Object.entries(tcp)) {
    const handler = JsonObjectSchema.parse(handlerValue);
    if (typeof handler.TCPForward !== "string") continue;
    const port = parsePort(portText);
    routes.push({
      hostPort: `*:${port}`,
      mountPath: "",
      proxy: handler.TCPForward,
      protocol: handler.TerminateTLS === undefined ? "tcp" : "tls-terminated-tcp",
      funnel: Object.entries(allowFunnel).some(
        ([hostPort, enabled]) => enabled && hostPort.endsWith(`:${port}`),
      ),
      source,
    });
  }

  const foreground = parseObjectMap(value.Foreground, "Foreground");
  if (Object.keys(foreground).length > 0)
    diagnostics.push("foreground Serve configuration is active");
  for (const foregroundValue of Object.values(foreground)) {
    const parsed = parseServeConfig(JsonObjectSchema.parse(foregroundValue), "foreground");
    routes.push(...parsed.routes);
    diagnostics.push(...parsed.diagnostics);
  }

  const services = parseObjectMap(value.Services, "Services");
  for (const serviceValue of Object.values(services)) {
    const parsed = parseServeConfig(JsonObjectSchema.parse(serviceValue), "service");
    routes.push(...parsed.routes);
    diagnostics.push(...parsed.diagnostics);
  }

  return { routes, diagnostics };
}

function parseObjectMap(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  const parsed = JsonObjectSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Tailscale ${label} must be a JSON object.`);
  return parsed.data;
}

function parseBooleanMap(value: unknown, label: string): Record<string, boolean> {
  const record = parseObjectMap(value, label);
  for (const entry of Object.values(record)) {
    if (typeof entry !== "boolean") throw new Error(`Tailscale ${label} values must be boolean.`);
  }
  return record as Record<string, boolean>;
}

function webProtocol(value: unknown): TailscaleServeRoute["protocol"] {
  const handler = JsonObjectSchema.parse(value);
  if (handler.HTTPS === true && handler.HTTP !== true) return "https";
  if (handler.HTTP === true && handler.HTTPS !== true) return "http";
  throw new Error("Tailscale web route has an ambiguous or missing HTTP/HTTPS TCP handler.");
}

function unsupportedHandler(handler: Record<string, unknown>): string {
  const kinds = Object.keys(handler).sort();
  if (kinds.length === 0) throw new Error("Tailscale web handler is empty.");
  return `unsupported:${kinds.join(",")}`;
}

function findVersionString(value: Record<string, unknown>): string | undefined {
  for (const field of ["short", "Short", "version", "Version", "majorMinorPatch"]) {
    const candidate = value[field];
    if (typeof candidate === "string" && /^\d+\.\d+/.test(candidate)) return candidate;
  }
  for (const candidate of Object.values(value)) {
    if (typeof candidate === "string") {
      const match = /(?:^|\s)(\d+\.\d+(?:\.\d+)?)/.exec(candidate);
      if (match?.[1] !== undefined) return match[1];
    }
  }
  return undefined;
}

function parseHostPort(value: string): { hostname: string; port: number } {
  const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(value);
  const hostname = match?.[1];
  const portText = match?.[2];
  if (hostname === undefined || portText === undefined) {
    throw new Error(`Tailscale Serve host-port is invalid: ${value}`);
  }
  return { hostname, port: parsePort(portText) };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Tailscale Serve port is invalid: ${value}`);
  }
  return port;
}

function routeKey(route: TailscaleServeRoute): string {
  return canonicalJson([route.source, route.hostPort.toLowerCase(), route.mountPath]);
}

function resourceKey(resource: TailscaleRouteResource): string {
  return canonicalJson(["background", resource.hostPort.toLowerCase(), resource.mountPath]);
}

function assertResource(resource: TailscaleRouteResource): void {
  if (
    resource.mountPath !== "/" ||
    resource.httpsPort < 1 ||
    resource.httpsPort > 65_535 ||
    !Number.isInteger(resource.httpsPort) ||
    !isExactLoopbackProxy(resource.proxy)
  ) {
    throw new Error("Tailscale resource is outside the v0 exact HTTPS loopback route contract.");
  }
}

function isExactLoopbackProxy(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "http:" &&
      parsed.origin === value &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.port !== "" &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}
