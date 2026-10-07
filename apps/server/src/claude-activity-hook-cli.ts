/** Side-effect-only Claude hook: never print input, decision JSON, or diagnostic details. */
import {
  MAX_CLAUDE_HOOK_INPUT_BYTES,
  parseClaudeActivityHookInput,
} from "./claude-activity-events.js";
import {
  readClaudeHookEnvironment,
  sendClaudeActivityEvent,
} from "./claude-activity-hook-client.js";

const input = await readStandardInput();
const event = input === null ? null : parseClaudeActivityHookInput(input);
const environment = event === null ? null : readClaudeHookEnvironment(process.env);
if (event !== null && environment !== null) {
  // Observation failure must not grant/deny tools or block Claude's conversation.
  try {
    await sendClaudeActivityEvent(event, environment);
  } catch {
    // Do not leak hook input, private paths, or transport details to the transcript.
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
