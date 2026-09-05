import { randomBytes } from "node:crypto";
import type { FastifyReply } from "fastify";

export function sendGatewayPreAuthPage(reply: FastifyReply, returnTo: string): FastifyReply {
  const nonce = randomBytes(18).toString("base64url");
  reply
    .header("cache-control", "no-store")
    .header("content-type", "text/html; charset=utf-8")
    .header("x-content-type-options", "nosniff")
    .header("x-frame-options", "DENY")
    .header("referrer-policy", "no-referrer")
    .header(
      "permissions-policy",
      "camera=(), microphone=(), geolocation=(), publickey-credentials-create=(self), publickey-credentials-get=(self)",
    )
    .header(
      "content-security-policy",
      `default-src 'none'; connect-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
  return reply.send(preAuthHtml(nonce, returnTo));
}

function preAuthHtml(nonce: string, returnTo: string): string {
  const serializedReturnTo = JSON.stringify(returnTo).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Private Workstation 로그인</title>
  <style nonce="${nonce}">
    :root { color-scheme: dark; font-family: system-ui, sans-serif; background: #0b1020; color: #f4f7ff; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    main { width: min(100%, 430px); padding: 28px; border: 1px solid #334166; border-radius: 18px; background: #121a30; box-shadow: 0 20px 70px #0008; }
    h1 { margin: 0 0 10px; font-size: 1.45rem; }
    p { color: #b8c2df; line-height: 1.55; }
    button, input { width: 100%; min-height: 46px; border-radius: 10px; font: inherit; }
    button { border: 0; padding: 0 16px; background: #78a7ff; color: #071022; font-weight: 700; cursor: pointer; }
    button.secondary { margin-top: 12px; border: 1px solid #44557f; background: transparent; color: #e9efff; }
    button:disabled { opacity: .55; cursor: wait; }
    button:focus-visible, input:focus-visible { outline: 3px solid #ffd166; outline-offset: 3px; }
    form { margin-top: 18px; padding-top: 18px; border-top: 1px solid #2d395a; }
    label { display: block; margin-bottom: 8px; font-weight: 650; }
    input { margin-bottom: 12px; border: 1px solid #53658f; padding: 0 12px; background: #091126; color: inherit; }
    [hidden] { display: none !important; }
    #status { min-height: 24px; margin-bottom: 14px; color: #ffd3d3; }
    .hint { margin: 16px 0 0; font-size: .9rem; }
  </style>
</head>
<body>
  <main aria-labelledby="title">
    <h1 id="title">Private Workstation</h1>
    <p>등록된 패스키로 본인 확인 후 private app을 엽니다.</p>
    <div id="status" role="alert" aria-live="polite"></div>
    <button id="login" type="button">패스키로 로그인</button>
    <button id="show-registration" class="secondary" type="button" aria-expanded="false" aria-controls="registration">새 워크스테이션 등록</button>
    <form id="registration" hidden autocomplete="off">
      <label for="bootstrap-code">로컬 bootstrap code</label>
      <input id="bootstrap-code" name="bootstrap-code" type="password" required minlength="20" maxlength="256" spellcheck="false" autocomplete="off">
      <button id="register" type="submit">패스키 등록</button>
    </form>
    <p class="hint">복구 code는 이 Mac의 local workstation CLI에서만 새로 만들 수 있습니다.</p>
  </main>
  <script nonce="${nonce}">
    (() => {
      "use strict";
      const returnTo = ${serializedReturnTo};
      const status = document.getElementById("status");
      const login = document.getElementById("login");
      const showRegistration = document.getElementById("show-registration");
      const registration = document.getElementById("registration");
      const bootstrapCode = document.getElementById("bootstrap-code");

      showRegistration.addEventListener("click", () => {
        const opening = registration.hidden;
        registration.hidden = !opening;
        showRegistration.setAttribute("aria-expanded", String(opening));
        if (opening) bootstrapCode.focus();
      });

      login.addEventListener("click", () => run(login, authenticate));
      registration.addEventListener("submit", (event) => {
        event.preventDefault();
        run(document.getElementById("register"), register);
      });

      async function authenticate() {
        const start = await json("/_gateway/auth/authentication/options", {});
        const credential = await navigator.credentials.get({
          publicKey: requestOptions(start.options),
        });
        if (!(credential instanceof PublicKeyCredential)) throw new Error("패스키 인증이 취소됐습니다.");
        await json("/_gateway/auth/authentication/verify", {
          ceremonyId: start.ceremonyId,
          response: authenticationResponse(credential),
        });
        window.location.assign(returnTo);
      }

      async function register() {
        const code = bootstrapCode.value;
        if (code.length < 20) throw new Error("유효한 local bootstrap code를 입력하세요.");
        const start = await json("/_gateway/auth/registration/options", { code });
        bootstrapCode.value = "";
        const credential = await navigator.credentials.create({
          publicKey: creationOptions(start.options),
        });
        if (!(credential instanceof PublicKeyCredential)) throw new Error("패스키 등록이 취소됐습니다.");
        await json("/_gateway/auth/registration/verify", {
          ceremonyId: start.ceremonyId,
          response: registrationResponse(credential),
        });
        window.location.assign(returnTo);
      }

      async function run(button, operation) {
        status.textContent = "";
        login.disabled = true;
        showRegistration.disabled = true;
        button.disabled = true;
        try {
          await operation();
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : "패스키 요청을 완료하지 못했습니다.";
          login.disabled = false;
          showRegistration.disabled = false;
          button.disabled = false;
        }
      }

      async function json(path, body) {
        const response = await fetch(path, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(body),
        });
        const payload = await response.json().catch(() => undefined);
        if (!response.ok) {
          throw new Error(payload?.error?.message || "Gateway 인증 요청이 거부됐습니다.");
        }
        return payload;
      }

      function creationOptions(options) {
        if (typeof PublicKeyCredential.parseCreationOptionsFromJSON === "function") {
          return PublicKeyCredential.parseCreationOptionsFromJSON(options);
        }
        return {
          ...options,
          challenge: bytes(options.challenge),
          user: { ...options.user, id: bytes(options.user.id) },
          excludeCredentials: options.excludeCredentials?.map((item) => ({
            ...item,
            id: bytes(item.id),
          })),
        };
      }

      function requestOptions(options) {
        if (typeof PublicKeyCredential.parseRequestOptionsFromJSON === "function") {
          return PublicKeyCredential.parseRequestOptionsFromJSON(options);
        }
        return {
          ...options,
          challenge: bytes(options.challenge),
          allowCredentials: options.allowCredentials?.map((item) => ({
            ...item,
            id: bytes(item.id),
          })),
        };
      }

      function registrationResponse(credential) {
        const response = credential.response;
        return {
          id: credential.id,
          rawId: base64url(credential.rawId),
          type: credential.type,
          response: {
            clientDataJSON: base64url(response.clientDataJSON),
            attestationObject: base64url(response.attestationObject),
            ...(typeof response.getTransports === "function" ? { transports: response.getTransports() } : {}),
            ...(typeof response.getPublicKeyAlgorithm === "function" ? { publicKeyAlgorithm: response.getPublicKeyAlgorithm() } : {}),
            ...(typeof response.getPublicKey === "function" && response.getPublicKey() ? { publicKey: base64url(response.getPublicKey()) } : {}),
            ...(typeof response.getAuthenticatorData === "function" ? { authenticatorData: base64url(response.getAuthenticatorData()) } : {}),
          },
          clientExtensionResults: credential.getClientExtensionResults(),
          ...(credential.authenticatorAttachment ? { authenticatorAttachment: credential.authenticatorAttachment } : {}),
        };
      }

      function authenticationResponse(credential) {
        const response = credential.response;
        return {
          id: credential.id,
          rawId: base64url(credential.rawId),
          type: credential.type,
          response: {
            clientDataJSON: base64url(response.clientDataJSON),
            authenticatorData: base64url(response.authenticatorData),
            signature: base64url(response.signature),
            userHandle: response.userHandle === null ? null : base64url(response.userHandle),
          },
          clientExtensionResults: credential.getClientExtensionResults(),
          ...(credential.authenticatorAttachment ? { authenticatorAttachment: credential.authenticatorAttachment } : {}),
        };
      }

      function bytes(value) {
        const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
        const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
        return Uint8Array.from(binary, (character) => character.charCodeAt(0));
      }

      function base64url(value) {
        const bytes = new Uint8Array(value);
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      }
    })();
  </script>
</body>
</html>`;
}
