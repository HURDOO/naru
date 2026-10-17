import type { Instruction } from "@naru/contracts/naru-agent/v1";
import { eventTypeLabel } from "./agent-labels";
import type { AgentDecision } from "./api";

/**
 * An agent's conversation as the chat shows it (AP-D022). Naru re-reads history from the runtime
 * instead of storing it (AP-D002): Claude's SDK returns session messages, Codex returns turns with
 * items. Requests are attributed to whoever asked by the verbatim instructions Naru recorded; tool
 * calls and thinking become collapsible rows; Naru's wakeup turns become the requests they carry,
 * and the person's decisions on what the agent asked become the person's words (AP-D035).
 * Anything not understood is left out rather than guessed.
 */

export type RequestSource =
  | { readonly kind: "me"; readonly channel: Instruction["channel"] }
  | { readonly kind: "agent"; readonly agentSessionId: string }
  | { readonly kind: "unknown" };

export type ToolKind =
  "read" | "search" | "edit" | "command" | "web" | "agent" | "naru" | "plan" | "other";

export interface ToolCall {
  readonly id: string;
  readonly kind: ToolKind;
  /** What it acted on: a path, a command, a query or the tool's name. */
  readonly title: string;
  readonly added: number | null;
  readonly removed: number | null;
  output: string | null;
  failed: boolean;
  readonly durationMs: number | null;
}

export type ConversationBlock =
  | {
      readonly kind: "request";
      readonly key: string;
      readonly source: RequestSource;
      readonly text: string;
      readonly at: string | null;
      /** The user instruction an agent's delegation serves. */
      readonly origin: Instruction | null;
      /** What these words decided: the agent's question or its intent contract (AP-D035). */
      readonly answered: Answered | null;
    }
  | { readonly kind: "answer"; readonly key: string; text: string }
  | { readonly kind: "tools"; readonly key: string; readonly calls: ToolCall[] }
  | { readonly kind: "thinking"; readonly key: string; text: string }
  | {
      readonly kind: "notice";
      readonly key: string;
      readonly text: string;
      readonly details: string[];
    }
  | AskBlock;

export type Answered =
  | {
      readonly kind: "question";
      readonly question: string;
      /** The option the person picked, when they also wrote more than its name. */
      readonly chosen: string | null;
    }
  | { readonly kind: "contract"; readonly version: number };

/** The agent asked the person something through Naru; shown in full, never folded. */
export interface AskBlock {
  readonly kind: "ask";
  readonly key: string;
  /** Handoff kind (`product-decision`, `manual-test`, `design-deviation`, …). */
  readonly handoffKind: string;
  readonly reason: string;
  readonly options: readonly { readonly label: string; readonly description: string }[];
  readonly recommendation: string;
  /** The handoff Naru recorded, once the call returned it. */
  handoffId: string | null;
  failed: boolean;
  /** The person's answer follows in this conversation (AP-D035). */
  answered: boolean;
}

/** Naru tools that put a question to the person, and the handoff kind each implies. */
const ASK_TOOLS: Readonly<Record<string, string | null>> = {
  request_human_handoff: null,
  propose_design_change: "design-deviation",
};

export interface ConversationContext {
  readonly instructions: readonly Instruction[];
  readonly origins: readonly Instruction[];
  readonly decisions?: readonly AgentDecision[] | undefined;
}

const WAKEUP_HEADER = "[Naru] New events since your last turn";
/** Server `OPEN_QUESTION_NOTE`: Naru's reminder appended to a person's chat turn. */
const OPEN_QUESTION_NOTE = "\n\n[Naru] Your question to the person is still open";
const WAKEUP_LINE = /^- #\d+ ([a-z_.]+) subject=([0-9a-f-]{36}) actor=(\w+)(.*)$/u;
const OUTPUT_LIMIT = 4_000;

export function conversationBlocks(
  items: readonly unknown[],
  context: ConversationContext,
): ConversationBlock[] {
  const builder = new Builder(context);
  for (const item of items) {
    const record = asRecord(item);
    if (record === null) continue;
    if (Array.isArray(record.items)) builder.codexTurn(record);
    else builder.claudeMessage(record);
  }
  return builder.blocks;
}

class Builder {
  readonly blocks: ConversationBlock[] = [];
  readonly #context: ConversationContext;
  readonly #used = new Set<string>();
  readonly #calls = new Map<string, ToolCall>();
  readonly #asks = new Map<string, AskBlock>();
  #next = 0;

  constructor(context: ConversationContext) {
    this.#context = context;
  }

  claudeMessage(record: Record<string, unknown>): void {
    // Messages of a native subagent belong to its own transcript (observed only, AP-D014).
    if (typeof record.parent_tool_use_id === "string") return;
    const message = asRecord(record.message);
    const content = message?.content;
    if (record.type === "system") {
      if (record.subtype === "compact_boundary") this.#notice("앞의 대화를 요약했습니다", []);
      return;
    }
    if (record.type === "user") {
      if (typeof content === "string") {
        this.#userText(content, null);
        return;
      }
      if (!Array.isArray(content)) return;
      const texts: string[] = [];
      for (const block of content) {
        const part = asRecord(block);
        if (part?.type === "tool_result") this.#toolResult(part);
        else if (part?.type === "text" && typeof part.text === "string") texts.push(part.text);
      }
      if (texts.length > 0) this.#userText(texts.join("\n\n"), null);
      return;
    }
    if (record.type !== "assistant" || !Array.isArray(content)) return;
    for (const block of content) {
      const part = asRecord(block);
      if (part === null) continue;
      if (part.type === "text" && typeof part.text === "string") this.#answer(part.text);
      else if (part.type === "thinking") {
        this.#thinking(typeof part.thinking === "string" ? part.thinking : "");
      } else if (part.type === "redacted_thinking") this.#thinking("");
      else if (part.type === "tool_use" && typeof part.name === "string") {
        const asked = naruAsk(part.name, asRecord(part.input) ?? {}, this.#key("ask"));
        if (asked !== null) {
          if (typeof part.id === "string") this.#asks.set(part.id, asked);
          this.blocks.push(asked);
          continue;
        }
        const call = claudeToolCall(
          typeof part.id === "string" ? part.id : this.#key("tool"),
          part.name,
          asRecord(part.input) ?? {},
        );
        if (typeof part.id === "string") this.#calls.set(part.id, call);
        this.#tool(call);
      }
    }
  }

  codexTurn(turn: Record<string, unknown>): void {
    const started =
      typeof turn.startedAt === "number" ? new Date(turn.startedAt * 1000).toISOString() : null;
    for (const entry of turn.items as unknown[]) {
      const item = asRecord(entry);
      if (item === null) continue;
      const id = typeof item.id === "string" ? item.id : this.#key("item");
      switch (item.type) {
        case "userMessage": {
          const content = Array.isArray(item.content) ? item.content : [];
          const text = content
            .map((part) => {
              const record = asRecord(part);
              return record?.type === "text" && typeof record.text === "string" ? record.text : "";
            })
            .join("");
          this.#userText(text, started);
          break;
        }
        case "agentMessage":
          if (typeof item.text === "string") this.#answer(item.text);
          break;
        case "reasoning": {
          const summary = Array.isArray(item.summary) ? item.summary : [];
          this.#thinking(summary.filter((part) => typeof part === "string").join("\n\n"));
          break;
        }
        case "commandExecution":
          this.#tool(codexCommand(id, item));
          break;
        case "fileChange":
          for (const [index, change] of (Array.isArray(item.changes)
            ? item.changes
            : []
          ).entries()) {
            const record = asRecord(change);
            if (record === null || typeof record.path !== "string") continue;
            const diff = typeof record.diff === "string" ? record.diff : "";
            const counted = diffCounts(diff);
            this.#tool({
              id: `${id}:${index}`,
              kind: "edit",
              title: record.path,
              added: counted.added,
              removed: counted.removed,
              output: diff === "" ? null : clip(diff),
              failed: item.status === "failed" || item.status === "declined",
              durationMs: null,
            });
          }
          break;
        case "mcpToolCall": {
          const server = typeof item.server === "string" ? item.server : "";
          const tool = typeof item.tool === "string" ? item.tool : "";
          const asked =
            server === "naru"
              ? naruAsk(`mcp__naru__${tool}`, asRecord(item.arguments) ?? {}, this.#key("ask"))
              : null;
          if (asked !== null) {
            asked.failed = item.status === "failed" || item.error != null;
            const result = asRecord(item.result);
            asked.handoffId = handoffIdIn(
              resultText(result?.content) || JSON.stringify(result?.structuredContent ?? null),
            );
            this.blocks.push(asked);
            break;
          }
          this.#tool({
            id,
            kind: server === "naru" ? "naru" : "other",
            title: server === "naru" ? naruToolLabel(tool) : `${server}.${tool}`,
            added: null,
            removed: null,
            output: null,
            failed: item.status === "failed" || item.error != null,
            durationMs: typeof item.durationMs === "number" ? item.durationMs : null,
          });
          break;
        }
        case "dynamicToolCall":
          this.#tool({
            id,
            kind: "other",
            title: typeof item.tool === "string" ? item.tool : "도구",
            added: null,
            removed: null,
            output: null,
            failed: item.success === false,
            durationMs: typeof item.durationMs === "number" ? item.durationMs : null,
          });
          break;
        case "webSearch":
          this.#tool({
            id,
            kind: "web",
            title: typeof item.query === "string" && item.query !== "" ? item.query : "웹 검색",
            added: null,
            removed: null,
            output: null,
            failed: false,
            durationMs: null,
          });
          break;
        case "plan":
          if (typeof item.text === "string" && item.text.trim() !== "") {
            this.#tool({
              id,
              kind: "plan",
              title: "계획",
              added: null,
              removed: null,
              output: clip(item.text),
              failed: false,
              durationMs: null,
            });
          }
          break;
        case "collabAgentToolCall":
        case "subAgentActivity":
          this.#tool({
            id,
            kind: "agent",
            title: "보조 에이전트",
            added: null,
            removed: null,
            output: null,
            failed: false,
            durationMs: null,
          });
          break;
        case "contextCompaction":
          this.#notice("앞의 대화를 요약했습니다", []);
          break;
        default:
          break;
      }
    }
  }

  #userText(raw: string, at: string | null): void {
    // Naru's reminder of an open question rides on the person's turn; it is not what they said.
    const note = raw.indexOf(OPEN_QUESTION_NOTE);
    const text = (note === -1 ? raw : raw.slice(0, note)).trim();
    if (text === "" || isSystemText(text)) return;
    if (text.startsWith(WAKEUP_HEADER)) {
      this.#wakeup(text);
      return;
    }
    const instruction = this.#match(text);
    if (instruction === null) {
      this.blocks.push({
        kind: "request",
        key: this.#key("request"),
        source: { kind: "unknown" },
        text,
        at,
        origin: null,
        answered: null,
      });
      return;
    }
    this.#request(instruction, text);
  }

  /**
   * A Naru wakeup turn: the instructions it announces become requests, the person's decisions on
   * what this agent asked become the person's words, the rest one notice.
   */
  #wakeup(text: string): void {
    const details: string[] = [];
    for (const line of text.split("\n")) {
      const parsed = WAKEUP_LINE.exec(line.trim());
      if (parsed === null) continue;
      const [, type, subjectId, , rest] = parsed;
      if (type === "instruction.created") {
        const instruction = this.#context.instructions.find((item) => item.id === subjectId);
        if (instruction !== undefined && instruction.verbatim !== null) {
          this.#used.add(instruction.id);
          this.#request(instruction, instruction.verbatim);
          continue;
        }
      }
      if (type === "handoff.resolved" || type === "intent_contract.approved") {
        const decision = this.#context.decisions?.find(
          (item) =>
            item.id === subjectId &&
            item.kind === (type === "handoff.resolved" ? "handoff" : "contract"),
        );
        if (decision !== undefined && !this.#used.has(decision.id)) {
          this.#used.add(decision.id);
          this.#decision(decision);
          continue;
        }
      }
      const status = /(?:^|\s)status=([a-z-]+)/u.exec(rest ?? "")?.[1] ?? null;
      details.push(eventTypeLabel(type!, status));
    }
    if (details.length > 0) this.#notice(`Naru 알림 · ${summarize(details)}`, details);
  }

  #request(instruction: Instruction, text: string): void {
    const author = instruction.author;
    this.blocks.push({
      kind: "request",
      key: this.#key("request"),
      source:
        author.kind === "agent"
          ? { kind: "agent", agentSessionId: author.agentSessionId }
          : author.kind === "human"
            ? { kind: "me", channel: instruction.channel }
            : { kind: "unknown" },
      text,
      at: instruction.createdAt,
      origin:
        instruction.originUserInstructionId === null
          ? null
          : (this.#context.origins.find(
              (item) => item.id === instruction.originUserInstructionId,
            ) ?? null),
      answered: null,
    });
  }

  #decision(decision: AgentDecision): void {
    for (const block of this.blocks) {
      if (block.kind === "ask" && block.handoffId === decision.id) block.answered = true;
    }
    const answered: Answered =
      decision.kind === "contract"
        ? { kind: "contract", version: decision.version }
        : {
            kind: "question",
            question: decision.question,
            chosen:
              decision.chosenOption !== null && decision.chosenOption !== decision.decision.trim()
                ? decision.chosenOption
                : null,
          };
    this.blocks.push({
      kind: "request",
      key: this.#key("request"),
      source: { kind: "me", channel: "naru-ui" },
      // The contract sheet's button is what the person said to it.
      text: decision.kind === "contract" ? "이 계약으로 진행" : decision.decision,
      at: decision.at,
      origin: null,
      answered,
    });
  }

  /** The recorded instruction this text is, oldest unused first; a wrapped one by containment. */
  #match(text: string): Instruction | null {
    const candidates = this.#context.instructions.filter(
      (item) => item.verbatim !== null && !this.#used.has(item.id),
    );
    const found =
      candidates.find((item) => item.verbatim!.trim() === text) ??
      candidates.find(
        (item) => item.verbatim!.trim().length >= 8 && text.includes(item.verbatim!.trim()),
      );
    if (found === undefined) return null;
    this.#used.add(found.id);
    return found;
  }

  #answer(text: string): void {
    if (text.trim() === "") return;
    const last = this.blocks.at(-1);
    if (last?.kind === "answer") last.text = `${last.text}\n\n${text}`;
    else this.blocks.push({ kind: "answer", key: this.#key("answer"), text });
  }

  #thinking(text: string): void {
    const last = this.blocks.at(-1);
    if (last?.kind === "thinking") {
      if (text !== "") last.text = last.text === "" ? text : `${last.text}\n\n${text}`;
      return;
    }
    this.blocks.push({ kind: "thinking", key: this.#key("thinking"), text });
  }

  #tool(call: ToolCall): void {
    const last = this.blocks.at(-1);
    if (last?.kind === "tools") last.calls.push(call);
    else this.blocks.push({ kind: "tools", key: this.#key("tools"), calls: [call] });
  }

  #toolResult(part: Record<string, unknown>): void {
    if (typeof part.tool_use_id !== "string") return;
    const asked = this.#asks.get(part.tool_use_id);
    if (asked !== undefined) {
      if (part.is_error === true) asked.failed = true;
      asked.handoffId = handoffIdIn(resultText(part.content));
      return;
    }
    const call = this.#calls.get(part.tool_use_id);
    if (call === undefined) return;
    if (part.is_error === true) call.failed = true;
    const text = resultText(part.content);
    if (text !== "" && call.kind !== "edit") call.output = clip(text);
  }

  #notice(text: string, details: string[]): void {
    this.blocks.push({ kind: "notice", key: this.#key("notice"), text, details });
  }

  #key(prefix: string): string {
    this.#next += 1;
    return `${prefix}-${this.#next}`;
  }
}

// Tool calls -------------------------------------------------------------------------------------

function naruAsk(name: string, input: Record<string, unknown>, key: string): AskBlock | null {
  if (!name.startsWith("mcp__naru__")) return null;
  const tool = name.slice("mcp__naru__".length);
  if (!(tool in ASK_TOOLS)) return null;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    kind: "ask",
    key,
    handoffKind: ASK_TOOLS[tool] ?? (text(input.kind) || "product-decision"),
    reason: text(input.reason),
    options: (Array.isArray(input.options) ? input.options : [])
      .map(asRecord)
      .filter((option): option is Record<string, unknown> => option !== null)
      .map((option) => ({ label: text(option.label), description: text(option.description) }))
      .filter((option) => option.label !== ""),
    recommendation: text(input.recommendation),
    handoffId: null,
    failed: false,
    answered: false,
  };
}

/** The recorded handoff's id in a tool result (the handoff itself, or wrapped in `result`). */
function handoffIdIn(text: string): string | null {
  try {
    const parsed = asRecord(JSON.parse(text));
    const handoff = asRecord(parsed?.result) ?? parsed;
    return typeof handoff?.id === "string" ? handoff.id : null;
  } catch {
    // A shortened result is no longer JSON; the handoff's own id comes first.
    return /"id"\s*:\s*"([0-9a-f-]{36})"/u.exec(text)?.[1] ?? null;
  }
}

function claudeToolCall(id: string, name: string, input: Record<string, unknown>): ToolCall {
  const text = (key: string): string | null =>
    typeof input[key] === "string" && input[key] !== "" ? input[key] : null;
  const base = { id, added: null, removed: null, output: null, failed: false, durationMs: null };
  switch (name) {
    case "Read":
    case "NotebookRead":
      return { ...base, kind: "read", title: text("file_path") ?? text("notebook_path") ?? name };
    case "Grep":
    case "Glob":
    case "LS":
      return { ...base, kind: "search", title: text("pattern") ?? text("path") ?? name };
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit": {
      const counted = editCounts(name, input);
      return {
        ...base,
        kind: "edit",
        title: text("file_path") ?? text("notebook_path") ?? name,
        added: counted.added,
        removed: counted.removed,
      };
    }
    case "Bash":
      return { ...base, kind: "command", title: text("command") ?? name };
    case "WebFetch":
    case "WebSearch":
      return { ...base, kind: "web", title: text("url") ?? text("query") ?? name };
    case "Task":
    case "Agent":
      return { ...base, kind: "agent", title: text("description") ?? "보조 에이전트" };
    case "TodoWrite":
      return { ...base, kind: "plan", title: "할 일 목록" };
    default:
      if (name.startsWith("mcp__naru__")) {
        return { ...base, kind: "naru", title: naruToolLabel(name.slice("mcp__naru__".length)) };
      }
      return { ...base, kind: "other", title: name.replace(/^mcp__/u, "").replaceAll("__", ".") };
  }
}

function codexCommand(id: string, item: Record<string, unknown>): ToolCall {
  const command = typeof item.command === "string" ? item.command : "명령";
  const actions = (Array.isArray(item.commandActions) ? item.commandActions : [])
    .map(asRecord)
    .filter((action): action is Record<string, unknown> => action !== null);
  // Codex parses read-only shell commands; show those as reads and searches like Claude's tools.
  const only = (type: string) =>
    actions.length > 0 && actions.every((action) => action.type === type);
  const kind: ToolKind = only("read")
    ? "read"
    : only("search") || only("listFiles")
      ? "search"
      : "command";
  const title =
    kind === "read" && typeof actions[0]?.path === "string"
      ? actions[0].path
      : kind === "search" && typeof actions[0]?.query === "string"
        ? actions[0].query
        : command;
  const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
  return {
    id,
    kind,
    title,
    added: null,
    removed: null,
    output: output === "" ? null : clip(output),
    failed:
      item.status === "failed" ||
      item.status === "declined" ||
      (typeof item.exitCode === "number" && item.exitCode !== 0),
    durationMs: typeof item.durationMs === "number" ? item.durationMs : null,
  };
}

function editCounts(
  name: string,
  input: Record<string, unknown>,
): { added: number | null; removed: number | null } {
  const lines = (value: unknown): number =>
    typeof value === "string" && value !== "" ? value.split("\n").length : 0;
  if (name === "Write") return { added: lines(input.content), removed: null };
  if (name === "Edit") return { added: lines(input.new_string), removed: lines(input.old_string) };
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    let added = 0;
    let removed = 0;
    for (const edit of input.edits) {
      const record = asRecord(edit);
      added += lines(record?.new_string);
      removed += lines(record?.old_string);
    }
    return { added, removed };
  }
  return { added: null, removed: null };
}

export function diffCounts(diff: string): { added: number | null; removed: number | null } {
  if (diff === "") return { added: null, removed: null };
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

const NARU_TOOL_LABELS: Readonly<Record<string, string>> = {
  get_project_state: "프로젝트 상태 읽음",
  get_delegated_work: "맡은 일 확인",
  get_applicable_user_instructions: "사용자 지시 확인",
  get_task_detail: "작업 확인",
  get_merge_gate: "병합 조건 확인",
  get_handoff_status: "질문 상태 확인",
  read_events: "새 소식 읽음",
  list_agents: "에이전트 목록 확인",
  list_projects: "프로젝트 목록 확인",
  list_processes: "프로세스 목록 확인",
  create_plan: "계획 작성",
  create_task: "작업 만듦",
  update_task: "작업 상태 바꿈",
  start_run: "작업 시작",
  finish_run: "작업 마침",
  report_progress: "진행 보고",
  request_human_handoff: "사람에게 물음",
  propose_design_change: "설계 변경 제안",
  propose_intent_contract: "의도 계약 제안",
  cancel_handoff: "질문 취소",
  submit_review: "리뷰 제출",
  publish_artifact: "산출물 등록",
  spawn_agent: "에이전트 띄움",
  interrupt_agent: "에이전트 멈춤",
  open_pane: "화면 열기",
  create_worktree: "작업 브랜치 만듦",
  merge_task: "병합",
  start_process: "프로세스 시작",
  send_process_input: "프로세스에 입력",
  read_process_screen: "프로세스 화면 읽음",
  stop_process: "프로세스 정지",
  close_process: "프로세스 닫음",
};

function naruToolLabel(tool: string): string {
  return NARU_TOOL_LABELS[tool] ?? tool.replaceAll("_", " ");
}

/** "파일 6개 읽음 · 검색 2번 · 명령 1개 실행" for a collapsed group of calls. */
export function toolSummary(calls: readonly ToolCall[]): string {
  const count = (kind: ToolKind) => calls.filter((call) => call.kind === kind).length;
  const edited = new Set(calls.filter((call) => call.kind === "edit").map((call) => call.title));
  const parts: string[] = [];
  const read = count("read");
  if (read > 0) parts.push(`파일 ${read}개 읽음`);
  if (count("search") > 0) parts.push(`검색 ${count("search")}번`);
  if (edited.size > 0) parts.push(`파일 ${edited.size}개 수정`);
  if (count("command") > 0) parts.push(`명령 ${count("command")}개 실행`);
  if (count("web") > 0) parts.push(`웹 ${count("web")}번`);
  if (count("agent") > 0) parts.push(`보조 에이전트 ${count("agent")}번`);
  if (count("plan") > 0) parts.push("계획 갱신");
  if (count("naru") > 0) {
    const naru = calls.filter((call) => call.kind === "naru");
    parts.push(naru.length === 1 ? `Naru · ${naru[0]!.title}` : `Naru 기록 ${naru.length}번`);
  }
  if (count("other") > 0) parts.push(`도구 ${count("other")}번`);
  return parts.join(" · ");
}

/** "+86 −4" when the group edited files. */
export function changeSummary(calls: readonly ToolCall[]): string | null {
  let added = 0;
  let removed = 0;
  let known = false;
  for (const call of calls) {
    if (call.added !== null) {
      added += call.added;
      known = true;
    }
    if (call.removed !== null) {
      removed += call.removed;
      known = true;
    }
  }
  return known ? `+${added} −${removed}` : null;
}

function summarize(labels: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts]
    .map(([label, count]) => (count === 1 ? label : `${label} ${count}`))
    .join(" · ");
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const record = asRecord(part);
      return record?.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter((text) => text !== "")
    .join("\n");
}

/** Runtime-injected context (reminders, command echoes) is not something anyone said. */
function isSystemText(text: string): boolean {
  return /^<([a-z][a-z0-9-]*)>[\s\S]*<\/\1>$/u.test(text) || text.startsWith("Caveat: ");
}

function clip(text: string): string {
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n…` : text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
