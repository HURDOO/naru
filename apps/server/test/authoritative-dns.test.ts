import { describe, expect, it } from "vitest";
import {
  AuthoritativeDnsError,
  waitForAuthoritativeTxt,
  type AuthoritativeDnsLookup,
} from "../src/authoritative-dns.js";

const expectedValue = "a".repeat(43);

describe("authoritative DNS-01 propagation", () => {
  it("waits until every delegated authoritative nameserver serves the exact TXT value", async () => {
    let now = 0;
    let poll = 0;
    const lookup: AuthoritativeDnsLookup = {
      nameServers() {
        return Promise.resolve(["ns-b.example", "ns-a.example", "ns-a.example"]);
      },
      addresses(nameServer) {
        return Promise.resolve(nameServer === "ns-a.example" ? ["192.0.2.1"] : ["192.0.2.2"]);
      },
      txtValues(address) {
        return Promise.resolve(address === "192.0.2.1" || poll > 0 ? [expectedValue] : []);
      },
    };

    const result = await waitForAuthoritativeTxt({
      zoneName: "example.test",
      recordName: "_acme-challenge.naru.example.test",
      expectedValue,
      timeoutMs: 10_000,
      pollIntervalMs: 1_000,
      lookup,
      now: () => now,
      delay: (milliseconds) => {
        now += milliseconds;
        poll += 1;
        return Promise.resolve();
      },
    });

    expect(result).toEqual({ nameServerCount: 2 });
    expect(poll).toBe(1);
  });

  it("fails closed on timeout without exposing the challenge value", async () => {
    let now = 0;
    const lookup: AuthoritativeDnsLookup = {
      nameServers() {
        return Promise.resolve(["ns-a.example"]);
      },
      addresses() {
        return Promise.resolve(["192.0.2.1"]);
      },
      txtValues() {
        return Promise.resolve([]);
      },
    };

    let captured: unknown;
    try {
      await waitForAuthoritativeTxt({
        zoneName: "example.test",
        recordName: "_acme-challenge.naru.example.test",
        expectedValue,
        timeoutMs: 2_000,
        pollIntervalMs: 1_000,
        lookup,
        now: () => now,
        delay: (milliseconds) => {
          now += milliseconds;
          return Promise.resolve();
        },
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(AuthoritativeDnsError);
    expect(captured).toMatchObject({ code: "DNS_PROPAGATION_TIMEOUT" });
    expect(String(captured)).not.toContain(expectedValue);
  });
});
