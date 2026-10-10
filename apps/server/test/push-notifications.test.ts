import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import webPush from "web-push";
import { NaruRepository } from "../src/database.js";
import { WebPushNotificationService } from "../src/push-notifications.js";
import type { RuntimePaneActivityChange } from "../src/pty.js";

const pushConfig = {
  publicKey: Buffer.alloc(65, 1).toString("base64url"),
  privateKey: Buffer.alloc(32, 2).toString("base64url"),
  subject: "https://naru.example.test",
};

describe("WebPushNotificationService", () => {
  it("builds an encrypted aes128gcm VAPID request with the pinned Node-compatible library", () => {
    const sender = createECDH("prime256v1");
    sender.generateKeys();
    const receiver = createECDH("prime256v1");
    receiver.generateKeys();
    const details = webPush.generateRequestDetails(
      {
        endpoint: "https://push.example.test/device",
        expirationTime: null,
        keys: {
          p256dh: receiver.getPublicKey().toString("base64url"),
          auth: randomBytes(16).toString("base64url"),
        },
      },
      JSON.stringify({ version: 1, eventId: randomUUID() }),
      {
        contentEncoding: "aes128gcm",
        TTL: 14_400,
        vapidDetails: {
          subject: "https://naru.example.test",
          publicKey: sender.getPublicKey().toString("base64url"),
          privateKey: sender.getPrivateKey().toString("base64url"),
        },
      },
    );

    expect(details).toMatchObject({
      method: "POST",
      endpoint: "https://push.example.test/device",
    });
    expect(details.body).toBeInstanceOf(Buffer);
    expect(details.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(details.headers.Authorization).toMatch(/^vapid /);
  });

  it("sends only the minimal eligible payload once per subscription and event", async () => {
    const repository = new NaruRepository(":memory:");
    const sender = vi.fn().mockResolvedValue({ statusCode: 201 });
    const service = new WebPushNotificationService(repository, pushConfig, sender);
    try {
      service.subscribe(subscriptionInput());
      const change = activityChange("completed");
      service.handleActivity(change);
      service.handleActivity(change);
      service.handleActivity(activityChange("running"));
      service.handleActivity(activityChange("canceled"));
      service.handleActivity(activityChange("server-stopped"));
      await service.close();

      expect(sender).toHaveBeenCalledTimes(1);
      const [subscription, serializedPayload, options] = sender.mock.calls[0] as [
        Record<string, unknown>,
        string,
        Record<string, unknown>,
      ];
      expect(subscription).toMatchObject({
        endpoint: "https://push.example.test/device",
      });
      const keys = subscription.keys as Record<string, unknown>;
      expect(typeof keys.p256dh).toBe("string");
      expect(typeof keys.auth).toBe("string");
      expect(JSON.parse(serializedPayload)).toEqual({
        version: 1,
        eventId: change.eventId,
        projectId: change.projectId,
        paneId: change.paneId,
        runtimeId: change.runtimeId,
        eventKind: "completed",
      });
      expect(serializedPayload).not.toMatch(/terminal|command|transcript|secret|title|name/i);
      expect(options).toMatchObject({
        TTL: 14_400,
        urgency: "normal",
        timeout: 10_000,
        vapidDetails: pushConfig,
      });
      expect(options.topic).toMatch(/^[A-Za-z0-9_-]{32}$/);
    } finally {
      await service.close();
      repository.close();
    }
  });

  it("uses the project aggregate priority and collapses pending pushes by project", async () => {
    const repository = new NaruRepository(":memory:");
    const sender = vi.fn().mockResolvedValue({ statusCode: 201 });
    const service = new WebPushNotificationService(repository, pushConfig, sender);
    try {
      service.subscribe(subscriptionInput());
      const projectId = randomUUID();
      service.handleActivity(activityChange("completed", "completed", projectId));
      service.handleActivity(activityChange("completed", "failed", projectId));
      service.handleActivity(activityChange("completed", "interaction-required", projectId));
      service.handleActivity(activityChange("failed", "failed", randomUUID()));
      await service.close();

      expect(sender).toHaveBeenCalledTimes(4);
      const calls = sender.mock.calls.map(([, serializedPayload, options]) => ({
        payload: JSON.parse(serializedPayload as string) as Record<string, unknown>,
        options: options as Record<string, unknown>,
      }));
      expect(calls.map(({ payload }) => payload.eventKind)).toEqual([
        "completed",
        "failed",
        "interaction-required",
        "failed",
      ]);
      expect(calls.map(({ options }) => options.urgency)).toEqual([
        "normal",
        "high",
        "high",
        "high",
      ]);
      expect(calls[0]?.options.topic).toBe(calls[1]?.options.topic);
      expect(calls[1]?.options.topic).toBe(calls[2]?.options.topic);
      expect(calls[2]?.options.topic).not.toBe(calls[3]?.options.topic);
    } finally {
      await service.close();
      repository.close();
    }
  });

  it("suppresses every device while the controlling client is recently active", async () => {
    const repository = new NaruRepository(":memory:");
    repository.updatePushInactivityDelayMinutes(5);
    const sender = vi.fn();
    const active = vi.fn(() => true);
    const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const service = new WebPushNotificationService(
      repository,
      pushConfig,
      sender,
      (_level, event, fields) => events.push({ event, fields: { ...fields } }),
      active,
    );
    try {
      service.subscribe(subscriptionInput());
      service.handleActivity(activityChange("completed"));
      await service.close();

      expect(active).toHaveBeenCalledWith(5);
      expect(sender).not.toHaveBeenCalled();
      expect(events).toHaveLength(1);
      expect(events[0]?.event).toBe("push.suppressed");
      expect(events[0]?.fields).toMatchObject({
        reason: "active_client",
        inactivityDelayMinutes: 5,
      });
      expect(JSON.stringify(events)).not.toContain("push.example.test");
    } finally {
      repository.close();
    }
  });

  it("clears a resolved project only on devices that showed its alert", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let now = Date.parse("2026-10-10T00:00:00.000Z");
    const tick = () => vi.setSystemTime((now += 1_000));
    tick();
    const repository = new NaruRepository(":memory:");
    const sender = vi.fn().mockResolvedValue({ statusCode: 201 });
    const service = new WebPushNotificationService(repository, pushConfig, sender);
    try {
      const phone = service.subscribe(subscriptionInput("phone"));
      const tablet = service.subscribe(subscriptionInput("tablet"));
      const projectId = randomUUID();
      service.handleActivity(activityChange("completed", "completed", projectId));
      await service.close();
      tick();
      const laptop = service.subscribe(subscriptionInput("laptop"));
      sender.mockClear();

      // Resolving another project or staying unresolved never clears this project's alert.
      service.handleActivity(activityChange("idle", "idle", randomUUID()));
      service.handleActivity(activityChange("running", "completed", projectId));
      await service.close();
      expect(sender).not.toHaveBeenCalled();

      service.handleActivity(activityChange("idle", "idle", projectId));
      await service.close();
      tick();
      const cleared = sender.mock.calls.map(([subscription, serializedPayload, options]) => ({
        endpoint: (subscription as { endpoint: string }).endpoint,
        payload: JSON.parse(serializedPayload as string) as Record<string, unknown>,
        options: options as Record<string, unknown>,
      }));
      expect(cleared.map(({ endpoint }) => endpoint).sort()).toEqual([
        endpointFor("phone"),
        endpointFor("tablet"),
      ]);
      const clearPayload = cleared[0]?.payload ?? {};
      expect(Object.keys(clearPayload).sort()).toEqual(["eventId", "projectId", "type", "version"]);
      expect(clearPayload).toMatchObject({ version: 1, type: "clear", projectId });
      expect(clearPayload.eventId).toMatch(/^[0-9a-f-]{36}$/);
      expect(cleared[0]?.options).toMatchObject({ urgency: "normal", TTL: 14_400 });
      expect(laptop.id).not.toBe(phone.id);
      expect(tablet.id).not.toBe(phone.id);

      sender.mockClear();
      service.handleActivity(activityChange("running", "running", projectId));
      await service.close();
      expect(sender).not.toHaveBeenCalled();

      tick();
      service.handleActivity(activityChange("failed", "failed", projectId));
      await service.close();
      tick();
      sender.mockClear();
      sender.mockRejectedValueOnce(Object.assign(new Error("unavailable"), { statusCode: 503 }));
      service.handleActivity(activityChange("idle", "idle", projectId));
      await service.close();
      expect(sender).toHaveBeenCalledTimes(3);
      tick();

      // The device whose clear failed is retried on the next resolution; the others are not.
      const failedEndpoint = (sender.mock.calls[0]?.[0] as { endpoint: string }).endpoint;
      sender.mockClear();
      service.handleActivity(activityChange("idle", "idle", projectId));
      await service.close();
      expect(
        sender.mock.calls.map(([subscription]) => (subscription as { endpoint: string }).endpoint),
      ).toEqual([failedEndpoint]);
    } finally {
      await service.close();
      repository.close();
      vi.useRealTimers();
    }
  });

  it("still clears an alert delivered in the same millisecond as the previous clear", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-10T00:00:00.000Z"));
    const repository = new NaruRepository(":memory:");
    const sender = vi.fn().mockResolvedValue({ statusCode: 201 });
    const service = new WebPushNotificationService(repository, pushConfig, sender);
    try {
      service.subscribe(subscriptionInput());
      const projectId = randomUUID();
      for (let round = 0; round < 2; round += 1) {
        service.handleActivity(activityChange("completed", "completed", projectId));
        await service.close();
        sender.mockClear();
        service.handleActivity(activityChange("idle", "idle", projectId));
        await service.close();
        expect(sender).toHaveBeenCalledTimes(1);
      }
    } finally {
      await service.close();
      repository.close();
      vi.useRealTimers();
    }
  });

  it("updates the inactivity delay even when Web Push keys are not configured", () => {
    const repository = new NaruRepository(":memory:");
    const service = new WebPushNotificationService(repository);
    try {
      expect(service.configuration()).toEqual({
        configured: false,
        publicKey: null,
        inactivityDelayMinutes: 2,
      });
      expect(service.updateConfiguration(10)).toEqual({
        configured: false,
        publicKey: null,
        inactivityDelayMinutes: 10,
      });
    } finally {
      repository.close();
    }
  });

  it("removes expired push-service endpoints without logging endpoint details", async () => {
    const repository = new NaruRepository(":memory:");
    const error = Object.assign(new Error("response body with endpoint"), { statusCode: 410 });
    const sender = vi.fn().mockRejectedValue(error);
    const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const service = new WebPushNotificationService(
      repository,
      pushConfig,
      sender,
      (_level, event, fields) => events.push({ event, fields: { ...fields } }),
    );
    try {
      service.subscribe(subscriptionInput());
      service.handleActivity(activityChange("interaction-required"));
      await service.close();

      expect(repository.listPushSubscriptions()).toEqual([]);
      expect(events).toHaveLength(1);
      expect(events[0]?.event).toBe("push.delivery.failed");
      expect(events[0]?.fields).toMatchObject({ statusCode: 410, endpointRemoved: true });
      expect(JSON.stringify(events)).not.toContain("push.example.test");
      expect(JSON.stringify(events)).not.toContain("response body");
    } finally {
      await service.close();
      repository.close();
    }
  });

  it("keeps the existing app usable when VAPID is not configured", async () => {
    const repository = new NaruRepository(":memory:");
    const sender = vi.fn();
    const service = new WebPushNotificationService(repository, undefined, sender);
    try {
      expect(service.configuration()).toEqual({
        configured: false,
        publicKey: null,
        inactivityDelayMinutes: 2,
      });
      expect(() => service.subscribe(subscriptionInput())).toThrowError(
        expect.objectContaining({ code: "PUSH_NOT_CONFIGURED", statusCode: 503 }),
      );
      service.handleActivity(activityChange("failed"));
      await service.close();
      expect(sender).not.toHaveBeenCalled();
    } finally {
      repository.close();
    }
  });
});

function endpointFor(device: string): string {
  return `https://push.example.test/${device}`;
}

function subscriptionInput(device = "device") {
  return {
    name: "Test PWA",
    endpoint: endpointFor(device),
    expirationTime: null,
    keys: {
      p256dh: Buffer.alloc(65, 3).toString("base64url"),
      auth: Buffer.alloc(16, 4).toString("base64url"),
    },
  };
}

function activityChange(
  state: RuntimePaneActivityChange["activity"]["state"],
  projectState: RuntimePaneActivityChange["projectActivity"]["state"] = state,
  projectId = randomUUID(),
): RuntimePaneActivityChange {
  const eventId = randomUUID();
  const runtimeId = randomUUID();
  return {
    eventId,
    projectId,
    paneId: randomUUID(),
    runtimeId,
    activity: {
      state,
      eventId,
      runtimeId,
      revision: 1,
      updatedAt: new Date().toISOString(),
    },
    projectActivity: {
      state: projectState,
      interactionRequiredCount: projectState === "interaction-required" ? 1 : 0,
      updatedAt: new Date().toISOString(),
    },
  };
}
