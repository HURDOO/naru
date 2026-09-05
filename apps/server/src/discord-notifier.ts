import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseEnv } from "node:util";

const DISCORD_WEBHOOK_SECRET_KEY = "DISCORD_WEBHOOK_SECRET_URL";
const MAX_SECRET_FILE_BYTES = 4 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const DISCORD_WEBHOOK_HOSTS = new Set(["discord.com", "canary.discord.com", "ptb.discord.com"]);
const DISCORD_WEBHOOK_PATH =
  /^\/api(?:\/v\d{1,2})?\/webhooks\/[0-9]{17,20}\/[A-Za-z0-9._-]{32,200}$/;

export type DiscordWebhookConfigurationStatus = "configured" | "disabled" | "invalid";
export type DiscordNotificationDeliveryStatus = "sent" | "failed" | "disabled";
export type DiscordMaintenanceNotificationEvent =
  "preparing" | "succeeded" | "recovered" | "rolled_back" | "failed";

export interface DiscordMaintenanceNotification {
  event: DiscordMaintenanceNotificationEvent;
  phase: "preparation" | "worker";
  action: "restart" | "deploy";
  activeRelease: string;
  targetRelease: string;
  effectiveRelease?: string;
  activePtys: number;
  manualRecoveryRequired?: boolean;
  occurredAt: string;
}

export type DiscordNotificationDelivery =
  | { status: "sent"; httpStatus: number }
  | { status: "failed"; httpStatus?: number }
  | { status: "disabled" };

export type DiscordMaintenanceNotificationSender = (
  secretFile: string,
  notification: DiscordMaintenanceNotification,
) => Promise<DiscordNotificationDelivery>;

export interface DiscordNotifierOptions {
  uid?: number;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

interface DiscordWebhookPayload {
  username: string;
  allowed_mentions: { parse: never[] };
  embeds: Array<{
    title: string;
    description: string;
    color: number;
    timestamp: string;
    fields: Array<{ name: string; value: string; inline: boolean }>;
    footer: { text: string };
  }>;
}

export function inspectDiscordWebhookConfiguration(
  secretFile: string,
  uid = currentUid(),
): DiscordWebhookConfigurationStatus {
  try {
    return readDiscordWebhookUrl(secretFile, uid) === null ? "disabled" : "configured";
  } catch {
    return "invalid";
  }
}

export async function sendDiscordMaintenanceNotification(
  secretFile: string,
  notification: DiscordMaintenanceNotification,
  options: DiscordNotifierOptions = {},
): Promise<DiscordNotificationDelivery> {
  let webhookUrl: URL | null;
  try {
    webhookUrl = readDiscordWebhookUrl(secretFile, options.uid ?? currentUid());
  } catch {
    return { status: "failed" };
  }
  if (webhookUrl === null) return { status: "disabled" };

  webhookUrl.searchParams.set("wait", "true");
  const fetcher = options.fetch ?? globalThis.fetch;
  try {
    const response = await fetcher(webhookUrl, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "user-agent": "Naru-Operations/1.0",
      },
      body: JSON.stringify(renderDiscordMaintenancePayload(notification)),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    const httpStatus = response.status;
    if (!response.ok || httpStatus !== 200) return { status: "failed", httpStatus };

    const responseBody = await response.text();
    if (Buffer.byteLength(responseBody, "utf8") > MAX_RESPONSE_BYTES) {
      return { status: "failed", httpStatus };
    }
    const message = parseJsonRecord(responseBody);
    if (typeof message?.id !== "string" || !/^[0-9]{17,20}$/.test(message.id)) {
      return { status: "failed", httpStatus };
    }
    return { status: "sent", httpStatus };
  } catch {
    return { status: "failed" };
  }
}

export function renderDiscordMaintenancePayload(
  notification: DiscordMaintenanceNotification,
): DiscordWebhookPayload {
  const presentation = notificationPresentation(notification);
  const action = notification.action === "deploy" ? "코드 배포·재시작" : "운영 재시작";
  const release =
    notification.action === "deploy"
      ? `\`${notification.activeRelease}\` → \`${notification.targetRelease}\``
      : `\`${notification.activeRelease}\``;
  const fields: DiscordWebhookPayload["embeds"][number]["fields"] = [
    { name: "작업", value: action, inline: true },
    { name: "상태", value: presentation.status, inline: true },
    { name: "릴리스", value: release, inline: false },
    {
      name: notification.event === "preparing" ? "예상 영향" : "작업 시작 시 영향",
      value: `PTY ${notification.activePtys}개`,
      inline: true,
    },
  ];
  if (notification.effectiveRelease !== undefined) {
    fields.push({
      name: "현재 유효 릴리스",
      value: `\`${notification.effectiveRelease}\``,
      inline: true,
    });
  }
  if (notification.manualRecoveryRequired === true) {
    fields.push({ name: "후속 조치", value: "수동 복구 확인 필요", inline: false });
  }

  return {
    username: "Naru 비상 연락망",
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: presentation.title,
        description: presentation.description,
        color: presentation.color,
        timestamp: notification.occurredAt,
        fields,
        footer: { text: "상세 상태: naru-ops status" },
      },
    ],
  };
}

function readDiscordWebhookUrl(secretFile: string, uid: number): URL | null {
  if (!isAbsolute(secretFile)) throw new Error("Discord webhook secret path is invalid.");

  let metadata;
  try {
    metadata = lstatSync(secretFile);
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw new Error("Discord webhook secret is unavailable.", { cause: error });
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.uid !== uid ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size <= 0 ||
    metadata.size > MAX_SECRET_FILE_BYTES ||
    realpathSync(secretFile) !== resolve(secretFile)
  ) {
    throw new Error("Discord webhook secret is unsafe.");
  }

  const contents = readFileSync(secretFile, "utf8");
  const value = parseWebhookSecret(contents);
  const webhookUrl = new URL(value);
  if (
    webhookUrl.protocol !== "https:" ||
    !DISCORD_WEBHOOK_HOSTS.has(webhookUrl.hostname) ||
    (webhookUrl.port !== "" && webhookUrl.port !== "443") ||
    webhookUrl.username !== "" ||
    webhookUrl.password !== "" ||
    webhookUrl.search !== "" ||
    webhookUrl.hash !== "" ||
    !DISCORD_WEBHOOK_PATH.test(webhookUrl.pathname)
  ) {
    throw new Error("Discord webhook URL is invalid.");
  }
  return webhookUrl;
}

function parseWebhookSecret(contents: string): string {
  const trimmed = contents.trim();
  if (trimmed.startsWith("https://")) return trimmed;

  const values = parseEnv(contents);
  const keys = Object.keys(values);
  if (keys.length !== 1 || keys[0] !== DISCORD_WEBHOOK_SECRET_KEY) {
    throw new Error("Discord webhook secret format is invalid.");
  }
  const value = values[DISCORD_WEBHOOK_SECRET_KEY];
  if (value === undefined || value.trim() !== value || value.length === 0) {
    throw new Error("Discord webhook secret format is invalid.");
  }
  return value;
}

function notificationPresentation(notification: DiscordMaintenanceNotification): {
  title: string;
  description: string;
  status: string;
  color: number;
} {
  switch (notification.event) {
    case "preparing":
      return {
        title: "🛠️ Naru 운영 작업 시작",
        description:
          "릴리스 검증과 백업을 시작했습니다. 서비스 전환은 독립 유지보수 worker가 이어서 수행합니다.",
        status: "준비 중",
        color: 0x5865f2,
      };
    case "succeeded":
      return {
        title: "✅ Naru 운영 작업 성공",
        description: "유지보수 작업과 실행 후 검증을 완료했습니다.",
        status: "성공",
        color: 0x57f287,
      };
    case "recovered":
      return {
        title: "⚠️ Naru 재시작 자동 복구",
        description: "첫 재기동은 실패했지만 현재 릴리스로 자동 복구했습니다.",
        status: "자동 복구",
        color: 0xfee75c,
      };
    case "rolled_back":
      return {
        title: "↩️ Naru 배포 롤백",
        description: "새 릴리스 검증이 실패해 이전 릴리스로 자동 복귀했습니다.",
        status: "롤백 완료",
        color: 0xfee75c,
      };
    case "failed":
      return {
        title: "🚨 Naru 운영 작업 실패",
        description:
          notification.manualRecoveryRequired === true
            ? "자동 복구까지 완료되지 않았습니다. 운영 서비스와 검증된 백업 상태를 직접 확인해야 합니다."
            : notification.phase === "preparation"
              ? "서비스를 중지하기 전 준비 단계에서 작업이 실패했습니다."
              : "유지보수 작업이 실패했습니다. 안전한 상세 상태를 확인해 주세요.",
        status: notification.manualRecoveryRequired === true ? "수동 확인 필요" : "실패",
        color: 0xed4245,
      };
  }
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined || !Number.isInteger(uid) || uid < 0) {
    throw new Error("Discord notifier requires a service-user UID.");
  }
  return uid;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
