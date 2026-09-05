import { PushNotificationPayloadSchema, type PushNotificationPayload } from "@naru/contracts";
import type { NaruApi } from "./api";
import { getPwaServiceWorkerRegistration } from "./pwa";

export interface NotificationTarget {
  projectId: string;
  paneId: string;
  eventId: string;
}

export function browserSupportsPushNotifications(): boolean {
  return (
    "Notification" in window &&
    "PushManager" in window &&
    "serviceWorker" in navigator &&
    window.isSecureContext
  );
}

export function currentNotificationPermission(): NotificationPermission | "unsupported" {
  return browserSupportsPushNotifications() ? Notification.permission : "unsupported";
}

export async function enablePushNotifications(
  api: NaruApi,
  name: string,
): Promise<{ fingerprint: string }> {
  if (!browserSupportsPushNotifications()) {
    throw new Error("이 브라우저에서는 Web Push 알림을 지원하지 않습니다.");
  }
  const configuration = await api.pushConfiguration();
  if (!configuration.configured || configuration.publicKey === null) {
    throw new Error("서버에 Web Push 알림이 아직 설정되지 않았습니다.");
  }
  const registration = await getPwaServiceWorkerRegistration();
  if (registration === null) {
    throw new Error("현재 Naru instance Origin과 일치하는 PWA에서만 알림을 켤 수 있습니다.");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(
      permission === "denied"
        ? "브라우저에서 알림 권한이 차단됐습니다. 사이트 설정에서 허용해 주세요."
        : "알림 권한을 허용하지 않았습니다.",
    );
  }

  const existingSubscription = await registration.pushManager.getSubscription();
  const subscription =
    existingSubscription ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeBase64Url(configuration.publicKey),
    }));
  const serialized = subscription.toJSON();
  const p256dh = serialized.keys?.p256dh;
  const auth = serialized.keys?.auth;
  if (!p256dh || !auth) {
    if (existingSubscription === null) await subscription.unsubscribe().catch(() => false);
    throw new Error("브라우저가 알림 암호화 key를 제공하지 않았습니다.");
  }
  try {
    await api.registerPushSubscription({
      name,
      endpoint: subscription.endpoint,
      expirationTime: subscription.expirationTime,
      keys: { p256dh, auth },
    });
  } catch (error) {
    if (existingSubscription === null) await subscription.unsubscribe().catch(() => false);
    throw error;
  }
  return { fingerprint: await pushEndpointFingerprint(subscription.endpoint) };
}

export async function currentPushSubscriptionFingerprint(): Promise<string | null> {
  if (!browserSupportsPushNotifications()) return null;
  const registration = await getPwaServiceWorkerRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? pushEndpointFingerprint(subscription.endpoint) : null;
}

export async function unsubscribeCurrentPushSubscription(): Promise<boolean> {
  if (!browserSupportsPushNotifications()) return false;
  const registration = await getPwaServiceWorkerRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? subscription.unsubscribe() : false;
}

export function defaultPushDeviceName(): string {
  const platform = navigator.platform.trim();
  return platform ? `${platform} PWA` : "내 PWA";
}

export function notificationTargetFromLocation(): NotificationTarget | null {
  const parameters = new URLSearchParams(window.location.search);
  const projectId = parameters.get("naruProject");
  const paneId = parameters.get("naruPane");
  const eventId = parameters.get("naruEvent");
  if (!isUuid(projectId) || !isUuid(paneId) || !isUuid(eventId)) return null;
  parameters.delete("naruProject");
  parameters.delete("naruPane");
  parameters.delete("naruEvent");
  const query = parameters.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  return { projectId, paneId, eventId };
}

export function listenForNotificationTargets(
  listener: (target: NotificationTarget) => void,
): () => void {
  if (!("serviceWorker" in navigator)) return () => undefined;
  const receive = (event: MessageEvent<unknown>): void => {
    if (
      event.data === null ||
      typeof event.data !== "object" ||
      !("type" in event.data) ||
      event.data.type !== "NARU_PUSH_EVENT" ||
      !("payload" in event.data)
    ) {
      return;
    }
    const parsed = PushNotificationPayloadSchema.safeParse(event.data.payload);
    if (parsed.success) listener(targetFromPayload(parsed.data));
  };
  navigator.serviceWorker.addEventListener("message", receive);
  return () => navigator.serviceWorker.removeEventListener("message", receive);
}

function targetFromPayload(payload: PushNotificationPayload): NotificationTarget {
  return {
    projectId: payload.projectId,
    paneId: payload.paneId,
    eventId: payload.eventId,
  };
}

async function pushEndpointFingerprint(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const decoded = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function isUuid(value: string | null): value is string {
  return (
    value !== null &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
