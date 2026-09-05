import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AuthenticationResponseJSON,
  GenerateAuthenticationOptionsOpts,
  GenerateRegistrationOptionsOpts,
  RegistrationResponseJSON,
  VerifiedAuthenticationResponse,
  VerifiedRegistrationResponse,
} from "@simplewebauthn/server";
import { generateAuthenticationOptions, generateRegistrationOptions } from "@simplewebauthn/server";
import { InMemoryGatewayReplayStore, verifyGatewayAssertion } from "@naru/gateway-verifier";
import { describe, expect, it } from "vitest";
import { GatewayAssertionIssuer } from "../src/assertion-issuer.js";
import { GatewayRepository } from "../src/database.js";
import { GatewayError } from "../src/gateway-error.js";
import { gatewayVerifierKey, loadOrCreateGatewayKeys } from "../src/keys.js";
import { GatewayPasskeyManager, type WebAuthnOperations } from "../src/passkeys.js";
import { GatewaySessionStore } from "../src/sessions.js";
import { createGatewayTestFixture, FakeGatewayClock } from "./support.js";

const RAW_CREDENTIAL_ID = "raw-browser-credential-id-fixture";

class FakeWebAuthn implements WebAuthnOperations {
  registrationOptions?: GenerateRegistrationOptionsOpts;
  authenticationOptions?: GenerateAuthenticationOptionsOpts;
  registrationChallenge?: string;
  authenticationChallenge?: string;
  registrationVerifications = 0;
  authenticationVerifications = 0;
  failRegistration = false;

  async generateRegistrationOptions(
    options: GenerateRegistrationOptionsOpts,
  ): ReturnType<typeof generateRegistrationOptions> {
    this.registrationOptions = options;
    const generated = await generateRegistrationOptions(options);
    this.registrationChallenge = generated.challenge;
    return generated;
  }

  async verifyRegistrationResponse(
    options: Parameters<WebAuthnOperations["verifyRegistrationResponse"]>[0],
  ): Promise<VerifiedRegistrationResponse> {
    await Promise.resolve();
    this.registrationVerifications += 1;
    if (this.failRegistration) throw new Error("fixture registration failure");
    if (!(await challengeMatches(options.expectedChallenge, this.registrationChallenge))) {
      throw new Error("fixture registration challenge mismatch");
    }
    return {
      verified: true,
      registrationInfo: {
        fmt: "none",
        aaguid: "00000000-0000-0000-0000-000000000000",
        credential: {
          id: RAW_CREDENTIAL_ID,
          publicKey: new Uint8Array(new ArrayBuffer(32)),
          counter: 0,
          transports: ["internal"],
        },
        credentialType: "public-key",
        attestationObject: new Uint8Array(new ArrayBuffer(0)),
        userVerified: true,
        credentialDeviceType: "multiDevice",
        credentialBackedUp: true,
        origin: "https://gateway.fixture.invalid",
        rpID: "gateway.fixture.invalid",
      },
    };
  }

  async generateAuthenticationOptions(
    options: GenerateAuthenticationOptionsOpts,
  ): ReturnType<typeof generateAuthenticationOptions> {
    this.authenticationOptions = options;
    const generated = await generateAuthenticationOptions(options);
    this.authenticationChallenge = generated.challenge;
    return generated;
  }

  async verifyAuthenticationResponse(
    options: Parameters<WebAuthnOperations["verifyAuthenticationResponse"]>[0],
  ): Promise<VerifiedAuthenticationResponse> {
    await Promise.resolve();
    this.authenticationVerifications += 1;
    if (!(await challengeMatches(options.expectedChallenge, this.authenticationChallenge))) {
      throw new Error("fixture authentication challenge mismatch");
    }
    return {
      verified: true,
      authenticationInfo: {
        credentialID: RAW_CREDENTIAL_ID,
        newCounter: 1,
        userVerified: true,
        credentialDeviceType: "multiDevice",
        credentialBackedUp: true,
        origin: "https://gateway.fixture.invalid",
        rpID: "gateway.fixture.invalid",
      },
    };
  }
}

async function challengeMatches(
  expected: string | ((challenge: string) => boolean | Promise<boolean>),
  challenge: string | undefined,
): Promise<boolean> {
  if (challenge === undefined) return false;
  return typeof expected === "string" ? expected === challenge : expected(challenge);
}

const registrationResponse = {
  id: RAW_CREDENTIAL_ID,
  rawId: RAW_CREDENTIAL_ID,
  response: {
    clientDataJSON: "fixture",
    attestationObject: "fixture",
    transports: ["internal"],
  },
  type: "public-key",
  clientExtensionResults: {},
} as RegistrationResponseJSON;

const authenticationResponse = {
  id: RAW_CREDENTIAL_ID,
  rawId: RAW_CREDENTIAL_ID,
  response: {
    clientDataJSON: "fixture",
    authenticatorData: "fixture",
    signature: "fixture",
  },
  type: "public-key",
  clientExtensionResults: {},
} as AuthenticationResponseJSON;

function expectGatewayCode(error: unknown, code: GatewayError["code"]): void {
  expect(error).toBeInstanceOf(GatewayError);
  expect((error as GatewayError).code).toBe(code);
}

describe("Gateway passkey and assertion foundation", () => {
  it("uses local single-consume bootstrap, discoverable UV passkeys, and opaque sessions", async () => {
    const { config } = createGatewayTestFixture();
    const clock = new FakeGatewayClock();
    const keys = loadOrCreateGatewayKeys(config.dataDirectory);
    const repository = new GatewayRepository(join(config.dataDirectory, "gateway.sqlite"));
    const sessions = new GatewaySessionStore(repository, keys.sessionDigestKey, config, clock);
    const webauthn = new FakeWebAuthn();
    const manager = new GatewayPasskeyManager(
      repository,
      sessions,
      keys.bootstrapDigestKey,
      keys.ceremonyDigestKey,
      config,
      webauthn,
      clock,
    );

    const intent = manager.createBootstrapIntent("bootstrap");
    expect(readFileSync(join(config.dataDirectory, "gateway.sqlite"), "latin1")).not.toContain(
      intent.code,
    );
    const registration = await manager.beginRegistration(intent.code, config.browserOrigin);
    expect(readFileSync(join(config.dataDirectory, "gateway.sqlite"), "latin1")).not.toContain(
      registration.options.challenge,
    );
    expect(webauthn.registrationOptions?.authenticatorSelection).toMatchObject({
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    });
    await expect(manager.beginRegistration(intent.code, config.browserOrigin)).rejects.toSatisfy(
      (error: unknown) => {
        expectGatewayCode(error, "BOOTSTRAP_DENIED");
        return true;
      },
    );
    const registrationResult = await manager.finishRegistration(config.browserOrigin, {
      ceremonyId: registration.ceremonyId,
      response: registrationResponse,
    });
    expect(registrationResult.credential).not.toHaveProperty("credentialId");
    expect(registrationResult.session.subject).toBe(config.ownerSubject);
    expect(JSON.stringify(manager.listCredentials())).not.toContain(RAW_CREDENTIAL_ID);
    await expect(
      manager.finishRegistration(config.browserOrigin, {
        ceremonyId: registration.ceremonyId,
        response: registrationResponse,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectGatewayCode(error, "PASSKEY_DENIED");
      return true;
    });

    const authentication = await manager.beginAuthentication(config.browserOrigin);
    expect(webauthn.authenticationOptions).toMatchObject({
      rpID: "gateway.fixture.invalid",
      userVerification: "required",
    });
    const session = await manager.finishAuthentication(config.browserOrigin, {
      ceremonyId: authentication.ceremonyId,
      response: authenticationResponse,
    });
    expect(session.token).not.toContain(RAW_CREDENTIAL_ID);
    expect(session.csrfToken).not.toContain(RAW_CREDENTIAL_ID);
    expect(sessions.authenticate(session.token)?.subject).toBe(config.ownerSubject);
    expect(manager.listCredentials()[0]?.lastUsedAt).toBe(clock.nowMs());
    repository.close();
  });

  it("burns a registration challenge on the first failed verification", async () => {
    const { config } = createGatewayTestFixture();
    const clock = new FakeGatewayClock();
    const keys = loadOrCreateGatewayKeys(config.dataDirectory);
    const repository = new GatewayRepository(join(config.dataDirectory, "gateway.sqlite"));
    const sessions = new GatewaySessionStore(repository, keys.sessionDigestKey, config, clock);
    const webauthn = new FakeWebAuthn();
    const manager = new GatewayPasskeyManager(
      repository,
      sessions,
      keys.bootstrapDigestKey,
      keys.ceremonyDigestKey,
      config,
      webauthn,
      clock,
    );
    const intent = manager.createBootstrapIntent("bootstrap");
    const registration = await manager.beginRegistration(intent.code, config.browserOrigin);
    webauthn.failRegistration = true;
    await expect(
      manager.finishRegistration(config.browserOrigin, {
        ceremonyId: registration.ceremonyId,
        response: registrationResponse,
      }),
    ).rejects.toBeInstanceOf(GatewayError);
    webauthn.failRegistration = false;
    await expect(
      manager.finishRegistration(config.browserOrigin, {
        ceremonyId: registration.ceremonyId,
        response: registrationResponse,
      }),
    ).rejects.toBeInstanceOf(GatewayError);
    expect(webauthn.registrationVerifications).toBe(1);
    repository.close();
  });

  it("issues verifier-compatible app-scoped credential references without raw IDs", () => {
    const { config } = createGatewayTestFixture();
    const clock = new FakeGatewayClock();
    const keys = loadOrCreateGatewayKeys(config.dataDirectory);
    const issuer = new GatewayAssertionIssuer(config, keys, clock);
    const app = config.appRegistrations[0];
    if (app?.mode !== "gateway-managed") throw new Error("Fixture managed app is missing.");
    const session = {
      sessionId: "session-fixture",
      subject: config.ownerSubject,
      credentialRecordId: "credential-record-fixture",
      credentialId: RAW_CREDENTIAL_ID,
      authTime: Math.floor(clock.nowMs() / 1_000) - 5,
      expiresAt: clock.nowMs() + 60_000,
      idleExpiresAt: clock.nowMs() + 60_000,
    };
    const issued = issuer.issue(app, session);
    expect(issued.assertion).not.toContain(RAW_CREDENTIAL_ID);
    expect(issued.principal.credentialRef).toMatch(/^cr_[A-Za-z0-9_-]+$/);
    expect(issued.principal.credentialRef).not.toBe(RAW_CREDENTIAL_ID);
    const verifierKey = gatewayVerifierKey(keys);
    expect(
      verifyGatewayAssertion(issued.assertion, {
        expectedIssuer: config.instanceId,
        expectedAudience: app.appId,
        expectedOrigin: config.browserOrigin,
        resolveKey: (keyId) => (keyId === verifierKey.keyId ? verifierKey.publicKeyPem : undefined),
        replayStore: new InMemoryGatewayReplayStore(),
        now: () => Math.floor(clock.nowMs() / 1_000),
      }).principal,
    ).toEqual(issued.principal);
  });
});
