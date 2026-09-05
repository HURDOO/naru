import { defineConfig } from "@playwright/test";
import baseConfig from "./playwright.config.js";

export default defineConfig(baseConfig, {
  testDir: "tests/performance",
  testMatch: "browser-load.spec.ts",
  timeout: 60_000,
  use: {
    ...baseConfig.use,
    headless: false,
  },
});
