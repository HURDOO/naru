import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts", "src/browser-transport.ts"],
  format: ["esm"],
  platform: "node",
  sourcemap: true,
  clean: true,
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  noExternal: ["@naru/contracts", "@naru/gateway-verifier", "ws", "zod"],
});
