/** Host-owned Claude hook: parse locally and send only redacted lifecycle identifiers. */
import {
  MAX_CLAUDE_HOOK_INPUT_BYTES,
  parseClaudeActivityHookInput,
} from "./claude-activity-events.js";
import { requestCodexIntegration } from "./integrations/codex/client.js";
import { NARU_CODEX_INTEGRATION_SOCKET_ENV } from "./integrations/codex/protocol.js";

const bootstrap = process.env.NARU_CLAUDE_HOOK_BOOTSTRAP;
const socketPath = process.env[NARU_CODEX_INTEGRATION_SOCKET_ENV];
if (bootstrap !== undefined && socketPath !== undefined) {
  const input = await readStandardInput();
  const event = input === null ? null : parseClaudeActivityHookInput(input);
  if (event !== null) {
    try {
      await requestCodexIntegration(socketPath, {
        version: 1,
        type: "claude-hook",
        bootstrap,
        event,
      });
    } catch {
      // Observation must not affect Claude's permission or stop decisions.
    }
  }
}

async function readStandardInput(): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += bytes.length;
    if (size > MAX_CLAUDE_HOOK_INPUT_BYTES) return null;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}
