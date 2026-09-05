import type {
  ControlOfferId,
  ControlRequestId,
  DurableSessionEvent,
  TerminalSize,
  TerminalSnapshot,
} from "@naru/contracts/durable-session/v0";
import type {
  DurableSessionAttachmentHandle,
  DurableSessionAttachmentView,
} from "@naru/durable-session-client";
import { DurableSessionProtocolError } from "@naru/durable-session-client";

const CONTROL_PREFIX = "\u001d";

export interface InteractiveTerminalIo {
  readonly writeTerminal: (data: string) => void;
  readonly writeStatus: (message: string) => void;
  readonly terminalSize: () => TerminalSize;
}

export interface InteractiveTerminalControllerOptions {
  readonly preemptEnabled?: boolean;
}

type AttachmentPort = Pick<
  DurableSessionAttachmentHandle,
  | "view"
  | "snapshot"
  | "resync"
  | "acceptEvent"
  | "acquireControl"
  | "requestControl"
  | "approveControl"
  | "rejectControl"
  | "acceptControl"
  | "preemptControl"
  | "releaseControl"
  | "sendInput"
  | "resizeTerminal"
  | "close"
>;

export class InteractiveTerminalController {
  readonly #attachment: AttachmentPort;
  readonly #io: InteractiveTerminalIo;
  readonly #preemptEnabled: boolean;
  #paletteOpen = false;
  #confirmPreempt = false;
  #pendingRequestId: ControlRequestId | null = null;
  #pendingOfferId: ControlOfferId | null = null;

  constructor(
    attachment: AttachmentPort,
    io: InteractiveTerminalIo,
    options: InteractiveTerminalControllerOptions = {},
  ) {
    this.#attachment = attachment;
    this.#io = io;
    this.#preemptEnabled = options.preemptEnabled ?? false;
  }

  get attachmentView(): DurableSessionAttachmentView {
    return this.#attachment.view;
  }

  async restore(): Promise<TerminalSnapshot> {
    const snapshot = await this.#attachment.snapshot();
    this.#io.writeTerminal(snapshot.serializedState);
    this.#status();
    return snapshot;
  }

  async handleEvent(event: DurableSessionEvent): Promise<void> {
    const sequence = this.#attachment.acceptEvent(event);
    if (sequence.kind === "snapshot") this.#io.writeTerminal(sequence.serializedState);
    if (sequence.kind === "output") this.#io.writeTerminal(sequence.data);
    if (sequence.kind === "resync-required") {
      const snapshot = await this.#attachment.resync();
      this.#io.writeTerminal(snapshot.serializedState);
      this.#io.writeStatus(`terminal resynced (${sequence.reason})`);
    }
    if (event.sessionId !== this.#attachment.view.sessionId) return;
    if (event.type === "terminal.exited") {
      this.#io.writeStatus(
        `terminal exited code=${event.exitCode ?? "none"} signal=${event.signal ?? "none"}`,
      );
    }
    switch (event.type) {
      case "control.requested":
        if (this.#attachment.view.role === "controller") {
          this.#pendingRequestId = event.request.controlRequestId;
          this.#io.writeStatus("control requested; press Ctrl+] then a to approve or x to reject");
        }
        break;
      case "control.offered":
        if (event.offer.requesterAttachmentId === this.#attachment.view.attachmentId) {
          this.#pendingOfferId = event.offer.controlOfferId;
          this.#io.writeStatus("control offered; press Ctrl+] then a to accept");
        }
        break;
      case "control.request-resolved":
        if (event.controlRequestId === this.#pendingRequestId) this.#pendingRequestId = null;
        break;
      case "control.changed":
        this.#pendingRequestId = null;
        this.#pendingOfferId = null;
        this.#confirmPreempt = false;
        this.#status();
        break;
      default:
        break;
    }
  }

  async requestInitialControl(): Promise<"acquired" | "requested"> {
    try {
      await this.#attachment.acquireControl(this.#io.terminalSize());
      this.#status();
      return "acquired";
    } catch (error) {
      if (!(error instanceof DurableSessionProtocolError) || error.code !== "CONTROL_HELD") {
        throw error;
      }
      this.#pendingRequestId = await this.#attachment.requestControl();
      this.#io.writeStatus("control request sent; waiting for controller approval");
      return "requested";
    }
  }

  async handleInput(data: string): Promise<"continue" | "closed"> {
    let remaining = data;
    while (remaining.length > 0) {
      if (this.#paletteOpen) {
        const key = remaining[0] ?? "";
        remaining = remaining.slice(1);
        if ((await this.#handlePaletteKey(key)) === "closed") return "closed";
        continue;
      }
      const paletteIndex = remaining.indexOf(CONTROL_PREFIX);
      if (paletteIndex === -1) {
        await this.#forwardTerminalInput(remaining);
        return "continue";
      }
      if (paletteIndex > 0) await this.#forwardTerminalInput(remaining.slice(0, paletteIndex));
      remaining = remaining.slice(paletteIndex + CONTROL_PREFIX.length);
      this.#paletteOpen = true;
      this.#io.writeStatus(
        `control palette: c acquire, r request, a approve/accept, x reject, ${
          this.#preemptEnabled ? "p preempt, " : ""
        }l release, q detach`,
      );
    }
    return "continue";
  }

  async #handlePaletteKey(data: string): Promise<"continue" | "closed"> {
    this.#paletteOpen = false;
    if (data !== "p") this.#confirmPreempt = false;
    switch (data) {
      case "c":
        await this.#attachment.acquireControl(this.#io.terminalSize());
        this.#status();
        return "continue";
      case "r":
        this.#pendingRequestId = await this.#attachment.requestControl();
        this.#io.writeStatus("control request sent; waiting for controller approval");
        return "continue";
      case "a":
        await this.#approveOrAccept();
        return "continue";
      case "x":
        if (this.#pendingRequestId === null || this.#attachment.view.role !== "controller") {
          this.#io.writeStatus("no control request is available to reject");
          return "continue";
        }
        await this.#attachment.rejectControl(this.#pendingRequestId);
        this.#pendingRequestId = null;
        this.#io.writeStatus("control request rejected");
        return "continue";
      case "p":
        if (!this.#preemptEnabled) {
          this.#io.writeStatus("explicit takeover requires the control command");
          return "continue";
        }
        if (!this.#confirmPreempt) {
          this.#confirmPreempt = true;
          this.#io.writeStatus("explicit takeover: press Ctrl+] then p again to confirm");
          return "continue";
        }
        this.#confirmPreempt = false;
        await this.#attachment.preemptControl(this.#io.terminalSize(), "owner-takeover");
        this.#status();
        return "continue";
      case "l":
        await this.#attachment.releaseControl();
        this.#status();
        return "continue";
      case "q":
        await this.#attachment.close();
        return "closed";
      default:
        this.#io.writeStatus("unknown control palette key");
        return "continue";
    }
  }

  async #forwardTerminalInput(data: string): Promise<void> {
    if (this.#attachment.view.role === "controller") await this.#attachment.sendInput(data);
    else this.#io.writeStatus("observer mode: terminal input was not sent");
  }

  async handleResize(): Promise<void> {
    if (this.#attachment.view.role === "controller") {
      await this.#attachment.resizeTerminal(this.#io.terminalSize());
    } else {
      this.#io.writeStatus("observer viewport changed locally; Host geometry was not changed");
    }
  }

  async #approveOrAccept(): Promise<void> {
    if (this.#attachment.view.role === "controller" && this.#pendingRequestId !== null) {
      await this.#attachment.approveControl(this.#pendingRequestId);
      this.#pendingRequestId = null;
      this.#io.writeStatus("control request approved; waiting for requester acceptance");
      return;
    }
    if (this.#pendingOfferId !== null) {
      await this.#attachment.acceptControl(this.#pendingOfferId, this.#io.terminalSize());
      this.#pendingOfferId = null;
      this.#status();
      return;
    }
    this.#io.writeStatus("no control request or offer is available");
  }

  #status(): void {
    const view = this.#attachment.view;
    this.#io.writeStatus(
      `${view.role} runtime=${view.runtimeId} generation=${view.controllerGeneration}`,
    );
  }
}
