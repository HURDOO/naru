import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/**/*.test.{ts,tsx}",
      "packages/**/*.test.{ts,tsx}",
      "ops/**/*.test.{ts,tsx}",
      "scripts/**/*.test.{ts,mjs}",
      "tests/characterization/**/*.characterization.test.ts",
    ],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
    },
  },
});
