import { describe, expect, it } from "vitest";
import {
  GATEWAY_BROWSER_LIMITS,
  GatewayAuthenticationRateLimiter,
  hasReservedIdentityHeader,
  rawHeaderBytes,
} from "../src/browser-security.js";

describe("Gateway browser security limits", () => {
  it("bounds authentication requests per actual source and releases the window", () => {
    const limiter = new GatewayAuthenticationRateLimiter();
    const now = 1_780_000_000_000;
    for (
      let attempt = 0;
      attempt < GATEWAY_BROWSER_LIMITS.authenticationAttemptsPerSource;
      attempt += 1
    ) {
      expect(limiter.consume("10.44.0.10", now)).toBe(true);
    }
    expect(limiter.consume("10.44.0.10", now)).toBe(false);
    expect(limiter.consume("10.44.0.11", now)).toBe(true);
    expect(
      limiter.consume("10.44.0.10", now + GATEWAY_BROWSER_LIMITS.authenticationWindowMs + 1),
    ).toBe(true);
  });

  it("applies a global bound across distinct allowed sources", () => {
    const limiter = new GatewayAuthenticationRateLimiter();
    const now = 1_780_000_000_000;
    for (
      let attempt = 0;
      attempt < GATEWAY_BROWSER_LIMITS.authenticationAttemptsGlobal;
      attempt += 1
    ) {
      const third = Math.floor(attempt / 250);
      const fourth = (attempt % 250) + 1;
      expect(limiter.consume(`10.44.${third}.${fourth}`, now)).toBe(true);
    }
    expect(limiter.consume("10.45.0.1", now)).toBe(false);
  });

  it("detects proxy and identity headers while allowing the Gateway CSRF header", () => {
    expect(hasReservedIdentityHeader({ forwarded: "for=203.0.113.9" })).toBe(true);
    expect(hasReservedIdentityHeader({ "x-forwarded-for": "203.0.113.9" })).toBe(true);
    expect(hasReservedIdentityHeader({ "x-workstation-gateway-assertion": "spoofed" })).toBe(true);
    expect(hasReservedIdentityHeader({ "x-durable-session-capability": "spoofed" })).toBe(true);
    expect(hasReservedIdentityHeader({ "x-workstation-gateway-csrf": "allowed-input" })).toBe(
      false,
    );
  });

  it("counts raw header bytes without decoding private values", () => {
    expect(rawHeaderBytes(["host", "gateway.fixture.invalid", "x-fixture", "value"])).toBe(
      Buffer.byteLength("host: gateway.fixture.invalid\r\nx-fixture: value\r\n\r\n"),
    );
  });
});
