import { isAbsolute } from "node:path";
import { z } from "zod";

export const MAX_CLAUDE_HOOK_INPUT_BYTES = 8 * 1024 * 1024;

export const ClaudeActivityEventSchema = z.strictObject({
  type: z.enum([
    "session-start",
    "turn-start",
    "interaction-required",
    "turn-running",
    "turn-completed",
    "turn-failed",
    "session-end",
  ]),
  sessionId: z.string().min(1).max(128),
  cwd: z.string().min(1).max(4_096),
});

export type ClaudeActivityEvent = z.infer<typeof ClaudeActivityEventSchema>;

/** Extract only lifecycle identifiers; never forward prompts, tool payloads, or transcript data. */
export function parseClaudeActivityHookInput(serialized: string): ClaudeActivityEvent | null {
  if (Buffer.byteLength(serialized) > MAX_CLAUDE_HOOK_INPUT_BYTES) return null;
  let input: unknown;
  try {
    input = JSON.parse(serialized) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(input) || input.agent_id !== undefined) return null;
  const { session_id: sessionId, cwd } = input;
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    sessionId.length > 128 ||
    typeof cwd !== "string" ||
    cwd.length === 0 ||
    Buffer.byteLength(cwd) > 4_096 ||
    !isAbsolute(cwd)
  ) {
    return null;
  }

  let type: ClaudeActivityEvent["type"];
  switch (input.hook_event_name) {
    case "SessionStart":
      type = "session-start";
      break;
    case "UserPromptSubmit":
      type = "turn-start";
      break;
    case "PermissionRequest":
    case "Elicitation":
      type = "interaction-required";
      break;
    case "Notification":
      if (
        input.notification_type === "permission_prompt" ||
        input.notification_type === "elicitation_dialog"
      ) {
        type = "interaction-required";
      } else if (
        input.notification_type === "elicitation_response" ||
        input.notification_type === "elicitation_complete"
      ) {
        type = "turn-running";
      } else {
        return null;
      }
      break;
    case "PostToolUse":
    case "PostToolUseFailure":
    case "PermissionDenied":
    case "ElicitationResult":
      type = "turn-running";
      break;
    case "Stop":
      type = "turn-completed";
      break;
    case "StopFailure":
      type = "turn-failed";
      break;
    case "SessionEnd":
      type = "session-end";
      break;
    default:
      return null;
  }
  return { type, sessionId, cwd };
}

export function claudeActivityHookSettings(command: string): string {
  const handler = { type: "command", command, timeout: 3 };
  return JSON.stringify({
    hooks: Object.fromEntries(
      [
        "SessionStart",
        "UserPromptSubmit",
        "PermissionRequest",
        "Notification",
        "PostToolUse",
        "PostToolUseFailure",
        "PermissionDenied",
        "Elicitation",
        "ElicitationResult",
        "Stop",
        "StopFailure",
        "SessionEnd",
      ].map((event) => [event, [{ hooks: [handler] }]]),
    ),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
