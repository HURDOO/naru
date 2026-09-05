import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { WorkstationGatewayConfig } from "./config.js";
import type { BootstrapIntentKind, GatewayRepository } from "./database.js";
import { GatewayError } from "./gateway-error.js";
import type { GatewayLogger } from "./logging.js";
import { silentGatewayLogger } from "./logging.js";
import { secretEqual } from "./security.js";
import type { CreatedGatewaySession, GatewayClock, GatewaySessionStore } from "./sessions.js";
import { SystemGatewayClock } from "./sessions.js";

const AUTHENTICATOR_TIMEOUT_MS = 2 * 60_000;
const MAX_PASSKEYS = 10;

export interface WebAuthnOperations {
  generateRegistrationOptions: typeof generateRegistrationOptions;
  verifyRegistrationResponse: typeof verifyRegistrationResponse;
  generateAuthenticationOptions: typeof generateAuthenticationOptions;
  verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
}

const DEFAULT_WEBAUTHN: WebAuthnOperations = {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
};

export interface GatewayBootstrapIntent {
  readonly intentId: string;
  readonly kind: BootstrapIntentKind;
  readonly code: string;
  readonly origin: string;
  readonly expiresAt: number;
}

export interface GatewayPasskeyOptions<TOptions> {
  readonly ceremonyId: string;
  readonly options: TOptions;
}

export interface GatewayRegistrationResponse {
  readonly ceremonyId: string;
  readonly response: RegistrationResponseJSON;
}

export interface GatewayAuthenticationResponse {
  readonly ceremonyId: string;
  readonly response: AuthenticationResponseJSON;
}

export interface RedactedGatewayCredential {
  readonly credentialRecordId: string;
  readonly createdAt: number;
  readonly lastUsedAt?: number;
  readonly backedUp: boolean;
}

export interface GatewayRegistrationResult {
  readonly credential: RedactedGatewayCredential;
  readonly session: CreatedGatewaySession;
}

export class GatewayPasskeyManager {
  readonly #origin: string;
  readonly #rpId: string;
  readonly #ownerUserHandle: Uint8Array<ArrayBuffer>;

  constructor(
    private readonly repository: GatewayRepository,
    private readonly sessions: GatewaySessionStore,
    private readonly bootstrapDigestKey: Buffer,
    private readonly ceremonyDigestKey: Buffer,
    private readonly config: WorkstationGatewayConfig,
    private readonly operations: WebAuthnOperations = DEFAULT_WEBAUTHN,
    private readonly clock: GatewayClock = new SystemGatewayClock(),
    private readonly logger: GatewayLogger = silentGatewayLogger,
  ) {
    this.#origin = config.browserOrigin;
    this.#rpId = new URL(config.browserOrigin).hostname;
    this.#ownerUserHandle = repository.ensureOwner(
      config.ownerSubject,
      randomBytes(32),
      clock.nowMs(),
    );
  }

  createBootstrapIntent(kind: BootstrapIntentKind): GatewayBootstrapIntent {
    if (kind === "bootstrap" && this.repository.countActiveCredentials() > 0) {
      throw bootstrapDenied();
    }
    const now = this.clock.nowMs();
    const code = randomBytes(20).toString("base64url");
    const intent = {
      intentId: randomUUID(),
      kind,
      code,
      origin: this.#origin,
      expiresAt: now + this.config.bootstrapTtlMs,
    };
    this.repository.createBootstrapIntent({
      intentId: intent.intentId,
      codeDigest: this.#bootstrapDigest(code),
      kind,
      origin: intent.origin,
      createdAt: now,
      expiresAt: intent.expiresAt,
    });
    this.logger.write({ level: "info", event: "auth.bootstrap-created" });
    return intent;
  }

  async beginRegistration(
    code: string,
    origin: string,
  ): Promise<GatewayPasskeyOptions<PublicKeyCredentialCreationOptionsJSON>> {
    this.#requireOrigin(origin);
    if (code.length < 20 || code.length > 256) throw bootstrapDenied();
    const now = this.clock.nowMs();
    const intent = this.repository.consumeBootstrapIntent(this.#bootstrapDigest(code), origin, now);
    if (intent === undefined) throw bootstrapDenied();
    if (intent.kind === "bootstrap" && this.repository.countActiveCredentials() > 0) {
      throw bootstrapDenied();
    }
    const credentials = this.repository.listActiveCredentials();
    if (credentials.length >= MAX_PASSKEYS) throw bootstrapDenied();
    const options = await this.operations.generateRegistrationOptions({
      rpName: this.config.rpName,
      rpID: this.#rpId,
      userName: this.config.ownerSubject,
      userDisplayName: this.config.ownerSubject,
      userID: this.#ownerUserHandle,
      timeout: AUTHENTICATOR_TIMEOUT_MS,
      attestationType: "none",
      excludeCredentials: credentials.map((credential) => ({
        id: credential.credentialId,
        transports: credential.transports as AuthenticatorTransportFuture[],
      })),
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      },
    });
    const ceremonyId = randomUUID();
    this.repository.createCeremony({
      ceremonyId,
      kind: "registration",
      challengeDigest: this.#challengeDigest(options.challenge),
      origin,
      createdAt: now,
      expiresAt: now + this.config.ceremonyTtlMs,
      bootstrapKind: intent.kind,
    });
    return { ceremonyId, options };
  }

  async finishRegistration(
    origin: string,
    input: GatewayRegistrationResponse,
  ): Promise<GatewayRegistrationResult> {
    this.#requireOrigin(origin);
    const now = this.clock.nowMs();
    const ceremony = this.repository.consumeCeremony(input.ceremonyId, "registration", origin, now);
    if (ceremony === undefined) throw passkeyDenied();
    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await this.operations.verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: (challenge) =>
          secretEqual(ceremony.challengeDigest, this.#challengeDigest(challenge)),
        expectedOrigin: origin,
        expectedRPID: this.#rpId,
        requireUserPresence: true,
        requireUserVerification: true,
      });
    } catch {
      throw passkeyDenied();
    }
    if (!verification.verified || !verification.registrationInfo.userVerified) {
      throw passkeyDenied();
    }
    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    const created = {
      credentialRecordId: randomUUID(),
      credentialId: credential.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports ?? [],
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      createdAt: now,
    };
    try {
      this.repository.createCredential(created);
    } catch {
      throw passkeyDenied();
    }
    const session = this.sessions.create({
      subject: this.config.ownerSubject,
      credentialRecordId: created.credentialRecordId,
      credentialId: created.credentialId,
      authTime: Math.floor(now / 1_000),
    });
    this.logger.write({ level: "info", event: "auth.registration-succeeded" });
    return {
      credential: {
        credentialRecordId: created.credentialRecordId,
        createdAt: created.createdAt,
        backedUp: created.backedUp,
      },
      session,
    };
  }

  async beginAuthentication(
    origin: string,
  ): Promise<GatewayPasskeyOptions<PublicKeyCredentialRequestOptionsJSON>> {
    this.#requireOrigin(origin);
    if (this.repository.countActiveCredentials() === 0) throw passkeyDenied();
    const now = this.clock.nowMs();
    const options = await this.operations.generateAuthenticationOptions({
      rpID: this.#rpId,
      timeout: AUTHENTICATOR_TIMEOUT_MS,
      userVerification: "required",
    });
    const ceremonyId = randomUUID();
    this.repository.createCeremony({
      ceremonyId,
      kind: "authentication",
      challengeDigest: this.#challengeDigest(options.challenge),
      origin,
      createdAt: now,
      expiresAt: now + this.config.ceremonyTtlMs,
    });
    return { ceremonyId, options };
  }

  async finishAuthentication(
    origin: string,
    input: GatewayAuthenticationResponse,
  ): Promise<CreatedGatewaySession> {
    this.#requireOrigin(origin);
    const now = this.clock.nowMs();
    const ceremony = this.repository.consumeCeremony(
      input.ceremonyId,
      "authentication",
      origin,
      now,
    );
    if (ceremony === undefined) throw passkeyDenied();
    const credential = this.repository.getActiveCredentialByRawId(input.response.id);
    if (credential === undefined) throw passkeyDenied();
    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await this.operations.verifyAuthenticationResponse({
        response: input.response,
        expectedChallenge: (challenge) =>
          secretEqual(ceremony.challengeDigest, this.#challengeDigest(challenge)),
        expectedOrigin: origin,
        expectedRPID: this.#rpId,
        credential: {
          id: credential.credentialId,
          publicKey: credential.publicKey,
          counter: credential.counter,
          transports: credential.transports as AuthenticatorTransportFuture[],
        },
        requireUserVerification: true,
      });
    } catch {
      throw passkeyDenied();
    }
    if (!verification.verified || !verification.authenticationInfo.userVerified) {
      throw passkeyDenied();
    }
    const { newCounter, credentialDeviceType, credentialBackedUp } =
      verification.authenticationInfo;
    if (
      !this.repository.updateCredentialAfterAuthentication({
        credentialRecordId: credential.credentialRecordId,
        counter: newCounter,
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        now,
      })
    ) {
      throw passkeyDenied();
    }
    const session = this.sessions.create({
      subject: this.config.ownerSubject,
      credentialRecordId: credential.credentialRecordId,
      credentialId: credential.credentialId,
      authTime: Math.floor(now / 1_000),
    });
    this.logger.write({ level: "info", event: "auth.authentication-succeeded" });
    return session;
  }

  listCredentials(): RedactedGatewayCredential[] {
    return this.repository.listActiveCredentials().map((credential) => ({
      credentialRecordId: credential.credentialRecordId,
      createdAt: credential.createdAt,
      ...(credential.lastUsedAt === undefined ? {} : { lastUsedAt: credential.lastUsedAt }),
      backedUp: credential.backedUp,
    }));
  }

  #requireOrigin(origin: string): void {
    if (origin !== this.#origin) throw new GatewayError("ORIGIN_DENIED", 403, "Origin denied.");
  }

  #bootstrapDigest(code: string): string {
    return createHmac("sha256", this.bootstrapDigestKey)
      .update("bootstrap-code")
      .update("\0")
      .update(code)
      .digest("base64url");
  }

  #challengeDigest(challenge: string): string {
    return createHmac("sha256", this.ceremonyDigestKey)
      .update("webauthn-challenge")
      .update("\0")
      .update(challenge)
      .digest("base64url");
  }
}

function bootstrapDenied(): GatewayError {
  return new GatewayError(
    "BOOTSTRAP_DENIED",
    400,
    "Gateway bootstrap or recovery intent is invalid.",
  );
}

function passkeyDenied(): GatewayError {
  return new GatewayError("PASSKEY_DENIED", 400, "Gateway passkey ceremony is invalid.");
}
