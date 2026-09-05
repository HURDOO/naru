import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Pane, Workspace } from "../../packages/contracts/src/index.js";
import { describe, expect, it } from "vitest";
import {
  createCurrentNaruFixture,
  loginWithPassword,
  registerProject,
  unsafeHeaders,
  waitFor,
  workspace,
} from "./current-naru-harness.js";

describe("current Naru Pane and PTY lifecycle", () => {
  it("current behavior: Pane mapping starts only the two default Codex PTYs and read-only project switches do not duplicate spawns", async () => {
    const fixture = await createCurrentNaruFixture();
    try {
      const auth = await loginWithPassword(fixture.app);
      const firstProject = await registerProject(fixture, auth);
      const initial = workspace(fixture, firstProject.id);

      expect(initial.panes.map(({ kind }) => kind)).toEqual(["codex", "codex", "terminal"]);
      expect(initial.panes.map(({ status }) => status)).toEqual(["running", "running", "stopped"]);
      expect(fixture.launches).toHaveLength(2);
      expect(fixture.launches.map(({ cwd }) => cwd)).toEqual([
        fixture.projectPath,
        fixture.projectPath,
      ]);

      await fixture.app.inject({
        method: "GET",
        url: `/api/projects/${firstProject.id}/workspace`,
        headers: { cookie: auth.cookie },
      });
      await fixture.app.inject({
        method: "GET",
        url: `/api/projects/${firstProject.id}/workspace`,
        headers: { cookie: auth.cookie },
      });
      expect(fixture.launches).toHaveLength(2);

      const secondProjectPath = join(fixture.rootPath, "project-two");
      await mkdir(secondProjectPath);
      const secondProject = await registerProject(
        fixture,
        auth,
        secondProjectPath,
        "Second project",
      );
      expect(fixture.launches).toHaveLength(4);

      await fixture.app.inject({
        method: "GET",
        url: `/api/projects/${firstProject.id}/workspace`,
        headers: { cookie: auth.cookie },
      });
      await fixture.app.inject({
        method: "GET",
        url: `/api/projects/${secondProject.id}/workspace`,
        headers: { cookie: auth.cookie },
      });
      expect(fixture.launches).toHaveLength(4);
    } finally {
      await fixture.dispose();
    }
  });

  it("current behavior: create, exit, restart, and close map one Pane to one PTY incarnation", async () => {
    const fixture = await createCurrentNaruFixture();
    try {
      const auth = await loginWithPassword(fixture.app);
      const project = await registerProject(fixture, auth);
      const initial = workspace(fixture, project.id);
      const created = await fixture.app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/panes`,
        headers: unsafeHeaders(auth),
        payload: {
          kind: "terminal",
          title: "Characterized terminal",
          workspaceVersion: initial.version,
          targetPaneId: initial.activePaneId,
          direction: "vertical",
        },
      });
      expect(created.statusCode).toBe(201);
      const createdWorkspace = created.json<Workspace>();
      const pane = createdWorkspace.panes.find(({ title }) => title === "Characterized terminal");
      if (!pane?.activity.runtimeId) throw new Error("Characterized terminal did not start.");
      const firstRuntimeId = pane.activity.runtimeId;
      const firstProcess = fixture.launches.at(-1)?.process;
      if (!firstProcess) throw new Error("Characterized terminal PTY was not recorded.");
      expect(fixture.launches).toHaveLength(3);

      firstProcess.emitExit(7);
      await waitFor(() => fixture.repository.getPaneContext(pane.id)?.pane.status === "exited");
      expect(fixture.repository.getPaneContext(pane.id)?.pane).toMatchObject({
        status: "exited",
        exitCode: 7,
      });

      const restarted = await fixture.app.inject({
        method: "POST",
        url: `/api/panes/${pane.id}/restart`,
        headers: unsafeHeaders(auth),
      });
      expect(restarted.statusCode).toBe(200);
      const restartedPane = restarted.json<Pane>();
      expect(restartedPane).toMatchObject({ id: pane.id, status: "running" });
      expect(restartedPane.activity.runtimeId).not.toBe(firstRuntimeId);
      expect(fixture.launches).toHaveLength(4);

      const restartedProcess = fixture.launches.at(-1)?.process;
      if (!restartedProcess) throw new Error("Restarted terminal PTY was not recorded.");
      const beforeClose = workspace(fixture, project.id);
      const closed = await fixture.app.inject({
        method: "DELETE",
        url: `/api/panes/${pane.id}`,
        headers: unsafeHeaders(auth),
        payload: { workspaceVersion: beforeClose.version },
      });
      expect(closed.statusCode).toBe(200);
      expect(closed.json<Workspace>().panes.some(({ id }) => id === pane.id)).toBe(false);
      expect(restartedProcess.killSignals).toEqual(["SIGHUP"]);
      expect(fixture.repository.getPaneContext(pane.id)).toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });

  it("legacy limitation: closing the current Naru App Server terminates its owned PTYs instead of preserving them", async () => {
    const fixture = await createCurrentNaruFixture();
    try {
      const auth = await loginWithPassword(fixture.app);
      await registerProject(fixture, auth);
      const running = fixture.launches.map(({ process }) => process);
      expect(running).toHaveLength(2);

      await fixture.closeApp();

      expect(running.map(({ killSignals }) => killSignals)).toEqual([["SIGHUP"], ["SIGHUP"]]);
    } finally {
      await fixture.dispose();
    }
  });
});
