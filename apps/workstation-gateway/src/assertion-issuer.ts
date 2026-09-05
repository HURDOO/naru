import { createHmac, randomUUID } from "node:crypto";
import type { GatewayPrincipalV1 } from "@naru/contracts/workstation-gateway/v1";
import { createGatewayAssertion } from "@naru/gateway-verifier";
import type { GatewayManagedAppRegistration, WorkstationGatewayConfig } from "./config.js";
import type { GatewayKeys } from "./keys.js";
import type { AuthenticatedGatewaySession, GatewayClock } from "./sessions.js";
import { SystemGatewayClock } from "./sessions.js";

export interface IssuedGatewayAssertion {
  readonly assertion: string;
  readonly principal: GatewayPrincipalV1;
}

export class GatewayAssertionIssuer {
  constructor(
    private readonly config: WorkstationGatewayConfig,
    private readonly keys: GatewayKeys,
    private readonly clock: GatewayClock = new SystemGatewayClock(),
  ) {}

  issue(
    app: GatewayManagedAppRegistration,
    session: AuthenticatedGatewaySession,
  ): IssuedGatewayAssertion {
    const issuedAt = Math.floor(this.clock.nowMs() / 1_000);
    const principal: GatewayPrincipalV1 = {
      version: 1,
      iss: this.config.instanceId,
      aud: app.appId,
      sub: session.subject,
      authTime: session.authTime,
      methods: ["passkey"],
      userVerified: true,
      origin: this.config.browserOrigin,
      ingressProfile: this.config.ingressProfileId,
      ...(app.includeCredentialRef
        ? { credentialRef: this.#credentialReference(app.appId, session.credentialId) }
        : {}),
      issuedAt,
      expiresAt: issuedAt + this.config.principalTtlSeconds,
      assertionId: randomUUID(),
    };
    return {
      assertion: createGatewayAssertion(
        principal,
        this.keys.signingKeyId,
        this.keys.signingPrivateKey,
      ),
      principal,
    };
  }

  #credentialReference(appId: string, credentialId: string): string {
    return `cr_${createHmac("sha256", this.keys.credentialReferenceKey)
      .update("credential-reference")
      .update("\0")
      .update(appId)
      .update("\0")
      .update(credentialId)
      .digest("base64url")}`;
  }
}
