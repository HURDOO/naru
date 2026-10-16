import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cliPermissionMode,
  personPermissionMode,
} from "../src/agent-runtime/claude/permission-mode.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "naru-permission-mode-"));
  roots.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(project, ".claude"), { recursive: true });
  const write = (file: string, value: unknown) =>
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return {
    home,
    project,
    user: (value: unknown) => write(join(home, ".claude", "settings.json"), value),
    shared: (value: unknown) => write(join(project, ".claude", "settings.json"), value),
    local: (value: unknown) => write(join(project, ".claude", "settings.local.json"), value),
  };
}

describe("the person's own Claude permission mode", () => {
  it("is auto unless their settings choose another, the nearest settings winning", () => {
    const f = fixture();
    expect(personPermissionMode(f.project, f.home)).toBe("auto");
    f.user({ model: "opus" });
    expect(personPermissionMode(f.project, f.home)).toBe("auto");
    f.user({ permissions: { defaultMode: "acceptEdits" } });
    expect(personPermissionMode(f.project, f.home)).toBe("acceptEdits");
    f.shared({ permissions: { defaultMode: "plan" } });
    expect(personPermissionMode(f.project, f.home)).toBe("plan");
    f.local({ permissions: { defaultMode: "manual" } });
    expect(personPermissionMode(f.project, f.home)).toBe("default");
    expect(cliPermissionMode("default")).toBe("manual");
    expect(cliPermissionMode("auto")).toBe("auto");
  });

  it("never applies bypassPermissions, dontAsk or an unknown mode, and ignores broken files", () => {
    const f = fixture();
    f.user({ permissions: { defaultMode: "bypassPermissions" } });
    expect(personPermissionMode(f.project, f.home)).toBe("auto");
    f.user({ permissions: { defaultMode: "turbo" } });
    expect(personPermissionMode(f.project, f.home)).toBe("auto");
    f.user({ permissions: { defaultMode: "dontAsk" } });
    expect(personPermissionMode(f.project, f.home)).toBe("auto");
    f.local("{ not json");
    f.user({ permissions: { defaultMode: "plan" } });
    expect(personPermissionMode(f.project, f.home)).toBe("plan");
  });
});
