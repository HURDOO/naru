import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  issueAcmeCertificate,
  safeAcmeErrorCode,
  type AcmeRenewalConfig,
} from "../src/acme-renewal.js";
import { AuthoritativeDnsError } from "../src/authoritative-dns.js";
import { readTlsCertificateGeneration } from "../src/tls-certificate.js";
import { createTestTlsState, type TestTlsGeneration, type TestTlsState } from "./tls-fixture.js";

const challengeValue = "v".repeat(43);
const tokenValue = "cloudflare-test-token-value-1234567890";
const PUBLIC_ACME_FIXTURE_HOSTNAME = "naru.example.test";
const PUBLIC_ACME_FIXTURE_ZONE_NAME = "example.test";
const PUBLIC_ACME_FIXTURE_CHALLENGE_NAME = `_acme-challenge.${PUBLIC_ACME_FIXTURE_HOSTNAME}`;
const temporaryStates: TestTlsState[] = [];

afterEach(() => {
  for (const state of temporaryStates.splice(0)) {
    // Test TLS directories contain private keys, so they are removed after each test.
    rmSync(state.root, { recursive: true, force: true });
  }
});

describe("ACME certificate renewal", () => {
  it("rejects a challenge name that does not exactly match the configured hostname", async () => {
    const state = trackedState();
    const certificate = state.createGeneration("fixture-certificate");
    const tokenFile = createTokenFile(state);
    const fake = fakeAcme(certificate);

    await expect(
      issueAcmeCertificate(
        "production",
        { ...config(state, tokenFile), challengeName: "_acme-challenge.other.example.test" },
        { force: true },
        fake.dependencies,
      ),
    ).rejects.toMatchObject({ code: "ACME_STATE_INVALID" });
    expect(fake.events).toEqual([]);
  });

  it("validates staging issuance and removes the untrusted generation instead of publishing it", async () => {
    const state = trackedState();
    const certificate = state.createGeneration("fixture-certificate");
    const tokenFile = createTokenFile(state);
    const fake = fakeAcme(certificate);

    const result = await issueAcmeCertificate(
      "staging",
      config(state, tokenFile),
      { force: true },
      {
        ...fake.dependencies,
        waitForTxt: (options) => {
          expect(options).toMatchObject({
            zoneName: PUBLIC_ACME_FIXTURE_ZONE_NAME,
            recordName: PUBLIC_ACME_FIXTURE_CHALLENGE_NAME,
            expectedValue: challengeValue,
          });
          fake.events.push("propagated");
          return Promise.resolve({ nameServerCount: 2 });
        },
        generationSuffix: () => "test0001",
      },
    );

    expect(result).toMatchObject({
      status: "ok",
      action: "issued",
      environment: "staging",
      hostname: PUBLIC_ACME_FIXTURE_HOSTNAME,
      authoritativeNameServers: 2,
      fingerprint256: certificate.fingerprint256,
    });
    expect(result).not.toHaveProperty("generation");
    expect(readdirSync(join(state.stateDirectory, "generations"))).toEqual(["fixture-certificate"]);
    expect(() => statSync(join(state.stateDirectory, "current.json"))).toThrow();
    expect(statSync(join(state.stateDirectory, "acme", "account.key")).mode & 0o777).toBe(0o600);
    expect(fake.events).toEqual(["verify", "create", "propagated", "delete", "cleanup"]);
  });

  it("atomically publishes a validated production generation", async () => {
    const state = trackedState();
    const certificate = state.createGeneration("fixture-certificate");
    const tokenFile = createTokenFile(state);
    const fake = fakeAcme(certificate);

    const result = await issueAcmeCertificate(
      "production",
      config(state, tokenFile),
      { force: true },
      {
        ...fake.dependencies,
        waitForTxt: () => {
          fake.events.push("propagated");
          return Promise.resolve({ nameServerCount: 2 });
        },
        generationSuffix: () => "test0002",
      },
    );

    expect(result).toMatchObject({
      action: "issued",
      environment: "production",
      fingerprint256: certificate.fingerprint256,
    });
    expect(result.generation).toMatch(/^production-/u);
    const loaded = readTlsCertificateGeneration({
      stateDirectory: state.stateDirectory,
      serverNames: [PUBLIC_ACME_FIXTURE_HOSTNAME],
      reloadIntervalMs: 10_000,
    });
    expect(loaded.generation).toBe(result.generation);
    expect(loaded.fingerprint256).toBe(certificate.fingerprint256);
    expect(statSync(join(state.stateDirectory, "current.json")).mode & 0o777).toBe(0o600);
    expect(
      statSync(join(state.stateDirectory, "generations", loaded.generation)).mode & 0o777,
    ).toBe(0o700);
  });

  it("keeps the prior pointer when a newly issued key and certificate do not match", async () => {
    const state = trackedState();
    const current = state.createGeneration("current");
    const different = state.createGeneration("different");
    state.publish(current.generation);
    const tokenFile = createTokenFile(state);
    const fake = fakeAcme(different, readFileSync(current.privateKeyFile));

    let captured: unknown;
    try {
      await issueAcmeCertificate(
        "production",
        config(state, tokenFile),
        { force: true },
        {
          ...fake.dependencies,
          waitForTxt: () => Promise.resolve({ nameServerCount: 2 }),
          generationSuffix: () => "rejected",
        },
      );
    } catch (error) {
      captured = error;
    }

    expect(safeAcmeErrorCode(captured)).toBe("ACME_ISSUANCE_FAILED");
    const loaded = readTlsCertificateGeneration({
      stateDirectory: state.stateDirectory,
      serverNames: [PUBLIC_ACME_FIXTURE_HOSTNAME],
      reloadIntervalMs: 10_000,
    });
    expect(loaded.generation).toBe(current.generation);
    expect(loaded.fingerprint256).toBe(current.fingerprint256);
    expect(
      readdirSync(join(state.stateDirectory, "generations")).some((entry) =>
        entry.includes("rejected"),
      ),
    ).toBe(false);
  });

  it("cleans its record and does not publish when authoritative propagation times out", async () => {
    const state = trackedState();
    const certificate = state.createGeneration("fixture-certificate");
    const tokenFile = createTokenFile(state);
    const fake = fakeAcme(certificate);

    await expect(
      issueAcmeCertificate(
        "production",
        config(state, tokenFile),
        { force: true },
        {
          ...fake.dependencies,
          waitForTxt: () => Promise.reject(new AuthoritativeDnsError("DNS_PROPAGATION_TIMEOUT")),
        },
      ),
    ).rejects.toMatchObject({ code: "DNS_PROPAGATION_TIMEOUT" });
    expect(fake.events).toEqual(["verify", "create", "delete", "cleanup"]);
    expect(() => statSync(join(state.stateDirectory, "current.json"))).toThrow();
  });

  it("skips DNS and ACME calls while the current certificate is outside the renewal window", async () => {
    const state = trackedState();
    const current = state.createGeneration("current");
    state.publish(current.generation);
    const tokenFile = createTokenFile(state);
    const fake = fakeAcme(current);

    const result = await issueAcmeCertificate(
      "production",
      { ...config(state, tokenFile), renewBeforeMs: 60 * 60 * 1_000 },
      {},
      fake.dependencies,
    );

    expect(result).toMatchObject({
      action: "skipped",
      generation: current.generation,
      fingerprint256: current.fingerprint256,
    });
    expect(fake.events).toEqual([]);
  });
});

function trackedState(): TestTlsState {
  const state = createTestTlsState(PUBLIC_ACME_FIXTURE_HOSTNAME);
  temporaryStates.push(state);
  return state;
}

function createTokenFile(state: TestTlsState): string {
  const filename = join(state.root, "cloudflare.env");
  writeFileSync(filename, `CLOUDFLARE_DNS_API_TOKEN=${tokenValue}\n`, { mode: 0o600 });
  return filename;
}

function config(state: TestTlsState, tokenFile: string): AcmeRenewalConfig {
  return {
    tokenFile,
    stateDirectory: state.stateDirectory,
    repositoryDirectory: process.cwd(),
    hostname: PUBLIC_ACME_FIXTURE_HOSTNAME,
    zoneName: PUBLIC_ACME_FIXTURE_ZONE_NAME,
    challengeName: PUBLIC_ACME_FIXTURE_CHALLENGE_NAME,
    propagationTimeoutMs: 1_000,
  };
}

function fakeAcme(certificate: TestTlsGeneration, certificateKey?: Buffer) {
  const events: string[] = [];
  const activeRecords = new Map<string, { id: string; name: string }>();
  const privateKey = certificateKey ?? readFileSync(certificate.privateKeyFile);
  const certificateChain = readFileSync(certificate.certificateFile, "utf8");
  return {
    events,
    dependencies: {
      createDnsAdapter: (providedToken: string) => ({
        verifyAccess() {
          expect(providedToken).toBe(tokenValue);
          events.push("verify");
          return Promise.resolve();
        },
        createTxtRecord(value: string) {
          expect(value).toBe(challengeValue);
          events.push("create");
          const record = { id: "a".repeat(32), name: PUBLIC_ACME_FIXTURE_CHALLENGE_NAME };
          activeRecords.set(record.id, record);
          return Promise.resolve(record);
        },
        deleteCreatedTxtRecord(record: { id: string; name: string }) {
          expect(activeRecords.get(record.id)).toEqual(record);
          activeRecords.delete(record.id);
          events.push("delete");
          return Promise.resolve();
        },
        cleanupCreatedTxtRecords() {
          expect(activeRecords.size).toBe(0);
          events.push("cleanup");
          return Promise.resolve();
        },
      }),
      issuer: {
        createAccountKey() {
          return Promise.resolve(readFileSync(certificate.privateKeyFile));
        },
        createCertificateKeyAndCsr(hostname: string) {
          expect(hostname).toBe(PUBLIC_ACME_FIXTURE_HOSTNAME);
          return Promise.resolve([privateKey, Buffer.from("test-csr")] as const);
        },
        async issue(
          environment: string,
          _accountKey: Buffer,
          _csr: Buffer,
          hooks: {
            create(challenge: {
              identifier: string;
              type: string;
              id: string;
              keyAuthorization: string;
            }): Promise<void>;
            remove(challenge: {
              identifier: string;
              type: string;
              id: string;
              keyAuthorization: string;
            }): Promise<void>;
          },
        ) {
          expect(["production", "staging"]).toContain(environment);
          const challenge = {
            identifier: PUBLIC_ACME_FIXTURE_HOSTNAME,
            type: "dns-01",
            id: "https://acme.invalid/challenge/1",
            keyAuthorization: challengeValue,
          };
          try {
            await hooks.create(challenge);
            return certificateChain;
          } finally {
            await hooks.remove(challenge);
          }
        },
      },
    },
  };
}
