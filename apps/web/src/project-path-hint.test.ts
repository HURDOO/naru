import { describe, expect, it } from "vitest";
import {
  PROJECT_PATH_PLACEHOLDER,
  PROJECT_ROOTS_INSTRUCTION,
  PROJECT_ROOTS_LABEL,
} from "./project-path-hint";

describe("Project path hint", () => {
  it("does not expose a developer or another macOS user's home path", () => {
    expect(PROJECT_PATH_PLACEHOLDER).toBe("/path/to/project");
    expect(PROJECT_PATH_PLACEHOLDER).not.toMatch(/^\/Users\//);
    expect(PROJECT_PATH_PLACEHOLDER).not.toContain("developer-account");
  });

  it("explains the configured-root policy without embedding a developer or other-user path", () => {
    expect(PROJECT_ROOTS_LABEL).toContain("허용된 상위 폴더");
    expect(PROJECT_ROOTS_INSTRUCTION).toContain("실제 프로젝트 폴더 절대 경로");
    expect(`${PROJECT_ROOTS_LABEL} ${PROJECT_ROOTS_INSTRUCTION}`).not.toMatch(/\/Users\//);
    expect(`${PROJECT_ROOTS_LABEL} ${PROJECT_ROOTS_INSTRUCTION}`).not.toContain(
      "developer-account",
    );
  });
});
