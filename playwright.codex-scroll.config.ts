import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/operations",
  testMatch: "codex-scroll.actual.spec.ts",
  workers: 1,
  retries: 0,
  reporter: "list",
  use: { channel: "chrome", trace: "off" },
});
