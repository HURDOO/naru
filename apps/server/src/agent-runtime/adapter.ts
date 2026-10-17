import type {
  AgentApprovalDecision,
  AgentRuntime,
  RuntimeCapabilities,
} from "@naru/contracts/naru-agent/v1";
import type { SwitchStrategy, WriterKind } from "./writer-gate.js";

/**
 * Runtime adapter boundary (SOURCE_SPEC §7.3, refined by V01–V12). Adapters translate one runtime's
 * official interface (Codex app-server, Claude Agent SDK, OpenCode serve) into these calls; they
 * never decide product questions and never store conversation text (AP-D002): history is re-read
 * through the runtime's own API.
 */
export interface AgentLaunchSpec {
  /** Naru AgentSession already registered in AgentPlatformCore. */
  readonly agentSessionId: string;
  readonly cwd: string;
  readonly model: string;
  /** Existing runtime conversation to resume; null starts a new one. */
  readonly resumeRef: string | null;
  /** Per-session MCP binding, passed in the runtime's MCP server config, never the agent's env. */
  readonly mcp: { readonly socketPath: string; readonly capability: string } | null;
  /** Role guidance injected as the runtime's system/developer instructions. */
  readonly instructions: string;
}

export type AgentRuntimeEvent =
  | { readonly type: "conversation-ready"; readonly runtimeSessionRef: string }
  | { readonly type: "turn-started"; readonly turnId: string | null }
  | {
      readonly type: "turn-ended";
      readonly turnId: string | null;
      readonly outcome: "completed" | "interrupted" | "failed";
    }
  /** A prompt a person submitted directly in the TUI (AP-D002-2); text is recorded by the core. */
  | {
      readonly type: "user-prompt";
      readonly source: "tui";
      readonly text: string;
      readonly promptId?: string;
    }
  | {
      readonly type: "approval-requested";
      readonly requestId: string;
      readonly kind: "command" | "file" | "tool" | "permission" | "question";
      /** What is asked (tool and command or path), shown to the person; never stored. */
      readonly summary?: string;
      /** The runtime can allow this kind of call for the rest of the session (AP-D023). */
      readonly sessionAllow?: boolean;
    }
  | { readonly type: "approval-resolved"; readonly requestId: string }
  | {
      readonly type: "child-started";
      readonly childRef: string;
      readonly parentRef: string;
    }
  | { readonly type: "child-ended"; readonly childRef: string }
  /** A tool call starting: name and short target, shown live and never stored (AP-D026). */
  | { readonly type: "tool-activity"; readonly tool: string; readonly target: string | null }
  | { readonly type: "exited"; readonly reason: "stopped" | "crashed" };

export interface HistoryPage {
  /** Runtime-native items as the conversation shows them (AP-D040); not persisted by Naru. */
  readonly items: readonly unknown[];
  readonly nextCursor: string | null;
}

export interface AgentRuntimeHandle {
  readonly runtimeSessionRef: string | null;
  onEvent(listener: (event: AgentRuntimeEvent) => void): () => void;
  /** Starts a turn; the caller must hold the writer gate for `writer` at `generation`. */
  sendTurn(text: string, writer: WriterKind, generation: number): Promise<void>;
  interrupt(): Promise<void>;
  respondApproval(requestId: string, decision: AgentApprovalDecision): Promise<void>;
  readHistory(cursor: string | null): Promise<HistoryPage>;
  stop(): Promise<void>;
}

export interface AgentRuntimeAdapter {
  readonly runtime: AgentRuntime;
  readonly switchStrategy: SwitchStrategy;
  capabilities(): RuntimeCapabilities;
  start(spec: AgentLaunchSpec): Promise<AgentRuntimeHandle>;
  /**
   * Restart recovery: is this conversation still running, idle, or gone? Used to settle runs left
   * `unknown` (INV-07) without inventing an outcome.
   */
  probe(runtimeSessionRef: string): Promise<"running" | "idle" | "missing" | "unknown">;
}
