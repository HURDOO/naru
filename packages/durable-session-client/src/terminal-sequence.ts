import type {
  AttachmentId,
  DurableSessionEvent,
  RuntimeId,
  TerminalSnapshot,
} from "@naru/contracts/durable-session/v0";

export type TerminalSequenceResult =
  | { readonly kind: "ignored" }
  | {
      readonly kind: "snapshot";
      readonly runtimeId: RuntimeId;
      readonly sequence: number;
      readonly serializedState: string;
    }
  | { readonly kind: "output"; readonly sequence: number; readonly data: string }
  | {
      readonly kind: "resync-required";
      readonly reason:
        "not-initialized" | "runtime-changed" | "sequence-discontinuity" | "host-required";
    };

export class TerminalSequenceTracker {
  #runtimeId: RuntimeId | null = null;
  #sequence: number | null = null;

  get runtimeId(): RuntimeId | null {
    return this.#runtimeId;
  }

  get sequence(): number | null {
    return this.#sequence;
  }

  restore(snapshot: TerminalSnapshot): void {
    this.#runtimeId = snapshot.runtimeId;
    this.#sequence = snapshot.sequence;
  }

  accept(event: DurableSessionEvent, attachmentId?: AttachmentId): TerminalSequenceResult {
    if (event.type === "terminal.snapshot") {
      this.#runtimeId = event.runtimeId;
      this.#sequence = event.sequence;
      return {
        kind: "snapshot",
        runtimeId: event.runtimeId,
        sequence: event.sequence,
        serializedState: event.serializedState,
      };
    }
    if (event.type === "attachment.resync-required") {
      if (attachmentId !== undefined && event.attachmentId !== attachmentId) {
        return { kind: "ignored" };
      }
      return { kind: "resync-required", reason: "host-required" };
    }
    if (event.type !== "terminal.output") return { kind: "ignored" };
    if (this.#runtimeId === null || this.#sequence === null) {
      return { kind: "resync-required", reason: "not-initialized" };
    }
    if (event.runtimeId !== this.#runtimeId) {
      return { kind: "resync-required", reason: "runtime-changed" };
    }
    if (event.sequence !== this.#sequence + 1) {
      return { kind: "resync-required", reason: "sequence-discontinuity" };
    }
    this.#sequence = event.sequence;
    return { kind: "output", sequence: event.sequence, data: event.data };
  }
}
