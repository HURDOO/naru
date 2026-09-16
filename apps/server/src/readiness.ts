import { isLoopbackHost, isValidSessionCookieName, type AppConfig } from "./config.js";
import { parseNaruAppBasePath } from "@naru/contracts/naru-app/v1";

export type CheckStatus = "ok" | "failed";

export interface ReadinessChecks {
  configuration: CheckStatus;
  database: CheckStatus;
  tls?: CheckStatus;
  sessionRuntime?: CheckStatus;
}

export function configurationReadiness(config: AppConfig): CheckStatus {
  const authenticationValid =
    config.authMode === "app-managed"
      ? config.passwordHash.length > 0 &&
        config.sessionSecret.length >= 32 &&
        isValidSessionCookieName(config.sessionCookieName) &&
        config.secureCookie === (config.tls !== undefined)
      : config.host === "127.0.0.1" &&
        config.secureCookie === false &&
        config.tls === undefined &&
        config.allowedClientIps === undefined &&
        config.allowedOrigins.size === 1 &&
        config.allowedOrigins.has(config.gatewayAuth.origin) &&
        isHttpsOrigin(config.gatewayAuth.origin) &&
        config.gatewayAuth.verifierKeys.size > 0 &&
        config.sessionRuntime?.owner === "durable-host" &&
        config.sessionRuntime.appId === config.gatewayAuth.audience &&
        config.sessionRuntime.subject === config.gatewayAuth.ownerSubject;
  const valid =
    config.allowedOrigins.size > 0 &&
    config.projectRoots.length > 0 &&
    authenticationValid &&
    config.host.length > 0 &&
    (isLoopbackHost(config.host) || (config.allowedClientIps?.size ?? 0) > 0) &&
    Number.isInteger(config.port) &&
    config.port > 0 &&
    isCanonicalAppBasePath(config.appBasePath) &&
    (config.authMode === "gateway-managed" || config.appBasePath === "/");
  return valid ? "ok" : "failed";
}

function isCanonicalAppBasePath(value: string): boolean {
  try {
    return parseNaruAppBasePath(value) === value;
  } catch {
    return false;
  }
}

export function readinessStatus(checks: ReadinessChecks): "ready" | "not_ready" {
  return checks.configuration === "ok" &&
    checks.database === "ok" &&
    checks.tls !== "failed" &&
    checks.sessionRuntime !== "failed"
    ? "ready"
    : "not_ready";
}

function isHttpsOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.origin === value;
  } catch {
    return false;
  }
}
