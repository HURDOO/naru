import { randomUUID } from "node:crypto";
import type { CodexInteractionSnapshot } from "./integrations/codex/events.js";

type Phase = CodexInteractionSnapshot["phase"];
type PendingRequest = CodexInteractionSnapshot["pending"][number];
type RequestId = PendingRequest["requestId"];

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PENDING = 64;
const MAX_CALLS = 64;

interface TrackedCall {
  readonly method: "thread/start" | "thread/resume" | "turn/start";
  readonly threadId: string | null;
  readonly switchOrdinal: number;
  readonly previousPhase: Phase;
  readonly previousTurnId: string | null;
}

/**
 * Reads only JSON-RPC envelope and lifecycle identifiers. The relay forwards
 * the original message separately, without retaining prompt or tool content.
 */
export class CodexInteractionState {
  readonly #streamId = randomUUID();
  readonly #calls = new Map<string, TrackedCall>();
  readonly #pending = new Map<string, PendingRequest>();
  #sequence = -1;
  #sessionId: string | null = null;
  #identity: CodexInteractionSnapshot["identity"] = "unbound";
  #turnId: string | null = null;
  #phase: Phase = "idle";
  #lastFingerprint: string | null = null;
  #switchOrdinal = 0;
  #previousTurnId: string | null = null;

  constructor(
    private readonly cwd: string,
    private readonly publish: (snapshot: CodexInteractionSnapshot) => void,
  ) {}

  start(): void {
    this.#emit();
  }

  closeChannel(channel: number): void {
    for (const key of this.#calls.keys()) {
      if (key.startsWith(`${channel}:`)) this.#calls.delete(key);
    }
  }

  observeClient(value: unknown, channel = 0): void {
    if (!isRecord(value) || typeof value.method !== "string") return;
    const params = isRecord(value.params) ? value.params : null;
    const requestId = validRequestId(value.id);
    if (value.method === "thread/start" || value.method === "thread/resume") {
      // The TUI starts ephemeral system threads (for example title generation)
      // over the same WebSocket. They must not replace the user's thread.
      if (
        value.method === "thread/start" &&
        (params?.ephemeral === true || params?.threadSource === "system")
      )
        return;
      const switchOrdinal = ++this.#switchOrdinal;
      this.#remember(requestId, channel, {
        method: value.method,
        threadId: null,
        switchOrdinal,
        previousPhase: this.#phase,
        previousTurnId: this.#turnId,
      });
      return;
    }
    const threadId = validSessionId(params?.threadId);
    if (threadId === null || threadId !== this.#sessionId) return;
    if (value.method === "turn/start") {
      this.#remember(requestId, channel, {
        method: "turn/start",
        threadId,
        switchOrdinal: this.#switchOrdinal,
        previousPhase: this.#phase,
        previousTurnId: this.#turnId,
      });
      // Submission is visible immediately, before the model responds.
      this.#previousTurnId = this.#turnId;
      this.#phase = "running";
      this.#turnId = null;
      this.#emit();
    } else if (value.method === "turn/steer") {
      this.#phase = "running";
      this.#emit();
    }
    // A response to a server request is intentionally ignored here. Only the
    // app-server's serverRequest/resolved event can remove that pending id.
  }

  observeServer(value: unknown, channel = 0): void {
    if (!isRecord(value)) return;
    if (typeof value.method !== "string") {
      this.#observeResponse(value, channel);
      return;
    }
    const params = isRecord(value.params) ? value.params : null;
    if (value.method === "serverRequest/resolved") {
      if (params?.threadId !== this.#sessionId) return;
      const requestId = validRequestId(params.requestId);
      if (requestId !== null && this.#pending.delete(requestKey(requestId))) this.#emit();
      return;
    }

    const kind = requestKind(value.method);
    if (kind !== null) {
      const requestId = validRequestId(value.id);
      if (requestId === null || params?.threadId !== this.#sessionId) return;
      const turnId = validTurnId(params.turnId);
      if (this.#pending.size >= MAX_PENDING && !this.#pending.has(requestKey(requestId))) {
        throw new Error("Codex interaction request limit exceeded.");
      }
      this.#pending.set(requestKey(requestId), { requestId, turnId, kind });
      this.#emit();
      return;
    }

    if (params?.threadId !== this.#sessionId) return;
    if (value.method === "turn/started") {
      const turn = isRecord(params.turn) ? params.turn : null;
      const turnId = validTurnId(turn?.id);
      if (turnId === null || turnId === this.#previousTurnId) return;
      if (this.#phase === "completed" || this.#phase === "canceled" || this.#phase === "failed")
        return;
      if (this.#turnId !== null && this.#turnId !== turnId && this.#phase === "running") return;
      this.#turnId = turnId;
      this.#phase = "running";
      this.#emit();
    } else if (value.method === "turn/completed") {
      const turn = isRecord(params.turn) ? params.turn : null;
      const turnId = validTurnId(turn?.id);
      if (turnId === null || turnId === this.#previousTurnId) return;
      if (this.#turnId !== null && this.#turnId !== turnId) return;
      this.#turnId = turnId;
      this.#phase =
        turn?.status === "completed"
          ? "completed"
          : turn?.status === "interrupted"
            ? "canceled"
            : "failed";
      this.#emit();
    } else if (value.method === "thread/closed" || value.method === "thread/archived") {
      this.#bindSession(null, "idle");
    }
  }

  #observeResponse(value: Record<string, unknown>, channel: number): void {
    const requestId = validRequestId(value.id);
    if (requestId === null) return;
    const key = callKey(channel, requestId);
    const call = this.#calls.get(key);
    if (call === undefined) return;
    this.#calls.delete(key);
    const result = isRecord(value.result) ? value.result : null;
    if (call.method === "thread/start" || call.method === "thread/resume") {
      if (call.switchOrdinal !== this.#switchOrdinal) return;
      if (result === null) return;
      const thread = isRecord(result.thread) ? result.thread : null;
      const sessionId = validSessionId(thread?.id);
      if (thread?.ephemeral === true) return;
      if (sessionId === null || thread?.cwd !== this.cwd || thread?.parentThreadId !== null) {
        throw new Error("Codex thread identity could not be verified.");
      }
      const status = isRecord(thread.status) ? thread.status : null;
      this.#bindSession(sessionId, status?.type === "active" ? "running" : "idle");
    } else if (call.method === "turn/start" && call.threadId === this.#sessionId) {
      if (result === null) {
        if (this.#phase === "running" && this.#turnId === null) {
          this.#phase = call.previousPhase;
          this.#turnId = call.previousTurnId;
          this.#previousTurnId = null;
        }
      } else {
        const turn = isRecord(result.turn) ? result.turn : null;
        const resolvedTurnId = validTurnId(turn?.id);
        if (resolvedTurnId === null) throw new Error("Codex turn identity is unavailable.");
        if (this.#phase === "running") {
          this.#turnId = resolvedTurnId;
        }
        this.#previousTurnId = null;
      }
      this.#emit();
    }
  }

  #bindSession(sessionId: string | null, phase: Phase): void {
    if (sessionId !== this.#sessionId) {
      this.#sessionId = sessionId;
      this.#turnId = null;
      this.#previousTurnId = null;
      this.#pending.clear();
      for (const [requestKey, call] of this.#calls) {
        if (call.method === "turn/start" && call.threadId !== sessionId) {
          this.#calls.delete(requestKey);
        }
      }
    }
    this.#identity = sessionId === null ? "cleared" : "bound";
    this.#phase = phase;
    this.#emit();
  }

  #remember(requestId: RequestId | null, channel: number, call: TrackedCall): void {
    if (requestId === null || this.#calls.size >= MAX_CALLS) {
      throw new Error("Codex client request could not be tracked.");
    }
    this.#calls.set(callKey(channel, requestId), call);
  }

  #emit(): void {
    const state = {
      cwd: this.cwd,
      sessionId: this.#sessionId,
      identity: this.#identity,
      turnId: this.#turnId,
      phase: this.#phase,
      pending: [...this.#pending.values()],
    };
    const fingerprint = JSON.stringify(state);
    if (fingerprint === this.#lastFingerprint) return;
    this.#lastFingerprint = fingerprint;
    this.#sequence += 1;
    this.publish({ streamId: this.#streamId, sequence: this.#sequence, ...state });
  }
}

function requestKind(method: string): PendingRequest["kind"] | null {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command";
    case "item/fileChange/requestApproval":
      return "file-change";
    case "item/permissions/requestApproval":
      return "permissions";
    case "item/tool/requestUserInput":
      return "user-input";
    case "mcpServer/elicitation/request":
      return "mcp-elicitation";
    default:
      return null;
  }
}

function validRequestId(value: unknown): RequestId | null {
  if (typeof value === "string" && value.length > 0 && value.length <= 128) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return null;
}

function validSessionId(value: unknown): string | null {
  return typeof value === "string" && SESSION_ID.test(value) ? value : null;
}

function validTurnId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : null;
}

function requestKey(requestId: RequestId): string {
  return typeof requestId === "number" ? `n:${requestId}` : `s:${requestId}`;
}

function callKey(channel: number, requestId: RequestId): string {
  return `${channel}:${requestKey(requestId)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
