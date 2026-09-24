import { realpathSync } from "node:fs";
import { startCodexAcceptanceFixture } from "../../../apps/server/test/codex-acceptance-fixture.js";

const executable = process.env.NARU_ACTUAL_CODEX;
if (!executable) throw new Error("Set NARU_ACTUAL_CODEX to an actual Codex executable.");
const password = process.env.NARU_TEST_PASSWORD;
if (!password) throw new Error("Set a test-only NARU_TEST_PASSWORD in the process environment.");
const server = await startCodexAcceptanceFixture(realpathSync(executable), password);
console.log(`Isolated Codex test server: ${server.origin}`);
console.log(
  "Use your NARU_TEST_PASSWORD. Real Codex CLI; synthetic loopback model, no account credentials.",
);
let closing = false;
const close = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await server.close();
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
