// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileTerminalImeBridge } from "./mobile-terminal-ime";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("Android terminal input fallback", () => {
  it("rejects an input event whose beforeinput crossed a control generation", () => {
    const { field, bridge, send, changeControlGeneration } = fixture();
    field.dispatchEvent(input("beforeinput", "deleteContentBackward"));
    bridge.cancelPending();
    changeControlGeneration();
    field.dispatchEvent(input("input", "deleteContentBackward"));
    expect(send).not.toHaveBeenCalled();

    field.dispatchEvent(input("beforeinput", "deleteContentBackward"));
    field.dispatchEvent(input("input", "deleteContentBackward"));
    expect(send).toHaveBeenCalledExactlyOnceWith("\u007f");
  });

  it("does not let a stale beforeinput reach xterm as another input type", () => {
    const { field, bridge, changeControlGeneration } = fixture();
    const nativeInput = vi.fn();
    field.addEventListener("input", nativeInput);
    field.dispatchEvent(input("beforeinput", "deleteContentBackward"));
    bridge.cancelPending();
    changeControlGeneration();
    field.dispatchEvent(input("input", "insertText"));
    expect(nativeInput).not.toHaveBeenCalled();
  });

  it("keeps distinct input-only Enters and cancels a queued Enter on handoff", () => {
    vi.useFakeTimers();
    const { field, bridge, send, changeControlGeneration } = fixture();
    for (let index = 0; index < 2; index += 1) {
      field.dispatchEvent(input("beforeinput", "insertLineBreak"));
      field.dispatchEvent(input("input", "insertLineBreak"));
    }
    vi.runAllTimers();
    expect(send.mock.calls).toEqual([["\r"], ["\r"]]);

    field.dispatchEvent(input("beforeinput", "insertLineBreak"));
    field.dispatchEvent(input("input", "insertLineBreak"));
    bridge.cancelPending();
    changeControlGeneration();
    vi.runAllTimers();
    expect(send.mock.calls).toEqual([["\r"], ["\r"]]);
  });

  it("leaves active composition and navigation keys on the native xterm path", () => {
    const { field, bridge, send, setComposing, setCanResetTextarea } = fixture();
    const nativeKeydown = vi.fn();
    field.addEventListener("keydown", nativeKeydown);

    setComposing(true);
    field.dispatchEvent(key229("Backspace"));
    field.dispatchEvent(input("beforeinput", "deleteContentBackward"));
    field.dispatchEvent(input("input", "deleteContentBackward"));
    expect(nativeKeydown).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();

    setComposing(false);
    field.dispatchEvent(key229("ArrowLeft"));
    field.dispatchEvent(key229("c", { ctrlKey: true }));
    setCanResetTextarea(false);
    field.dispatchEvent(key229("2"));
    expect(nativeKeydown).toHaveBeenCalledTimes(4);
    expect(bridge.allowNativeData("2")).toBe(true);
  });

  it("sends one native Backspace and clears committed textarea residue", () => {
    const { field, bridge, send } = fixture();
    field.value = "이전내용";
    field.addEventListener("keydown", (event) => {
      if (event.key === "Backspace" && bridge.allowNativeData("\u007f")) send("\u007f");
    });
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    field.dispatchEvent(input("beforeinput", "deleteContentBackward"));
    field.dispatchEvent(input("input", "deleteContentBackward"));
    expect(send).toHaveBeenCalledExactlyOnceWith("\u007f");
    expect(field.value).toBe("");
  });

  it("cancels a queued post-composition delete when controller generation changes", () => {
    vi.useFakeTimers();
    const { field, bridge, send, changeControlGeneration } = fixture();
    field.value = "한";
    field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "한" }));
    const beforeDelete = input("beforeinput", "deleteContentBackward");
    field.dispatchEvent(beforeDelete);
    expect(beforeDelete.defaultPrevented).toBe(true);
    bridge.cancelPending();
    changeControlGeneration();
    vi.runAllTimers();
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps distinct accepted deletes behind a pending composition flush", () => {
    vi.useFakeTimers();
    const { field, send } = fixture();
    field.value = "한";
    field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "한" }));
    const first = input("beforeinput", "deleteContentBackward");
    const second = input("beforeinput", "deleteContentBackward");
    field.dispatchEvent(first);
    field.dispatchEvent(second);
    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    expect(send).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(send.mock.calls).toEqual([["\u007f"], ["\u007f"]]);
  });
});

function fixture(): {
  field: HTMLTextAreaElement;
  bridge: MobileTerminalImeBridge;
  send: ReturnType<typeof vi.fn<(data: string) => void>>;
  changeControlGeneration: () => void;
  setComposing: (next: boolean) => void;
  setCanResetTextarea: (next: boolean) => void;
} {
  const host = document.createElement("div");
  const field = document.createElement("textarea");
  host.appendChild(field);
  document.body.appendChild(host);
  const attachment = {};
  const terminal = {};
  let controlGeneration = 1;
  let composing = false;
  let canResetTextarea = true;
  const send = vi.fn<(data: string) => void>();
  const bridge = new MobileTerminalImeBridge({
    textarea: () => field,
    composing: () => composing,
    canResetTextarea: () => canResetTextarea,
    fence: () => ({
      attachment,
      terminal,
      runtimeId: "fixture-runtime",
      leaseGeneration: 1,
      controlGeneration,
      allowed: true,
    }),
    send,
  });
  bridge.attach(host);
  return {
    field,
    bridge,
    send,
    changeControlGeneration: () => {
      controlGeneration += 1;
    },
    setComposing: (next) => {
      composing = next;
    },
    setCanResetTextarea: (next) => {
      canResetTextarea = next;
    },
  };
}

function input(type: "beforeinput" | "input", inputType: string): InputEvent {
  return new InputEvent(type, { bubbles: true, cancelable: true, inputType });
}

function key229(key: string, options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  Object.defineProperty(event, "keyCode", { value: 229 });
  return event;
}
