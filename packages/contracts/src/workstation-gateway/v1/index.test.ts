import { describe, expect, it } from "vitest";
import { WorkstationGatewayV1 } from "../../index.js";
import {
  ExactHttpsOriginSchema,
  GATEWAY_V1_TEST_VECTORS,
  GatewayBrowserFailureResponseV1Schema,
  GatewayPrincipalV1Schema,
  WORKSTATION_GATEWAY_BROWSER_ROUTE_PREFIX,
  WORKSTATION_GATEWAY_LOGIN_PATH,
  VersionedIngressProfileSchema,
  isWorkstationGatewayBrowserPath,
} from "./index.js";

describe("Workstation Gateway v1 contracts", () => {
  it("accepts the public principal and ingress profile fixtures", () => {
    expect(GatewayPrincipalV1Schema.parse(GATEWAY_V1_TEST_VECTORS.principal)).toEqual(
      GATEWAY_V1_TEST_VECTORS.principal,
    );
    expect(VersionedIngressProfileSchema.parse(GATEWAY_V1_TEST_VECTORS.ingressProfile)).toEqual(
      GATEWAY_V1_TEST_VECTORS.ingressProfile,
    );
    expect(
      GatewayBrowserFailureResponseV1Schema.parse(GATEWAY_V1_TEST_VECTORS.authenticationRequired),
    ).toEqual(GATEWAY_V1_TEST_VECTORS.authenticationRequired);
    expect(WorkstationGatewayV1.GatewayPrincipalV1Schema).toBe(GatewayPrincipalV1Schema);
  });

  it("publishes the browser-owned route and exact failure envelope", () => {
    expect(WORKSTATION_GATEWAY_BROWSER_ROUTE_PREFIX).toBe("/_gateway");
    expect(WORKSTATION_GATEWAY_LOGIN_PATH).toBe("/_gateway/login");
    expect(isWorkstationGatewayBrowserPath("/_gateway")).toBe(true);
    expect(isWorkstationGatewayBrowserPath("/_gateway/login")).toBe(true);
    expect(isWorkstationGatewayBrowserPath("/_gateway-not-reserved")).toBe(false);
    expect(
      GatewayBrowserFailureResponseV1Schema.safeParse({
        ...GATEWAY_V1_TEST_VECTORS.authenticationRequired,
        error: { code: "AUTH_REQUIRED", message: "App-owned code must not be accepted." },
      }).success,
    ).toBe(false);
  });

  it("requires an exact credential-free HTTPS Origin", () => {
    expect(ExactHttpsOriginSchema.safeParse("https://fixture.invalid").success).toBe(true);
    for (const origin of [
      "http://fixture.invalid",
      "https://fixture.invalid/extra",
      "https://fixture.invalid?query=yes",
      ["https://user", "password@fixture.invalid"].join(":"),
      "https://fixture.invalid/",
    ]) {
      expect(ExactHttpsOriginSchema.safeParse(origin).success).toBe(false);
    }
  });

  it("rejects unsupported versions, extra credential material, and invalid time ordering", () => {
    const principal = GATEWAY_V1_TEST_VECTORS.principal;

    expect(GatewayPrincipalV1Schema.safeParse({ ...principal, version: 2 }).success).toBe(false);
    expect(
      GatewayPrincipalV1Schema.safeParse({ ...principal, rawCredential: "inline" }).success,
    ).toBe(false);
    expect(
      GatewayPrincipalV1Schema.safeParse({ ...principal, authTime: principal.issuedAt + 1 })
        .success,
    ).toBe(false);
    expect(
      GatewayPrincipalV1Schema.safeParse({ ...principal, expiresAt: principal.issuedAt }).success,
    ).toBe(false);
    expect(
      VersionedIngressProfileSchema.safeParse({
        ...GATEWAY_V1_TEST_VECTORS.ingressProfile,
        profile: { ...GATEWAY_V1_TEST_VECTORS.ingressProfile.profile, bearerToken: "inline" },
      }).success,
    ).toBe(false);
  });
});
