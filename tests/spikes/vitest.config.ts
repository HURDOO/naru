import { defineConfig } from "vitest/config";

// Agent Platform Phase 1 검증용. 기본 `pnpm test`에는 포함하지 않는다.
export default defineConfig({
  test: {
    include: ["tests/spikes/**/*.spike.test.ts"],
    environment: "node",
  },
});
