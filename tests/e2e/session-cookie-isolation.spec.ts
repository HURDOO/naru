import { expect, test, type Page } from "@playwright/test";

const developmentOrigin = `http://127.0.0.1:${process.env.NARU_E2E_API_PORT ?? "4990"}`;
const productionOrigin = `http://127.0.0.1:${process.env.NARU_E2E_PRODUCTION_API_PORT ?? "4992"}`;

test("keeps development and production sessions isolated on one host across ports", async ({
  context,
}) => {
  const developmentPage = await context.newPage();
  const productionPage = await context.newPage();

  await Promise.all([
    developmentPage.goto(`${developmentOrigin}/healthz`),
    productionPage.goto(`${productionOrigin}/healthz`),
  ]);

  const developmentSession = await login(developmentPage);
  await openTerminalSocket(developmentPage);
  const productionSession = await login(productionPage);
  await openTerminalSocket(productionPage);

  const cookieNames = (await context.cookies([developmentOrigin, productionOrigin])).map(
    ({ name }) => name,
  );
  expect(cookieNames).toEqual(expect.arrayContaining(["naru_dev_session", "naru_session"]));
  expect(await sessionStatus(developmentPage)).toBe(200);
  expect(await sessionStatus(productionPage)).toBe(200);

  const logoutStatus = await developmentPage.evaluate(async (csrfToken) => {
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
      headers: { "x-csrf-token": csrfToken },
    });
    return response.status;
  }, developmentSession.csrfToken);
  expect(logoutStatus).toBe(204);

  await expect.poll(() => socketState(developmentPage)).toBe(3);
  await expect.poll(() => socketState(productionPage)).toBe(1);
  expect(await sessionStatus(developmentPage)).toBe(401);
  expect(await sessionStatus(productionPage)).toBe(200);

  const remainingCookieNames = (await context.cookies([developmentOrigin, productionOrigin])).map(
    ({ name }) => name,
  );
  expect(remainingCookieNames).not.toContain("naru_dev_session");
  expect(remainingCookieNames).toContain("naru_session");

  const productionLogoutStatus = await productionPage.evaluate(async (csrfToken) => {
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
      headers: { "x-csrf-token": csrfToken },
    });
    return response.status;
  }, productionSession.csrfToken);
  expect(productionLogoutStatus).toBe(204);
});

async function login(page: Page): Promise<{ csrfToken: string }> {
  return page.evaluate(async () => {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "naru-test-password" }),
    });
    if (!response.ok) throw new Error(`Login failed with status ${response.status}.`);
    return response.json() as Promise<{ csrfToken: string }>;
  });
}

async function sessionStatus(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const response = await fetch("/api/session", { credentials: "include" });
    return response.status;
  });
}

async function openTerminalSocket(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/api/terminal`);
        const timeout = window.setTimeout(
          () => reject(new Error("WebSocket open timed out.")),
          5_000,
        );
        socket.addEventListener(
          "open",
          () => {
            window.clearTimeout(timeout);
            (window as Window & { __naruIsolationSocket?: WebSocket }).__naruIsolationSocket =
              socket;
            resolve();
          },
          { once: true },
        );
        socket.addEventListener(
          "error",
          () => {
            window.clearTimeout(timeout);
            reject(new Error("WebSocket connection failed."));
          },
          { once: true },
        );
      }),
  );
}

async function socketState(page: Page): Promise<number | undefined> {
  return page.evaluate(
    () =>
      (window as Window & { __naruIsolationSocket?: WebSocket }).__naruIsolationSocket?.readyState,
  );
}
