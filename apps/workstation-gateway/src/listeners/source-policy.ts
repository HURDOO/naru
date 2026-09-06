import type { TLSSocket } from "node:tls";
import {
  PrivateIngressSourcePolicyV0Schema,
  type PrivateIngressSourcePolicyV0,
} from "@naru/contracts/private-ingress/v0";

export interface GatewaySecureConnectionServer {
  prependListener(event: "secureConnection", listener: (socket: TLSSocket) => void): unknown;
}

interface Ipv4Range {
  readonly start: number;
  readonly end: number;
}

export class PrivateIpv4SourceAdmission {
  readonly #addresses: ReadonlySet<number>;
  readonly #ranges: readonly Ipv4Range[];

  constructor(policy: PrivateIngressSourcePolicyV0) {
    const validated = PrivateIngressSourcePolicyV0Schema.parse(policy);
    this.#addresses = new Set(
      validated.allowedAddresses.map((address) => requiredCanonicalIpv4(address)),
    );
    this.#ranges = validated.allowedCidrs.map(cidrRange);
  }

  allows(remoteAddress: string | undefined): boolean {
    if (remoteAddress === undefined) return false;
    const numeric = parseCanonicalIpv4(remoteAddress);
    return (
      numeric !== undefined &&
      (this.#addresses.has(numeric) ||
        this.#ranges.some((range) => numeric >= range.start && numeric <= range.end))
    );
  }
}

export function installPrivateIpv4SourceAdmission(
  server: GatewaySecureConnectionServer,
  admission: PrivateIpv4SourceAdmission,
): void {
  server.prependListener("secureConnection", (socket) => {
    if (!admission.allows(socket.remoteAddress)) socket.destroy();
  });
}

function cidrRange(cidr: string): Ipv4Range {
  const [address, prefixSource] = cidr.split("/");
  const start = requiredCanonicalIpv4(address ?? "");
  const prefix = Number(prefixSource);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error("Private IPv4 source CIDR must be validated before use.");
  }
  return { start, end: start + 2 ** (32 - prefix) - 1 };
}

function requiredCanonicalIpv4(value: string): number {
  const parsed = parseCanonicalIpv4(value);
  if (parsed === undefined) {
    throw new Error("Private IPv4 source address must be validated before use.");
  }
  return parsed;
}

function parseCanonicalIpv4(value: string): number | undefined {
  const parts = value.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)
  ) {
    return undefined;
  }
  const [first, second, third, fourth] = parts.map(Number);
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) {
    return undefined;
  }
  return ((first * 256 + second) * 256 + third) * 256 + fourth;
}
