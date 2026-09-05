import { chmodSync, lstatSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GatewayRepository } from "../src/database.js";
import { loadOrCreateGatewayKeys } from "../src/keys.js";
import { GatewaySessionStore } from "../src/sessions.js";
import { createGatewayTestFixture, FakeGatewayClock } from "./support.js";

describe("Gateway private state", () => {
  it("keeps database and purpose-separated keys private and stable", () => {
    const { config } = createGatewayTestFixture();
    const keys = loadOrCreateGatewayKeys(config.dataDirectory);
    const second = loadOrCreateGatewayKeys(config.dataDirectory);
    expect(second.signingKeyId).toBe(keys.signingKeyId);
    expect(second.bootstrapDigestKey).toEqual(keys.bootstrapDigestKey);
    expect(keys.bootstrapDigestKey).not.toEqual(keys.sessionDigestKey);
    expect(keys.bootstrapDigestKey).not.toEqual(keys.ceremonyDigestKey);
    expect(keys.ceremonyDigestKey).not.toEqual(keys.sessionDigestKey);
    expect(keys.sessionDigestKey).not.toEqual(keys.credentialReferenceKey);
    for (const name of [
      "assertion-signing.pk8.pem",
      "bootstrap-digest.key",
      "ceremony-digest.key",
      "session-digest.key",
      "credential-reference.key",
    ]) {
      expect(lstatSync(join(config.dataDirectory, "keys", name)).mode & 0o777).toBe(0o600);
    }
    const repository = new GatewayRepository(join(config.dataDirectory, "gateway.sqlite"));
    expect(repository.ping()).toBe(true);
    expect(lstatSync(join(config.dataDirectory, "gateway.sqlite")).mode & 0o777).toBe(0o600);
    repository.close();
  });

  it("rejects a symlinked private data directory", () => {
    const { root, config } = createGatewayTestFixture();
    const openDirectory = join(root, "open");
    mkdirSync(openDirectory, { mode: 0o700 });
    chmodSync(root, 0o700);
    symlinkSync(openDirectory, join(root, "linked"));
    expect(() => loadOrCreateGatewayKeys(join(root, "linked"))).toThrow(/symbolic link/);
    expect(config.dataDirectory).not.toBe(join(root, "linked"));
  });

  it("atomically consumes bootstrap codes and ceremonies on the first matching-secret attempt", () => {
    const { config } = createGatewayTestFixture();
    const repository = new GatewayRepository(join(config.dataDirectory, "gateway.sqlite"));
    repository.createBootstrapIntent({
      intentId: "intent-1",
      codeDigest: "digest-1",
      kind: "bootstrap",
      origin: config.browserOrigin,
      createdAt: 1_000,
      expiresAt: 2_000,
    });
    expect(
      repository.consumeBootstrapIntent("digest-1", "https://wrong.invalid", 1_100),
    ).toBeUndefined();
    expect(
      repository.consumeBootstrapIntent("digest-1", config.browserOrigin, 1_100),
    ).toBeUndefined();
    repository.createCeremony({
      ceremonyId: "ceremony-1",
      kind: "registration",
      challengeDigest: "challenge-digest",
      origin: config.browserOrigin,
      createdAt: 1_000,
      expiresAt: 2_000,
    });
    expect(
      repository.consumeCeremony("ceremony-1", "authentication", config.browserOrigin, 1_100),
    ).toBeUndefined();
    expect(
      repository.consumeCeremony("ceremony-1", "registration", config.browserOrigin, 1_100),
    ).toBeUndefined();
    repository.close();
  });
});

describe("Gateway browser sessions", () => {
  it("stores token/CSRF digests, rotates CSRF, and enforces idle and absolute expiry", () => {
    const { config } = createGatewayTestFixture();
    const repository = new GatewayRepository(join(config.dataDirectory, "gateway.sqlite"));
    const clock = new FakeGatewayClock();
    const keys = loadOrCreateGatewayKeys(config.dataDirectory);
    repository.ensureOwner(config.ownerSubject, new Uint8Array(32), clock.nowMs());
    repository.createCredential({
      credentialRecordId: "credential-record-1",
      credentialId: "raw-browser-credential-id",
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      transports: [],
      deviceType: "multiDevice",
      backedUp: true,
      createdAt: clock.nowMs(),
    });
    const sessions = new GatewaySessionStore(repository, keys.sessionDigestKey, config, clock);
    const created = sessions.create({
      subject: config.ownerSubject,
      credentialRecordId: "credential-record-1",
      credentialId: "raw-browser-credential-id",
      authTime: Math.floor(clock.nowMs() / 1_000),
    });
    const databaseBytes = Buffer.from(
      // The database can contain the private credential ID but never raw browser session secrets.
      readFileSync(join(config.dataDirectory, "gateway.sqlite")),
    ).toString("latin1");
    expect(databaseBytes).not.toContain(created.token);
    expect(databaseBytes).not.toContain(created.csrfToken);
    expect(sessions.authenticate(created.token)?.sessionId).toBe(created.sessionId);
    expect(sessions.verifyCsrf(created.token, created.csrfToken)).toBe(true);
    const rotated = sessions.rotateCsrf(created);
    expect(rotated).not.toBe(created.csrfToken);
    expect(sessions.verifyCsrf(created.token, created.csrfToken)).toBe(false);
    expect(sessions.verifyCsrf(created.token, rotated)).toBe(true);
    clock.value += config.sessionIdleTtlMs + 1;
    expect(sessions.authenticate(created.token)).toBeUndefined();
    repository.close();
  });

  it("restores a live session after a Gateway process restart", () => {
    const { config } = createGatewayTestFixture();
    const databasePath = join(config.dataDirectory, "gateway.sqlite");
    const clock = new FakeGatewayClock();
    const keys = loadOrCreateGatewayKeys(config.dataDirectory);
    const firstRepository = new GatewayRepository(databasePath);
    firstRepository.ensureOwner(config.ownerSubject, new Uint8Array(32), clock.nowMs());
    firstRepository.createCredential({
      credentialRecordId: "credential-record-restart",
      credentialId: "restart-browser-credential-id",
      publicKey: new Uint8Array([4, 5, 6]),
      counter: 0,
      transports: [],
      deviceType: "multiDevice",
      backedUp: true,
      createdAt: clock.nowMs(),
    });
    const firstSessions = new GatewaySessionStore(
      firstRepository,
      keys.sessionDigestKey,
      config,
      clock,
    );
    const created = firstSessions.create({
      subject: config.ownerSubject,
      credentialRecordId: "credential-record-restart",
      credentialId: "restart-browser-credential-id",
      authTime: Math.floor(clock.nowMs() / 1_000),
    });
    firstRepository.close();

    const restartedRepository = new GatewayRepository(databasePath);
    const restartedKeys = loadOrCreateGatewayKeys(config.dataDirectory);
    const restartedSessions = new GatewaySessionStore(
      restartedRepository,
      restartedKeys.sessionDigestKey,
      config,
      clock,
    );
    expect(restartedSessions.authenticate(created.token)?.sessionId).toBe(created.sessionId);
    expect(restartedSessions.verifyCsrf(created.token, created.csrfToken)).toBe(true);
    restartedRepository.close();
  });
});
