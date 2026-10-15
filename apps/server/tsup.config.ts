import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/operations-cli.ts",
    "src/maintenance-cli.ts",
    "src/acme-renewal-cli.ts",
    "src/codex-session-hook-cli.ts",
    "src/claude-activity-hook-cli.ts",
    "src/claude-integration-hook-cli.ts",
    "src/claude-integration-launcher.ts",
    "src/codex-integration-launcher.ts",
    "src/agent-mcp-cli.ts",
    "src/agent-hook-cli.ts",
    "src/claude-agent-runner.ts",
  ],
  format: ["esm"],
  platform: "node",
  target: "node24",
  sourcemap: true,
  clean: true,
  shims: true,
  banner: {
    js: 'import { createRequire as __naruCreateRequire } from "node:module"; const require = __naruCreateRequire(import.meta.url);',
  },
  noExternal: [/^@naru\//],
});
