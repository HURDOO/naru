import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts", "src/network-main.ts", "src/index.ts"],
  format: ["esm"],
  platform: "node",
  sourcemap: true,
  clean: true,
  noExternal: ["@naru/contracts", "@naru/domain", "@naru/gateway-verifier"],
});
