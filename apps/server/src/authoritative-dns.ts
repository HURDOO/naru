import { Resolver } from "node:dns/promises";

const DEFAULT_BOOTSTRAP_RESOLVER = "1.1.1.1";

export type AuthoritativeDnsErrorCode = "DNS_DELEGATION_INVALID" | "DNS_PROPAGATION_TIMEOUT";

export class AuthoritativeDnsError extends Error {
  override readonly name = "AuthoritativeDnsError";

  constructor(readonly code: AuthoritativeDnsErrorCode) {
    super(
      code === "DNS_DELEGATION_INVALID"
        ? "Authoritative DNS delegation is invalid."
        : "DNS-01 TXT propagation timed out.",
    );
  }
}

export interface AuthoritativeDnsLookup {
  nameServers(zoneName: string): Promise<readonly string[]>;
  addresses(nameServer: string): Promise<readonly string[]>;
  txtValues(nameServerAddress: string, recordName: string): Promise<readonly string[]>;
}

export interface WaitForAuthoritativeTxtOptions {
  readonly zoneName: string;
  readonly recordName: string;
  readonly expectedValue: string;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly lookup?: AuthoritativeDnsLookup;
  readonly now?: () => number;
  readonly delay?: (milliseconds: number) => Promise<void>;
}

export class NodeAuthoritativeDnsLookup implements AuthoritativeDnsLookup {
  readonly #bootstrap = new Resolver();

  constructor(bootstrapResolver = DEFAULT_BOOTSTRAP_RESOLVER) {
    this.#bootstrap.setServers([bootstrapResolver]);
  }

  async nameServers(zoneName: string): Promise<readonly string[]> {
    return this.#bootstrap.resolveNs(zoneName);
  }

  async addresses(nameServer: string): Promise<readonly string[]> {
    return this.#bootstrap.resolve4(nameServer);
  }

  async txtValues(nameServerAddress: string, recordName: string): Promise<readonly string[]> {
    const authoritative = new Resolver();
    authoritative.setServers([nameServerAddress]);
    const records = await authoritative.resolveTxt(recordName);
    return records.map((segments) => segments.join(""));
  }
}

export async function waitForAuthoritativeTxt(
  options: WaitForAuthoritativeTxtOptions,
): Promise<{ readonly nameServerCount: number }> {
  const lookup = options.lookup ?? new NodeAuthoritativeDnsLookup();
  const now = options.now ?? Date.now;
  const delay = options.delay ?? wait;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  if (timeoutMs < 1 || pollIntervalMs < 1 || options.expectedValue.length === 0) {
    throw new AuthoritativeDnsError("DNS_DELEGATION_INVALID");
  }

  let nameServers: readonly string[];
  let addresses: ReadonlyMap<string, readonly string[]>;
  try {
    nameServers = [...new Set(await lookup.nameServers(options.zoneName))].sort();
    addresses = new Map(
      await Promise.all(
        nameServers.map(
          async (nameServer) =>
            [nameServer, [...new Set(await lookup.addresses(nameServer))]] as const,
        ),
      ),
    );
  } catch {
    throw new AuthoritativeDnsError("DNS_DELEGATION_INVALID");
  }
  if (
    nameServers.length === 0 ||
    nameServers.some((nameServer) => (addresses.get(nameServer)?.length ?? 0) === 0)
  ) {
    throw new AuthoritativeDnsError("DNS_DELEGATION_INVALID");
  }

  const deadline = now() + timeoutMs;
  while (true) {
    const propagated = await Promise.all(
      nameServers.map((nameServer) =>
        nameServerHasValue(
          lookup,
          addresses.get(nameServer) ?? [],
          options.recordName,
          options.expectedValue,
        ),
      ),
    );
    if (propagated.every(Boolean)) return { nameServerCount: nameServers.length };
    const remaining = deadline - now();
    if (remaining <= 0) throw new AuthoritativeDnsError("DNS_PROPAGATION_TIMEOUT");
    await delay(Math.min(pollIntervalMs, remaining));
  }
}

async function nameServerHasValue(
  lookup: AuthoritativeDnsLookup,
  addresses: readonly string[],
  recordName: string,
  expectedValue: string,
): Promise<boolean> {
  for (const address of addresses) {
    try {
      if ((await lookup.txtValues(address, recordName)).includes(expectedValue)) return true;
    } catch {
      // A missing TXT record or a transient authoritative query failure is retried.
    }
  }
  return false;
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
