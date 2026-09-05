import type { ServerWsFrame, TerminalRestoreProtocol } from "@naru/contracts";
import type { PaneActivityChange } from "./database.js";

export type SessionFrameListener = (frame: ServerWsFrame) => void;
export type SessionActivityListener = (change: PaneActivityChange) => void;
export interface SessionCodexIdentityChange {
  readonly paneId: string;
  readonly runtimeId: string;
  readonly sessionId: string | null;
  readonly resumable: boolean;
  readonly updatedAt: string;
}
export type SessionCodexIdentityListener = (change: SessionCodexIdentityChange) => void;
export type SessionOperation = void | Promise<void>;

export interface SessionAttachmentOptions {
  /** Stable only for the lifetime of one Naru WebSocket attachment. */
  readonly attachmentKey: string;
  /** Whether this Naru surface is allowed to acquire Host control. */
  readonly control: "controller" | "observer";
}

/**
 * The stable Naru-side boundary around terminal Session ownership.
 *
 * Legacy mode delegates this interface to PtySupervisor. Durable Host mode implements it without
 * creating a local PTY, lease, terminal emulator, or sequence source.
 */
export interface NaruSessionFacade {
  readiness(): boolean | Promise<boolean>;
  count(): number;
  isRunning(paneId: string): boolean;
  onActivity(listener: SessionActivityListener): () => void;
  onCodexIdentity(listener: SessionCodexIdentityListener): () => void;
  acknowledgeCompleted(paneId: string, eventId: string): SessionOperation;
  start(paneId: string, columns?: number, rows?: number): SessionOperation;
  attach(
    paneId: string,
    columns: number,
    rows: number,
    listener: SessionFrameListener,
    restoreProtocol?: TerminalRestoreProtocol,
    restoreId?: string,
    options?: SessionAttachmentOptions,
  ): Promise<() => void>;
  write(paneId: string, data: string, attachmentKey?: string): SessionOperation;
  resize(paneId: string, columns: number, rows: number, attachmentKey?: string): SessionOperation;
  updateViewport(
    paneId: string,
    runtimeId: string,
    bottomOffset: number,
    attachmentKey?: string,
  ): SessionOperation;
  setControlDesired(
    paneId: string,
    desired: boolean,
    columns: number,
    rows: number,
    attachmentKey?: string,
  ): SessionOperation;
  preemptControl(
    paneId: string,
    columns: number,
    rows: number,
    attachmentKey?: string,
  ): SessionOperation;
  approveControl(
    paneId: string,
    controlRequestId: string,
    attachmentKey?: string,
  ): SessionOperation;
  rejectControl(paneId: string, controlRequestId: string, attachmentKey?: string): SessionOperation;
  releaseControl(paneId: string, attachmentKey?: string): SessionOperation;
  restart(paneId: string): SessionOperation;
  startNewCodex(paneId: string): SessionOperation;
  stop(paneId: string): SessionOperation;
  /** Stop the runtime and forget its durable identity before the Pane row is deleted. */
  remove(paneId: string): SessionOperation;
  /** Release only this Naru process's resources. Durable implementations must not stop Sessions. */
  shutdown(): Promise<void>;
}
