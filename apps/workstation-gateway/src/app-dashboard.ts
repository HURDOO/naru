import { randomBytes } from "node:crypto";
import type { FastifyReply } from "fastify";
import type { GatewayAppInventoryItem, GatewayAppInventoryState } from "./app-registry.js";

export const GATEWAY_APPS_PATH = "/_gateway/apps" as const;

export function sendGatewayAppDashboard(
  reply: FastifyReply,
  apps: readonly GatewayAppInventoryItem[],
): FastifyReply {
  const nonce = randomBytes(18).toString("base64url");
  reply
    .header("cache-control", "no-store")
    .header("content-type", "text/html; charset=utf-8")
    .header("x-content-type-options", "nosniff")
    .header("x-frame-options", "DENY")
    .header("referrer-policy", "no-referrer")
    .header("cross-origin-opener-policy", "same-origin")
    .header("cross-origin-resource-policy", "same-origin")
    .header(
      "permissions-policy",
      "camera=(), microphone=(), geolocation=(), publickey-credentials-create=(), publickey-credentials-get=()",
    )
    .header(
      "content-security-policy",
      `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
  return reply.send(appDashboardHtml(nonce, apps));
}

function appDashboardHtml(nonce: string, apps: readonly GatewayAppInventoryItem[]): string {
  const cards = apps.map(appCardHtml).join("\n");
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Private Workstation 앱</title>
  <style nonce="${nonce}">
    :root { color-scheme: dark; font-family: system-ui, sans-serif; background: #0b1020; color: #f4f7ff; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100dvh; padding: clamp(20px, 5vw, 64px); }
    main { width: min(100%, 1040px); margin: 0 auto; }
    header { margin-bottom: 28px; }
    h1 { margin: 0 0 10px; font-size: clamp(1.7rem, 4vw, 2.5rem); }
    header p { margin: 0; color: #b8c2df; line-height: 1.55; }
    ul { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 250px), 1fr)); gap: 16px; margin: 0; padding: 0; list-style: none; }
    article { height: 100%; padding: 20px; border: 1px solid #334166; border-radius: 16px; background: #121a30; box-shadow: 0 14px 42px #0005; }
    .meta { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
    .mode { color: #9dacd1; font-size: .82rem; }
    .status { padding: 4px 9px; border-radius: 999px; font-size: .78rem; font-weight: 700; }
    .status-enabled { background: #173d35; color: #91efcd; }
    .status-disabled { background: #30394e; color: #c1c9dc; }
    .status-unavailable { background: #4a292e; color: #ffc2ca; }
    h2 { overflow-wrap: anywhere; margin: 0 0 18px; font-size: 1.15rem; }
    a { display: inline-flex; min-height: 44px; align-items: center; justify-content: center; border-radius: 10px; padding: 0 16px; background: #78a7ff; color: #071022; font-weight: 750; text-decoration: none; }
    a:hover { background: #9cbdff; }
    a:focus-visible { outline: 3px solid #ffd166; outline-offset: 3px; }
    .disabled { min-height: 44px; display: inline-flex; align-items: center; color: #9dacd1; }
    @media (max-width: 420px) { body { padding: 18px 14px 28px; } article { padding: 18px; } }
  </style>
</head>
<body>
  <main aria-labelledby="title">
    <header>
      <h1 id="title">Private Workstation 앱</h1>
      <p>이 Gateway에 등록된 앱을 선택하세요.</p>
    </header>
    <ul aria-label="등록된 앱">
${cards}
    </ul>
  </main>
</body>
</html>`;
}

function appCardHtml(app: GatewayAppInventoryItem): string {
  const stateLabel = inventoryStateLabel(app.state);
  const action =
    app.href === undefined
      ? '<span class="disabled">관리자가 비활성화했습니다.</span>'
      : `<a href="${escapeHtml(app.href)}" rel="noreferrer">열기</a>`;
  return `      <li>
        <article>
          <div class="meta">
            <span class="mode">${app.mode === "gateway-managed" ? "Gateway 관리" : "앱 관리"}</span>
            <span class="status status-${app.state}">${stateLabel}</span>
          </div>
          <h2>${escapeHtml(app.appId)}</h2>
          ${action}
        </article>
      </li>`;
}

function inventoryStateLabel(state: GatewayAppInventoryState): string {
  switch (state) {
    case "enabled":
      return "활성";
    case "disabled":
      return "비활성";
    case "unavailable":
      return "연결 오류";
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
