import { networkInterfaces } from "node:os";
import { lookup } from "node:dns/promises";
import {
  PrivateIpv4AddressSchema,
  type PrivateIngressV0,
} from "../../../packages/contracts/src/private-ingress/v0/index.js";
import {
  TlsMaterialError,
  validateTlsMaterial,
  type ValidatedTlsMaterial,
} from "../../../packages/tls-material/src/index.js";
import { digestJson, type WorkstationInstallationIntentV2 } from "./model.js";

export interface PrivateIngressPreflightCheck {
  readonly id: string;
  readonly status: "ok" | "warning" | "blocked" | "unavailable";
  readonly expected: string;
  readonly actual: string;
  readonly owner: "package" | "user" | "system" | "browser";
  readonly remediation?: string;
}

export interface PrivateIngressPreflightDependencies {
  readonly interfaces: () => readonly {
    readonly address: string;
    readonly family: string | number;
    readonly internal: boolean;
  }[];
  readonly resolveHostname: (
    hostname: string,
  ) => Promise<readonly { readonly address: string; readonly family: number }[]>;
  readonly validateTls: (
    ingress: PrivateIngressV0,
    ownerUid: number,
  ) => Pick<ValidatedTlsMaterial, "revision" | "expiresAt">;
}

export interface PrivateIngressPreflightResult {
  readonly checks: readonly PrivateIngressPreflightCheck[];
  readonly stateFingerprint: string;
}

const DEFAULT_DEPENDENCIES: PrivateIngressPreflightDependencies = {
  interfaces: () =>
    Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .map((entry) => ({
        address: entry.address,
        family: entry.family,
        internal: entry.internal,
      })),
  resolveHostname: async (hostname) => await lookup(hostname, { all: true, verbatim: true }),
  validateTls: (ingress, ownerUid) =>
    validateTlsMaterial(
      {
        approvedRoot: ingress.tls.approvedRoot,
        certificateFile: ingress.tls.certificateFile,
        privateKeyFile: ingress.tls.privateKeyFile,
        serverNames: [new URL(ingress.browserOrigin).hostname],
        allowSymlinkReferences: true,
      },
      { ownerUid },
    ),
};

export async function inspectPrivateIngressPreflight(
  intent: WorkstationInstallationIntentV2,
  overrides: Partial<PrivateIngressPreflightDependencies> = {},
): Promise<PrivateIngressPreflightResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const ingress = intent.ingress;
  const checks: PrivateIngressPreflightCheck[] = [];
  const activeAddresses = [
    ...new Set(
      dependencies
        .interfaces()
        .filter(
          (entry) =>
            (entry.family === "IPv4" || entry.family === 4) &&
            !entry.internal &&
            PrivateIpv4AddressSchema.safeParse(entry.address).success,
        )
        .map((entry) => entry.address),
    ),
  ].sort(compareText);
  const listenerActive = activeAddresses.includes(ingress.listener.host);
  checks.push({
    id: "private-ingress.listener-interface",
    status: listenerActive ? "ok" : "blocked",
    expected: "the exact private listener address is active on a non-loopback local interface",
    actual: listenerActive ? "active exact private interface" : "listener address is not active",
    owner: "system",
    ...(listenerActive
      ? {}
      : { remediation: "Restore the operator-owned private interface and create a new plan." }),
  });

  let dnsAddresses: readonly string[] = [];
  let dnsStatus: PrivateIngressPreflightCheck["status"] = "blocked";
  try {
    const hostname = new URL(ingress.browserOrigin).hostname;
    const answers = await dependencies.resolveHostname(hostname);
    dnsAddresses = [...new Set(answers.map((answer) => answer.address))].sort(compareText);
    const allPrivateIpv4 =
      dnsAddresses.length > 0 &&
      answers.every(
        (answer) =>
          answer.family === 4 && PrivateIpv4AddressSchema.safeParse(answer.address).success,
      );
    const includesListener = dnsAddresses.includes(ingress.listener.host);
    dnsStatus = allPrivateIpv4 && includesListener ? "ok" : "blocked";
    checks.push({
      id: "private-ingress.private-dns",
      status: dnsStatus,
      expected: "private DNS resolves only to private IPv4 and includes the exact listener",
      actual:
        dnsStatus === "ok" ? "private DNS matches listener" : "DNS answer is missing or unsafe",
      owner: "user",
      ...(dnsStatus === "ok"
        ? {}
        : {
            remediation:
              "Repair operator-owned private DNS without adding a public or IPv6 address, then create a new plan.",
          }),
    });
  } catch {
    checks.push({
      id: "private-ingress.private-dns",
      status: "unavailable",
      expected: "private DNS resolves only to private IPv4 and includes the exact listener",
      actual: "DNS inspection unavailable",
      owner: "user",
      remediation: "Restore the operator-owned resolver and create a new plan.",
    });
  }

  let tlsRevision = "invalid";
  let tlsExpiry = "invalid";
  try {
    const material = dependencies.validateTls(ingress, intent.targetUid);
    tlsRevision = material.revision;
    tlsExpiry = material.expiresAt;
    checks.push({
      id: "private-ingress.tls-material",
      status: "ok",
      expected: "owner-private TLS material matches the exact Origin and is currently valid",
      actual: "validated without exposing material or paths",
      owner: "user",
    });
  } catch (error) {
    const code = error instanceof TlsMaterialError ? error.code : "TLS_RELOAD_FAILED";
    checks.push({
      id: "private-ingress.tls-material",
      status: "blocked",
      expected: "owner-private TLS material matches the exact Origin and is currently valid",
      actual: code,
      owner: "user",
      remediation: "Repair the user-owned TLS material and create a new plan.",
    });
  }

  return {
    checks,
    stateFingerprint: digestJson({
      purpose: "naru.private-ingress.preflight-state.v0",
      activeAddresses,
      listenerActive,
      dnsAddresses,
      dnsStatus,
      tlsRevision,
      tlsExpiry,
    }),
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
