/** Reattach to the approved project after a test-server restart and start its stopped Panes. */
import { spawnSync } from "node:child_process";
import { chromium, expect } from "@playwright/test";
import { loadTestServerSettings } from "./server.js";

let stage = "settings";

async function main(): Promise<void> {
  let discoveredWorktrees = 0;
  const [root, projectPath] = process.argv.slice(2);
  if (root === undefined || projectPath === undefined || process.argv.length !== 4) {
    throw new Error("Expected test root and exact project path.");
  }
  const { settings } = loadTestServerSettings(root);
  if (settings.exactProjectRoot !== projectPath) {
    throw new Error("The requested project is not the exact approved test project.");
  }
  stage = "credential";
  const credential = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-s", "dev.naru.claude-password-9443", "-w"],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (credential.status !== 0 || !credential.stdout.trim()) {
    throw new Error("Test password is unavailable from Keychain.");
  }
  stage = "browser";
  const browser = await chromium.launch({ headless: true });
  try {
    stage = "login";
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(settings.browserOrigin);
    await page.getByRole("button", { name: "비밀번호로 로그인" }).click();
    await page.getByLabel("Naru 비밀번호").fill(credential.stdout.trim());
    await page.getByRole("button", { name: "작업공간 열기" }).click();
    await expect(page.getByRole("button", { name: "로그아웃" })).toBeVisible();
    stage = "project-list";
    const projects = await page.evaluate(async () => {
      const response = await fetch("/api/projects");
      if (!response.ok) throw new Error("Projects could not be listed.");
      return (await response.json()) as Array<{ id: string; path: string }>;
    });
    const project = projects.find((candidate) => candidate.path === projectPath);
    if (project === undefined) throw new Error("Approved test project is not registered.");
    stage = "project-select";
    const sidebarToggle = page.locator("#project-sidebar-toggle");
    await expect(sidebarToggle).toBeVisible();
    if ((await sidebarToggle.getAttribute("aria-expanded")) === "false") {
      await sidebarToggle.click();
    }
    const target = page.locator(`#project-target-${project.id}`);
    if (!(await target.isVisible())) {
      const disclosure = page.getByRole("button", { name: /Cheers 작업 폴더 펼치기/ });
      if (await disclosure.isVisible()) await disclosure.click();
    }
    await expect(target).toBeVisible({ timeout: 15_000 });
    if (settings.worktreeRoots !== undefined) {
      stage = "worktree-discovery";
      const groups = await page.evaluate(async () => {
        const response = await fetch("/api/project-groups");
        if (!response.ok) throw new Error("Project groups could not be listed.");
        return (await response.json()) as Array<{
          targets: Array<{ registration: string; path: string }>;
        }>;
      });
      const group = groups.find((candidate) =>
        candidate.targets.some(
          (candidateTarget) =>
            candidateTarget.registration === "connected" && candidateTarget.path === projectPath,
        ),
      );
      if (group === undefined) throw new Error("Approved Git project group is missing.");
      const discovered = group.targets.filter(
        (candidate) => candidate.registration === "discovered",
      );
      for (const root of settings.worktreeRoots) {
        if (!discovered.some((candidate) => candidate.path.startsWith(`${root}/`))) {
          throw new Error("An approved worktree root has no discovered target.");
        }
      }
      discoveredWorktrees = discovered.length;
      const groupSection = page.locator("section.project-group").filter({
        has: page.getByRole("button", { name: /Cheers Git 프로젝트/ }),
      });
      await expect(groupSection.getByText("발견됨", { exact: true })).toHaveCount(
        discoveredWorktrees,
        { timeout: 15_000 },
      );
    }
    await target.click();
    stage = "panes";
    const first = page.getByLabel("Claude Code 1 Claude Code");
    const second = page.getByLabel("Claude Code 2 Claude Code");
    for (const [pane, title] of [
      [first, "Claude Code 1"],
      [second, "Claude Code 2"],
    ] as const) {
      stage = `${title} visible`;
      await expect(pane).toBeVisible({ timeout: 30_000 });
      if (!(await pane.getAttribute("data-runtime-id"))) {
        stage = `${title} restart`;
        const restart = pane.getByRole("button", { name: `${title} 재시작` });
        await expect(restart).toBeEnabled();
        await restart.click();
      }
      stage = `${title} ready`;
      await expect(pane).toHaveAttribute("data-restore-phase", "ready", { timeout: 30_000 });
    }
    stage = "independent runtimes";
    const firstRuntime = await first.getAttribute("data-runtime-id");
    const secondRuntime = await second.getAttribute("data-runtime-id");
    if (!firstRuntime || !secondRuntime || firstRuntime === secondRuntime) {
      throw new Error("Both Claude runtimes must be independent and active.");
    }
    stage = "no codex defaults";
    await expect(page.getByLabel("Main Codex Codex")).toHaveCount(0);
    await expect(page.getByLabel("Quick Codex Codex")).toHaveCount(0);
    stage = "reload";
    await page.reload();
    await expect(first).toHaveAttribute("data-runtime-id", firstRuntime, { timeout: 30_000 });
    await expect(second).toHaveAttribute("data-runtime-id", secondRuntime, { timeout: 30_000 });
    process.stdout.write(
      JSON.stringify({
        projectPersisted: true,
        twoClaudeRuntimesActive: true,
        noDefaultCodexPanes: true,
        reconnectPreservedBothRuntimes: true,
        discoveredWorktrees,
      }) + "\n",
    );
  } finally {
    await browser.close();
  }
}

void main().catch(() => {
  process.stderr.write(`Isolated project reconnect check failed at ${stage}.\n`);
  process.exitCode = 1;
});
