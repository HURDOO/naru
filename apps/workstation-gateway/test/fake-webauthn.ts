import type {
  GenerateAuthenticationOptionsOpts,
  GenerateRegistrationOptionsOpts,
  VerifiedAuthenticationResponse,
  VerifiedRegistrationResponse,
} from "@simplewebauthn/server";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { WebAuthnOperations } from "../src/passkeys.js";

export const RAW_CREDENTIAL_ID = "raw-browser-credential-id-fixture";

export class FakeWebAuthn implements WebAuthnOperations {
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

export const registrationResponse = {
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

export const authenticationResponse = {
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
