import { z } from "zod";

export const WORKSTATION_GATEWAY_CONTRACT_VERSION = 1 as const;
export const INGRESS_PROFILE_VERSION = 0 as const;
export const WORKSTATION_GATEWAY_ASSERTION_HEADER = "x-workstation-gateway-assertion" as const;
export const WORKSTATION_GATEWAY_CSRF_HEADER = "x-workstation-gateway-csrf" as const;
/**
 * Gateway-owned browser namespace. Application routers, caches, and service workers must let the
 * browser fetch this exact path and every descendant directly from the network.
 */
export const WORKSTATION_GATEWAY_BROWSER_ROUTE_PREFIX = "/_gateway" as const;
export const WORKSTATION_GATEWAY_LOGIN_PATH = "/_gateway/login" as const;

export const WORKSTATION_GATEWAY_LIMITS = {
  identifierCharacters: 128,
  originCharacters: 2_048,
  endpointCharacters: 4_096,
  policyReferenceCharacters: 256,
} as const;

const GatewayIdentifierSchema = z
  .string()
  .min(1)
  .max(WORKSTATION_GATEWAY_LIMITS.identifierCharacters)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/);

export const ExactHttpsOriginSchema = z
  .string()
  .min(1)
  .max(WORKSTATION_GATEWAY_LIMITS.originCharacters)
  .refine(isExactHttpsOrigin, "Origin must be an exact credential-free HTTPS origin.");

export const IngressProfileKindSchema = z.enum([
  "tailscale-serve",
  "wireguard-direct",
  "trusted-lan",
]);
export const IngressTransportSchema = z.enum(["loopback-proxy", "direct-private-listener"]);
export const TlsOwnerSchema = z.enum(["tailscale", "gateway", "app", "user"]);

export const IngressProfileV0Schema = z.strictObject({
  id: GatewayIdentifierSchema,
  kind: IngressProfileKindSchema,
  targetAppId: GatewayIdentifierSchema,
  browserOrigin: ExactHttpsOriginSchema,
  transport: IngressTransportSchema,
  bindOrUpstream: z
    .string()
    .min(1)
    .max(WORKSTATION_GATEWAY_LIMITS.endpointCharacters)
    .refine((value) => !/[\0\r\n]/.test(value), "Endpoint contains a control character."),
  tlsOwner: TlsOwnerSchema,
  trustedProxyPolicy: z
    .string()
    .min(1)
    .max(WORKSTATION_GATEWAY_LIMITS.policyReferenceCharacters)
    .optional(),
  sourcePolicy: z
    .string()
    .min(1)
    .max(WORKSTATION_GATEWAY_LIMITS.policyReferenceCharacters)
    .optional(),
});
export type IngressProfileV0 = z.infer<typeof IngressProfileV0Schema>;

export const VersionedIngressProfileSchema = z.strictObject({
  version: z.literal(INGRESS_PROFILE_VERSION),
  profile: IngressProfileV0Schema,
});
export type VersionedIngressProfile = z.infer<typeof VersionedIngressProfileSchema>;

export const GatewayAppModeSchema = z.enum(["gateway-managed", "app-managed"]);
export type GatewayAppMode = z.infer<typeof GatewayAppModeSchema>;

export const GatewayBrowserErrorCodeSchema = z.enum([
  "REQUEST_INVALID",
  "ORIGIN_DENIED",
  "AUTHENTICATION_REQUIRED",
  "CSRF_DENIED",
  "BOOTSTRAP_DENIED",
  "PASSKEY_DENIED",
  "APP_UNAVAILABLE",
  "INTERNAL_ERROR",
]);
export type GatewayBrowserErrorCode = z.infer<typeof GatewayBrowserErrorCodeSchema>;

/** Browser-facing, no-store Gateway failure envelope returned before an upstream app responds. */
export const GatewayBrowserFailureResponseV1Schema = z.strictObject({
  version: z.literal(WORKSTATION_GATEWAY_CONTRACT_VERSION),
  ok: z.literal(false),
  error: z.strictObject({
    code: GatewayBrowserErrorCodeSchema,
    message: z.string().min(1).max(500),
    diagnosticId: z.string().min(1).max(256).optional(),
  }),
  requestId: z.string().min(1).max(256),
});
export type GatewayBrowserFailureResponseV1 = z.infer<typeof GatewayBrowserFailureResponseV1Schema>;

export function isWorkstationGatewayBrowserPath(pathname: string): boolean {
  return (
    pathname === WORKSTATION_GATEWAY_BROWSER_ROUTE_PREFIX ||
    pathname.startsWith(`${WORKSTATION_GATEWAY_BROWSER_ROUTE_PREFIX}/`)
  );
}

export const GatewayPrincipalV1Schema = z
  .strictObject({
    version: z.literal(WORKSTATION_GATEWAY_CONTRACT_VERSION),
    iss: GatewayIdentifierSchema,
    aud: GatewayIdentifierSchema,
    sub: GatewayIdentifierSchema,
    authTime: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    methods: z.tuple([z.literal("passkey")]),
    userVerified: z.literal(true),
    origin: ExactHttpsOriginSchema,
    ingressProfile: GatewayIdentifierSchema,
    credentialRef: GatewayIdentifierSchema.optional(),
    tailscaleLogin: z.string().min(1).max(320).optional(),
    issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    assertionId: GatewayIdentifierSchema,
  })
  .superRefine((value, context) => {
    if (value.authTime > value.issuedAt) {
      context.addIssue({
        code: "custom",
        path: ["authTime"],
        message: "authTime must not follow issuedAt.",
      });
    }
    if (value.expiresAt <= value.issuedAt) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "expiresAt must follow issuedAt.",
      });
    }
  });
export type GatewayPrincipalV1 = z.infer<typeof GatewayPrincipalV1Schema>;

export const GATEWAY_V1_TEST_VECTORS = {
  authenticationRequired: {
    version: 1,
    ok: false,
    error: {
      code: "AUTHENTICATION_REQUIRED",
      message: "Gateway authentication is required.",
    },
    requestId: "fixture-request-id",
  },
  principal: {
    version: 1,
    iss: "gateway-instance-fixture",
    aud: "fixture-app",
    sub: "fixture-owner",
    authTime: 1_780_000_000,
    methods: ["passkey"],
    userVerified: true,
    origin: "https://fixture.invalid",
    ingressProfile: "fixture-tailscale",
    credentialRef: "fixture-app-scoped-reference",
    issuedAt: 1_780_000_010,
    expiresAt: 1_780_000_070,
    assertionId: "fixture-assertion-id",
  },
  ingressProfile: {
    version: 0,
    profile: {
      id: "fixture-tailscale",
      kind: "tailscale-serve",
      targetAppId: "fixture-app",
      browserOrigin: "https://fixture.invalid",
      transport: "loopback-proxy",
      bindOrUpstream: "http://127.0.0.1:49100",
      tlsOwner: "tailscale",
      trustedProxyPolicy: "verified-loopback-serve",
    },
  },
} as const;

function isExactHttpsOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.origin === value
    );
  } catch {
    return false;
  }
}
