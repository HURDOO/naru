import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectDiscordWebhookConfiguration,
  renderDiscordMaintenancePayload,
  sendDiscordMaintenanceNotification,
  type DiscordMaintenanceNotification,
} from "../src/discord-notifier.js";

const temporaryDirectories: string[] = [];
const fakeWebhookUrl = [
  "https://discord.com/api/webhooks",
  "123456789012345678",
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-",
].join("/");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Discord maintenance notifier", () => {
  it("sends a mention-free embed through a secure Discord webhook with wait enabled", async () => {
    const secretFile = writeSecret(`${fakeWebhookUrl}\n`);
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const fetcher: typeof fetch = (input, init) => {
      requestedUrl = requestUrl(input);
      requestedInit = init;
      return Promise.resolve(
        new Response(JSON.stringify({ id: "987654321098765432" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };

    expect(inspectDiscordWebhookConfiguration(secretFile)).toBe("configured");
    await expect(
      sendDiscordMaintenanceNotification(secretFile, notification("preparing"), { fetch: fetcher }),
    ).resolves.toEqual({ status: "sent", httpStatus: 200 });

    const url = new URL(requestedUrl);
    expect(url.origin + url.pathname).toBe(fakeWebhookUrl);
    expect(url.searchParams.get("wait")).toBe("true");
    expect(requestedInit?.method).toBe("POST");
    expect(requestedInit?.redirect).toBe("error");
    const payload = JSON.parse(requestBody(requestedInit?.body)) as {
      allowed_mentions: { parse: string[] };
      embeds: Array<{ title: string; fields: Array<{ value: string }> }>;
    };
    expect(payload.allowed_mentions.parse).toEqual([]);
    expect(payload.embeds[0]?.title).toContain("운영 작업 시작");
    expect(payload.embeds[0]?.fields.map((field) => field.value)).toContain("PTY 3개");
  });

  it("accepts the handoff environment assignment without exposing it in the payload", async () => {
    const secretFile = writeSecret(
      `DISCORD_WEBHOOK_SECRET_URL=${JSON.stringify(fakeWebhookUrl)}\n`,
    );
    let body = "";
    const fetcher: typeof fetch = (_input, init) => {
      body = requestBody(init?.body);
      return Promise.resolve(
        new Response(JSON.stringify({ id: "987654321098765432" }), { status: 200 }),
      );
    };

    const delivery = await sendDiscordMaintenanceNotification(
      secretFile,
      notification("succeeded"),
      { fetch: fetcher },
    );

    expect(delivery.status).toBe("sent");
    expect(body).not.toContain(fakeWebhookUrl);
    expect(body).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("treats an absent secret as disabled without making a network request", async () => {
    const directory = temporaryDirectory();
    const secretFile = join(directory, "missing.url");
    let calls = 0;
    const fetcher: typeof fetch = () => {
      calls += 1;
      return Promise.reject(new Error("must not fetch"));
    };

    expect(inspectDiscordWebhookConfiguration(secretFile)).toBe("disabled");
    await expect(
      sendDiscordMaintenanceNotification(secretFile, notification("preparing"), { fetch: fetcher }),
    ).resolves.toEqual({ status: "disabled" });
    expect(calls).toBe(0);
  });

  it("rejects permissive, symlinked, and non-Discord secrets without fetching", async () => {
    const secretFile = writeSecret(`${fakeWebhookUrl}\n`);
    const linkedFile = join(realpathSync(join(secretFile, "..")), "linked.url");
    symlinkSync(secretFile, linkedFile);
    chmodSync(secretFile, 0o644);
    let calls = 0;
    const fetcher: typeof fetch = () => {
      calls += 1;
      return Promise.reject(new Error("must not fetch"));
    };

    expect(inspectDiscordWebhookConfiguration(secretFile)).toBe("invalid");
    expect(inspectDiscordWebhookConfiguration(linkedFile)).toBe("invalid");
    await expect(
      sendDiscordMaintenanceNotification(secretFile, notification("failed"), { fetch: fetcher }),
    ).resolves.toEqual({ status: "failed" });

    chmodSync(secretFile, 0o600);
    writeFileSync(
      secretFile,
      "https://example.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ\n",
    );
    expect(inspectDiscordWebhookConfiguration(secretFile)).toBe("invalid");
    expect(calls).toBe(0);
  });

  it("reports HTTP, malformed-response, and network failures without retries or throws", async () => {
    const secretFile = writeSecret(`${fakeWebhookUrl}\n`);
    let calls = 0;
    const rateLimited: typeof fetch = () => {
      calls += 1;
      return Promise.resolve(new Response("rate limited", { status: 429 }));
    };
    await expect(
      sendDiscordMaintenanceNotification(secretFile, notification("failed"), {
        fetch: rateLimited,
      }),
    ).resolves.toEqual({ status: "failed", httpStatus: 429 });
    expect(calls).toBe(1);

    const malformed: typeof fetch = () => Promise.resolve(new Response("{}", { status: 200 }));
    await expect(
      sendDiscordMaintenanceNotification(secretFile, notification("failed"), {
        fetch: malformed,
      }),
    ).resolves.toEqual({ status: "failed", httpStatus: 200 });

    const unavailable: typeof fetch = () =>
      Promise.reject(new Error("network details must stay private"));
    await expect(
      sendDiscordMaintenanceNotification(secretFile, notification("failed"), {
        fetch: unavailable,
      }),
    ).resolves.toEqual({ status: "failed" });
  });

  it("distinguishes rollback and manual recovery without accepting raw errors", () => {
    const rollback = renderDiscordMaintenancePayload(notification("rolled_back"));
    const manualFailure = renderDiscordMaintenancePayload({
      ...notification("failed"),
      manualRecoveryRequired: true,
    });

    expect(rollback.embeds[0]?.title).toContain("롤백");
    expect(manualFailure.embeds[0]?.description).toContain("자동 복구까지 완료되지 않았습니다");
    expect(JSON.stringify(manualFailure)).not.toContain("Error");
  });
});

function notification(
  event: DiscordMaintenanceNotification["event"],
): DiscordMaintenanceNotification {
  const base: DiscordMaintenanceNotification = {
    event,
    phase: event === "preparing" ? "preparation" : "worker",
    action: "deploy",
    activeRelease: "aaaaaaaaaaaa",
    targetRelease: "bbbbbbbbbbbb",
    activePtys: 3,
    occurredAt: "2026-08-18T03:00:00.000Z",
  };
  return event === "preparing" ? base : { ...base, effectiveRelease: "bbbbbbbbbbbb" };
}

function writeSecret(contents: string): string {
  const directory = temporaryDirectory();
  const filename = join(directory, "discord-webhook.url");
  writeFileSync(filename, contents, { mode: 0o600 });
  chmodSync(filename, 0o600);
  return filename;
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "naru-discord-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function requestBody(body: BodyInit | null | undefined): string {
  if (typeof body !== "string") throw new Error("Expected a string request body.");
  return body;
}
