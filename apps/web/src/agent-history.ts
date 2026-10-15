/** One line of an agent conversation as the Agent Panel shows it. */
export interface HistoryEntry {
  readonly role: "user" | "assistant" | "tool";
  readonly text: string;
}

/**
 * Naru re-reads history from the runtime instead of storing it (AP-D002). Claude's SDK returns
 * session messages; Codex returns turns with items. Both become plain-text entries; anything the
 * Panel does not understand is left out rather than guessed.
 */
export function historyEntries(items: readonly unknown[]): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const item of items) {
    const record = asRecord(item);
    if (record === null) continue;
    if (Array.isArray(record.items)) {
      for (const turnItem of record.items) entries.push(...codexItem(asRecord(turnItem)));
      continue;
    }
    entries.push(...claudeMessage(record));
  }
  return entries.filter((entry) => entry.text.trim() !== "");
}

function claudeMessage(record: Record<string, unknown>): HistoryEntry[] {
  const role = record.type === "user" ? "user" : record.type === "assistant" ? "assistant" : null;
  if (role === null) return [];
  const message = asRecord(record.message);
  const content = message?.content;
  if (typeof content === "string") return [{ role, text: content }];
  if (!Array.isArray(content)) return [];
  const entries: HistoryEntry[] = [];
  for (const block of content) {
    const part = asRecord(block);
    if (part?.type === "text" && typeof part.text === "string") {
      entries.push({ role, text: part.text });
    } else if (part?.type === "tool_use" && typeof part.name === "string") {
      entries.push({ role: "tool", text: `도구 사용: ${part.name}` });
    }
  }
  return entries;
}

function codexItem(item: Record<string, unknown> | null): HistoryEntry[] {
  switch (item?.type) {
    case "userMessage": {
      const content = Array.isArray(item.content) ? item.content : [];
      const text = content
        .map((part) => {
          const record = asRecord(part);
          return record?.type === "text" && typeof record.text === "string" ? record.text : "";
        })
        .join("");
      return [{ role: "user", text }];
    }
    case "agentMessage":
      return typeof item.text === "string" ? [{ role: "assistant", text: item.text }] : [];
    case "commandExecution":
      return typeof item.command === "string"
        ? [{ role: "tool", text: `명령 실행: ${item.command}` }]
        : [];
    case "fileChange":
      return [{ role: "tool", text: "파일 변경" }];
    case "mcpToolCall": {
      const server = typeof item.server === "string" ? item.server : "";
      const tool = typeof item.tool === "string" ? item.tool : "";
      return [{ role: "tool", text: `도구 사용: ${server}/${tool}` }];
    }
    default:
      return [];
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
