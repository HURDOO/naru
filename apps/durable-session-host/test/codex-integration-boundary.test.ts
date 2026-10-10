import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CORE_SCOPES = [
  "packages/contracts/src/durable-session",
  "packages/domain/src/durable-session",
  "packages/durable-session-client/src",
  "apps/durable-session-host/src",
  "apps/cli/src",
] as const;
const PACKAGE_MANIFESTS = [
  "packages/contracts/package.json",
  "packages/domain/package.json",
  "packages/durable-session-client/package.json",
  "apps/durable-session-host/package.json",
  "apps/cli/package.json",
] as const;

describe("Codex integration dependency boundary", () => {
  it("keeps Codex names and dependencies out of Core, Host, public client, and CLI", () => {
    const offenders = [...CORE_SCOPES.flatMap(sourceFiles), ...PACKAGE_MANIFESTS].filter((path) =>
      /codex/i.test(readFileSync(join(REPOSITORY_ROOT, path), "utf8")),
    );

    expect(offenders).toEqual([]);
  });

  it("imports only Host-scoped contract and domain entry points", () => {
    // The package roots carry Naru application schemas; bundling them into the Host turns a
    // UI/API contract change into a Host payload change and a PTY-ending restart.
    const rootImport = /from\s+"@naru\/(contracts|domain)"/;
    const offenders = sourceFiles("apps/durable-session-host/src").filter((path) =>
      rootImport.test(readFileSync(join(REPOSITORY_ROOT, path), "utf8")),
    );

    expect(offenders).toEqual([]);
  });
});

function sourceFiles(relativeDirectory: string): string[] {
  const absoluteDirectory = join(REPOSITORY_ROOT, relativeDirectory);
  return readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = join(relativeDirectory, entry.name);
    if (entry.isDirectory()) return sourceFiles(relativePath);
    return extname(entry.name) === ".ts" ? [relativePath] : [];
  });
}
