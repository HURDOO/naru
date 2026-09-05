import type { DurableSessionCallerContext } from "@naru/contracts/durable-session/v0";
import { deriveIntegrationBootstrapKey } from "@naru/durable-session-integration";
import type { HostAppRegistration } from "./config.js";
import { HostOperationError } from "./host-error.js";
import { credentialDigest, credentialMatches, readCredentialFile } from "./security.js";

interface LoadedAppRegistration {
  readonly config: HostAppRegistration;
  readonly credentialDigest: Buffer;
  readonly integrationBootstrapKey: Buffer;
}

export interface AuthenticatedHostOperationCaller {
  readonly caller: DurableSessionCallerContext;
  readonly integrationBootstrapKey: Buffer;
}

export class HostAppRegistry {
  readonly #registrations: ReadonlyMap<string, LoadedAppRegistration>;
  #closed = false;

  constructor(registrations: readonly HostAppRegistration[]) {
    this.#registrations = new Map(
      registrations.map((registration) => {
        const credential = readCredentialFile(registration.credentialFile);
        return [
          registration.appId,
          {
            config: registration,
            credentialDigest: credentialDigest(credential),
            integrationBootstrapKey: deriveIntegrationBootstrapKey(credential),
          },
        ] as const;
      }),
    );
  }

  authenticate(
    appId: string,
    credential: string,
    caller: DurableSessionCallerContext,
    nowMs: number,
  ): DurableSessionCallerContext {
    if (this.#closed) throw denied("Host app registry is closed.");
    const registration = this.#registrations.get(appId);
    if (
      registration === undefined ||
      credential.length > 1_024 ||
      !credentialMatches(credential, registration.credentialDigest)
    ) {
      throw denied("Host app credential was rejected.");
    }
    if (caller.appId !== appId) throw denied("Caller app binding does not match the credential.");
    if (
      caller.expiresAtMs <= nowMs ||
      caller.expiresAtMs > nowMs + registration.config.maxCallerTtlMs
    ) {
      throw denied("Caller context expiry is outside the registered app policy.");
    }
    if (!scopeAllows(registration.config.subjectScope, caller.subject)) {
      throw denied("Caller subject is outside the registered app policy.");
    }
    const allowedCapabilities = new Set(registration.config.capabilities);
    if (caller.capabilities.some((capability) => !allowedCapabilities.has(capability))) {
      throw denied("Caller capability exceeds the registered app policy.");
    }
    if (
      !delegatedScopeAllows(registration.config.sessionScope, caller.sessionScope) ||
      !delegatedScopeAllows(registration.config.profileScope, caller.profileScope) ||
      !delegatedScopeAllows(registration.config.rootScope, caller.rootScope)
    ) {
      throw denied("Caller scope exceeds the registered app policy.");
    }
    return caller;
  }

  authenticateOperation(
    appId: string,
    credential: string,
    caller: DurableSessionCallerContext,
    nowMs: number,
  ): AuthenticatedHostOperationCaller {
    const authenticated = this.authenticate(appId, credential, caller, nowMs);
    const registration = this.#registrations.get(appId);
    if (registration === undefined) throw denied("Host app credential was rejected.");
    return {
      caller: authenticated,
      integrationBootstrapKey: Buffer.from(registration.integrationBootstrapKey),
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const registration of this.#registrations.values()) {
      registration.credentialDigest.fill(0);
      registration.integrationBootstrapKey.fill(0);
    }
  }
}

function scopeAllows(
  scope: { readonly kind: "all" } | { readonly kind: "ids"; readonly ids: readonly string[] },
  id: string,
): boolean {
  return scope.kind === "all" || scope.ids.includes(id);
}

function delegatedScopeAllows(
  allowed: { readonly kind: "all" } | { readonly kind: "ids"; readonly ids: readonly string[] },
  requested: { readonly kind: "all" } | { readonly kind: "ids"; readonly ids: readonly string[] },
): boolean {
  if (allowed.kind === "all") return true;
  if (requested.kind === "all") return false;
  const allowedIds = new Set(allowed.ids);
  return requested.ids.every((id) => allowedIds.has(id));
}

function denied(message: string): HostOperationError {
  return new HostOperationError("CAPABILITY_REQUIRED", message);
}
