import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type VerifiedAuthenticationResponse,
  type VerifiedRegistrationResponse,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  FinishPasskeyAuthenticationRequest,
  FinishPasskeyRegistrationRequest,
} from "@naru/contracts";
import { describe, expect, it, vi } from "vitest";
import { NaruRepository } from "../src/database.js";
import { PasskeyManager } from "../src/passkeys.js";

const origin = "https://naru.example.test:8443";

describe("PasskeyManager", () => {
  it("binds one-time registration ceremonies to the session and exact Origin", async () => {
    const repository = new NaruRepository(":memory:");
    const verifyRegistration = vi.fn<typeof verifyRegistrationResponse>(async () => {
      await Promise.resolve();
      return registrationVerification();
    });
    const manager = new PasskeyManager(repository, {
      generateRegistrationOptions,
      verifyRegistrationResponse: verifyRegistration,
      generateAuthenticationOptions,
      verifyAuthenticationResponse,
    });
    try {
      const wrongBinding = await manager.beginRegistration("session-one", origin);
      await expect(
        manager.finishRegistration("session-two", origin, {
          ...registrationRequest,
          ceremonyId: wrongBinding.ceremonyId,
        }),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID", statusCode: 400 });
      await expect(
        manager.finishRegistration("session-one", origin, {
          ...registrationRequest,
          ceremonyId: wrongBinding.ceremonyId,
        }),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID", statusCode: 400 });

      const started = await manager.beginRegistration("session-one", origin);
      expect(started.options).toMatchObject({
        rp: { id: "naru.example.test", name: "Naru" },
        authenticatorSelection: {
          residentKey: "required",
          requireResidentKey: true,
          userVerification: "required",
        },
        attestation: "none",
      });
      const created = await manager.finishRegistration("session-one", origin, {
        ...registrationRequest,
        ceremonyId: started.ceremonyId,
      });
      expect(created).toMatchObject({ name: "Galaxy", backedUp: true });
      expect(verifyRegistration).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedChallenge: started.options.challenge,
          expectedOrigin: origin,
          expectedRPID: "naru.example.test",
          requireUserVerification: true,
        }),
      );
      await expect(
        manager.finishRegistration("session-one", origin, {
          ...registrationRequest,
          ceremonyId: started.ceremonyId,
        }),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    } finally {
      repository.close();
    }
  });

  it("uses discoverable credentials, rejects expired ceremonies, and advances the counter", async () => {
    const repository = new NaruRepository(":memory:");
    repository.createPasskey({
      name: "Phone",
      credentialId: authenticationRequest.response.id,
      publicKey: Uint8Array.from([1, 2, 3]),
      counter: 7,
      transports: ["internal"],
      deviceType: "multiDevice",
      backedUp: true,
    });
    let now = 1_000;
    const verifyAuthentication = vi.fn<typeof verifyAuthenticationResponse>(async () => {
      await Promise.resolve();
      return authenticationVerification();
    });
    const manager = new PasskeyManager(
      repository,
      {
        generateRegistrationOptions,
        verifyRegistrationResponse,
        generateAuthenticationOptions,
        verifyAuthenticationResponse: verifyAuthentication,
      },
      () => now,
    );
    try {
      const expired = await manager.beginAuthentication("ip:10.23.45.12", origin);
      expect(expired.options).toMatchObject({
        rpId: "naru.example.test",
        userVerification: "required",
      });
      expect(expired.options.allowCredentials).toBeUndefined();
      now += 5 * 60 * 1_000;
      await expect(
        manager.finishAuthentication("ip:10.23.45.12", origin, {
          ...authenticationRequest,
          ceremonyId: expired.ceremonyId,
        }),
      ).rejects.toMatchObject({ code: "AUTH_INVALID", statusCode: 401 });

      const unknownCredential = await manager.beginAuthentication("ip:10.23.45.12", origin);
      await expect(
        manager.finishAuthentication("ip:10.23.45.12", origin, {
          ...authenticationRequest,
          ceremonyId: unknownCredential.ceremonyId,
          response: {
            ...authenticationRequest.response,
            id: "unknown-credential",
            rawId: "unknown-credential",
          },
        }),
      ).rejects.toMatchObject({ code: "AUTH_INVALID", statusCode: 401 });
      expect(verifyAuthentication).not.toHaveBeenCalled();

      const started = await manager.beginAuthentication("ip:10.23.45.12", origin);
      await manager.finishAuthentication("ip:10.23.45.12", origin, {
        ...authenticationRequest,
        ceremonyId: started.ceremonyId,
      });
      const verificationInput = verifyAuthentication.mock.calls[0]?.[0];
      expect(verificationInput).toMatchObject({
        expectedChallenge: started.options.challenge,
        expectedOrigin: origin,
        expectedRPID: "naru.example.test",
        requireUserVerification: true,
      });
      expect(verificationInput?.credential.counter).toBe(7);
      const authenticated = repository.getPasskeyByCredentialId(authenticationRequest.response.id);
      expect(authenticated).toMatchObject({ counter: 8 });
      expect(typeof authenticated?.lastUsedAt).toBe("string");
      await expect(
        manager.finishAuthentication("ip:10.23.45.12", origin, {
          ...authenticationRequest,
          ceremonyId: started.ceremonyId,
        }),
      ).rejects.toMatchObject({ code: "AUTH_INVALID" });
    } finally {
      repository.close();
    }
  });
});

const registrationRequest: FinishPasskeyRegistrationRequest = {
  ceremonyId: "00000000-0000-4000-8000-000000000001",
  name: "Galaxy",
  response: {
    id: "credential-id",
    rawId: "credential-id",
    response: { clientDataJSON: "client-data", attestationObject: "attestation" },
    type: "public-key",
    clientExtensionResults: {},
  },
};

const authenticationRequest: FinishPasskeyAuthenticationRequest = {
  ceremonyId: "00000000-0000-4000-8000-000000000002",
  response: {
    id: "credential-id",
    rawId: "credential-id",
    response: {
      clientDataJSON: "client-data",
      authenticatorData: "authenticator-data",
      signature: "signature",
      userHandle: null,
    },
    type: "public-key",
    clientExtensionResults: {},
  },
};

function registrationVerification(): VerifiedRegistrationResponse {
  return {
    verified: true,
    registrationInfo: {
      fmt: "none",
      aaguid: "00000000-0000-0000-0000-000000000000",
      credential: {
        id: "credential-id",
        publicKey: Uint8Array.from([1, 2, 3]),
        counter: 0,
        transports: ["internal"],
      },
      credentialType: "public-key",
      attestationObject: Uint8Array.from([4, 5, 6]),
      userVerified: true,
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true,
      origin,
      rpID: "naru.example.test",
    },
  };
}

function authenticationVerification(): VerifiedAuthenticationResponse {
  return {
    verified: true,
    authenticationInfo: {
      credentialID: "credential-id",
      newCounter: 8,
      userVerified: true,
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true,
      origin,
      rpID: "naru.example.test",
    },
  };
}
