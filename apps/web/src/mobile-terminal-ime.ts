interface InputFence {
  readonly attachment: object | null;
  readonly terminal: object | null;
  readonly runtimeId: string | null;
  readonly leaseGeneration: number | undefined;
  readonly controlGeneration: number | undefined;
  readonly allowed: boolean;
}

interface MobileTerminalImeOptions {
  readonly textarea: () => HTMLTextAreaElement | undefined;
  readonly fence: () => InputFence;
  readonly composing: () => boolean;
  readonly canResetTextarea: () => boolean;
  readonly send: (data: string) => void;
}

interface PairedKey {
  readonly inputType: "deleteContentBackward" | "insertLineBreak";
  emitted: boolean;
}

export function isAndroidTouchInput(): boolean {
  return /Android/i.test(navigator.userAgent) && navigator.maxTouchPoints > 0;
}

/** Complements xterm's Android input handling without taking over visible IME composition. */
export class MobileTerminalImeBridge {
  readonly #options: MobileTerminalImeOptions;
  #beforeInputFence: InputFence | null = null;
  #beforeInputType: string | null = null;
  #beforeInputValue: string | null = null;
  #beforeInputEpoch = 0;
  #pendingDeleteFromBeforeInput = false;
  #epoch = 0;
  #pairedKey: PairedKey | null = null;
  #pairedKeyTimer: ReturnType<typeof setTimeout> | null = null;
  #suppressedImeKey = false;
  #suppressedImeKeyTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #lineBreakTimers = new Set<ReturnType<typeof setTimeout>>();
  readonly #pendingDeleteTimers = new Set<ReturnType<typeof setTimeout>>();
  #compositionJustEnded = false;
  #compositionEndTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: MobileTerminalImeOptions) {
    this.#options = options;
  }

  attach(host: HTMLElement): () => void {
    host.addEventListener("keydown", this.#keydown, true);
    host.addEventListener("beforeinput", this.#beforeInput, true);
    host.addEventListener("input", this.#input, true);
    // Run after xterm's target listener so our settled marker follows its 0ms flush.
    host.addEventListener("compositionend", this.#compositionEnd);
    return () => {
      host.removeEventListener("keydown", this.#keydown, true);
      host.removeEventListener("beforeinput", this.#beforeInput, true);
      host.removeEventListener("input", this.#input, true);
      host.removeEventListener("compositionend", this.#compositionEnd);
      this.#clearTimers();
    };
  }

  /** Observe a keydown's synchronous xterm output so its following input event is not sent twice. */
  allowNativeData(data: string): boolean {
    const allowed = this.#options.fence().allowed;
    if (
      this.#pairedKey !== null &&
      ((this.#pairedKey.inputType === "deleteContentBackward" && data === "\u007f") ||
        (this.#pairedKey.inputType === "insertLineBreak" && data === "\r"))
    ) {
      this.#pairedKey.emitted = true;
      if (allowed && data === "\u007f") this.#resetCommittedTextarea();
    }
    return allowed;
  }

  /** Cancel only Naru-owned delayed operations on lifecycle changes. */
  cancelPending(): void {
    this.#epoch += 1;
    // Keep the old beforeinput marker so its later input cannot enter a new lease.
    this.#pairedKey = null;
    this.#suppressedImeKey = false;
    this.#compositionJustEnded = false;
    this.#clearTimers();
  }

  readonly #keydown = (event: KeyboardEvent): void => {
    if (event.target !== this.#options.textarea() || this.#options.composing() || event.isComposing)
      return;
    if (
      event.keyCode === 229 &&
      this.#options.canResetTextarea() &&
      !this.#compositionJustEnded &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      editableImeKey(event.key)
    ) {
      // xterm's deferred textarea diff can echo old committed text or a second DEL.
      // Browser editing and xterm's composition events continue unchanged.
      event.stopImmediatePropagation();
      this.#suppressedImeKey = true;
      if (this.#suppressedImeKeyTimer !== null) clearTimeout(this.#suppressedImeKeyTimer);
      this.#suppressedImeKeyTimer = setTimeout(() => {
        this.#suppressedImeKey = false;
        this.#suppressedImeKeyTimer = null;
      }, 0);
    }
    if (event.key !== "Backspace" && event.key !== "Enter") return;
    this.#pairedKey = {
      inputType: event.key === "Backspace" ? "deleteContentBackward" : "insertLineBreak",
      emitted: false,
    };
    if (this.#pairedKeyTimer !== null) clearTimeout(this.#pairedKeyTimer);
    this.#pairedKeyTimer = setTimeout(() => {
      this.#pairedKey = null;
      this.#pairedKeyTimer = null;
    }, 0);
  };

  readonly #beforeInput = (event: InputEvent): void => {
    if (event.target !== this.#options.textarea()) return;
    this.#beforeInputFence = this.#options.fence();
    this.#beforeInputType = event.inputType;
    this.#beforeInputValue = (event.target as HTMLTextAreaElement).value;
    this.#beforeInputEpoch = this.#epoch;
    this.#pendingDeleteFromBeforeInput = false;
    if (
      event.inputType === "deleteContentBackward" &&
      this.#compositionJustEnded &&
      !this.#options.composing() &&
      !event.isComposing &&
      this.#options.canResetTextarea() &&
      this.#beforeInputFence.allowed &&
      !(this.#pairedKey?.inputType === event.inputType && this.#pairedKey.emitted) &&
      event.cancelable
    ) {
      // Keep xterm's just-committed text intact until its deferred composition flush runs.
      event.preventDefault();
      event.stopImmediatePropagation();
      this.#pendingDeleteFromBeforeInput = true;
      this.#queuePendingDelete(this.#beforeInputFence);
    }
  };

  readonly #input = (event: InputEvent): void => {
    if (event.target !== this.#options.textarea()) return;
    const fence = this.#options.fence();
    const beforeFence = this.#beforeInputType === event.inputType ? this.#beforeInputFence : null;
    const beforeValue = this.#beforeInputType === event.inputType ? this.#beforeInputValue : null;
    const pendingDeleteFromBeforeInput = this.#pendingDeleteFromBeforeInput;
    const staleBeforeInput =
      this.#beforeInputType !== null && this.#beforeInputEpoch !== this.#epoch;
    const beforeEpoch = this.#beforeInputEpoch;
    const suppressedImeKey = this.#suppressedImeKey;
    this.#suppressedImeKey = false;
    this.#beforeInputFence = null;
    this.#beforeInputType = null;
    this.#beforeInputValue = null;
    this.#pendingDeleteFromBeforeInput = false;
    if (
      !fence.allowed ||
      staleBeforeInput ||
      (beforeFence !== null && (beforeEpoch !== this.#epoch || !sameFence(beforeFence, fence)))
    ) {
      event.stopImmediatePropagation();
      return;
    }
    if (this.#options.composing() || event.isComposing) return;
    if (
      pendingDeleteFromBeforeInput &&
      this.#compositionJustEnded &&
      event.inputType === "deleteContentBackward"
    ) {
      event.stopImmediatePropagation();
      return;
    }
    if (!this.#options.canResetTextarea()) return;
    if (suppressedImeKey && event.inputType === "insertText" && event.data) {
      event.stopImmediatePropagation();
      this.#options.send(event.data);
      this.#resetCommittedTextarea();
      return;
    }
    if (event.inputType !== "deleteContentBackward" && event.inputType !== "insertLineBreak") {
      return;
    }

    // xterm 6 ignores these InputEvents. A paired keydown may already have sent the key.
    event.stopImmediatePropagation();
    if (this.#pairedKey?.inputType === event.inputType && this.#pairedKey.emitted) {
      this.#pairedKey = null;
      if (event.inputType === "deleteContentBackward") this.#resetCommittedTextarea();
      return;
    }
    this.#pairedKey = null;
    if (event.inputType === "deleteContentBackward") {
      if (this.#compositionJustEnded) {
        const textarea = this.#options.textarea();
        if (textarea && beforeValue !== null) textarea.value = beforeValue;
        this.#queuePendingDelete(fence);
        return;
      }
      this.#options.send("\u007f");
      this.#resetCommittedTextarea();
      return;
    }
    if (this.#compositionJustEnded) return;

    // xterm defers compositionend commits. Schedule the line break after that commit.
    const acceptedEpoch = this.#epoch;
    const timer = setTimeout(() => {
      this.#lineBreakTimers.delete(timer);
      if (acceptedEpoch !== this.#epoch || !sameFence(fence, this.#options.fence())) return;
      const textarea = this.#options.textarea();
      if (textarea) textarea.value = "";
      this.#options.send("\r");
    }, 0);
    this.#lineBreakTimers.add(timer);
  };

  readonly #compositionEnd = (event: CompositionEvent): void => {
    if (event.target !== this.#options.textarea()) return;
    this.#compositionJustEnded = true;
    if (this.#compositionEndTimer !== null) clearTimeout(this.#compositionEndTimer);
    this.#compositionEndTimer = setTimeout(() => {
      this.#compositionJustEnded = false;
      this.#compositionEndTimer = null;
    }, 0);
  };

  #clearTimers(): void {
    if (this.#pairedKeyTimer !== null) clearTimeout(this.#pairedKeyTimer);
    if (this.#suppressedImeKeyTimer !== null) clearTimeout(this.#suppressedImeKeyTimer);
    for (const timer of this.#lineBreakTimers) clearTimeout(timer);
    for (const timer of this.#pendingDeleteTimers) clearTimeout(timer);
    if (this.#compositionEndTimer !== null) clearTimeout(this.#compositionEndTimer);
    this.#pairedKeyTimer = null;
    this.#suppressedImeKeyTimer = null;
    this.#lineBreakTimers.clear();
    this.#pendingDeleteTimers.clear();
    this.#compositionEndTimer = null;
  }

  #queuePendingDelete(fence: InputFence): void {
    const acceptedEpoch = this.#epoch;
    const timer = setTimeout(() => {
      this.#pendingDeleteTimers.delete(timer);
      if (acceptedEpoch !== this.#epoch || !sameFence(fence, this.#options.fence())) return;
      this.#options.send("\u007f");
      this.#resetCommittedTextarea();
    }, 0);
    this.#pendingDeleteTimers.add(timer);
  }

  #resetCommittedTextarea(): void {
    if (
      this.#options.composing() ||
      this.#compositionJustEnded ||
      !this.#options.canResetTextarea()
    )
      return;
    const textarea = this.#options.textarea();
    if (textarea) textarea.value = "";
  }
}

function sameFence(a: InputFence, b: InputFence): boolean {
  return (
    a.allowed &&
    b.allowed &&
    a.attachment === b.attachment &&
    a.terminal === b.terminal &&
    a.runtimeId === b.runtimeId &&
    a.leaseGeneration === b.leaseGeneration &&
    a.controlGeneration === b.controlGeneration
  );
}

function editableImeKey(key: string): boolean {
  return (
    key === "Backspace" ||
    key === "Enter" ||
    key === "Unidentified" ||
    key === "Process" ||
    key === "Dead" ||
    Array.from(key).length === 1
  );
}
