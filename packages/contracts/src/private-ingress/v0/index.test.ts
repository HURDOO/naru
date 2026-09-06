import { describe, expect, it } from "vitest";
import { PrivateIngressV0 as PrivateIngressV0Namespace } from "../../index.js";
import {
  GATEWAY_INGRESS_V0_JSON_SCHEMA,
  GatewayIngressV0Schema,
  PRIVATE_INGRESS_V0_DIGEST_ALGORITHM,
  PRIVATE_INGRESS_V0_JSON_SCHEMA,
  PrivateIngressSourcePolicyV0Schema,
  PrivateIngressV0Schema,
  canonicalizePrivateIngressV0,
  digestPrivateIngressIntentV0,
  redactPrivateIngressV0,
} from "./index.js";
import {
  PRIVATE_INGRESS_V0_DIGEST_TEST_VECTOR,
  PRIVATE_INGRESS_V0_REDACTION_TEST_VECTOR,
  PRIVATE_INGRESS_V0_TEST_VECTORS,
} from "./test-vectors.js";

describe("Private Ingress v0 contract", () => {
  it("accepts the public loopback, WireGuard, and trusted-LAN fixtures", () => {
    for (const fixture of Object.values(PRIVATE_INGRESS_V0_TEST_VECTORS.accepted)) {
      expect(GatewayIngressV0Schema.parse(fixture)).toEqual(fixture);
    }
    expect(
      PrivateIngressV0Schema.parse(PRIVATE_INGRESS_V0_TEST_VECTORS.accepted.wireguardDirect),
    ).toMatchObject({
      contractVersion: "private-ingress.v0",
      kind: "direct-private-tls",
      sourcePolicy: {
        allowedAddresses: ["10.44.0.10"],
        allowedCidrs: ["10.45.0.0/24"],
      },
    });
    expect(PrivateIngressV0Namespace.PrivateIngressV0Schema).toBe(PrivateIngressV0Schema);
  });

  it("strictly rejects cross-mode and unsafe public fixtures", () => {
    for (const fixture of Object.values(PRIVATE_INGRESS_V0_TEST_VECTORS.rejected)) {
      expect(GatewayIngressV0Schema.safeParse(fixture).success).toBe(false);
    }
  });

  it("accepts exact private IPv4 and canonical private CIDRs, including mixed policies", () => {
    expect(
      PrivateIngressSourcePolicyV0Schema.parse({
        mode: "private-ipv4-allowlist",
        allowedAddresses: ["10.0.1.2", "172.16.4.8"],
        allowedCidrs: ["10.0.2.0/24", "192.168.0.0/16"],
      }),
    ).toEqual({
      mode: "private-ipv4-allowlist",
      allowedAddresses: ["10.0.1.2", "172.16.4.8"],
      allowedCidrs: ["10.0.2.0/24", "192.168.0.0/16"],
    });
  });

  it("rejects empty, duplicate, overlapping, public, noncanonical, and IPv6 source policies", () => {
    for (const sourcePolicy of [
      { mode: "private-ipv4-allowlist", allowedAddresses: [], allowedCidrs: [] },
      {
        mode: "private-ipv4-allowlist",
        allowedAddresses: ["10.0.0.2", "10.0.0.2"],
        allowedCidrs: [],
      },
      {
        mode: "private-ipv4-allowlist",
        allowedAddresses: [],
        allowedCidrs: ["10.0.0.0/24", "10.0.0.0/25"],
      },
      {
        mode: "private-ipv4-allowlist",
        allowedAddresses: ["10.0.0.2"],
        allowedCidrs: ["10.0.0.0/24"],
      },
      {
        mode: "private-ipv4-allowlist",
        allowedAddresses: ["203.0.113.2"],
        allowedCidrs: [],
      },
      {
        mode: "private-ipv4-allowlist",
        allowedAddresses: [],
        allowedCidrs: ["10.0.0.1/24"],
      },
      {
        mode: "private-ipv4-allowlist",
        allowedAddresses: ["fd00::2"],
        allowedCidrs: [],
      },
      {
        mode: "private-ipv4-allowlist",
        allowedAddresses: [],
        allowedCidrs: ["fd00::/64"],
      },
      {
        mode: "private-ipv4-allowlist",
        allowedAddresses: [],
        allowedCidrs: ["10.0.0.0/7"],
      },
      {
        mode: "private-ipv4-allowlist",
        allowedAddresses: [],
        allowedCidrs: ["172.16.0.0/11"],
      },
      {
        mode: "private-ipv4-allowlist",
        allowedAddresses: [],
        allowedCidrs: ["192.168.0.0/15"],
      },
      {
        mode: "private-ipv4-allowlist",
        allowedAddresses: [],
        allowedCidrs: ["10.0.0.0/08"],
      },
    ]) {
      expect(PrivateIngressSourcePolicyV0Schema.safeParse(sourcePolicy).success).toBe(false);
    }
  });

  it("requires exact Origin/listener port ownership and strict TLS path ownership", () => {
    const fixture = PRIVATE_INGRESS_V0_TEST_VECTORS.accepted.wireguardDirect;
    for (const browserOrigin of [
      "http://naru.fixture.invalid:8443",
      "https://naru.fixture.invalid:8443/",
      "https://naru.fixture.invalid:8443/path",
      "https://naru.fixture.invalid:8443?query=yes",
      "https://127.0.0.1:8443",
    ]) {
      expect(PrivateIngressV0Schema.safeParse({ ...fixture, browserOrigin }).success).toBe(false);
    }
    expect(
      PrivateIngressV0Schema.safeParse({
        ...fixture,
        listener: { ...fixture.listener, port: 9443 },
      }).success,
    ).toBe(false);
    expect(
      PrivateIngressV0Schema.safeParse({
        ...fixture,
        tls: { ...fixture.tls, certificateFile: "/private/tmp/outside/full-chain.pem" },
      }).success,
    ).toBe(false);
    expect(
      PrivateIngressV0Schema.safeParse({
        ...fixture,
        tls: { ...fixture.tls, privateKeyFile: fixture.tls.certificateFile },
      }).success,
    ).toBe(false);
  });

  it("exports strict JSON Schema artifacts for both direct and adapter contracts", () => {
    expect(PRIVATE_INGRESS_V0_JSON_SCHEMA).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
    });
    expect(GATEWAY_INGRESS_V0_JSON_SCHEMA).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
    });
    const json = JSON.stringify(GATEWAY_INGRESS_V0_JSON_SCHEMA);
    expect(json).toContain("loopback-proxy");
    expect(json).toContain("direct-private-tls");
    expect(json).toContain('"additionalProperties":false');
  });

  it("redacts path and topology values while retaining ownership and bounded counts", () => {
    const fixture = PRIVATE_INGRESS_V0_REDACTION_TEST_VECTOR.intent;
    const redacted = redactPrivateIngressV0(fixture);
    expect(redacted).toEqual(PRIVATE_INGRESS_V0_REDACTION_TEST_VECTOR.expected);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(fixture.browserOrigin);
    expect(serialized).not.toContain(fixture.listener.host);
    expect(serialized).not.toContain(fixture.tls.approvedRoot);
    expect(serialized).not.toContain(fixture.sourcePolicy.allowedAddresses[0] ?? "missing");
    expect(serialized).not.toContain(fixture.sourcePolicy.allowedCidrs[0] ?? "missing");

    const rejected = PrivateIngressV0Schema.safeParse(
      PRIVATE_INGRESS_V0_TEST_VECTORS.rejected.inlinePrivateKey,
    );
    expect(rejected.success).toBe(false);
    if (!rejected.success) {
      expect(JSON.stringify(rejected.error.issues)).not.toContain(
        "fixture-secret-must-not-surface",
      );
    }
  });

  it("canonicalizes set-like sources and freezes the receipt intent digest", async () => {
    expect(PRIVATE_INGRESS_V0_DIGEST_ALGORITHM).toBe("sha256");
    const fixture = PRIVATE_INGRESS_V0_TEST_VECTORS.accepted.wireguardDirect;
    const reordered = {
      ...fixture,
      sourcePolicy: {
        ...fixture.sourcePolicy,
        allowedAddresses: ["192.168.2.2", "10.44.0.10"],
        allowedCidrs: ["192.168.3.0/24", "10.45.0.0/24"],
      },
    };
    const canonical = canonicalizePrivateIngressV0(reordered);
    expect(canonical.sourcePolicy.allowedAddresses).toEqual(["10.44.0.10", "192.168.2.2"]);
    expect(canonical.sourcePolicy.allowedCidrs).toEqual(["10.45.0.0/24", "192.168.3.0/24"]);

    const reverseOrder = {
      ...reordered,
      sourcePolicy: {
        ...reordered.sourcePolicy,
        allowedAddresses: [...reordered.sourcePolicy.allowedAddresses].reverse(),
        allowedCidrs: [...reordered.sourcePolicy.allowedCidrs].reverse(),
      },
    };
    await expect(digestPrivateIngressIntentV0(reordered)).resolves.toBe(
      await digestPrivateIngressIntentV0(reverseOrder),
    );
    await expect(
      digestPrivateIngressIntentV0(PRIVATE_INGRESS_V0_DIGEST_TEST_VECTOR.intent),
    ).resolves.toBe(PRIVATE_INGRESS_V0_DIGEST_TEST_VECTOR.expectedSha256);
  });
});
