import {
  MAX_CODEX_HOOK_INPUT_BYTES,
  parseCodexHookInput,
  readCodexSessionHookEnvironment,
  sendCodexHookEvent,
} from "./codex-session-hook-client.js";

type HookFailureCode =
  | "NARU_CODEX_HOOK_INPUT_TOO_LARGE"
  | "NARU_CODEX_HOOK_INPUT_INVALID"
  | "NARU_CODEX_HOOK_ENVIRONMENT_INVALID"
  | "NARU_CODEX_HOOK_DELIVERY_FAILED";

const input = await readStandardInput();
let failureCode: HookFailureCode | null = null;
const event = input.ok ? parseCodexHookInput(input.value) : null;
if (!input.ok) failureCode = "NARU_CODEX_HOOK_INPUT_TOO_LARGE";
else if (event === null) failureCode = "NARU_CODEX_HOOK_INPUT_INVALID";

const environment = failureCode === null ? readCodexSessionHookEnvironment(process.env) : null;
if (failureCode === null && environment === null) {
  failureCode = "NARU_CODEX_HOOK_ENVIRONMENT_INVALID";
}

if (
  failureCode === null &&
  event !== null &&
  environment !== null &&
  !(await sendCodexHookEvent(event, environment))
) {
  // Durable Host-owned Codex must keep working while Naru is restarting. This
  // hook only observes redacted lifecycle state and never grants an approval.
  if (!("bootstrap" in environment)) failureCode = "NARU_CODEX_HOOK_DELIVERY_FAILED";
}

if (failureCode !== null) {
  process.stderr.write(`${failureCode}\n`);
  process.exitCode = 1;
} else if (event?.type === "turn-completed") {
  process.stdout.write("{}\n");
}

async function readStandardInput(): Promise<
  { readonly ok: true; readonly value: string } | { readonly ok: false }
> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += bytes.length;
    if (size > MAX_CODEX_HOOK_INPUT_BYTES) return { ok: false };
    chunks.push(bytes);
  }
  return { ok: true, value: Buffer.concat(chunks).toString("utf8") };
}
