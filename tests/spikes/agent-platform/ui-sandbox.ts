/**
 * AP-T17 UI sandbox: the built Naru server and web app with the Agent Platform enabled, against an
 * isolated DurableSession Host, scripted runtimes (a stand-in Claude SDK and TUI, a fake Codex) and
 * a temp project. It keeps running until SIGINT/SIGTERM and removes everything on exit. The stand-in
 * SDK uses its plan's own Naru MCP capability, so demo data goes through the real agent path.
 *
 * Run (Node 24) after `pnpm build`: node --import tsx tests/spikes/agent-platform/ui-sandbox.ts
 * A goal like "@sample PLAN 로그인을 passkey로" in the control room builds a whole team.
 * SANDBOX_STALL_MINUTES=1 makes a quiet team ("@sample PLAN QUIET …") stall within minutes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startNaruStack } from "./naru-stack.js";

// Stand-in Claude SDK (see ui-sandbox-sdk.mjs): Claude-shaped histories, and keywords that act
// through each agent's own Naru MCP capability.
const SDK = readFileSync(new URL("./ui-sandbox-sdk.mjs", import.meta.url), "utf8");

const stack = await startNaruStack({
  sdkSource: SDK,
  ...(process.env.SANDBOX_PORT === undefined ? {} : { port: Number(process.env.SANDBOX_PORT) }),
  ...(process.env.SANDBOX_STALL_MINUTES === undefined
    ? {}
    : { stallMinutes: Number(process.env.SANDBOX_STALL_MINUTES) }),
});
process.stdout.write(
  `SANDBOX ${stack.origin} password ${stack.password} project ${join(stack.projectRoot, "sample")}\n`,
);

const shutdown = async (): Promise<void> => {
  await stack.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
