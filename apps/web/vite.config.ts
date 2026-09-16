import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { NARU_DEFAULT_APP_BASE_PATH, parseNaruAppBasePath } from "@naru/contracts/naru-app/v1";
import { pwaServiceWorkerPlugin } from "./pwa-build.js";
import { PUBLIC_PWA_BUILD_FIXTURE_ORIGIN } from "./src/public-build-config.js";

const webPort = readPort("NARU_WEB_PORT", 5173);
const apiPort = readPort("NARU_API_PORT", 4174);
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const pwaBuildOrigin = process.env.NARU_PWA_BUILD_ORIGIN ?? PUBLIC_PWA_BUILD_FIXTURE_ORIGIN;
const pwaBuildBasePath = parseNaruAppBasePath(
  process.env.NARU_APP_BASE_PATH ?? NARU_DEFAULT_APP_BASE_PATH,
);

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    pwaServiceWorkerPlugin(
      fileURLToPath(new URL("./public", import.meta.url)),
      pwaBuildOrigin,
      pwaBuildBasePath,
    ),
  ],
  server: {
    port: webPort,
    strictPort: true,
    proxy: {
      "/api": {
        target: apiOrigin,
        ws: true,
      },
      "/healthz": apiOrigin,
      "/readyz": apiOrigin,
    },
  },
  build: {
    outDir: "dist",
  },
});

function readPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer TCP port.`);
  }
  return port;
}
