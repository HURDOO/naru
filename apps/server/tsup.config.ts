import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/operations-cli.ts",
    "src/maintenance-cli.ts",
    "src/acme-renewal-cli.ts",
    "src/codex-session-hook-cli.ts",
    "src/codex-integration-launcher.ts",
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
