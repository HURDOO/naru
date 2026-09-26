/** Redacted live checks against the isolated 9443 server only. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import https from "node:https";
import { join } from "node:path";
import { TLSSocket } from "node:tls";
import type { IncomingHttpHeaders } from "node:http";

interface TestConnection {
  browserOrigin: string;
  listenerHost: string;
}

interface Response {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  tlsAuthorized: boolean;
}

function request(
  connection: TestConnection,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      new URL(path, connection.browserOrigin),
      {
        method,
        headers,
        timeout: 10_000,
        lookup: (_host, options, callback) =>
          callback(
            null,
            options.all
              ? [{ address: connection.listenerHost, family: 4 }]
              : connection.listenerHost,
            4,
          ),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            tlsAuthorized: req.socket instanceof TLSSocket && req.socket.authorized === true,
          }),
        );
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function main(): Promise<void> {
  const root = process.argv[2];
  if (root === undefined || process.argv.length !== 3) throw new Error("Expected one test root.");
  const connection = JSON.parse(
    readFileSync(join(root, "settings.json"), "utf8"),
  ) as TestConnection;
  const credential = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-s", "dev.naru.claude-password-9443", "-w"],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (credential.status !== 0 || !credential.stdout.trim()) {
    throw new Error("Test password is unavailable from Keychain.");
  }
  const health = await request(connection, "GET", "/healthz");
  const ready = await request(connection, "GET", "/readyz");
  const rejectedOrigin = await request(
    connection,
    "POST",
    "/api/auth/login",
    { Origin: "https://wrong.example.test", "Content-Type": "application/json" },
    JSON.stringify({ password: credential.stdout.trim() }),
  );
  const login = await request(
    connection,
    "POST",
    "/api/auth/login",
    { Origin: connection.browserOrigin, "Content-Type": "application/json" },
    JSON.stringify({ password: credential.stdout.trim() }),
  );
  const cookie = login.headers["set-cookie"]?.[0]?.split(";")[0];
  const session =
    cookie === undefined
      ? undefined
      : await request(connection, "GET", "/api/session", { Cookie: cookie });
  const result = {
    tlsAuthorized: health.tlsAuthorized,
    health: health.status,
    readiness: ready.status,
    invalidOriginRejected: rejectedOrigin.status === 403,
    passwordLogin: login.status,
    secureSessionCookie: login.headers["set-cookie"]?.[0]?.includes("Secure") === true,
    session: session?.status,
  };
  process.stdout.write(JSON.stringify(result) + "\n");
  if (
    !result.tlsAuthorized ||
    result.health !== 200 ||
    result.readiness !== 200 ||
    !result.invalidOriginRejected ||
    result.passwordLogin !== 200 ||
    !result.secureSessionCookie ||
    result.session !== 200
  ) {
    process.exitCode = 1;
  }
}

void main().catch(() => {
  process.stderr.write("Isolated 9443 smoke check failed; no credential was logged.\n");
  process.exitCode = 1;
});
