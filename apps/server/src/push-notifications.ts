import { createHash, randomUUID } from "node:crypto";
import type {
  CreatePushSubscriptionRequest,
  NaruPushSubscription,
  PushClearPayload,
  PushConfiguration,
  PushHandoffPayload,
  PushNotificationPayload,
} from "@naru/contracts";
import {
  PushClearPayloadSchema,
  PushHandoffPayloadSchema,
  PushNotificationPayloadSchema,
} from "@naru/contracts";
import webPush, {
  type PushSubscription as WebPushSubscription,
  type RequestOptions,
} from "web-push";
import type { PushConfig } from "./config.js";
import type { NaruRepository, PushSubscriptionDeliveryRecord } from "./database.js";
import { AppError } from "./errors.js";
import type { RuntimePaneActivityChange } from "./pty.js";

export type PushNotificationEventSink = (
  level: "info" | "warn",
  event: string,
  fields: Readonly<Record<string, string | number | boolean | null>>,
) => void;

export type WebPushSender = (
  subscription: WebPushSubscription,
  payload: string,
  options: RequestOptions,
) => Promise<unknown>;

export interface PushNotificationService {
  configuration(): PushConfiguration;
  updateConfiguration(inactivityDelayMinutes: number): PushConfiguration;
  list(): NaruPushSubscription[];
  subscribe(input: CreatePushSubscriptionRequest): NaruPushSubscription;
  rename(id: string, name: string): NaruPushSubscription;
  delete(id: string): boolean;
  handleActivity(change: RuntimePaneActivityChange): void;
  /** An agent's handoff waits for the person (AP-D004 L4); suppressed while they are here. */
  notifyHandoff(input: {
    readonly projectId: string;
    readonly handoffId: string;
    readonly kind: PushHandoffPayload["handoffKind"];
  }): void;
  close(): Promise<void>;
}

export class WebPushNotificationService implements PushNotificationService {
  readonly #pending = new Set<Promise<void>>();

  constructor(
    private readonly repository: NaruRepository,
    private readonly config?: PushConfig,
    private readonly sender: WebPushSender = webPush.sendNotification,
    private readonly eventSink?: PushNotificationEventSink,
    private readonly hasRecentlyActiveClient: (inactivityDelayMinutes: number) => boolean = () =>
      false,
  ) {}

  configuration(): PushConfiguration {
    return {
      configured: this.config !== undefined,
      publicKey: this.config?.publicKey ?? null,
      inactivityDelayMinutes: this.repository.getPushInactivityDelayMinutes(),
    };
  }

  updateConfiguration(inactivityDelayMinutes: number): PushConfiguration {
    this.repository.updatePushInactivityDelayMinutes(inactivityDelayMinutes);
    return this.configuration();
  }

  list(): NaruPushSubscription[] {
    return this.repository.listPushSubscriptions();
  }

  subscribe(input: CreatePushSubscriptionRequest): NaruPushSubscription {
    if (this.config === undefined) {
      throw new AppError(
        "PUSH_NOT_CONFIGURED",
        503,
        "서버에 Web Push 알림이 아직 설정되지 않았습니다.",
      );
    }
    return this.repository.upsertPushSubscription(input);
  }

  rename(id: string, name: string): NaruPushSubscription {
    return this.repository.updatePushSubscriptionName(id, name);
  }

  delete(id: string): boolean {
    return this.repository.deletePushSubscription(id);
  }

  handleActivity(change: RuntimePaneActivityChange): void {
    if (this.config !== undefined && !ATTENTION_STATES.has(change.projectActivity.state)) {
      this.#track(this.#clearProject(change.projectId));
    }
    if (
      this.config === undefined ||
      change.runtimeId === null ||
      (change.activity.state !== "completed" &&
        change.activity.state !== "interaction-required" &&
        change.activity.state !== "failed")
    ) {
      return;
    }
    const eventKind =
      change.projectActivity.state === "completed" ||
      change.projectActivity.state === "interaction-required" ||
      change.projectActivity.state === "failed"
        ? change.projectActivity.state
        : change.activity.state;
    const inactivityDelayMinutes = this.repository.getPushInactivityDelayMinutes();
    if (this.hasRecentlyActiveClient(inactivityDelayMinutes)) {
      this.eventSink?.("info", "push.suppressed", {
        eventId: change.eventId,
        projectId: change.projectId,
        paneId: change.paneId,
        eventKind,
        reason: "active_client",
        inactivityDelayMinutes,
      });
      return;
    }
    const payload = PushNotificationPayloadSchema.parse({
      version: 1,
      eventId: change.eventId,
      projectId: change.projectId,
      paneId: change.paneId,
      runtimeId: change.runtimeId,
      eventKind,
    });
    this.#track(this.#deliver(payload));
  }

  notifyHandoff(input: {
    readonly projectId: string;
    readonly handoffId: string;
    readonly kind: PushHandoffPayload["handoffKind"];
  }): void {
    if (this.config === undefined) return;
    const eventId = randomUUID();
    const inactivityDelayMinutes = this.repository.getPushInactivityDelayMinutes();
    if (this.hasRecentlyActiveClient(inactivityDelayMinutes)) {
      this.eventSink?.("info", "push.suppressed", {
        eventId,
        projectId: input.projectId,
        eventKind: "handoff",
        reason: "active_client",
        inactivityDelayMinutes,
      });
      return;
    }
    const payload = PushHandoffPayloadSchema.parse({
      version: 1,
      type: "handoff",
      eventId,
      projectId: input.projectId,
      handoffId: input.handoffId,
      handoffKind: input.kind,
    });
    this.#track(this.#deliverHandoff(payload));
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.#pending]);
  }

  async #deliverHandoff(payload: PushHandoffPayload): Promise<void> {
    await Promise.all(
      this.repository.listActivePushSubscriptionRecords().map(async (subscription) => {
        try {
          // Its own topic: a later clear for the project must not replace an undelivered handoff.
          await this.#send(subscription, payload, payload.handoffId, "high");
          this.eventSink?.("info", "push.delivered", {
            eventId: payload.eventId,
            subscriptionId: subscription.id,
          });
        } catch (error) {
          this.eventSink?.("warn", "push.delivery.failed", {
            eventId: payload.eventId,
            subscriptionId: subscription.id,
            statusCode: this.#handleSendFailure(subscription.id, error),
          });
        }
      }),
    );
  }

  #track(delivery: Promise<void>): void {
    this.#pending.add(delivery);
    void delivery.then(
      () => this.#pending.delete(delivery),
      () => this.#pending.delete(delivery),
    );
  }

  // Only devices shown an alert since their last clear receive one; the shared project topic
  // lets a newer alert replace a clear the push service has not delivered yet.
  async #clearProject(projectId: string): Promise<void> {
    const reservations = this.repository.reservePushProjectClears(projectId);
    if (reservations.length === 0) return;
    const eventId = randomUUID();
    await Promise.all(
      reservations.map(async ({ subscription, previousClearedAt, alertEventIds }) => {
        // Each device closes only alerts it was sent, so a newer alert that replaced one keeps.
        const payload: PushClearPayload = PushClearPayloadSchema.parse({
          version: 1,
          type: "clear",
          eventId,
          projectId,
          alertEventIds,
        });
        try {
          await this.#send(subscription, payload, projectId, "normal");
          this.eventSink?.("info", "push.cleared", {
            eventId,
            subscriptionId: subscription.id,
          });
        } catch (error) {
          const statusCode = this.#handleSendFailure(subscription.id, error);
          if (statusCode !== 404 && statusCode !== 410) {
            this.repository.restorePushProjectClear(subscription.id, projectId, previousClearedAt);
          }
          this.eventSink?.("warn", "push.clear.failed", {
            eventId,
            subscriptionId: subscription.id,
            statusCode,
          });
        }
      }),
    );
  }

  async #send(
    subscription: PushSubscriptionDeliveryRecord,
    payload: PushNotificationPayload | PushClearPayload | PushHandoffPayload,
    projectId: string,
    urgency: "normal" | "high",
  ): Promise<void> {
    const config = this.config;
    if (config === undefined) return;
    await this.sender(
      {
        endpoint: subscription.endpoint,
        expirationTime: subscription.expirationTime,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      JSON.stringify(payload),
      {
        TTL: 4 * 60 * 60,
        urgency,
        topic: pushTopic(projectId),
        timeout: 10_000,
        vapidDetails: config,
      },
    );
  }

  #handleSendFailure(subscriptionId: string, error: unknown): number {
    const statusCode = pushStatusCode(error);
    if (statusCode === 404 || statusCode === 410) {
      this.repository.deletePushSubscription(subscriptionId);
    }
    return statusCode;
  }

  async #deliver(payload: PushNotificationPayload): Promise<void> {
    if (this.config === undefined) return;
    const subscriptions = this.repository.listActivePushSubscriptionRecords();
    await Promise.all(
      subscriptions.map(async (subscription) => {
        if (!this.repository.reservePushDelivery(subscription.id, payload)) return;
        try {
          await this.#send(
            subscription,
            payload,
            payload.projectId,
            payload.eventKind === "completed" ? "normal" : "high",
          );
          this.repository.markPushDeliverySent(subscription.id, payload.eventId);
          this.eventSink?.("info", "push.delivered", {
            eventId: payload.eventId,
            subscriptionId: subscription.id,
            eventKind: payload.eventKind,
          });
        } catch (error) {
          const statusCode = this.#handleSendFailure(subscription.id, error);
          this.eventSink?.("warn", "push.delivery.failed", {
            eventId: payload.eventId,
            subscriptionId: subscription.id,
            eventKind: payload.eventKind,
            statusCode,
            endpointRemoved: statusCode === 404 || statusCode === 410,
          });
        }
      }),
    );
  }
}

const ATTENTION_STATES: ReadonlySet<string> = new Set([
  "completed",
  "interaction-required",
  "failed",
]);

function pushTopic(projectId: string): string {
  return createHash("sha256").update(projectId).digest("base64url").slice(0, 32);
}

function pushStatusCode(error: unknown): number {
  if (
    error !== null &&
    typeof error === "object" &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  ) {
    return error.statusCode;
  }
  return 0;
}
