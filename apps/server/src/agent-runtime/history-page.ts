import type { RunnerMessage } from "./channel-protocol.js";

/**
 * History pages carry what a conversation shows (AP-D040). Image bytes are left out, and a tool's
 * output is kept to more than the conversation shows of it, so a page fits the runtime channel's
 * line bound. Text, tool inputs and diffs stay whole unless one item alone is too big for a page.
 */
export const HISTORY_PAGE_BYTES = 512 * 1024;
/** The conversation shows 4,000 characters of a tool's output. */
const OUTPUT_CHARS = 8_000;
/** For one item too big alone: every long string is cut to this. */
const TIGHT_CHARS = 1_000;
/**
 * The channel's line bound (`MAX_CHANNEL_LINE_BYTES`, checked equal in tests). Not imported: the
 * shared chunk would then export it, and the Host's Codex launcher bundle would change with it.
 */
export const HISTORY_LINE_BYTES = 1024 * 1024;

/** The longest prefix of `items` that fits one page, at least one item, as the conversation shows them. */
export function fitHistoryPage(items: readonly unknown[]): unknown[] {
  const fitted: unknown[] = [];
  let bytes = 2;
  for (const item of items) {
    let slim = slimHistoryItem(item, false);
    let size = jsonBytes(slim);
    if (size > HISTORY_PAGE_BYTES) {
      slim = slimHistoryItem(item, true);
      size = jsonBytes(slim);
    }
    if (fitted.length > 0 && bytes + size + 1 > HISTORY_PAGE_BYTES) break;
    fitted.push(slim);
    bytes += size + 1;
  }
  return fitted;
}

/** A history reply, or an error when even a fitted page would break the channel's line bound. */
export function historyMessage(
  requestId: string,
  items: readonly unknown[],
  nextCursor: string | null,
): RunnerMessage {
  const message: RunnerMessage = { type: "history", requestId, items: [...items], nextCursor };
  // Naru ends a connection that sends an oversized line; one unreadable page must not do that.
  return jsonBytes(message) + 1 > HISTORY_LINE_BYTES
    ? { type: "error", requestId, code: "HISTORY_TOO_LARGE" }
    : message;
}

export function slimHistoryItem(item: unknown, tight: boolean): unknown {
  return slim(item, tight, false);
}

function slim(value: unknown, tight: boolean, output: boolean): unknown {
  if (typeof value === "string") {
    const limit = tight ? TIGHT_CHARS : output ? OUTPUT_CHARS : Infinity;
    return value.length > limit ? `${value.slice(0, limit)}\n…` : value;
  }
  if (Array.isArray(value)) return value.map((entry) => slim(entry, tight, output));
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  // Claude's image blocks, MCP image content, Codex image input: the block stays, its bytes go.
  if (record.type === "image") return { type: "image" };
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    next[key] = slim(entry, tight, output || isToolOutput(record, key));
  }
  return next;
}

/** Where a tool's output is: Claude's tool_result, Codex's command, MCP and dynamic tool items. */
function isToolOutput(record: Record<string, unknown>, key: string): boolean {
  switch (record.type) {
    case "tool_result":
      return key === "content";
    case "commandExecution":
      return key === "aggregatedOutput";
    case "mcpToolCall":
      return key === "result";
    case "dynamicToolCall":
      return key === "contentItems";
    default:
      return false;
  }
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null");
}
