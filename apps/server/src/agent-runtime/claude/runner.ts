import { randomUUID } from "node:crypto";
import type { AgentApprovalDecision } from "@naru/contracts/naru-agent/v1";
import type { AgentRuntimeEvent, HistoryPage } from "../adapter.js";
import type {
  ClaudePermissionResult,
  ClaudePermissionUpdate,
  ClaudeSdkMessage,
  ClaudeSdkPort,
  ClaudeSdkQuery,
  ClaudeSdkUserMessage,
} from "./sdk-port.js";

/**
 * One managed Claude conversation driven through the SDK (AP-D011, AP-D012). It keeps no transcript:
 * events carry identities and outcomes only, and history is re-read from the SDK on demand
 * (AP-D002). Writer ownership is decided by Naru's writer gate before calls reach this class.
 */
export interface ClaudeRunnerPlan {
  readonly executable: string;
  readonly cwd: string;
  readonly model: string;
  readonly resumeRef: string | null;
  /** `--name` for native messaging (AP-D015). */
  readonly nativeName: string;
  /** `--settings` (Naru hooks); user-global settings are not loaded (AP-D013). */
  readonly settings: Record<string, unknown>;
  readonly mcpServers: Record<string, unknown>;
  readonly instructions: string;
  /** Absent: the person's own mode, as their Claude starts it (AP-D023). */
  readonly permissionMode?: "default" | "acceptEdits" | "plan" | "auto" | undefined;
  readonly environment: Record<string, string>;
}

type Listener = (event: AgentRuntimeEvent) => void;

interface PendingApproval {
  readonly resolve: (result: ClaudePermissionResult) => void;
  /** What the SDK proposed for "allow for this session", kept for the answer. */
  readonly suggestions: readonly ClaudePermissionUpdate[];
}

const HISTORY_PAGE = 50;

export class ClaudeRunner {
  readonly #port: ClaudeSdkPort;
  readonly #plan: ClaudeRunnerPlan;
  readonly #listeners = new Set<Listener>();
  readonly #pendingInput: ClaudeSdkUserMessage[] = [];
  readonly #approvals = new Map<string, PendingApproval>();
  #wakeInput: (() => void) | null = null;
  #query: ClaudeSdkQuery | null = null;
  #sessionId: string | null;
  /** Set once the SDK itself named the conversation (a resume ref alone is not a confirmation). */
  #conversationConfirmed = false;
  #inputClosed = false;
  #turnsInFlight = 0;
  #interruptRequested = false;
  #done: Promise<void> | null = null;

  constructor(port: ClaudeSdkPort, plan: ClaudeRunnerPlan) {
    this.#port = port;
    this.#plan = plan;
    this.#sessionId = plan.resumeRef;
  }

  get runtimeSessionRef(): string | null {
    return this.#sessionId;
  }

  get busy(): boolean {
    return this.#turnsInFlight > 0;
  }

  onEvent(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(): void {
    if (this.#query !== null) return;
    this.#query = this.#port.query({
      prompt: this.#input(),
      options: {
        pathToClaudeCodeExecutable: this.#plan.executable,
        cwd: this.#plan.cwd,
        env: this.#plan.environment,
        model: this.#plan.model,
        ...(this.#plan.resumeRef === null ? {} : { resume: this.#plan.resumeRef }),
        // The person's own Claude settings too (AP-D020); Naru's flag settings take precedence.
        settingSources: ["user", "project", "local"],
        settings: this.#plan.settings,
        mcpServers: this.#plan.mcpServers,
        strictMcpConfig: true,
        ...(this.#plan.permissionMode === undefined
          ? {}
          : { permissionMode: this.#plan.permissionMode }),
        systemPrompt: { type: "preset", preset: "claude_code", append: this.#plan.instructions },
        extraArgs: { name: this.#plan.nativeName },
        forwardSubagentText: true,
        canUseTool: (
          toolName: string,
          input: Record<string, unknown>,
          options: { readonly suggestions?: readonly ClaudePermissionUpdate[] },
        ) => this.#requestApproval(toolName, input, options.suggestions ?? []),
      },
    });
    this.#done = this.#consume(this.#query);
  }

  /** Starts a turn now, or queues it behind the running one as the SDK does. */
  sendTurn(text: string): void {
    if (this.#inputClosed) throw new Error("The Claude runner has stopped.");
    this.#pendingInput.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: this.#sessionId ?? "",
    });
    this.#turnsInFlight += 1;
    this.#emit({ type: "turn-started", turnId: null });
    this.#wakeInput?.();
  }

  async interrupt(): Promise<void> {
    if (this.#query === null || this.#turnsInFlight === 0) return;
    this.#interruptRequested = true;
    await this.#query.interrupt();
  }

  respondApproval(requestId: string, decision: AgentApprovalDecision): boolean {
    const pending = this.#approvals.get(requestId);
    if (pending === undefined) return false;
    this.#approvals.delete(requestId);
    pending.resolve(
      decision === "deny"
        ? { behavior: "deny", message: "The person declined this action in Naru." }
        : decision === "approve-session" && pending.suggestions.length > 0
          ? {
              behavior: "allow",
              // Only for this session: never written to the person's settings files (AP-D023).
              updatedPermissions: pending.suggestions.map((update) => ({
                ...update,
                destination: "session",
              })),
            }
          : { behavior: "allow" },
    );
    this.#emit({ type: "approval-resolved", requestId });
    return true;
  }

  /** Official SDK history (AP-D002): Naru re-reads instead of storing the conversation. */
  async readHistory(cursor: string | null): Promise<HistoryPage> {
    if (this.#sessionId === null) return { items: [], nextCursor: null };
    const offset = cursor === null ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid history cursor.");
    const items = await this.#port.getSessionMessages(this.#sessionId, {
      dir: this.#plan.cwd,
      offset,
      limit: HISTORY_PAGE,
    });
    return {
      items,
      nextCursor: items.length === HISTORY_PAGE ? String(offset + HISTORY_PAGE) : null,
    };
  }

  /** Ends input after the running turn; pending approvals are denied so nothing hangs. */
  async stop(): Promise<void> {
    this.#inputClosed = true;
    this.#wakeInput?.();
    for (const requestId of [...this.#approvals.keys()]) this.respondApproval(requestId, "deny");
    this.#query?.close?.();
    await this.#done;
  }

  async *#input(): AsyncGenerator<ClaudeSdkUserMessage> {
    for (;;) {
      const next = this.#pendingInput.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#inputClosed) return;
      await new Promise<void>((resolve) => {
        this.#wakeInput = resolve;
      });
      this.#wakeInput = null;
    }
  }

  async #consume(query: ClaudeSdkQuery): Promise<void> {
    let crashed = false;
    try {
      for await (const message of query) this.#observe(message);
    } catch {
      crashed = true;
    } finally {
      this.#inputClosed = true;
      // A turn that never produced a result is not reported as completed.
      while (this.#turnsInFlight > 0) {
        this.#turnsInFlight -= 1;
        this.#emit({ type: "turn-ended", turnId: null, outcome: "interrupted" });
      }
      this.#emit({ type: "exited", reason: crashed ? "crashed" : "stopped" });
    }
  }

  #observe(message: ClaudeSdkMessage): void {
    // Any system message names the conversation. A resumed one does so before the first prompt
    // (`session_title_changed`, `commands_changed`); `init` only comes with the first prompt. A
    // runner switched back from the TUI must confirm its resume without sending a turn.
    if (
      message.type === "system" &&
      typeof message.session_id === "string" &&
      (!this.#conversationConfirmed || message.session_id !== this.#sessionId)
    ) {
      this.#conversationConfirmed = true;
      this.#sessionId = message.session_id;
      this.#emit({ type: "conversation-ready", runtimeSessionRef: message.session_id });
    }
    if (message.type === "system" && message.subtype === "init") return;
    if (message.type === "assistant") {
      const call = lastToolUse(message);
      if (call !== null)
        this.#emit({ type: "tool-activity", ...toolActivity(call.name, call.input) });
      return;
    }
    if (message.type === "result") {
      if (this.#turnsInFlight === 0) return;
      this.#turnsInFlight -= 1;
      const outcome = this.#interruptRequested
        ? "interrupted"
        : message.subtype === "success" && message.is_error !== true
          ? "completed"
          : "failed";
      if (this.#turnsInFlight === 0) this.#interruptRequested = false;
      this.#emit({ type: "turn-ended", turnId: null, outcome });
      return;
    }
    if (message.type === "system" && message.subtype === "task_started") {
      // Claude Code's own helpers (e.g. prompt suggestions) are ambient, not the agent's children.
      if (message.ambient === true || typeof message.task_id !== "string") return;
      this.#emit({
        type: "child-started",
        childRef: message.task_id,
        parentRef: this.#sessionId ?? "",
      });
      return;
    }
    if (message.type === "system" && message.subtype === "task_notification") {
      if (message.ambient === true || typeof message.task_id !== "string") return;
      this.#emit({ type: "child-ended", childRef: message.task_id });
    }
  }

  #requestApproval(
    toolName: string,
    input: Record<string, unknown>,
    suggestions: readonly ClaudePermissionUpdate[],
  ): Promise<ClaudePermissionResult> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      this.#approvals.set(requestId, { resolve, suggestions });
      this.#emit({
        type: "approval-requested",
        requestId,
        kind: approvalKind(toolName),
        summary: approvalSummary(toolName, input),
        ...(suggestions.length > 0 ? { sessionAllow: true } : {}),
      });
    });
  }

  #emit(event: AgentRuntimeEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // Observers must not break the conversation.
      }
    }
  }
}

/**
 * The conversation a launch can resume. Claude names a conversation before it saves anything, so an
 * agent that never had a turn keeps a ref with nothing behind it, and resuming that ends the runtime
 * at once. Such an agent starts a new conversation instead. A failed read proves nothing; resume.
 */
export async function resumableRef(
  port: ClaudeSdkPort,
  resumeRef: string | null,
): Promise<string | null> {
  if (resumeRef === null) return null;
  // No `dir`: the SDK looks in every project directory, as a resume would find it anywhere.
  const saved = await port.getSessionMessages(resumeRef, { limit: 1 }).catch(() => null);
  return saved === null || saved.length > 0 ? resumeRef : null;
}

/** The last tool call an assistant message makes, if any. */
function lastToolUse(
  message: ClaudeSdkMessage,
): { readonly name: string; readonly input: Record<string, unknown> } | null {
  const body = message.message;
  const content =
    typeof body === "object" && body !== null ? (body as { content?: unknown }).content : null;
  if (!Array.isArray(content)) return null;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = content[index] as { type?: unknown; name?: unknown; input?: unknown };
    if (block?.type === "tool_use" && typeof block.name === "string") {
      const input =
        typeof block.input === "object" && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {};
      return { name: block.name, input };
    }
  }
  return null;
}

/** "What it is doing now" (AP-D026): a readable tool name and its short target. */
export function toolActivity(
  toolName: string,
  input: Record<string, unknown>,
): { readonly tool: string; readonly target: string | null } {
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/u.exec(toolName);
  const tool = (mcp === null ? toolName : `${mcp[1]} ${mcp[2]}`).slice(0, 80);
  const raw = [
    input.command,
    input.file_path,
    input.notebook_path,
    input.path,
    input.pattern,
    input.url,
    input.description,
  ].find((value): value is string => typeof value === "string" && value.trim() !== "");
  const target = raw === undefined ? null : raw.replace(/\s+/gu, " ").trim();
  return {
    tool,
    target: target === null ? null : target.length > 200 ? `${target.slice(0, 199)}…` : target,
  };
}

/** What the person is asked to allow: the tool and its command or path, shortened (AP-D017). */
export function approvalSummary(toolName: string, input: Record<string, unknown>): string {
  const detail =
    typeof input.command === "string"
      ? input.command
      : typeof input.file_path === "string"
        ? input.file_path
        : typeof input.notebook_path === "string"
          ? input.notebook_path
          : typeof input.url === "string"
            ? input.url
            : "";
  const text = detail === "" ? toolName : `${toolName}: ${detail}`;
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

function approvalKind(toolName: string): "command" | "file" | "tool" | "permission" {
  if (toolName === "Bash") return "command";
  if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") return "file";
  if (toolName.startsWith("mcp__")) return "tool";
  return "permission";
}
