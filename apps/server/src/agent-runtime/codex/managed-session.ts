import { randomUUID } from "node:crypto";
import type { AgentRuntimeEvent } from "../adapter.js";
import type { CodexRunnerPlan, NaruMessage } from "../channel-protocol.js";
import { RunnerChannelClient } from "../runner-channel.js";
import type { WriterKind } from "../writer-gate.js";
import {
  CodexRpcError,
  type CodexAppServerClient,
  type JsonRpcFrame,
  type JsonRpcId,
} from "./app-server-client.js";

const HISTORY_PAGE = 20;

type ApprovalKind = Extract<AgentRuntimeEvent, { type: "approval-requested" }>["kind"];

/**
 * Client methods that change the conversation or its settings (V01 classification). In a managed
 * session the TUI may send them only while the person is the conversation writer (INV-05).
 */
const WRITE_METHODS = new Set([
  "review/start",
  "thread/approveGuardianDeniedAction",
  "thread/archive",
  "thread/attachment/add",
  "thread/attachment/remove",
  "thread/compact/start",
  "thread/decrement_elicitation",
  "thread/delete",
  "thread/fork",
  "thread/goal/clear",
  "thread/goal/set",
  "thread/increment_elicitation",
  "thread/inject_items",
  "thread/metadata/update",
  "thread/name/set",
  "thread/prediction/request",
  "thread/queue/add",
  "thread/queue/delete",
  "thread/queue/reorder",
  "thread/queue/start",
  "thread/queue/update",
  "thread/realtime/appendAudio",
  "thread/realtime/appendSpeech",
  "thread/realtime/appendText",
  "thread/realtime/start",
  "thread/realtime/stop",
  "thread/revert",
  "thread/section/move",
  "thread/start",
  "thread/unarchive",
  "turn/interrupt",
  "turn/settings/update",
  "turn/start",
  "turn/steer",
  // Settings and execution with external effect are writes too.
  "command/exec",
  "command/exec/write",
  "config/batchWrite",
  "config/mcpServer/reload",
  "config/value/write",
  "fs/copy",
  "fs/createDirectory",
  "fs/remove",
  "fs/writeFile",
  "mcpServer/tool/call",
  "process/spawn",
  "process/writeStdin",
  "thread/memoryMode/set",
  "thread/settings/update",
  "thread/shellCommand",
]);

/** Server requests that are approvals; answered only by the writer (V01). */
const APPROVAL_KINDS: Readonly<Record<string, ApprovalKind>> = {
  "item/commandExecution/requestApproval": "command",
  "item/fileChange/requestApproval": "file",
  "item/permissions/requestApproval": "permission",
  "mcpServer/elicitation/request": "tool",
  execCommandApproval: "command",
  applyPatchApproval: "file",
};

export type TuiFrameDecision =
  | { readonly forward: true; readonly frame: JsonRpcFrame }
  | { readonly forward: false; readonly reply: JsonRpcFrame | null };

/**
 * The Codex relay's managed mode (AP-T13): the relay is the runner of a Naru-managed Codex agent.
 * It reaches Naru over the private runtime channel (and reconnects after a Naru restart), owns the
 * conversation thread through its own app-server client, injects Naru's MCP server per thread, and
 * fences the real TUI by Naru's writer. Events carry identities only (AP-D002); the TUI's own turn
 * text is reported once for Naru's instruction record.
 */
export class CodexManagedSession {
  readonly #channel: RunnerChannelClient;
  readonly #client: () => Promise<CodexAppServerClient>;
  readonly #onStop: () => void;
  readonly #console: (line: string) => void;
  readonly #pendingApprovals = new Map<string, { id: JsonRpcId; method: string }>();
  readonly #answered = new Set<string>();
  readonly #children = new Set<string>();
  #rpc: CodexAppServerClient | null = null;
  #threadId: string | null = null;
  #activeTurnId: string | null = null;
  #writer: WriterKind = "orchestrator";
  #ready: ((threadId: string) => void) | null = null;
  #starting = false;
  #stopRequested = false;

  constructor(options: {
    readonly socketPath: string;
    readonly token: string;
    readonly connect: () => Promise<CodexAppServerClient>;
    readonly onStop: () => void;
    readonly console: (line: string) => void;
  }) {
    this.#client = options.connect;
    this.#onStop = options.onStop;
    this.#console = options.console;
    this.#channel = new RunnerChannelClient({
      socketPath: options.socketPath,
      token: options.token,
      state: () => ({
        started: this.#threadId !== null,
        runtimeSessionRef: this.#threadId,
        busy: this.#activeTurnId !== null,
        pendingApprovals: [...this.#pendingApprovals.keys()],
      }),
      onMessage: (message) => void this.#handle(message),
    });
  }

  /** Connects to Naru and resolves with the conversation thread once the plan has started it. */
  start(): Promise<string> {
    const ready = new Promise<string>((resolve) => {
      this.#ready = resolve;
    });
    this.#channel.start();
    return ready;
  }

  get threadId(): string | null {
    return this.#threadId;
  }

  /**
   * A frame from the TUI (or another relay client) towards the app-server. Writes and approval
   * answers pass only while the person is the writer; the TUI stays bound to this conversation.
   */
  filterClientFrame(frame: JsonRpcFrame): TuiFrameDecision {
    const tuiWrites = this.#writer === "tui";
    if (frame.method === undefined) {
      if (frame.id === undefined) return { forward: true, frame };
      // An answer to a server request (approval): writer only, once.
      const key = String(frame.id);
      if (!this.#pendingApprovals.has(key)) return { forward: true, frame };
      if (!tuiWrites || this.#answered.has(key)) return { forward: false, reply: null };
      this.#answered.add(key);
      return { forward: true, frame };
    }
    const params = asRecord(frame.params);
    if (frame.method === "thread/resume") {
      if (params?.threadId === this.#threadId) return { forward: true, frame };
      return deny(frame, "This Naru-managed session is bound to its own conversation.");
    }
    if (!WRITE_METHODS.has(frame.method)) return { forward: true, frame };
    if (!tuiWrites) {
      return deny(frame, "Naru: another writer owns this conversation. Take it over in Naru.");
    }
    if (frame.method === "turn/start" && params?.threadId === this.#threadId) {
      const text = inputText(params.input);
      if (text !== "") {
        this.#emit({ type: "user-prompt", source: "tui", text, promptId: randomUUID() });
      }
    }
    return { forward: true, frame };
  }

  /** The relay is ending: report it to Naru, then let go of the channel and the app-server. */
  async finish(reason: "stopped" | "crashed"): Promise<void> {
    // A stop Naru asked for is a stop, whatever exit status the TUI reports on the signal.
    this.#emit({ type: "exited", reason: this.#stopRequested ? "stopped" : reason });
    await this.#channel.drain(2_000);
    this.#channel.stop();
    this.#rpc?.close();
  }

  // Naru channel -----------------------------------------------------------------------------------

  async #handle(message: NaruMessage): Promise<void> {
    switch (message.type) {
      case "plan":
        if (!("runtime" in message.plan) || message.plan.runtime !== "codex") {
          this.#console("plan for another runtime");
          this.#onStop();
          return;
        }
        if (this.#threadId === null && !this.#starting) await this.#startThread(message.plan);
        return;
      case "send":
        await this.#call("turn/start", {
          threadId: this.#threadId,
          input: [{ type: "text", text: message.text, text_elements: [] }],
        });
        return;
      case "interrupt":
        // Only an observed active turn can be interrupted (V01: -32600 before `turn/started`).
        if (this.#activeTurnId !== null) {
          await this.#call("turn/interrupt", {
            threadId: this.#threadId,
            turnId: this.#activeTurnId,
          });
        }
        return;
      case "approval": {
        const pending = this.#pendingApprovals.get(message.requestId);
        if (pending === undefined || this.#answered.has(message.requestId)) return;
        this.#answered.add(message.requestId);
        this.#rpc?.respond(pending.id, approvalResult(pending.method, message.decision));
        return;
      }
      case "history":
        await this.#history(message.requestId, message.cursor);
        return;
      case "writer":
        this.#writer = message.writer;
        return;
      case "stop":
      case "rejected":
        this.#console(message.type === "stop" ? "stop requested by Naru" : "launch rejected");
        this.#stopRequested = message.type === "stop";
        this.#onStop();
        return;
      case "ack":
        return;
    }
  }

  async #startThread(plan: CodexRunnerPlan): Promise<void> {
    this.#starting = true;
    try {
      const rpc = await this.#client();
      this.#rpc = rpc;
      rpc.onNotification((method, params) => this.#observe(method, params));
      rpc.onRequest((id, method, params) => this.#serverRequest(id, method, params));
      rpc.onClose(() => {
        this.#console("app-server connection closed");
        this.#onStop();
      });
      // Naru's MCP server is injected per thread; its capability lives only in that server's env.
      const config: Record<string, unknown> = {};
      for (const [name, server] of Object.entries(plan.mcpServers)) {
        config[`mcp_servers.${name}`] = server;
      }
      const result = asRecord(
        plan.resumeRef === null
          ? await rpc.request("thread/start", {
              model: plan.model,
              config,
              developerInstructions: plan.instructions,
            })
          : await rpc.request("thread/resume", {
              threadId: plan.resumeRef,
              model: plan.model,
              config,
              developerInstructions: plan.instructions,
            }),
      );
      const threadId = asRecord(result?.thread)?.id;
      if (typeof threadId !== "string") throw new Error("Codex returned no thread.");
      this.#threadId = threadId;
      this.#emit({ type: "conversation-ready", runtimeSessionRef: threadId });
      this.#console("Codex agent ready · observation through Naru");
      this.#ready?.(threadId);
    } catch {
      this.#console("NARU_CODEX_THREAD_UNAVAILABLE");
      this.#emit({ type: "exited", reason: "crashed" });
      this.#onStop();
    } finally {
      this.#starting = false;
    }
  }

  async #history(requestId: string, cursor: string | null): Promise<void> {
    try {
      const page = asRecord(
        await this.#rpc?.request("thread/turns/list", {
          threadId: this.#threadId,
          limit: HISTORY_PAGE,
          sortDirection: "asc",
          ...(cursor === null ? {} : { cursor }),
        }),
      );
      const items = Array.isArray(page?.data) ? (page.data as unknown[]) : [];
      const next = typeof page?.nextCursor === "string" ? page.nextCursor : null;
      this.#channel.send({ type: "history", requestId, items, nextCursor: next });
    } catch {
      this.#channel.send({ type: "error", requestId, code: "HISTORY_FAILED" });
    }
  }

  async #call(method: string, params: unknown): Promise<void> {
    try {
      await this.#rpc?.request(method, params);
    } catch (error) {
      const code = error instanceof CodexRpcError ? String(error.code ?? "") : "";
      this.#channel.send({ type: "error", requestId: null, code: `CODEX_${method}_${code}` });
    }
  }

  #observe(method: string, params: unknown): void {
    const record = asRecord(params);
    if (record?.threadId !== this.#threadId) return;
    switch (method) {
      case "turn/started": {
        const turnId = asRecord(record?.turn)?.id;
        this.#activeTurnId = typeof turnId === "string" ? turnId : null;
        this.#emit({ type: "turn-started", turnId: this.#activeTurnId });
        return;
      }
      case "turn/completed": {
        const turn = asRecord(record?.turn);
        const status = turn?.status;
        this.#activeTurnId = null;
        this.#emit({
          type: "turn-ended",
          turnId: typeof turn?.id === "string" ? turn.id : null,
          outcome:
            status === "completed"
              ? "completed"
              : status === "interrupted"
                ? "interrupted"
                : "failed",
        });
        return;
      }
      case "item/started":
      case "item/completed": {
        const item = asRecord(record?.item);
        if (item?.type !== "subAgentActivity" || typeof item.agentThreadId !== "string") return;
        if (item.kind === "started" && !this.#children.has(item.agentThreadId)) {
          this.#children.add(item.agentThreadId);
          this.#emit({
            type: "child-started",
            childRef: item.agentThreadId,
            parentRef: this.#threadId ?? "",
          });
        } else if (
          (item.kind === "completed" || item.kind === "interrupted") &&
          this.#children.delete(item.agentThreadId)
        ) {
          this.#emit({ type: "child-ended", childRef: item.agentThreadId });
        }
        return;
      }
      case "serverRequest/resolved": {
        const key = String(record?.requestId);
        if (this.#pendingApprovals.delete(key)) {
          this.#answered.delete(key);
          this.#emit({ type: "approval-resolved", requestId: key });
        }
        return;
      }
    }
  }

  #serverRequest(id: JsonRpcId, method: string, params: unknown): void {
    const kind = APPROVAL_KINDS[method];
    if (kind === undefined || asRecord(params)?.threadId !== this.#threadId) return;
    const key = String(id);
    this.#pendingApprovals.set(key, { id, method });
    this.#emit({ type: "approval-requested", requestId: key, kind });
  }

  #emit(event: AgentRuntimeEvent): void {
    this.#channel.emit(event);
  }
}

function deny(frame: JsonRpcFrame, message: string): TuiFrameDecision {
  return {
    forward: false,
    reply: frame.id === undefined ? null : { id: frame.id, error: { code: -32001, message } },
  };
}

function approvalResult(method: string, decision: "approve" | "deny"): unknown {
  const approve = decision === "approve";
  if (method === "mcpServer/elicitation/request") {
    return approve ? { action: "accept", content: {} } : { action: "decline", content: null };
  }
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return { decision: approve ? "approved" : "denied" };
  }
  if (method === "item/permissions/requestApproval") {
    // Naru never widens permissions on an approval; a person grants them in the TUI.
    return { permissions: {}, scope: "turn" };
  }
  return { decision: approve ? "accept" : "decline" };
}

function inputText(input: unknown): string {
  if (!Array.isArray(input)) return "";
  return input
    .map((item) => {
      const record = asRecord(item);
      return record?.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter((text) => text !== "")
    .join("\n")
    .slice(0, 64_000);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
