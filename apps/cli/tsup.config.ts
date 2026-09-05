import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts", "src/index.ts"],
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
