import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  ExactHttpsOriginSchema,
  GatewayAppModeSchema,
  isWorkstationGatewayBrowserPath,
} from "@naru/contracts/workstation-gateway/v1";
import { GatewayIngressV0Schema, type PrivateIngressV0 } from "@naru/contracts/private-ingress/v0";
import { z } from "zod";
import { assertPrivateRegularFile } from "./security.js";

const IdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/);

const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(isAbsolute, "Path must be absolute.")
  .refine((value) => !/[\0\r\n]/.test(value), "Path contains a control character.");

const RoutePrefixSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(isSafeRoutePrefix, "App route prefix is invalid or reserved.");

const LoopbackHttpOriginSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(isExactLoopbackHttpOrigin, "Upstream must be an exact loopback HTTP origin.");

const GatewayManagedAppSchema = z.strictObject({
  appId: IdentifierSchema,
  mode: z.literal(GatewayAppModeSchema.enum["gateway-managed"]),
  routePrefix: RoutePrefixSchema,
  upstream: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("uds"),
      socketPath: AbsolutePathSchema.refine(
        (path) => Buffer.byteLength(path) <= 103,
        "Unix socket path exceeds the macOS limit.",
      ),
    }),
    z.strictObject({
      kind: z.literal("loopback"),
      origin: LoopbackHttpOriginSchema,
    }),
  ]),
  includeCredentialRef: z.boolean().default(true),
  enabled: z.boolean().default(true),
});

const AppManagedAppSchema = z.strictObject({
  appId: IdentifierSchema,
  mode: z.literal(GatewayAppModeSchema.enum["app-managed"]),
  origin: ExactHttpsOriginSchema,
  enabled: z.boolean().default(true),
});

export const GatewayAppRegistrationSchema = z.discriminatedUnion("mode", [
  GatewayManagedAppSchema,
  AppManagedAppSchema,
]);

const WorkstationGatewayCommonConfigShape = {
  instanceId: IdentifierSchema,
  ownerSubject: IdentifierSchema,
  browserOrigin: ExactHttpsOriginSchema,
  ingressProfileId: IdentifierSchema,
  rpName: z.string().min(1).max(128),
  dataDirectory: AbsolutePathSchema,
  adminSocketPath: AbsolutePathSchema.refine(
    (path) => Buffer.byteLength(path) <= 103,
    "Unix socket path exceeds the macOS limit.",
  ),
  sessionCookieName: z
    .string()
    .min(8)
    .max(128)
    .regex(/^__Host-[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
  bootstrapTtlMs: z
    .number()
    .int()
    .min(30_000)
    .max(30 * 60_000)
    .default(5 * 60_000),
  ceremonyTtlMs: z
    .number()
    .int()
    .min(30_000)
    .max(30 * 60_000)
    .default(5 * 60_000),
  sessionAbsoluteTtlMs: z
    .number()
    .int()
    .min(60_000)
    .max(7 * 24 * 60 * 60_000)
    .default(8 * 60 * 60_000),
  sessionIdleTtlMs: z
    .number()
    .int()
    .min(30_000)
    .max(24 * 60 * 60_000)
    .default(60 * 60_000),
  principalTtlSeconds: z.number().int().min(5).max(60).default(30),
  requestBodyBytes: z
    .number()
    .int()
    .min(1_024)
    .max(4 * 1_024 * 1_024)
    .default(512 * 1_024),
  appRegistrations: z.array(GatewayAppRegistrationSchema).min(1).max(1_000),
} as const;

export const WorkstationGatewayConfigV1Schema = z.strictObject({
  version: z.literal(1),
  ...WorkstationGatewayCommonConfigShape,
  listenHost: z.literal("127.0.0.1"),
  listenPort: z.number().int().min(1).max(65_535),
});

export const WorkstationGatewayConfigV2Schema = z.strictObject({
  version: z.literal(2),
  ...WorkstationGatewayCommonConfigShape,
  browserIngress: GatewayIngressV0Schema,
});

export const WorkstationGatewayConfigSchema = z
  .discriminatedUnion("version", [
    WorkstationGatewayConfigV1Schema,
    WorkstationGatewayConfigV2Schema,
  ])
  .superRefine((config, context) => {
    if (config.version === 2 && config.browserIngress.kind === "direct-private-tls") {
      if (config.browserOrigin !== config.browserIngress.browserOrigin) {
        context.addIssue({
          code: "custom",
          path: ["browserIngress", "browserOrigin"],
          message: "Direct listener Origin must match the Gateway browser Origin.",
        });
      }
      if (config.ingressProfileId !== config.browserIngress.profileId) {
        context.addIssue({
          code: "custom",
          path: ["browserIngress", "profileId"],
          message: "Direct listener profile must match the active Gateway ingress profile.",
        });
      }
      const managedApps = config.appRegistrations.filter(
        (app): app is GatewayManagedAppRegistration =>
          app.mode === "gateway-managed" && app.enabled,
      );
      if (managedApps.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["appRegistrations"],
          message: "Direct listener mode requires an enabled Gateway-managed app.",
        });
      }
      for (const app of managedApps) {
        if (
          app.upstream.kind !== "loopback" ||
          !isExactIpv4LoopbackHttpOrigin(app.upstream.origin)
        ) {
          context.addIssue({
            code: "custom",
            path: ["appRegistrations", config.appRegistrations.indexOf(app), "upstream"],
            message: "Direct listener Gateway-managed apps require exact 127.0.0.1 HTTP upstreams.",
          });
        }
      }
    }

    const appIds = new Set<string>();
    const routes: { index: number; prefix: string }[] = [];
    for (const [index, app] of config.appRegistrations.entries()) {
      if (appIds.has(app.appId)) {
        context.addIssue({
          code: "custom",
          path: ["appRegistrations", index, "appId"],
          message: "Gateway app IDs must be unique.",
        });
      }
      appIds.add(app.appId);
      if (app.mode === "gateway-managed") routes.push({ index, prefix: app.routePrefix });
    }
    for (let left = 0; left < routes.length; left += 1) {
      for (let right = left + 1; right < routes.length; right += 1) {
        const first = routes[left];
        const second = routes[right];
        if (
          first !== undefined &&
          second !== undefined &&
          routesOverlap(first.prefix, second.prefix)
        ) {
          context.addIssue({
            code: "custom",
            path: ["appRegistrations", second.index, "routePrefix"],
            message: `Gateway app route overlaps ${first.prefix}.`,
          });
        }
      }
    }
  });

export type WorkstationGatewayConfig = z.infer<typeof WorkstationGatewayConfigSchema>;
export type WorkstationGatewayConfigV1 = z.infer<typeof WorkstationGatewayConfigV1Schema>;
export type WorkstationGatewayConfigV2 = z.infer<typeof WorkstationGatewayConfigV2Schema>;
export type GatewayAppRegistration = z.infer<typeof GatewayAppRegistrationSchema>;
export type GatewayManagedAppRegistration = Extract<
  GatewayAppRegistration,
  { mode: "gateway-managed" }
>;
export type DirectPrivateWorkstationGatewayConfig = Omit<
  WorkstationGatewayConfigV2,
  "browserIngress"
> & {
  readonly browserIngress: PrivateIngressV0;
};

export function isDirectPrivateWorkstationGatewayConfig(
  config: WorkstationGatewayConfig,
): config is DirectPrivateWorkstationGatewayConfig {
  return config.version === 2 && config.browserIngress.kind === "direct-private-tls";
}

export function gatewayLoopbackListenTarget(
  config: WorkstationGatewayConfig,
): { readonly host: "127.0.0.1"; readonly port: number } | undefined {
  if (config.version === 1) return { host: config.listenHost, port: config.listenPort };
  if (config.browserIngress.kind !== "loopback-proxy") return undefined;
  return {
    host: config.browserIngress.listenHost,
    port: config.browserIngress.listenPort,
  };
}

export function readWorkstationGatewayConfig(path: string): WorkstationGatewayConfig {
  assertPrivateRegularFile(path);
  const source = readFileSync(path, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new Error("Workstation Gateway config is not valid JSON.");
  }
  return WorkstationGatewayConfigSchema.parse(value);
}

function isSafeRoutePrefix(value: string): boolean {
  if (
    !value.startsWith("/") ||
    !/^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*$/.test(value) ||
    value.includes("//") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\")
  ) {
    return false;
  }
  if (value !== "/" && value.endsWith("/")) return false;
  if (isWorkstationGatewayBrowserPath(value)) return false;
  try {
    const parsed = new URL(value, "https://gateway.invalid");
    return (
      parsed.pathname === value &&
      !parsed.pathname.split("/").some((part) => part === "." || part === "..")
    );
  } catch {
    return false;
  }
}

function isExactLoopbackHttpOrigin(value: string): boolean {
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

function isExactIpv4LoopbackHttpOrigin(value: string): boolean {
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
      parsed.hostname === "127.0.0.1"
    );
  } catch {
    return false;
  }
}

function routesOverlap(left: string, right: string): boolean {
  if (left === "/" || right === "/") return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
