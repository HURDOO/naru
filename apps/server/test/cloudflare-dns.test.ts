import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CloudflareDnsClient,
  CloudflareDnsError,
  readCloudflareDnsTokenFile,
} from "../src/cloudflare-dns.js";

const token = "cloudflare-test-token-value-1234567890";
const zoneId = "a".repeat(32);
const recordId = "b".repeat(32);
const challengeName = "_acme-challenge.naru.example.test";
const challengeValue = "c".repeat(43);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Cloudflare DNS token file", () => {
  it("accepts a private raw token or exact supported assignment", () => {
    const raw = tokenFile(`${token}\n`);
    const assignment = tokenFile(`CLOUDFLARE_DNS_API_TOKEN='${token}'\n`);

    expect(readCloudflareDnsTokenFile(raw)).toBe(token);
    expect(readCloudflareDnsTokenFile(assignment)).toBe(token);
  });

  it("rejects permissive, linked, ambiguous, and unsupported files without exposing contents", () => {
    const permissive = tokenFile(`${token}\n`);
    chmodSync(permissive, 0o640);
    expectTokenFileError(permissive);

    const target = tokenFile(`${token}\n`);
    const link = join(realpathSync(join(target, "..")), "token-link.env");
    symlinkSync(target, link);
    expectTokenFileError(link);

    const ambiguous = tokenFile(`${token}\n${"d".repeat(40)}\n`);
    expectTokenFileError(ambiguous);

    const unsupported = tokenFile(`UNRELATED_SECRET=${token}\n`);
    expectTokenFileError(unsupported);
  });
});

describe("Cloudflare DNS adapter", () => {
  it("verifies the exact active zone and only deletes the TXT record it created", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown; authorization?: string }> =
      [];
    const fetchImplementation: typeof fetch = (input, init) => {
      const url = requestUrl(input);
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      requests.push({
        url,
        method,
        ...(body === undefined ? {} : { body }),
        ...(headers.get("authorization") === null
          ? {}
          : { authorization: headers.get("authorization") as string }),
      });
      if (url.endsWith("/user/tokens/verify")) {
        return Promise.resolve(cloudflareResponse({ id: "token-id", status: "active" }));
      }
      if (url.includes("/zones?")) {
        return Promise.resolve(
          cloudflareResponse([{ id: zoneId, name: "example.test", status: "active" }]),
        );
      }
      if (method === "POST") {
        return Promise.resolve(
          cloudflareResponse({ id: recordId, name: challengeName, type: "TXT" }),
        );
      }
      if (method === "DELETE" && url.endsWith(`/${recordId}`)) {
        return Promise.resolve(cloudflareResponse({ id: recordId }));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    };
    const client = new CloudflareDnsClient({
      token,
      zoneName: "example.test",
      challengeName,
      fetchImplementation,
    });

    await client.verifyAccess();
    const created = await client.createTxtRecord(challengeValue);
    await expect(
      client.deleteCreatedTxtRecord({ id: "f".repeat(32), name: challengeName }),
    ).rejects.toMatchObject({ code: "CLOUDFLARE_RECORD_INVALID" });
    await client.deleteCreatedTxtRecord(created);

    expect(requests).toHaveLength(4);
    expect(requests.map((request) => request.method)).toEqual(["GET", "GET", "POST", "DELETE"]);
    expect(requests[2]?.body).toEqual({
      type: "TXT",
      name: challengeName,
      content: challengeValue,
      ttl: 60,
      comment: "Naru ACME DNS-01 temporary challenge",
    });
    expect(requests[3]?.url.endsWith(`/zones/${zoneId}/dns_records/${recordId}`)).toBe(true);
    expect(requests.every((request) => request.authorization === `Bearer ${token}`)).toBe(true);
  });

  it("reports permission failures with a redacted stable code", async () => {
    const fetchImplementation: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ success: false, errors: [{ message: token }] }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      );
    const client = new CloudflareDnsClient({
      token,
      zoneName: "example.test",
      challengeName,
      fetchImplementation,
    });

    let captured: unknown;
    try {
      await client.verifyAccess();
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(CloudflareDnsError);
    expect(captured).toMatchObject({ code: "CLOUDFLARE_TOKEN_SCOPE_INSUFFICIENT" });
    expect(String(captured)).not.toContain(token);
    expect(JSON.stringify(captured)).not.toContain(token);
  });
});

function tokenFile(contents: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "naru-cloudflare-test-")));
  temporaryDirectories.push(directory);
  const filename = join(directory, "cloudflare.env");
  writeFileSync(filename, contents, { mode: 0o600 });
  return filename;
}

function expectTokenFileError(filename: string): void {
  let captured: unknown;
  try {
    readCloudflareDnsTokenFile(filename);
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(CloudflareDnsError);
  expect(captured).toMatchObject({ code: "CLOUDFLARE_TOKEN_FILE_INVALID" });
  expect(String(captured)).not.toContain(token);
}

function cloudflareResponse(result: unknown): Response {
  return new Response(JSON.stringify({ success: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}
