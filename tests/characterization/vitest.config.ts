import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/characterization/**/*.characterization.test.ts"],
    environment: "node",
    sequence: {
      concurrent: false,
    },
  },
});
