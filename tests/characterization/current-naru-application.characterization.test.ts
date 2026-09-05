import { execFileSync } from "node:child_process";
import type { ProjectGroup, Workspace } from "../../packages/contracts/src/index.js";
import { describe, expect, it } from "vitest";
import {
  createCurrentNaruFixture,
  closeSocket,
  type CurrentNaruApp,
  loginWithPassword,
  registerProject,
  unsafeHeaders,
  workspace,
} from "./current-naru-harness.js";

describe("current Naru application regression observation points", () => {
  it("current behavior: Files, Docs, Tasks, push, Project/Git, and Codex activity stay observable without spawning non-terminal PTYs", async () => {
    const fixture = await createCurrentNaruFixture({
      configPatch: {
        push: {
          publicKey: Buffer.alloc(65, 1).toString("base64url"),
          privateKey: Buffer.alloc(32, 2).toString("base64url"),
          subject: "https://naru.example.test",
        },
      },
    });
    let auth: Awaited<ReturnType<typeof loginWithPassword>> | null = null;
    try {
      await fixture.writeProjectFile(
        "docs/SPEC.md",
        "# Characterized docs\n\n## Behavior\n\nRead only.\n",
      );
      await fixture.writeProjectFile(
        "docs/TASKS.md",
        "# Characterized tasks\n\n## T03. Baseline\n\n- [-] Current behavior.\n",
      );
      await fixture.writeProjectFile("src/app.ts", "export const currentNaru = true;\n");
      runGit(fixture.projectPath, ["init", "--initial-branch=current-baseline"]);

      auth = await loginWithPassword(fixture.app);
      const project = await registerProject(fixture, auth);
      expect(fixture.launches).toHaveLength(2);

      const docs = await fixture.app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/docs`,
        headers: { cookie: auth.cookie },
      });
      expect(docs.statusCode).toBe(200);
      const docsBody = docs.json<{
        status: string;
        documents: Array<{ path: string; kind: string }>;
      }>();
      expect(docsBody.status).toBe("ready");
      expect(
        docsBody.documents.some(({ path, kind }) => path === "docs/SPEC.md" && kind === "markdown"),
      ).toBe(true);
      expect(
        docsBody.documents.some(({ path, kind }) => path === "docs/TASKS.md" && kind === "tasks"),
      ).toBe(true);
      const tasks = await fixture.app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/tasks`,
        headers: { cookie: auth.cookie },
      });
      expect(tasks.statusCode).toBe(200);
      const tasksBody = tasks.json<{ status: string; documents: Array<{ path: string }> }>();
      expect(tasksBody.status).toBe("ready");
      expect(tasksBody.documents.map(({ path }) => path)).toContain("docs/TASKS.md");
      const files = await fixture.app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/files?path=src`,
        headers: { cookie: auth.cookie },
      });
      expect(files.statusCode).toBe(200);
      expect(
        files.json<{ entries: Array<{ name: string }> }>().entries.map(({ name }) => name),
      ).toContain("app.ts");
      const file = await fixture.app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/file?path=src%2Fapp.ts`,
        headers: { cookie: auth.cookie },
      });
      expect(file.statusCode).toBe(200);
      expect(file.json()).toMatchObject({ source: "export const currentNaru = true;\n" });

      const initial = workspace(fixture, project.id);
      let current = await createNonTerminalPane(fixture.app, project.id, auth, initial, "files");
      current = await createNonTerminalPane(fixture.app, project.id, auth, current, "docs");
      current = await createNonTerminalPane(fixture.app, project.id, auth, current, "tasks");
      expect(
        current.panes.filter(({ kind }) => ["files", "docs", "tasks"].includes(kind)),
      ).toHaveLength(3);
      expect(fixture.launches).toHaveLength(2);

      const groups = await fixture.app.inject({
        method: "GET",
        url: "/api/project-groups",
        headers: { cookie: auth.cookie },
      });
      expect(groups.statusCode).toBe(200);
      const group = groups.json<ProjectGroup[]>()[0];
      expect(group?.kind).toBe("git");
      const connectedTarget = group?.targets[0];
      expect(connectedTarget?.registration).toBe("connected");
      expect(connectedTarget?.label).toContain("current-baseline");
      expect(connectedTarget?.git).toMatchObject({
        head: { kind: "unborn", name: "current-baseline" },
      });
      expect(fixture.launches).toHaveLength(2);

      const codexPane = current.panes.find(({ kind }) => kind === "codex");
      if (!codexPane) throw new Error("Current Naru Codex activity Pane is missing.");
      fixture.repository.setPaneActivity(codexPane.id, "completed");
      const workspaceResponse = await fixture.app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/workspace`,
        headers: { cookie: auth.cookie },
      });
      expect(
        workspaceResponse.json<Workspace>().panes.find(({ id }) => id === codexPane.id)?.activity,
      ).toMatchObject({ state: "completed" });
      const pushSummary = await fixture.app.inject({
        method: "GET",
        url: `/api/push/projects/${project.id}/summary`,
        headers: { cookie: auth.cookie },
      });
      expect(pushSummary.statusCode).toBe(200);
      expect(pushSummary.json()).toMatchObject({
        projectId: project.id,
        state: "completed",
        counts: { completed: 1 },
      });
      const pushConfig = await fixture.app.inject({
        method: "GET",
        url: "/api/push/config",
        headers: { cookie: auth.cookie },
      });
      expect(pushConfig.json()).toMatchObject({ configured: true, inactivityDelayMinutes: 2 });
      expect(JSON.stringify(pushConfig.json())).not.toContain("privateKey");
    } finally {
      if (auth?.surface !== undefined) await closeSocket(auth.surface.socket);
      await fixture.dispose();
    }
  }, 15_000);
});

async function createNonTerminalPane(
  app: CurrentNaruApp,
  projectId: string,
  auth: { readonly cookie: string; readonly csrfToken: string },
  current: Workspace,
  kind: "files" | "docs" | "tasks",
): Promise<Workspace> {
  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/panes`,
    headers: unsafeHeaders(auth),
    payload: {
      kind,
      workspaceVersion: current.version,
      targetPaneId: current.activePaneId,
      direction: "vertical",
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<Workspace>();
}

function runGit(cwd: string, args: readonly string[]): void {
  execFileSync("/usr/bin/git", [...args], {
    cwd,
    stdio: "ignore",
    env: {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}
