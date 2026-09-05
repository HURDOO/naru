import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { Project, ProjectGroup, Workspace } from "../../packages/contracts/src/index.js";

const primaryProjectId = "11111111-1111-4111-8111-111111111111";
const linkedProjectId = "22222222-2222-4222-8222-222222222222";
const groupId = "33333333-3333-4333-8333-333333333333";
const soloProjectId = "44444444-4444-4444-8444-444444444444";
const soloGroupId = "55555555-5555-4555-8555-555555555555";
const timestamp = "2026-08-20T00:00:00.000Z";
const primaryPath = "/Users/example/projects/repository/apps/web";
const linkedPath = "/Users/example/projects/repository-feature/apps/web";
const soloPath = "/Users/example/projects/solo";

test("shows discovered worktrees without connecting them and connects only from the explicit button", async ({
  page,
}) => {
  let connected = false;
  let connectRequests = 0;

  await isolateTerminalConnection(page);

  await page.route("**/api/project-groups/refresh", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(groups(connected)),
    });
  });
  await page.route("**/api/project-groups", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(groups(connected)),
    });
  });
  await page.route(`**/api/project-groups/${groupId}/targets`, async (route) => {
    connectRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ path: linkedPath });
    connected = true;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(project(linkedProjectId, "Web · feature/sidebar", linkedPath)),
    });
  });
  await page.route("**/api/projects/*/workspace", async (route) => {
    const projectId = route.request().url().split("/").at(-2) ?? primaryProjectId;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(emptyWorkspace(projectId)),
    });
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "비밀번호로 로그인" }).click();
  await page.getByLabel("Naru 비밀번호").fill("naru-test-password");
  await page.getByRole("button", { name: "작업공간 열기" }).click();

  const group = page.getByRole("button", { name: /Web Git 프로젝트/ });
  await expect(group).toBeVisible();
  await page.getByRole("button", { name: "프로젝트 연결" }).click();
  await expect(page.getByLabel("서버 절대 경로")).toBeVisible();
  await page.getByRole("button", { name: "폼 닫기" }).click();
  await expect(group.locator(".activity-status")).toHaveAttribute("data-activity-state", "running");
  await expect(page.locator("#project-sidebar").getByText("연결됨", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.locator(".project-target-list").getByText("release", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("primary · release", { exact: true })).toHaveCount(0);
  await expect(page.getByText("발견됨", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "feature/sidebar을 Naru에 연결" })).toBeVisible();
  const solo = page.getByRole("button", { name: /Solo, 작업 상태/ });
  await expect(solo).toBeVisible();
  await expect(solo).toHaveAttribute("aria-label", "Solo, 작업 상태 서버 중지");
  await expect(solo.locator("strong")).toHaveText("Solo");
  await expect(page.locator(".project-group").filter({ hasText: "Solo" })).toHaveCount(0);
  expect(connectRequests).toBe(0);

  await page.getByRole("button", { name: "Web 작업 폴더 접기" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "feature/sidebar을 Naru에 연결" })).toBeHidden();
  await page.getByRole("button", { name: "Web 작업 폴더 펼치기" }).press("Enter");

  await page.setViewportSize({ width: 360, height: 780 });
  await expect(page.locator("#project-sidebar")).toHaveAttribute("data-presentation", "overlay");
  const connect = page.getByRole("button", { name: "feature/sidebar을 Naru에 연결" });
  await connect.focus();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { name: "Web · feature/sidebar" })).toBeFocused();
  expect(connectRequests).toBe(1);
  await expect(page.getByText("발견됨", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("opens a closed multi-worktree project before switching targets across navigation modes", async ({
  page,
  browser,
}) => {
  const workspaceRequests: string[] = [];
  await mockConnectedGroupCatalog(page, workspaceRequests);
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInFixture(page);

  await expect(page.getByRole("heading", { name: "Web", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Solo, 작업 상태/ }).click();
  await expect(page.getByRole("heading", { name: "Solo", exact: true })).toBeFocused();

  const sidebar = page.locator("#project-sidebar");
  const workspaceRequestCount = workspaceRequests.length;
  await page.locator(".workspace-area").hover({ position: { x: 200, y: 200 } });
  await sidebar.hover();
  await expect(sidebar).toHaveAttribute("data-open-mode", "preview");
  await page.getByRole("button", { name: /Web Git 프로젝트/ }).click();

  await expect(sidebar).toHaveAttribute("data-open-mode", "pinned");
  await expect(page.getByRole("heading", { name: "Solo", exact: true })).toBeVisible();
  expect(workspaceRequests).toHaveLength(workspaceRequestCount);
  await expect(page.getByRole("button", { name: /release, 작업 상태/ })).toBeFocused();
  await expectNoAccessibilityViolations(page);

  await page.getByRole("button", { name: "Web 작업 폴더 접기" }).click();
  await expect(page.getByRole("button", { name: /feature\/sidebar, 작업 상태/ })).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(sidebar).toHaveAttribute("data-open-mode", "closed");
  await expect(page.getByRole("button", { name: "프로젝트 메뉴 펼치기 고정" })).toBeFocused();

  const groupButton = page.getByRole("button", { name: /Web Git 프로젝트/ });
  await groupButton.focus();
  await page.keyboard.press("Enter");
  await expect(sidebar).toHaveAttribute("data-open-mode", "pinned");
  await expect(page.getByRole("button", { name: /release, 작업 상태/ })).toBeFocused();
  expect(workspaceRequests).toHaveLength(workspaceRequestCount);

  await page.getByRole("button", { name: /feature\/sidebar, 작업 상태/ }).focus();
  await page.keyboard.press("Space");
  await expect(
    page.getByRole("heading", { name: "Web · feature/sidebar", exact: true }),
  ).toBeFocused();
  expect(workspaceRequests.at(-1)).toBe(linkedProjectId);

  await page.setViewportSize({ width: 360, height: 780 });
  await page.getByRole("button", { name: "프로젝트 메뉴 열기" }).click();
  await expect(sidebar).toHaveAttribute("data-presentation", "overlay");
  await expect(sidebar).toHaveAttribute("data-open-mode", "pinned");
  await expectNoAccessibilityViolations(page);
  await page.getByRole("button", { name: /release, 작업 상태/ }).click();
  await expect(page.getByRole("heading", { name: "Web", exact: true })).toBeFocused();
  expect(workspaceRequests.at(-1)).toBe(primaryProjectId);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);

  const tabletContext = await browser.newContext({
    baseURL: `http://localhost:${process.env.NARU_E2E_WEB_PORT ?? "4991"}`,
    hasTouch: true,
    viewport: { width: 768, height: 900 },
  });
  const tabletPage = await tabletContext.newPage();
  const tabletWorkspaceRequests: string[] = [];
  try {
    await mockConnectedGroupCatalog(tabletPage, tabletWorkspaceRequests);
    await signInFixture(tabletPage);
    await tabletPage.getByRole("button", { name: /Solo, 작업 상태/ }).click();
    await expect(tabletPage.getByRole("heading", { name: "Solo", exact: true })).toBeFocused();

    const tabletSidebar = tabletPage.locator("#project-sidebar");
    const tabletRequestCount = tabletWorkspaceRequests.length;
    await expect(tabletSidebar).toHaveAttribute("data-expand-trigger", "click");
    await tabletPage.getByRole("button", { name: /Web Git 프로젝트/ }).click();
    await expect(tabletSidebar).toHaveAttribute("data-open-mode", "pinned");
    await expect(tabletPage.getByRole("heading", { name: "Solo", exact: true })).toBeVisible();
    await expect(tabletPage.getByRole("button", { name: /release, 작업 상태/ })).toBeFocused();
    expect(tabletWorkspaceRequests).toHaveLength(tabletRequestCount);
    await tabletPage.getByRole("button", { name: /feature\/sidebar, 작업 상태/ }).press("Enter");
    await expect(
      tabletPage.getByRole("heading", { name: "Web · feature/sidebar", exact: true }),
    ).toBeFocused();
    expect(tabletWorkspaceRequests.at(-1)).toBe(linkedProjectId);
  } finally {
    await tabletContext.close();
  }
});

async function mockConnectedGroupCatalog(page: Page, workspaceRequests: string[]): Promise<void> {
  await page.route("**/api/project-groups/refresh", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(groups(true)),
    });
  });
  await page.route("**/api/project-groups", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(groups(true)),
    });
  });
  await page.route("**/api/projects/*/workspace", async (route) => {
    const projectId = route.request().url().split("/").at(-2) ?? primaryProjectId;
    workspaceRequests.push(projectId);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(emptyWorkspace(projectId)),
    });
  });
}

async function signInFixture(page: Page): Promise<void> {
  await isolateTerminalConnection(page);
  await page.goto("/");
  await page.getByRole("button", { name: "비밀번호로 로그인" }).click();
  await page.getByLabel("Naru 비밀번호").fill("naru-test-password");
  await page.getByRole("button", { name: "작업공간 열기" }).click();
}

async function isolateTerminalConnection(page: Page): Promise<void> {
  await page.routeWebSocket("**/api/terminal", (socket) => {
    socket.onMessage((message) => {
      if (typeof message !== "string") return;
      const frame = JSON.parse(message) as { type?: string };
      if (frame.type !== "lease.acquire") return;
      socket.send(
        JSON.stringify({
          type: "lease.granted",
          generation: 1,
          replacedClient: false,
          acquisition: "initial",
        }),
      );
      socket.send(
        JSON.stringify({
          type: "surface.state",
          connectionId: "66666666-6666-4666-8666-666666666666",
          generation: 1,
          role: "controller",
          controllerPresent: true,
          reason: "initial",
        }),
      );
    });
  });
}

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(results.violations).toEqual([]);
}

function groups(withLinkedTarget: boolean): ProjectGroup[] {
  const primary = {
    registration: "connected" as const,
    projectId: primaryProjectId,
    label: "release",
    path: primaryPath,
    availability: "ready" as const,
    git: {
      kind: "worktree" as const,
      role: "primary" as const,
      head: { kind: "branch" as const, name: "release", oid: "a".repeat(40) },
      locked: false,
      prunable: false,
    },
    activity: { state: "running" as const, interactionRequiredCount: 0, updatedAt: timestamp },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const linked = {
    label: "feature/sidebar",
    path: linkedPath,
    availability: "ready" as const,
    git: {
      kind: "worktree" as const,
      role: "linked" as const,
      head: { kind: "branch" as const, name: "feature/sidebar", oid: "b".repeat(40) },
      locked: false,
      prunable: false,
    },
  };
  return [
    {
      id: groupId,
      name: "Web",
      kind: "git",
      activity: primary.activity,
      targets: withLinkedTarget
        ? [
            primary,
            {
              ...linked,
              registration: "connected",
              projectId: linkedProjectId,
              activity: {
                state: "idle",
                interactionRequiredCount: 0,
                updatedAt: null,
              },
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ]
        : [primary, { ...linked, registration: "discovered" }],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: soloGroupId,
      name: "Solo",
      kind: "git",
      activity: { state: "server-stopped", interactionRequiredCount: 0, updatedAt: timestamp },
      targets: [
        {
          registration: "connected",
          projectId: soloProjectId,
          label: "main",
          path: soloPath,
          availability: "ready",
          git: {
            kind: "worktree",
            role: "primary",
            head: { kind: "branch", name: "main", oid: "c".repeat(40) },
            locked: false,
            prunable: false,
          },
          activity: {
            state: "server-stopped",
            interactionRequiredCount: 0,
            updatedAt: timestamp,
          },
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
}

function project(id: string, name: string, path: string): Project {
  return {
    id,
    name,
    path,
    activity: { state: "idle", interactionRequiredCount: 0, updatedAt: null },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function emptyWorkspace(projectId: string): Workspace {
  return {
    projectId,
    schemaVersion: 2,
    version: 0,
    layout: null,
    activePaneId: null,
    panes: [],
    updatedAt: timestamp,
  };
}
