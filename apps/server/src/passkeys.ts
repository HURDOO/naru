import { randomUUID } from "node:crypto";
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
import type {
  FinishPasskeyAuthenticationRequest,
  FinishPasskeyRegistrationRequest,
  Passkey,
} from "@naru/contracts";
import { AppError } from "./errors.js";
import type { NaruRepository } from "./database.js";

const CEREMONY_TTL_MS = 5 * 60 * 1_000;
const AUTHENTICATOR_TIMEOUT_MS = 2 * 60 * 1_000;
const MAX_PENDING_CEREMONIES = 64;
const MAX_PASSKEYS = 10;

interface PendingCeremony {
  kind: "authentication" | "registration";
  challenge: string;
  origin: string;
  binding: string;
  expiresAt: number;
}

export interface PasskeyOptions<TOptions> {
  ceremonyId: string;
  options: TOptions;
}

export interface PasskeyService {
  list(): Passkey[];
  beginRegistration(
    sessionBinding: string,
    origin: string,
  ): Promise<PasskeyOptions<PublicKeyCredentialCreationOptionsJSON>>;
  finishRegistration(
    sessionBinding: string,
    origin: string,
    input: FinishPasskeyRegistrationRequest,
  ): Promise<Passkey>;
  beginAuthentication(
    clientBinding: string,
    origin: string,
  ): Promise<PasskeyOptions<PublicKeyCredentialRequestOptionsJSON>>;
  finishAuthentication(
    clientBinding: string,
    origin: string,
    input: FinishPasskeyAuthenticationRequest,
  ): Promise<void>;
  rename(id: string, name: string): Passkey;
  delete(id: string): boolean;
}

interface WebAuthnOperations {
  generateRegistrationOptions: typeof generateRegistrationOptions;
  verifyRegistrationResponse: typeof verifyRegistrationResponse;
  generateAuthenticationOptions: typeof generateAuthenticationOptions;
  verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
}

const DEFAULT_OPERATIONS: WebAuthnOperations = {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
};

export class PasskeyManager implements PasskeyService {
  readonly #pending = new Map<string, PendingCeremony>();

  constructor(
    private readonly repository: NaruRepository,
    private readonly operations: WebAuthnOperations = DEFAULT_OPERATIONS,
    private readonly now: () => number = Date.now,
  ) {}

  list(): Passkey[] {
    return this.repository.listPasskeys();
  }

  async beginRegistration(
    sessionBinding: string,
    origin: string,
  ): Promise<PasskeyOptions<PublicKeyCredentialCreationOptionsJSON>> {
    const credentials = this.repository.listPasskeyCredentials();
    if (credentials.length >= MAX_PASSKEYS) {
      throw new AppError("REQUEST_INVALID", 400, "패스키는 최대 10개까지 등록할 수 있습니다.");
    }
    const options = await this.operations.generateRegistrationOptions({
      rpName: "Naru",
      rpID: rpIdFromOrigin(origin),
      userName: "naru",
      userDisplayName: "Naru",
      userID: this.repository.getOrCreatePasskeyUserId(),
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
    return this.remember("registration", sessionBinding, origin, options.challenge, options);
  }

  async finishRegistration(
    sessionBinding: string,
    origin: string,
    input: FinishPasskeyRegistrationRequest,
  ): Promise<Passkey> {
    const pending = this.consume(input.ceremonyId, "registration", sessionBinding, origin);
    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await this.operations.verifyRegistrationResponse({
        response: input.response as unknown as RegistrationResponseJSON,
        expectedChallenge: pending.challenge,
        expectedOrigin: pending.origin,
        expectedRPID: rpIdFromOrigin(pending.origin),
        requireUserPresence: true,
        requireUserVerification: true,
      });
    } catch {
      throw invalidRegistration();
    }
    if (!verification.verified) throw invalidRegistration();

    const { credential, credentialDeviceType, credentialBackedUp, userVerified } =
      verification.registrationInfo;
    if (!userVerified) throw invalidRegistration();
    return this.repository.createPasskey({
      name: input.name,
      credentialId: credential.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports ?? [],
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
    });
  }

  async beginAuthentication(
    clientBinding: string,
    origin: string,
  ): Promise<PasskeyOptions<PublicKeyCredentialRequestOptionsJSON>> {
    const options = await this.operations.generateAuthenticationOptions({
      rpID: rpIdFromOrigin(origin),
      timeout: AUTHENTICATOR_TIMEOUT_MS,
      userVerification: "required",
    });
    return this.remember("authentication", clientBinding, origin, options.challenge, options);
  }

  async finishAuthentication(
    clientBinding: string,
    origin: string,
    input: FinishPasskeyAuthenticationRequest,
  ): Promise<void> {
    const pending = this.consume(input.ceremonyId, "authentication", clientBinding, origin);
    const passkey = this.repository.getPasskeyByCredentialId(input.response.id);
    if (passkey === undefined) throw invalidAuthentication();

    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await this.operations.verifyAuthenticationResponse({
        response: input.response as unknown as AuthenticationResponseJSON,
        expectedChallenge: pending.challenge,
        expectedOrigin: pending.origin,
        expectedRPID: rpIdFromOrigin(pending.origin),
        credential: {
          id: passkey.credentialId,
          publicKey: passkey.publicKey,
          counter: passkey.counter,
          transports: passkey.transports as AuthenticatorTransportFuture[],
        },
        requireUserVerification: true,
      });
    } catch {
      throw invalidAuthentication();
    }
    if (!verification.verified || !verification.authenticationInfo.userVerified) {
      throw invalidAuthentication();
    }
    const { newCounter, credentialDeviceType, credentialBackedUp } =
      verification.authenticationInfo;
    if (
      !this.repository.updatePasskeyAfterAuthentication(
        passkey.id,
        newCounter,
        credentialDeviceType,
        credentialBackedUp,
      )
    ) {
      throw invalidAuthentication();
    }
  }

  rename(id: string, name: string): Passkey {
    return this.repository.updatePasskeyName(id, name);
  }

  delete(id: string): boolean {
    return this.repository.deletePasskey(id);
  }

  private remember<TOptions>(
    kind: PendingCeremony["kind"],
    binding: string,
    origin: string,
    challenge: string,
    options: TOptions,
  ): PasskeyOptions<TOptions> {
    this.prune();
    while (this.#pending.size >= MAX_PENDING_CEREMONIES) {
      const oldest = this.#pending.keys().next().value;
      if (oldest === undefined) break;
      this.#pending.delete(oldest);
    }
    const ceremonyId = randomUUID();
    this.#pending.set(ceremonyId, {
      kind,
      binding,
      origin,
      challenge,
      expiresAt: this.now() + CEREMONY_TTL_MS,
    });
    return { ceremonyId, options };
  }

  private consume(
    ceremonyId: string,
    kind: PendingCeremony["kind"],
    binding: string,
    origin: string,
  ): PendingCeremony {
    const pending = this.#pending.get(ceremonyId);
    this.#pending.delete(ceremonyId);
    if (
      pending === undefined ||
      pending.expiresAt <= this.now() ||
      pending.kind !== kind ||
      pending.binding !== binding ||
      pending.origin !== origin
    ) {
      if (kind === "authentication") throw invalidAuthentication();
      throw invalidRegistration();
    }
    return pending;
  }

  private prune(): void {
    const now = this.now();
    for (const [id, pending] of this.#pending) {
      if (pending.expiresAt <= now) this.#pending.delete(id);
    }
  }
}

function rpIdFromOrigin(origin: string): string {
  return new URL(origin).hostname;
}

function invalidRegistration(): AppError {
  return new AppError(
    "REQUEST_INVALID",
    400,
    "패스키 등록을 확인하지 못했습니다. 다시 시도해 주세요.",
  );
}

function invalidAuthentication(): AppError {
  return new AppError("AUTH_INVALID", 401, "패스키를 확인하지 못했습니다.");
}
