import {
  MAX_CLIPBOARD_IMAGE_BYTES,
  MAX_TERMINAL_SCROLLBACK_ROWS,
  type ErrorCode,
  type Pane,
  type PaneStatus,
} from "@naru/contracts";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  applyMobileModifiersToTerminalData,
  type MobileTerminalKey,
  mobileTerminalKeySequence,
} from "./mobile-terminal-input";
import { isAndroidTouchInput, MobileTerminalImeBridge } from "./mobile-terminal-ime";
import {
  codexShiftEnterSequence,
  isTerminalFocusReport,
  latchedModifierSequenceForKeyboardEvent,
  shouldUseBrowserClipboard,
} from "./terminal-keyboard";
import { readTerminalClipboard } from "./terminal-clipboard";
import { canPromoteTerminalRestore, translatePreviewBottomOffset } from "./terminal-restore";
import type {
  ConnectionSnapshot,
  PaneControlState,
  PaneFrame,
  TerminalAttachment,
  TerminalConnection,
} from "./terminal-connection";
import {
  areTerminalFontsReady,
  ensureTerminalFontsLoaded,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  TERMINAL_LINE_HEIGHT,
} from "./terminal-font";
import {
  createTerminalResizeScheduler,
  initialTerminalResizeState,
  resolveTerminalResize,
  type TerminalResizeScheduler,
} from "./terminal-resize";
import { attachTerminalTouchScroll } from "./terminal-touch-scroll";
import {
  attachTerminalTouchSelection,
  type TerminalTouchSelectionController,
} from "./terminal-touch-selection";
import { KEYBOARD_HEIGHT_DROP_PX, KEYBOARD_WIDTH_JITTER_PX } from "./workspace-view";

interface TerminalPaneProps {
  pane: Pane;
  active: boolean;
  panelId: string;
  tabPanel: boolean;
  connection: TerminalConnection | null;
  connectionStatus: ConnectionSnapshot;
  mutationAllowed: boolean;
  screenReaderMode: boolean;
  toolbarExtras?: ReactNode;
  onActivate: () => void;
  onFocus?: () => void;
  onRestart: () => Promise<void>;
  onStartNewCodex: () => Promise<void>;
  onClose: () => Promise<boolean>;
}

type RestorePhase = "waiting" | "legacy" | "preview" | "hydrating" | "deferred" | "ready";

interface TerminalRenderer {
  terminal: Terminal;
  fit: FitAddon;
  instanceId: number;
}

interface MountedTerminalRenderer extends TerminalRenderer {
  dispose: () => void;
  scheduleFit: (refresh?: boolean) => void;
  freezeFrame: () => void;
  clearResizeFreeze: () => void;
}

interface RestoreCandidate extends TerminalRenderer {
  restoreId: string;
  runtimeId: string;
  parsedSequence: number;
  ready: boolean;
  stagingHost: HTMLDivElement | null;
  stagingResizeObserver: ResizeObserver | null;
  stagingFitScheduler: TerminalResizeScheduler | null;
}

interface PreviewAnchor {
  restoreId: string;
  bottomOffset: number;
  previewBottomOffset: number;
}

interface TransientFocusIntent {
  connection: TerminalConnection;
  runtimeId: string;
  terminal: Terminal;
  target: HTMLTextAreaElement;
}

// Reserve the two six-character bracketed-paste markers within terminal.input's 64 KiB contract.
const MAX_TERMINAL_PASTE_CHARACTERS = 64 * 1_024 - 12;

let nextTerminalInstanceId = 1;

export function TerminalPane({
  pane,
  active,
  panelId,
  tabPanel,
  connection,
  connectionStatus,
  mutationAllowed,
  screenReaderMode,
  toolbarExtras,
  onActivate,
  onFocus,
  onRestart,
  onStartNewCodex,
  onClose,
}: TerminalPaneProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const mountedRendererRef = useRef<MountedTerminalRenderer | null>(null);
  const restoreCandidateRef = useRef<RestoreCandidate | null>(null);
  const preservedRestoreRef = useRef<{
    restoreId: string;
    runtimeId: string;
    sequence: number;
  } | null>(null);
  const previewAnchorRef = useRef<PreviewAnchor | null>(null);
  const paneFrameHandlerRef = useRef<((frame: PaneFrame) => void) | null>(null);
  const promoteRestoreRef = useRef<() => void>(() => undefined);
  const composingRef = useRef(false);
  const runtimeIdRef = useRef<string | null>(null);
  const restoreIdRef = useRef<string | null>(null);
  const latestSequenceRef = useRef(0);
  const desiredBottomOffsetRef = useRef(0);
  const resizeViewportAnchorRef = useRef<number | null>(null);
  const screenReaderModeRef = useRef(screenReaderMode);
  const surfaceControllerRef = useRef(mutationAllowed);
  const controlAllowedRef = useRef(false);
  const attachmentRef = useRef<TerminalAttachment | null>(null);
  const connectionRef = useRef(connection);
  const ctrlArmedRef = useRef(false);
  const altArmedRef = useRef(false);
  const clipboardBusyRef = useRef(false);
  const clipboardReadBusyRef = useRef(false);
  const clipboardImagePasteRef = useRef<(image: Blob) => Promise<boolean>>(() =>
    Promise.resolve(false),
  );
  const touchSelectionRef = useRef<TerminalTouchSelectionController | null>(null);
  const composeInputRef = useRef<HTMLTextAreaElement>(null);
  const mobileImeRef = useRef<MobileTerminalImeBridge | null>(null);
  const previousConnectionStatusRef = useRef(connectionStatus);
  const transientFocusIntentRef = useRef<TransientFocusIntent | null>(null);
  const paneTitleRef = useRef(pane.title);
  const keyboardHelpId = `${pane.id}-terminal-keyboard-help`;
  const composeInputId = `${pane.id}-terminal-compose-input`;
  const [runtimeStatus, setRuntimeStatus] = useState<PaneStatus>(pane.status);
  const [runtimeId, setRuntimeId] = useState<string | null>(null);
  const [restorePhase, setRestorePhase] = useState<RestorePhase>("waiting");
  const [terminalInstanceId, setTerminalInstanceId] = useState(0);
  const [scrollBottomOffset, setScrollBottomOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [altArmed, setAltArmed] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeText, setComposeText] = useState("");
  const [clipboardNotice, setClipboardNotice] = useState<{
    kind: "status" | "error";
    message: string;
  } | null>(null);
  const [clipboardReadBusy, setClipboardReadBusy] = useState(false);
  const [touchSelectionActive, setTouchSelectionActive] = useState(false);
  const [paneControlSource, setPaneControlSource] = useState<{
    connection: TerminalConnection | null;
    paneId: string;
    value: PaneControlState | undefined;
  }>(() => ({ connection, paneId: pane.id, value: connection?.paneControl(pane.id) }));
  const [documentVisible, setDocumentVisible] = useState(
    () => document.visibilityState === "visible",
  );
  const lastPaneControl =
    paneControlSource.connection === connection && paneControlSource.paneId === pane.id
      ? paneControlSource.value
      : connection?.paneControl(pane.id);
  const currentPaneControl =
    connectionStatus.state === "active" ? connection?.paneControl(pane.id) : undefined;
  const paneControl = lastPaneControl;
  const controlsPane = mutationAllowed && paneControl?.role === "controller";
  const transientConnection =
    connectionStatus.state === "connecting" || connectionStatus.state === "disconnected";
  const preservingReconnectInput =
    lastPaneControl?.role === "controller" &&
    (transientConnection ||
      (connectionStatus.state === "active" &&
        connectionStatus.surfaceRole === "controller" &&
        connectionStatus.acquisition === "reconnect" &&
        currentPaneControl === undefined));
  const inputDisabled = (!controlsPane && !preservingReconnectInput) || runtimeStatus !== "running";
  const terminalSubscriptionAllowed =
    (connectionStatus.state === "active" ||
      ((connectionStatus.state === "connecting" || connectionStatus.state === "disconnected") &&
        connectionStatus.surfaceRole !== undefined)) &&
    (connectionStatus.surfaceRole !== "observer" || (active && documentVisible));

  useLayoutEffect(() => {
    connectionRef.current = connection;
  }, [connection]);

  useEffect(() => {
    surfaceControllerRef.current = mutationAllowed;
    controlAllowedRef.current = controlsPane;
  }, [controlsPane, mutationAllowed]);

  const updateCtrlArmed = useCallback((armed: boolean): void => {
    ctrlArmedRef.current = armed;
    setCtrlArmed(armed);
  }, []);

  const updateAltArmed = useCallback((armed: boolean): void => {
    altArmedRef.current = armed;
    setAltArmed(armed);
  }, []);

  const clearMobileModifiers = useCallback((): void => {
    updateCtrlArmed(false);
    updateAltArmed(false);
  }, [updateAltArmed, updateCtrlArmed]);

  const returnToLiveTail = useCallback((): void => {
    const terminal = terminalRef.current;
    const alreadyAtLiveTail =
      desiredBottomOffsetRef.current === 0 &&
      resizeViewportAnchorRef.current === null &&
      (terminal === null || terminalBottomOffset(terminal) === 0);
    if (alreadyAtLiveTail) return;
    resizeViewportAnchorRef.current = null;
    desiredBottomOffsetRef.current = 0;
    setScrollBottomOffset(0);
    if (terminal) scrollToBottomOffset(terminal, 0);
    const currentRuntimeId = runtimeIdRef.current;
    if (currentRuntimeId) attachmentRef.current?.viewport(currentRuntimeId, 0);
  }, []);

  const sendTerminalData = useCallback(
    (data: string, revealLiveTail = true): void => {
      const attachment = attachmentRef.current;
      if (!attachment) return;
      const modifiersArmed = ctrlArmedRef.current || altArmedRef.current;
      const output =
        revealLiveTail && modifiersArmed
          ? applyMobileModifiersToTerminalData(data, ctrlArmedRef.current, altArmedRef.current)
          : data;
      if (!attachment.input(output)) return;
      if (revealLiveTail && modifiersArmed) clearMobileModifiers();
      if (revealLiveTail) returnToLiveTail();
    },
    [clearMobileModifiers, returnToLiveTail],
  );

  const sendSpecialKey = (key: MobileTerminalKey): void => {
    const attachment = attachmentRef.current;
    if (!attachment) return;
    if (
      !attachment.input(mobileTerminalKeySequence(key, ctrlArmedRef.current, altArmedRef.current))
    ) {
      return;
    }
    returnToLiveTail();
    clearMobileModifiers();
    terminalRef.current?.focus();
  };

  const toggleComposeInput = (): void => {
    const next = !composeOpen;
    setComposeOpen(next);
    clearMobileModifiers();
    requestAnimationFrame(() => {
      if (next) composeInputRef.current?.focus();
      else terminalRef.current?.focus();
    });
  };

  const copySelectedOutput = (): void => {
    const selection = touchSelectionRef.current;
    const value = selection?.getSelection() ?? "";
    if (!selection || !value) {
      setClipboardNotice({ kind: "error", message: "복사할 터미널 출력을 먼저 선택해 주세요." });
      return;
    }
    if (!navigator.clipboard?.writeText) {
      setClipboardNotice({
        kind: "error",
        message: "이 브라우저에서 클립보드 쓰기를 사용할 수 없습니다.",
      });
      return;
    }
    try {
      void navigator.clipboard.writeText(value).then(
        () => {
          if (touchSelectionRef.current !== selection) return;
          selection.cancel();
          setClipboardNotice({ kind: "status", message: "선택한 출력을 복사했습니다." });
        },
        () => {
          if (touchSelectionRef.current === selection) {
            setClipboardNotice({
              kind: "error",
              message: "클립보드에 복사하지 못했습니다. 브라우저 권한을 확인해 주세요.",
            });
          }
        },
      );
    } catch {
      setClipboardNotice({
        kind: "error",
        message: "클립보드에 복사하지 못했습니다. 브라우저 권한을 확인해 주세요.",
      });
    }
  };

  const pasteClipboardIntoTerminal = (): void => {
    if (clipboardReadBusyRef.current) return;
    const attachment = attachmentRef.current;
    const connectionAtRead = connectionRef.current;
    const statusAtRead = connectionAtRead?.status();
    const controlAtRead = connectionAtRead?.paneControl(pane.id);
    if (
      !attachment ||
      !connectionAtRead ||
      !controlAllowedRef.current ||
      statusAtRead?.state !== "active" ||
      statusAtRead.surfaceRole !== "controller" ||
      controlAtRead?.role !== "controller"
    ) {
      setClipboardNotice({
        kind: "error",
        message: `현재 화면은 이 ${pane.kind === "codex" ? "Codex" : "Terminal"} Pane을 제어할 수 없습니다.`,
      });
      return;
    }
    const clipboard = navigator.clipboard;
    if (!clipboard || (!clipboard.read && !clipboard.readText)) {
      setClipboardNotice({
        kind: "error",
        message: "이 브라우저에서 클립보드 읽기를 사용할 수 없습니다.",
      });
      return;
    }

    clipboardReadBusyRef.current = true;
    setClipboardReadBusy(true);
    void readTerminalClipboard(clipboard)
      .then(async ({ image, text }) => {
        const statusNow = connectionAtRead.status();
        const controlNow = connectionAtRead.paneControl(pane.id);
        if (
          attachmentRef.current !== attachment ||
          connectionRef.current !== connectionAtRead ||
          !controlAllowedRef.current ||
          statusNow.state !== "active" ||
          statusNow.surfaceRole !== "controller" ||
          statusNow.generation !== statusAtRead.generation ||
          controlNow?.role !== "controller" ||
          controlNow.controllerGeneration !== controlAtRead.controllerGeneration
        ) {
          throw new Error("제어권이나 터미널 연결이 바뀌어 붙여넣기를 중단했습니다.");
        }
        if (pane.kind === "codex" && image) {
          if (await clipboardImagePasteRef.current(image)) {
            touchSelectionRef.current?.cancel();
          }
          return;
        }
        if (text) {
          if (text.length > MAX_TERMINAL_PASTE_CHARACTERS) {
            throw new Error("붙여넣을 텍스트는 65,524자 이하여야 합니다.");
          }
          const terminal = terminalRef.current;
          if (!terminal) throw new Error("터미널 연결이 준비된 뒤 다시 붙여넣어 주세요.");
          clearMobileModifiers();
          terminal.paste(text);
          touchSelectionRef.current?.cancel();
          setClipboardNotice({ kind: "status", message: "클립보드 텍스트를 붙여넣었습니다." });
          return;
        }
        if (image) {
          throw new Error("이미지는 Codex Pane에만 붙여넣을 수 있습니다.");
        }
        setClipboardNotice({
          kind: "error",
          message: "클립보드에 붙여넣을 텍스트나 이미지가 없습니다.",
        });
      })
      .catch((error: unknown) => {
        setClipboardNotice({
          kind: "error",
          message:
            error instanceof Error && error.message && error.name !== "NotAllowedError"
              ? error.message
              : "클립보드를 읽지 못했습니다. 브라우저 권한을 확인해 주세요.",
        });
      })
      .finally(() => {
        clipboardReadBusyRef.current = false;
        setClipboardReadBusy(false);
      });
  };

  const submitComposedText = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const value = composeInputRef.current?.value ?? composeText;
    if (!value || !attachmentRef.current) return;
    if (!attachmentRef.current.input(value)) return;
    returnToLiveTail();
    clearMobileModifiers();
    setComposeText("");
    requestAnimationFrame(() => composeInputRef.current?.focus());
  };

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    const mobileIme = isAndroidTouchInput()
      ? new MobileTerminalImeBridge({
          textarea: () => terminalRef.current?.textarea,
          composing: () => composingRef.current,
          canResetTextarea: () => !screenReaderModeRef.current,
          fence: () => {
            const currentConnection = connectionRef.current;
            const status = currentConnection?.status();
            const control = currentConnection?.paneControl(pane.id);
            return {
              attachment: attachmentRef.current,
              terminal: terminalRef.current,
              runtimeId: runtimeIdRef.current,
              leaseGeneration: status?.generation,
              controlGeneration: control?.controllerGeneration,
              allowed:
                controlAllowedRef.current &&
                status?.state === "active" &&
                status.surfaceRole === "controller" &&
                control?.role === "controller" &&
                attachmentRef.current !== null &&
                runtimeIdRef.current !== null,
            };
          },
          send: sendTerminalData,
        })
      : null;
    mobileImeRef.current = mobileIme;
    const detachMobileIme = mobileIme?.attach(host);
    let viewportReportingSuppressions = 0;
    let loadedTerminalFontState: "true" | "fallback" | null = areTerminalFontsReady()
      ? "true"
      : null;
    let fontRevealTimeout: ReturnType<typeof setTimeout> | null = null;
    let fontSettleTimeout: ReturnType<typeof setTimeout> | null = null;

    const revealTerminalFonts = (): void => {
      if (loadedTerminalFontState === null) return;
      if (fontRevealTimeout !== null) clearTimeout(fontRevealTimeout);
      fontRevealTimeout = null;
      host.dataset.terminalFontsReady = loadedTerminalFontState;
    };

    const concealTerminalRestore = (): void => {
      host.dataset.terminalRestoreReady = "false";
    };

    const revealTerminalRestore = (): void => {
      host.dataset.terminalRestoreReady = "true";
    };

    const suppressViewportReporting = (): (() => void) => {
      viewportReportingSuppressions += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        viewportReportingSuppressions = Math.max(0, viewportReportingSuppressions - 1);
      };
    };

    const leaveTerminalWithShiftTab = (event: KeyboardEvent): void => {
      if (event.key !== "Tab" || !event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.type === "keydown") {
        host
          .closest<HTMLElement>(".pane-surface")
          ?.querySelector<HTMLButtonElement>(".pane-actions .danger-hover")
          ?.focus();
      }
    };

    const handleLatchedInput = (event: Event): void => {
      if (
        (!ctrlArmedRef.current && !altArmedRef.current) ||
        !(event instanceof InputEvent) ||
        !event.data
      ) {
        return;
      }
      const sequence = applyMobileModifiersToTerminalData(
        event.data,
        ctrlArmedRef.current,
        altArmedRef.current,
      );
      if (sequence === event.data || !attachmentRef.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const terminal = terminalRef.current;
      if (terminal?.textarea) terminal.textarea.value = "";
      clearMobileModifiers();
      if (!attachmentRef.current.input(sequence)) return;
      returnToLiveTail();
    };
    const pasteClipboardImage = async (image: Blob): Promise<boolean> => {
      if (pane.kind !== "codex") {
        setClipboardNotice({
          kind: "error",
          message: "이미지는 Codex Pane에만 붙여넣을 수 있습니다.",
        });
        return false;
      }
      const attachment = attachmentRef.current;
      if (!attachment) {
        setClipboardNotice({
          kind: "error",
          message: "Codex 연결이 준비된 뒤 다시 붙여넣어 주세요.",
        });
        return false;
      }
      const connectionAtPaste = connectionRef.current;
      const statusAtPaste = connectionAtPaste?.status();
      const controlAtPaste = connectionAtPaste?.paneControl(pane.id);
      if (
        !connectionAtPaste ||
        !controlAllowedRef.current ||
        statusAtPaste?.state !== "active" ||
        statusAtPaste.surfaceRole !== "controller" ||
        controlAtPaste?.role !== "controller"
      ) {
        setClipboardNotice({
          kind: "error",
          message: "현재 화면은 이 Codex Pane을 제어할 수 없습니다.",
        });
        return false;
      }
      if (clipboardBusyRef.current) {
        setClipboardNotice({
          kind: "error",
          message: "앞선 이미지를 붙여넣는 중입니다.",
        });
        return false;
      }
      const runtimeAtPaste = runtimeIdRef.current;
      const terminalAtPaste = terminalRef.current;
      const generationAtPaste = statusAtPaste.generation;
      const paneControlGenerationAtPaste = controlAtPaste.controllerGeneration;
      clipboardBusyRef.current = true;
      setClipboardNotice({ kind: "status", message: "이미지를 Codex에 붙여넣는 중…" });
      try {
        const bytes = await prepareClipboardPng(image);
        if (
          disposed ||
          !controlAllowedRef.current ||
          attachmentRef.current !== attachment ||
          runtimeIdRef.current !== runtimeAtPaste ||
          terminalRef.current !== terminalAtPaste ||
          connectionRef.current !== connectionAtPaste ||
          connectionAtPaste.status().state !== "active" ||
          connectionAtPaste.status().surfaceRole !== "controller" ||
          connectionAtPaste.status().generation !== generationAtPaste ||
          connectionAtPaste.paneControl(pane.id)?.role !== "controller" ||
          connectionAtPaste.paneControl(pane.id)?.controllerGeneration !==
            paneControlGenerationAtPaste
        ) {
          throw new Error("제어권이나 Codex 연결이 바뀌어 이미지 붙여넣기를 중단했습니다.");
        }
        await attachment.pasteImage(bytes);
        if (!disposed) {
          setClipboardNotice({
            kind: "status",
            message: "Codex에 이미지 붙여넣기 요청을 보냈습니다.",
          });
        }
        return !disposed;
      } catch (error: unknown) {
        if (!disposed) {
          setClipboardNotice({
            kind: "error",
            message: error instanceof Error ? error.message : "이미지를 붙여넣지 못했습니다.",
          });
        }
        return false;
      } finally {
        clipboardBusyRef.current = false;
      }
    };
    clipboardImagePasteRef.current = pasteClipboardImage;
    const handlePaste = (event: Event): void => {
      if (!(event instanceof ClipboardEvent)) return;
      if (
        !(event.target instanceof Node) ||
        (!host.contains(event.target) && event.target !== composeInputRef.current)
      ) {
        return;
      }
      clearMobileModifiers();
      const image = clipboardImageFrom(event.clipboardData);
      if (!image) {
        if (pane.kind === "codex" && clipboardAdvertisesImage(event.clipboardData)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          setClipboardNotice({
            kind: "error",
            message: "브라우저가 이미지 데이터를 제공하지 않았습니다. 이미지 복사를 확인해 주세요.",
          });
        }
        return;
      }
      if (pane.kind !== "codex" && event.clipboardData?.getData("text/plain")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void pasteClipboardImage(image);
    };

    const syncCandidateViewport = (): void => {
      const candidate = restoreCandidateRef.current;
      if (!candidate?.ready) return;
      scrollToBottomOffset(candidate.terminal, desiredBottomOffsetRef.current);
    };

    const reportViewport = (terminal: Terminal): void => {
      if (terminalRef.current !== terminal || viewportReportingSuppressions > 0) return;
      const internalOffset = resizeViewportAnchorRef.current ?? terminalBottomOffset(terminal);
      const preview = previewAnchorRef.current;
      const bottomOffset =
        preview === null
          ? internalOffset
          : translatePreviewBottomOffset(
              preview.bottomOffset,
              preview.previewBottomOffset,
              internalOffset,
              MAX_TERMINAL_SCROLLBACK_ROWS,
            );
      desiredBottomOffsetRef.current = bottomOffset;
      setScrollBottomOffset(bottomOffset);
      syncCandidateViewport();
      const currentRuntimeId = runtimeIdRef.current;
      if (currentRuntimeId) attachmentRef.current?.viewport(currentRuntimeId, bottomOffset);
    };

    const mountRenderer = (
      renderer: TerminalRenderer,
      fitToHost = true,
    ): MountedTerminalRenderer => {
      const { terminal, fit } = renderer;
      terminalRef.current = terminal;
      terminal.options.screenReaderMode = screenReaderModeRef.current;
      if (terminal.element) {
        if (terminal.element.parentElement !== host) host.appendChild(terminal.element);
      } else {
        terminal.open(host);
      }
      terminal.textarea?.setAttribute("aria-label", `${paneTitleRef.current} 명령 입력`);
      terminal.textarea?.setAttribute("aria-describedby", keyboardHelpId);
      terminal.attachCustomKeyEventHandler((event) => {
        if (ctrlArmedRef.current || altArmedRef.current) {
          const sequence = latchedModifierSequenceForKeyboardEvent(
            event,
            ctrlArmedRef.current,
            altArmedRef.current,
          );
          if (sequence !== null) {
            event.preventDefault();
            event.stopPropagation();
            clearMobileModifiers();
            if (!attachmentRef.current?.input(sequence)) return false;
            returnToLiveTail();
            return false;
          }
        }
        if (shouldUseBrowserClipboard(event, terminal.hasSelection())) {
          clearMobileModifiers();
          return false;
        }
        if (pane.kind === "codex") {
          const sequence = codexShiftEnterSequence(event);
          if (sequence !== null) {
            event.preventDefault();
            event.stopPropagation();
            clearMobileModifiers();
            if (!attachmentRef.current?.input(sequence)) return false;
            returnToLiveTail();
            return false;
          }
        }
        return true;
      });

      const terminalScreen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
      const touchSelection = terminalScreen
        ? attachTerminalTouchSelection(
            terminalScreen,
            terminal,
            (active) => {
              if (!disposed && touchSelectionRef.current === touchSelection) {
                setTouchSelectionActive(active);
              }
            },
            (result) => {
              if (disposed || touchSelectionRef.current !== touchSelection) return;
              setClipboardNotice(
                result === "copied"
                  ? { kind: "status", message: "선택한 출력을 복사했습니다." }
                  : result === "empty"
                    ? { kind: "error", message: "복사할 터미널 출력을 먼저 선택해 주세요." }
                    : {
                        kind: "error",
                        message: "이 브라우저에서 클립보드 복사를 사용할 수 없습니다.",
                      },
              );
            },
          )
        : null;
      touchSelectionRef.current = touchSelection;
      const detachTouchScroll = terminalScreen
        ? attachTerminalTouchScroll(terminalScreen, terminal, touchSelection ?? undefined, () => {
            returnToLiveTail();
            terminal.focus();
          })
        : () => undefined;
      const onData = terminal.onData((data) => {
        if (!mobileIme || mobileIme.allowNativeData(data)) {
          sendTerminalData(data, !isTerminalFocusReport(data, terminal.modes.sendFocusMode));
        }
      });
      const onScroll = terminal.onScroll(() => reportViewport(terminal));
      let rendererDisposed = false;
      let resizeAnchorTimeout: ReturnType<typeof setTimeout> | null = null;
      let resizeRevision = 0;
      resizeViewportAnchorRef.current = null;
      if (fitToHost) {
        try {
          // The connection effect reads these dimensions immediately after this layout effect.
          // Fit synchronously so a controller remount never attaches with xterm's 80x24 defaults.
          fit.fit();
        } catch {
          // A hidden pane will be fitted by the observer once it becomes measurable.
        }
      }
      publishTerminalDimensions(host, terminal);
      let resizeState = initialTerminalResizeState(
        terminalHostGeometry(host),
        terminalDimensions(terminal),
      );
      const resizeFreeze = createTerminalResizeFreeze(host, terminal);
      const onRender = terminal.onRender(() => resizeFreeze.rendered());
      const fitScheduler = createTerminalResizeScheduler(({ refresh }) => {
        if (disposed || rendererDisposed || terminalRef.current !== terminal) return;
        incrementDatasetCount(host, "resizeApplyCount");
        const proposed = fit.proposeDimensions();
        if (!proposed) return;
        const keyboardSessionWasActive = resizeState.keyboardSession !== null;
        const resolution = resolveTerminalResize(resizeState, {
          host: terminalHostGeometry(host),
          proposed,
          textInputFocused: isTerminalInputFocused(terminal, composeInputRef.current),
        });
        resizeState = resolution.state;
        host.dataset.resizeKeyboardSession = String(resolution.keyboardSession);
        const nextCols = Math.max(resolution.dimensions.cols, 2);
        const nextRows = Math.max(resolution.dimensions.rows, 1);
        const leavingKeyboardSession = keyboardSessionWasActive && !resolution.keyboardSession;
        if (!controlAllowedRef.current) {
          if (refresh && terminal.rows > 0) terminal.refresh(0, terminal.rows - 1);
          publishTerminalDimensions(host, terminal);
          return;
        }
        const columnsChanged = terminal.cols !== nextCols;
        const rowsChanged = terminal.rows !== nextRows;
        const keyboardBoundary =
          resolution.keyboardSession || (leavingKeyboardSession && !columnsChanged);
        const freezeThisResize = columnsChanged || !keyboardBoundary;
        if (!columnsChanged && !rowsChanged && !refresh) return;
        if (columnsChanged) touchSelection?.cancel();

        // Preserve the authoritative full-buffer viewport instead of sampling xterm while its
        // host changes size. A compact restore preview is the exception: its small local buffer
        // has a different visual offset, which reportViewport translates back to the full offset.
        const preview = previewAnchorRef.current;
        const bottomOffset =
          preview === null ? desiredBottomOffsetRef.current : terminalBottomOffset(terminal);
        const reportedBottomOffset = desiredBottomOffsetRef.current;
        const transactionRuntimeId = runtimeIdRef.current;
        const revision = ++resizeRevision;
        const transactionIsCurrent = (): boolean =>
          !disposed &&
          !rendererDisposed &&
          terminalRef.current === terminal &&
          transactionRuntimeId !== null &&
          runtimeIdRef.current === transactionRuntimeId &&
          desiredBottomOffsetRef.current === reportedBottomOffset &&
          revision === resizeRevision;
        const started = performance.now();
        const releaseViewportReporting = suppressViewportReporting();
        resizeViewportAnchorRef.current = bottomOffset;
        if (resizeAnchorTimeout !== null) clearTimeout(resizeAnchorTimeout);
        if (freezeThisResize) resizeFreeze.begin();
        try {
          if (columnsChanged || rowsChanged) {
            terminal.resize(nextCols, nextRows);
            incrementDatasetCount(host, "resizeCount");
            if (columnsChanged) incrementDatasetCount(host, "columnReflowCount");
          }
          scrollToBottomOffset(terminal, bottomOffset);
          if (refresh && terminal.rows > 0) terminal.refresh(0, terminal.rows - 1);
          if (columnsChanged || rowsChanged) {
            attachmentRef.current?.resize(nextCols, nextRows);
            if (transactionRuntimeId) {
              attachmentRef.current?.viewport(transactionRuntimeId, reportedBottomOffset);
            }
          }
        } catch {
          // The host can briefly be hidden while switching projects on a narrow screen.
        } finally {
          publishTerminalDimensions(host, terminal);
          host.dataset.resizeLastDurationMs = (performance.now() - started).toFixed(2);
        }
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (transactionIsCurrent()) {
              scrollToBottomOffset(terminal, bottomOffset);
            } else if (revision === resizeRevision) {
              resizeViewportAnchorRef.current = null;
            }
            releaseViewportReporting();
            if (transactionIsCurrent()) {
              reportViewport(terminal);
            }
          });
        });
        resizeAnchorTimeout = setTimeout(() => {
          resizeAnchorTimeout = null;
          if (transactionIsCurrent()) {
            scrollToBottomOffset(terminal, bottomOffset);
            resizeViewportAnchorRef.current = null;
            reportViewport(terminal);
          } else if (revision === resizeRevision) {
            resizeViewportAnchorRef.current = null;
          }
        }, 160);
      });
      const scheduleFit = (refresh = false): void => {
        if (disposed || rendererDisposed) return;
        fitScheduler.request(refresh);
      };
      const resizeObserver = new ResizeObserver(() => {
        incrementDatasetCount(host, "resizeObserverCount");
        scheduleFit();
        const geometry = terminalHostGeometry(host);
        const anchor = resizeState.keyboardSession ?? resizeState.stable;
        if (
          anchor !== null &&
          isTerminalInputFocused(terminal, composeInputRef.current) &&
          Math.abs(geometry.width - anchor.width) <= KEYBOARD_WIDTH_JITTER_PX &&
          (resizeState.keyboardSession !== null ||
            geometry.height < anchor.height - KEYBOARD_HEIGHT_DROP_PX)
        ) {
          fitScheduler.flush();
        }
      });
      resizeObserver.observe(host);
      scheduleFit();

      return {
        ...renderer,
        scheduleFit,
        freezeFrame: () => resizeFreeze.begin(),
        clearResizeFreeze: () => resizeFreeze.dispose(),
        dispose: () => {
          if (rendererDisposed) return;
          rendererDisposed = true;
          resizeObserver.disconnect();
          fitScheduler.dispose();
          resizeFreeze.dispose();
          resizeRevision += 1;
          if (resizeAnchorTimeout !== null) clearTimeout(resizeAnchorTimeout);
          resizeAnchorTimeout = null;
          resizeViewportAnchorRef.current = null;
          onData.dispose();
          onScroll.dispose();
          onRender.dispose();
          detachTouchScroll();
          touchSelection?.dispose();
          if (touchSelectionRef.current === touchSelection) {
            touchSelectionRef.current = null;
            if (!disposed) setTouchSelectionActive(false);
          }
          terminal.dispose();
          if (terminalRef.current === terminal) terminalRef.current = null;
        },
      };
    };

    const disposeCandidate = (): void => {
      const candidate = restoreCandidateRef.current;
      restoreCandidateRef.current = null;
      candidate?.stagingResizeObserver?.disconnect();
      candidate?.stagingFitScheduler?.dispose();
      candidate?.stagingHost?.remove();
      candidate?.terminal.dispose();
    };

    const promoteCandidate = (): void => {
      const candidate = restoreCandidateRef.current;
      if (disposed || !candidate) return;
      const inputFocused = isTerminalInputFocused(terminalRef.current, composeInputRef.current);
      const restoreMatches =
        candidate.restoreId === restoreIdRef.current &&
        candidate.runtimeId === runtimeIdRef.current;
      if (
        !canPromoteTerminalRestore({
          candidateReady: candidate.ready,
          parsedSequence: candidate.parsedSequence,
          latestSequence: latestSequenceRef.current,
          restoreMatches,
          composing: composingRef.current,
          inputFocused,
        })
      ) {
        if (
          candidate.ready &&
          candidate.parsedSequence >= latestSequenceRef.current &&
          restoreMatches &&
          (composingRef.current || inputFocused)
        ) {
          setRestorePhase("deferred");
        }
        return;
      }
      const targetBottomOffset = desiredBottomOffsetRef.current;
      const releaseViewportReporting = suppressViewportReporting();
      host.style.visibility = "hidden";
      try {
        const stagingHost = candidate.stagingHost;
        if (!stagingHost) return;
        candidate.stagingResizeObserver?.disconnect();
        candidate.stagingResizeObserver = null;
        candidate.stagingFitScheduler?.dispose();
        candidate.stagingFitScheduler = null;
        mountedRendererRef.current?.dispose();
        restoreCandidateRef.current = null;
        previewAnchorRef.current = null;
        candidate.stagingHost = null;
        const mounted = mountRenderer(candidate, controlAllowedRef.current);
        stagingHost.remove();
        mountedRendererRef.current = mounted;
        desiredBottomOffsetRef.current = targetBottomOffset;
        scrollToBottomOffset(candidate.terminal, targetBottomOffset);
        attachmentRef.current?.resize(
          Math.max(candidate.terminal.cols, 2),
          Math.max(candidate.terminal.rows, 1),
        );
        setTerminalInstanceId(candidate.instanceId);
        setRestorePhase("ready");
        setScrollBottomOffset(targetBottomOffset);
        revealTerminalFonts();
        revealTerminalRestore();
      } finally {
        host.style.removeProperty("visibility");
        releaseViewportReporting();
      }
      reportViewport(candidate.terminal);
    };
    promoteRestoreRef.current = promoteCandidate;

    paneFrameHandlerRef.current = (frame): void => {
      if (frame.type === "pane.control.state") {
        const controlsNow = surfaceControllerRef.current && frame.role === "controller";
        controlAllowedRef.current = controlsNow;
        if (!controlsNow) mobileIme?.cancelPending();
        host.dataset.controlRole = controlsNow ? "controller" : "observer";
        if (controlsNow) {
          mountedRendererRef.current?.scheduleFit(true);
        } else {
          const terminals = [terminalRef.current, restoreCandidateRef.current?.terminal];
          for (const terminal of terminals) {
            if (
              terminal &&
              (terminal.cols !== frame.terminal.cols || terminal.rows !== frame.terminal.rows)
            ) {
              terminal.resize(frame.terminal.cols, frame.terminal.rows);
              if (terminal === terminalRef.current) publishTerminalDimensions(host, terminal);
            }
          }
        }
        return;
      }
      if (frame.type === "pane.snapshot") {
        const terminal = terminalRef.current;
        if (terminal && runtimeIdRef.current === frame.runtimeId) {
          if (frame.sequence <= latestSequenceRef.current) return;
          const targetBottomOffset = desiredBottomOffsetRef.current;
          const releaseViewportReporting = suppressViewportReporting();
          disposeCandidate();
          preservedRestoreRef.current = null;
          restoreIdRef.current = null;
          previewAnchorRef.current = null;
          latestSequenceRef.current = frame.sequence;
          setRuntimeStatus("running");
          mountedRendererRef.current?.freezeFrame();
          incrementDatasetCount(host, "sameRuntimeSnapshotCount");
          if (terminal.cols !== frame.cols || terminal.rows !== frame.rows) {
            terminal.resize(frame.cols, frame.rows);
            publishTerminalDimensions(host, terminal);
          }
          terminal.reset();
          terminal.write(frame.serializedState, () => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                releaseViewportReporting();
                if (
                  disposed ||
                  runtimeIdRef.current !== frame.runtimeId ||
                  terminalRef.current !== terminal
                ) {
                  return;
                }
                desiredBottomOffsetRef.current = targetBottomOffset;
                setScrollBottomOffset(targetBottomOffset);
                scrollToBottomOffset(terminal, targetBottomOffset);
                attachmentRef.current?.viewport(frame.runtimeId, targetBottomOffset);
                setRestorePhase("ready");
                revealTerminalFonts();
                revealTerminalRestore();
              });
            });
          });
          return;
        }
        touchSelectionRef.current?.cancel();
        if (runtimeIdRef.current !== frame.runtimeId) mobileIme?.cancelPending();
        disposeCandidate();
        preservedRestoreRef.current = null;
        restoreIdRef.current = null;
        previewAnchorRef.current = null;
        latestSequenceRef.current = frame.sequence;
        desiredBottomOffsetRef.current = 0;
        runtimeIdRef.current = frame.runtimeId;
        setRuntimeId(frame.runtimeId);
        setRuntimeStatus("running");
        setRestorePhase("legacy");
        concealTerminalRestore();
        if (terminal && (terminal.cols !== frame.cols || terminal.rows !== frame.rows)) {
          terminal.resize(frame.cols, frame.rows);
          publishTerminalDimensions(host, terminal);
        }
        terminal?.reset();
        terminal?.write(frame.serializedState, () => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (disposed || terminalRef.current !== terminal) return;
              revealTerminalFonts();
              revealTerminalRestore();
            });
          });
        });
        return;
      }

      if (frame.type === "pane.restore.preview") {
        disposeCandidate();
        const displayedSequence = latestSequenceRef.current;
        const sameRuntime = runtimeIdRef.current === frame.runtimeId;
        const preservesMountedRuntime = sameRuntime;
        if (!preservesMountedRuntime) touchSelectionRef.current?.cancel();
        if (!preservesMountedRuntime) mobileIme?.cancelPending();
        preservedRestoreRef.current = preservesMountedRuntime
          ? {
              restoreId: frame.restoreId,
              runtimeId: frame.runtimeId,
              sequence: displayedSequence,
            }
          : null;
        restoreIdRef.current = frame.restoreId;
        latestSequenceRef.current = sameRuntime
          ? Math.max(displayedSequence, frame.sequence)
          : frame.sequence;
        if (!preservesMountedRuntime) {
          desiredBottomOffsetRef.current = frame.bottomOffset;
          setScrollBottomOffset(frame.bottomOffset);
        }
        runtimeIdRef.current = frame.runtimeId;
        setRuntimeId(frame.runtimeId);
        setRuntimeStatus("running");
        if (preservesMountedRuntime) {
          previewAnchorRef.current = null;
          setRestorePhase("hydrating");
          return;
        }

        const terminal = terminalRef.current;
        if (!terminal) return;
        // The compact snapshot is still useful as a parsed fallback and viewport anchor, but it
        // is not visually equivalent to the fully hydrated alternate-screen state used by TUIs
        // such as Codex. Keep it hidden so reset/write never exposes an unstyled intermediate
        // frame; promoteCandidate reveals only the fully parsed renderer in one task.
        concealTerminalRestore();
        previewAnchorRef.current = {
          restoreId: frame.restoreId,
          bottomOffset: frame.bottomOffset,
          previewBottomOffset: frame.previewBottomOffset,
        };
        setRestorePhase("preview");
        const releaseViewportReporting = suppressViewportReporting();
        terminal.reset();
        terminal.resize(frame.cols, frame.rows);
        terminal.write(frame.serializedState, () => {
          const restoreIsCurrent =
            !disposed &&
            restoreIdRef.current === frame.restoreId &&
            terminalRef.current === terminal;
          if (restoreIsCurrent) {
            scrollToBottomOffset(terminal, frame.previewBottomOffset);
          }
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              releaseViewportReporting();
              if (
                disposed ||
                restoreIdRef.current !== frame.restoreId ||
                terminalRef.current !== terminal
              ) {
                return;
              }
              desiredBottomOffsetRef.current = frame.bottomOffset;
              setScrollBottomOffset(frame.bottomOffset);
              syncCandidateViewport();
              attachmentRef.current?.viewport(frame.runtimeId, frame.bottomOffset);
            });
          });
        });
        return;
      }

      if (frame.type === "pane.restore.full") {
        if (frame.restoreId !== restoreIdRef.current || frame.runtimeId !== runtimeIdRef.current) {
          return;
        }
        const preserved = preservedRestoreRef.current;
        preservedRestoreRef.current = null;
        if (preserved?.restoreId === frame.restoreId && preserved.runtimeId === frame.runtimeId) {
          const terminal = terminalRef.current;
          if (frame.sequence > preserved.sequence && terminal) {
            const targetBottomOffset = desiredBottomOffsetRef.current;
            const releaseViewportReporting = suppressViewportReporting();
            touchSelectionRef.current?.cancel();
            mountedRendererRef.current?.freezeFrame();
            incrementDatasetCount(host, "sameRuntimeRestoreCount");
            terminal.reset();
            terminal.write(frame.serializedState, () => {
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  releaseViewportReporting();
                  if (
                    disposed ||
                    restoreIdRef.current !== frame.restoreId ||
                    runtimeIdRef.current !== frame.runtimeId ||
                    terminalRef.current !== terminal
                  ) {
                    return;
                  }
                  desiredBottomOffsetRef.current = targetBottomOffset;
                  setScrollBottomOffset(targetBottomOffset);
                  scrollToBottomOffset(terminal, targetBottomOffset);
                  attachmentRef.current?.viewport(frame.runtimeId, targetBottomOffset);
                  setRestorePhase("ready");
                  revealTerminalFonts();
                  revealTerminalRestore();
                });
              });
            });
          } else {
            setRestorePhase("ready");
            revealTerminalFonts();
            revealTerminalRestore();
          }
          return;
        }
        disposeCandidate();
        const renderer = createTerminalRenderer(
          screenReaderModeRef.current,
          frame.cols,
          frame.rows,
        );
        const candidate: RestoreCandidate = {
          ...renderer,
          restoreId: frame.restoreId,
          runtimeId: frame.runtimeId,
          parsedSequence: frame.sequence - 1,
          ready: false,
          stagingHost: null,
          stagingResizeObserver: null,
          stagingFitScheduler: null,
        };
        restoreCandidateRef.current = candidate;
        desiredBottomOffsetRef.current = frame.bottomOffset;
        setScrollBottomOffset(frame.bottomOffset);
        setRestorePhase("hydrating");
        candidate.terminal.write(frame.serializedState, () => {
          if (disposed || restoreCandidateRef.current !== candidate) return;
          candidate.parsedSequence = frame.sequence;
          void ensureTerminalFontsLoaded().then(() => {
            if (disposed || restoreCandidateRef.current !== candidate) return;
            const stagingHost = document.createElement("div");
            stagingHost.className = "terminal-restore-staging";
            Object.assign(stagingHost.style, {
              position: "fixed",
              left: "-100000px",
              top: "0",
              visibility: "hidden",
              pointerEvents: "none",
            });
            const sizeStagingHost = (): void => {
              const displayedBounds = terminalRef.current?.element?.getBoundingClientRect();
              stagingHost.style.width = `${Math.max(1, displayedBounds?.width ?? host.clientWidth)}px`;
              stagingHost.style.height = `${Math.max(1, displayedBounds?.height ?? host.clientHeight)}px`;
            };
            sizeStagingHost();
            document.body.appendChild(stagingHost);
            candidate.stagingHost = stagingHost;
            candidate.terminal.open(stagingHost);
            candidate.stagingFitScheduler = createTerminalResizeScheduler(() => {
              if (disposed || restoreCandidateRef.current !== candidate) return;
              sizeStagingHost();
              try {
                if (controlAllowedRef.current) candidate.fit.fit();
                scrollToBottomOffset(candidate.terminal, desiredBottomOffsetRef.current);
              } catch {
                // The focused pane can briefly become unmeasurable during a view transition.
              }
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  if (disposed || restoreCandidateRef.current !== candidate) return;
                  scrollToBottomOffset(candidate.terminal, desiredBottomOffsetRef.current);
                  candidate.ready = true;
                  promoteCandidate();
                });
              });
            });
            candidate.stagingResizeObserver = new ResizeObserver(() => {
              if (disposed || restoreCandidateRef.current !== candidate) return;
              candidate.ready = false;
              candidate.stagingFitScheduler?.request();
            });
            candidate.stagingResizeObserver.observe(host);
            candidate.stagingFitScheduler?.request();
          });
        });
        return;
      }

      if (frame.type === "terminal.output") {
        if (frame.sequence <= latestSequenceRef.current) return;
        latestSequenceRef.current = frame.sequence;
        const displayedTerminal = terminalRef.current;
        const followLiveTail = desiredBottomOffsetRef.current === 0;
        displayedTerminal?.write(frame.data, () => {
          if (disposed || terminalRef.current !== displayedTerminal || !followLiveTail) {
            return;
          }
          desiredBottomOffsetRef.current = 0;
          setScrollBottomOffset(0);
          scrollToBottomOffset(displayedTerminal, 0);
          const currentRuntimeId = runtimeIdRef.current;
          if (currentRuntimeId) attachmentRef.current?.viewport(currentRuntimeId, 0);
        });
        const candidate = restoreCandidateRef.current;
        if (candidate) {
          candidate.terminal.write(frame.data, () => {
            if (disposed || restoreCandidateRef.current !== candidate) return;
            candidate.parsedSequence = frame.sequence;
            if (candidate.ready) {
              scrollToBottomOffset(candidate.terminal, desiredBottomOffsetRef.current);
            }
            promoteCandidate();
          });
        }
        return;
      }

      disposeCandidate();
      touchSelectionRef.current?.cancel();
      preservedRestoreRef.current = null;
      restoreIdRef.current = null;
      previewAnchorRef.current = null;
      setRuntimeStatus("exited");
    };

    host.addEventListener("keydown", leaveTerminalWithShiftTab, true);
    host.addEventListener("keyup", leaveTerminalWithShiftTab, true);
    host.addEventListener("input", handleLatchedInput, true);
    const paneSurface = host.closest<HTMLElement>(".pane-surface");
    paneSurface?.addEventListener("paste", handlePaste, true);
    const initialRenderer = createTerminalRenderer(screenReaderModeRef.current);
    mountedRendererRef.current = mountRenderer(initialRenderer);
    setTerminalInstanceId(initialRenderer.instanceId);
    concealTerminalRestore();
    if (loadedTerminalFontState === "true") {
      host.dataset.terminalFontsReady = "true";
    } else {
      host.dataset.terminalFontsReady = "false";
      void ensureTerminalFontsLoaded().then((loaded) => {
        if (disposed) return;
        loadedTerminalFontState = loaded ? "true" : "fallback";
        const mounted = mountedRendererRef.current;
        mounted?.scheduleFit(true);
        fontSettleTimeout = setTimeout(() => {
          fontSettleTimeout = null;
          if (disposed) return;
          mountedRendererRef.current?.clearResizeFreeze();
          if (previewAnchorRef.current === null) revealTerminalFonts();
        }, 200);
        fontRevealTimeout = setTimeout(revealTerminalFonts, 2_000);
      });
    }

    return () => {
      disposed = true;
      detachMobileIme?.();
      mobileIme?.cancelPending();
      if (mobileImeRef.current === mobileIme) mobileImeRef.current = null;
      paneFrameHandlerRef.current = null;
      promoteRestoreRef.current = () => undefined;
      host.removeEventListener("keydown", leaveTerminalWithShiftTab, true);
      host.removeEventListener("keyup", leaveTerminalWithShiftTab, true);
      host.removeEventListener("input", handleLatchedInput, true);
      paneSurface?.removeEventListener("paste", handlePaste, true);
      clipboardBusyRef.current = false;
      if (clipboardImagePasteRef.current === pasteClipboardImage) {
        clipboardImagePasteRef.current = () => Promise.resolve(false);
      }
      disposeCandidate();
      preservedRestoreRef.current = null;
      mountedRendererRef.current?.dispose();
      mountedRendererRef.current = null;
      attachmentRef.current?.dispose();
      attachmentRef.current = null;
      terminalRef.current = null;
      if (fontRevealTimeout !== null) clearTimeout(fontRevealTimeout);
      fontRevealTimeout = null;
      if (fontSettleTimeout !== null) clearTimeout(fontSettleTimeout);
      fontSettleTimeout = null;
      delete host.dataset.terminalFontsReady;
      delete host.dataset.terminalRestoreReady;
    };
  }, [
    clearMobileModifiers,
    keyboardHelpId,
    pane.id,
    pane.kind,
    returnToLiveTail,
    sendTerminalData,
  ]);

  useLayoutEffect(() => {
    paneTitleRef.current = pane.title;
    terminalRef.current?.textarea?.setAttribute("aria-label", `${pane.title} 명령 입력`);
  }, [pane.title, terminalInstanceId]);

  useEffect(() => {
    if (!clipboardNotice || clipboardNotice.message.endsWith("중…")) return;
    const timeout = setTimeout(() => setClipboardNotice(null), 6_000);
    return () => clearTimeout(timeout);
  }, [clipboardNotice]);

  useEffect(() => {
    screenReaderModeRef.current = screenReaderMode;
    if (terminalRef.current) terminalRef.current.options.screenReaderMode = screenReaderMode;
    if (restoreCandidateRef.current) {
      restoreCandidateRef.current.terminal.options.screenReaderMode = screenReaderMode;
    }
  }, [screenReaderMode]);

  useEffect(() => {
    const updateVisibility = (): void => {
      setDocumentVisible(document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  useEffect(() => {
    const invalidateTransientFocus = (event: Event): void => {
      const intent = transientFocusIntentRef.current;
      if (intent && event.target !== intent.target) transientFocusIntentRef.current = null;
    };
    document.addEventListener("pointerdown", invalidateTransientFocus, true);
    document.addEventListener("focusin", invalidateTransientFocus, true);
    return () => {
      document.removeEventListener("pointerdown", invalidateTransientFocus, true);
      document.removeEventListener("focusin", invalidateTransientFocus, true);
    };
  }, []);

  useLayoutEffect(() => {
    const previous = previousConnectionStatusRef.current;
    previousConnectionStatusRef.current = connectionStatus;
    if (!connection || !active || runtimeIdRef.current === null) {
      transientFocusIntentRef.current = null;
      return;
    }
    if (transientConnection) {
      if (
        transientFocusIntentRef.current === null &&
        previous.state === "active" &&
        previous.surfaceRole === "controller" &&
        lastPaneControl?.role === "controller"
      ) {
        const terminal = terminalRef.current;
        const target =
          document.activeElement === terminal?.textarea
            ? terminal.textarea
            : document.activeElement === composeInputRef.current
              ? composeInputRef.current
              : undefined;
        if (terminal && target) {
          transientFocusIntentRef.current = {
            connection,
            runtimeId: runtimeIdRef.current,
            terminal,
            target,
          };
          if (hostRef.current) incrementDatasetCount(hostRef.current, "transientFocusCaptureCount");
        }
      }
      return;
    }

    const intent = transientFocusIntentRef.current;
    if (!intent) return;
    if (
      connectionStatus.state !== "active" ||
      connectionStatus.surfaceRole !== "controller" ||
      !mutationAllowed ||
      currentPaneControl?.role !== "controller"
    ) {
      if (
        connectionStatus.state === "revoked" ||
        connectionStatus.state === "authentication-required" ||
        connectionStatus.surfaceRole === "observer"
      ) {
        transientFocusIntentRef.current = null;
      }
      return;
    }
    if (
      intent.connection !== connection ||
      intent.runtimeId !== runtimeIdRef.current ||
      intent.terminal !== terminalRef.current ||
      !intent.target.isConnected ||
      !document.hasFocus()
    ) {
      transientFocusIntentRef.current = null;
      return;
    }
    if (document.activeElement === intent.target) {
      transientFocusIntentRef.current = null;
      return;
    }
    if (document.activeElement !== document.body && document.activeElement !== null) {
      transientFocusIntentRef.current = null;
      return;
    }
    requestAnimationFrame(() => {
      if (
        transientFocusIntentRef.current !== intent ||
        !active ||
        connectionRef.current !== intent.connection ||
        runtimeIdRef.current !== intent.runtimeId ||
        terminalRef.current !== intent.terminal ||
        !controlAllowedRef.current ||
        !intent.target.isConnected ||
        !document.hasFocus() ||
        (document.activeElement !== document.body && document.activeElement !== null)
      ) {
        return;
      }
      transientFocusIntentRef.current = null;
      intent.target.focus({ preventScroll: true });
      if (hostRef.current) incrementDatasetCount(hostRef.current, "transientFocusRestoreCount");
    });
  }, [
    active,
    connection,
    connectionStatus,
    controlsPane,
    currentPaneControl?.role,
    lastPaneControl?.role,
    mutationAllowed,
    runtimeId,
    transientConnection,
  ]);

  useEffect(() => {
    if (!connection) return;
    return connection.onPaneControl((frame) => {
      if (frame.type !== "pane.control.state" || frame.paneId !== pane.id) return;
      setPaneControlSource({ connection, paneId: pane.id, value: frame });
      controlAllowedRef.current = surfaceControllerRef.current && frame.role === "controller";
    });
  }, [connection, pane.id]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!connection || !terminal || runtimeStatus !== "running" || !terminalSubscriptionAllowed) {
      return;
    }
    const attachment = connection.attach(
      pane.id,
      Math.max(terminal.cols, 2),
      Math.max(terminal.rows, 1),
      (frame) => {
        paneFrameHandlerRef.current?.(frame);
      },
    );
    attachmentRef.current = attachment;
    const attachmentHost = hostRef.current;
    if (attachmentHost) incrementDatasetCount(attachmentHost, "attachmentCreateCount");
    return () => {
      const currentRuntimeId = runtimeIdRef.current;
      if (currentRuntimeId) {
        attachment.viewport(currentRuntimeId, desiredBottomOffsetRef.current);
      }
      attachment.dispose();
      if (attachmentHost) incrementDatasetCount(attachmentHost, "attachmentDisposeCount");
      mobileImeRef.current?.cancelPending();
      if (attachmentRef.current === attachment) attachmentRef.current = null;
    };
  }, [connection, pane.id, runtimeStatus, terminalSubscriptionAllowed]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.disableStdin = inputDisabled;
    }
    if (restoreCandidateRef.current) {
      restoreCandidateRef.current.terminal.options.disableStdin = inputDisabled;
    }
    if (inputDisabled) mobileImeRef.current?.cancelPending();
  }, [inputDisabled]);

  useEffect(() => {
    if (!active) touchSelectionRef.current?.cancel();
  }, [active]);

  const restart = async (): Promise<void> => {
    setBusy(true);
    try {
      await onRestart();
      setRuntimeStatus("running");
    } catch {
      setRuntimeStatus("error");
    } finally {
      setBusy(false);
    }
  };

  const startNewCodex = async (): Promise<void> => {
    setBusy(true);
    try {
      await onStartNewCodex();
      setRuntimeStatus("running");
    } catch {
      setRuntimeStatus("error");
    } finally {
      setBusy(false);
    }
  };

  const codexSessionId = pane.codexSessionId;
  const codexSessionResumable = pane.codexSessionResumable;
  const canResumeCodex = pane.kind === "codex" && codexSessionId !== null && codexSessionResumable;

  return (
    <section
      className={`${pane.kind}-pane pane-surface ${active ? "is-active" : ""}`}
      id={panelId}
      role={tabPanel ? "tabpanel" : "region"}
      aria-label={`${pane.title} ${pane.kind === "codex" ? "Codex" : "터미널"}`}
      tabIndex={-1}
      data-pane-id={pane.id}
      data-pane-kind={pane.kind}
      data-active={active}
      data-runtime-id={runtimeId ?? ""}
      data-restore-phase={restorePhase}
      data-terminal-instance-id={terminalInstanceId || ""}
      data-scroll-bottom-offset={scrollBottomOffset}
      data-control-role={controlsPane ? "controller" : "observer"}
      onPointerDown={onActivate}
      onFocusCapture={onFocus ?? onActivate}
      onBlurCapture={() => requestAnimationFrame(() => promoteRestoreRef.current())}
      onCompositionStartCapture={() => {
        composingRef.current = true;
      }}
      onCompositionEndCapture={() => {
        composingRef.current = false;
        requestAnimationFrame(() => promoteRestoreRef.current());
      }}
    >
      <header className="pane-toolbar">
        <div className="pane-identity">
          <span
            className={pane.kind === "codex" ? "codex-glyph" : "terminal-glyph"}
            aria-hidden="true"
          >
            {pane.kind === "codex" ? "✦" : ">_"}
          </span>
          <div>
            <strong>{pane.title}</strong>
            <span>{runtimeLabel(pane, runtimeId)}</span>
          </div>
        </div>
        <div className="pane-actions">
          <span
            className={`status-pill status-${runtimeStatus}`}
            role="status"
            aria-live="polite"
            aria-label={`${pane.title} 상태: ${statusLabel(runtimeStatus)}`}
          >
            <span aria-hidden="true" />
            {statusLabel(runtimeStatus)}
          </span>
          {!controlsPane && runtimeStatus === "running" && (
            <span className="terminal-control-state" role="status" aria-live="polite">
              {connectionStatus.surfaceRole === "observer" ? "보기 전용" : "외부 제어 중"}
            </span>
          )}
          {mutationAllowed && paneControl?.role === "observer" && runtimeStatus === "running" && (
            <button
              className="secondary-button compact pane-control-preempt"
              type="button"
              onClick={() => connection?.preemptPaneControl(pane.id)}
            >
              Pane 제어권 가져오기
            </button>
          )}
          {toolbarExtras}
          <button
            className="icon-button"
            type="button"
            onClick={() => void restart()}
            disabled={!mutationAllowed || busy || runtimeStatus === "running"}
            aria-label={`${pane.title} 재시작`}
          >
            ↻
          </button>
          <button
            className="icon-button danger-hover"
            type="button"
            onClick={(event) => {
              const trigger = event.currentTarget;
              void onClose().then((closed) => {
                if (!closed && trigger.isConnected) trigger.focus();
              });
            }}
            aria-label={`${pane.title} 닫기`}
            disabled={!mutationAllowed}
          >
            ×
          </button>
        </div>
      </header>
      <p id={keyboardHelpId} className="sr-only">
        터미널에서 Shift+Tab을 누르면 Pane 도구 모음으로 초점을 이동합니다. 모바일에서는 아래 Ctrl,
        Alt와 특수키 도구 및 한글 보조 입력을 사용할 수 있습니다. 출력을 길게 누르거나 선택 도구로
        범위를 지정한 뒤 복사하거나 클립보드 내용을 붙여넣을 수 있습니다.
      </p>
      <div
        className={`terminal-host ${controlsPane ? "is-controller" : "is-observer"}`}
        ref={hostRef}
        tabIndex={controlsPane ? undefined : 0}
        role={controlsPane ? undefined : "region"}
        aria-label={controlsPane ? undefined : `${pane.title} 보기 전용 터미널 출력`}
      />
      {touchSelectionActive && (
        <div
          className="terminal-selection-action-menu"
          role="toolbar"
          aria-label={`${pane.title} 출력 선택 도구`}
        >
          <button
            type="button"
            aria-label={`${pane.title} 선택한 출력 복사`}
            onClick={copySelectedOutput}
          >
            복사
          </button>
          <button
            type="button"
            aria-label={`${pane.title} 클립보드 붙여넣기`}
            onClick={pasteClipboardIntoTerminal}
            disabled={clipboardReadBusy}
          >
            붙여넣기
          </button>
          <button
            type="button"
            aria-label={`${pane.title} 출력 전체 선택`}
            onClick={() => touchSelectionRef.current?.selectAll()}
          >
            전체
          </button>
          <button
            type="button"
            aria-label={`${pane.title} 출력 선택 취소`}
            onClick={() => touchSelectionRef.current?.cancel()}
          >
            취소
          </button>
        </div>
      )}
      {clipboardNotice && (
        <div
          className={`terminal-clipboard-notice is-${clipboardNotice.kind}`}
          role={clipboardNotice.kind === "error" ? "alert" : "status"}
        >
          {clipboardNotice.message}
        </div>
      )}
      {composeOpen && (
        <form
          className="mobile-terminal-compose"
          aria-label={`${pane.title} 한글 보조 입력`}
          autoComplete="off"
          onSubmit={submitComposedText}
        >
          <label className="sr-only" htmlFor={composeInputId}>
            {pane.title} 터미널로 보낼 텍스트
          </label>
          <textarea
            id={composeInputId}
            ref={composeInputRef}
            rows={2}
            value={composeText}
            onChange={(event) => setComposeText(event.currentTarget.value)}
            placeholder="한글을 조합한 뒤 입력"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={inputDisabled}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
              requestAnimationFrame(() => promoteRestoreRef.current());
            }}
          />
          <button type="submit" disabled={inputDisabled || composeText.length === 0}>
            입력
          </button>
        </form>
      )}
      <div
        className="mobile-terminal-tools"
        role="toolbar"
        aria-label={`${pane.title} 모바일 터미널 키`}
      >
        <button
          type="button"
          className={touchSelectionActive ? "is-active" : ""}
          aria-pressed={touchSelectionActive}
          aria-label={`${pane.title} 출력 선택`}
          onClick={() => {
            if (touchSelectionActive) touchSelectionRef.current?.cancel();
            else touchSelectionRef.current?.enter();
          }}
        >
          선택
        </button>
        <button
          type="button"
          className={ctrlArmed ? "is-active" : ""}
          aria-pressed={ctrlArmed}
          aria-label={`${pane.title} Ctrl 다음 키와 조합`}
          disabled={inputDisabled}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            updateCtrlArmed(!ctrlArmedRef.current);
            terminalRef.current?.focus();
          }}
        >
          Ctrl
        </button>
        <button
          type="button"
          className={altArmed ? "is-active" : ""}
          aria-pressed={altArmed}
          aria-label={`${pane.title} Alt 다음 키와 조합`}
          disabled={inputDisabled}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            updateAltArmed(!altArmedRef.current);
            terminalRef.current?.focus();
          }}
        >
          Alt
        </button>
        <MobileKeyButton
          label={`${pane.title} Escape 키`}
          text="Esc"
          disabled={inputDisabled}
          onPress={() => sendSpecialKey("escape")}
        />
        <MobileKeyButton
          label={`${pane.title} Tab 키`}
          text="Tab"
          disabled={inputDisabled}
          onPress={() => sendSpecialKey("tab")}
        />
        <MobileKeyButton
          label={`${pane.title} 왼쪽 방향키`}
          text="←"
          disabled={inputDisabled}
          onPress={() => sendSpecialKey("arrow-left")}
        />
        <MobileKeyButton
          label={`${pane.title} 위쪽 방향키`}
          text="↑"
          disabled={inputDisabled}
          onPress={() => sendSpecialKey("arrow-up")}
        />
        <MobileKeyButton
          label={`${pane.title} 아래쪽 방향키`}
          text="↓"
          disabled={inputDisabled}
          onPress={() => sendSpecialKey("arrow-down")}
        />
        <MobileKeyButton
          label={`${pane.title} 오른쪽 방향키`}
          text="→"
          disabled={inputDisabled}
          onPress={() => sendSpecialKey("arrow-right")}
        />
        <MobileKeyButton
          label={`${pane.title} Enter 키`}
          text="Enter"
          disabled={inputDisabled}
          onPress={() => sendSpecialKey("enter")}
        />
        <button
          type="button"
          className={composeOpen ? "is-active compose-toggle" : "compose-toggle"}
          aria-expanded={composeOpen}
          aria-controls={composeOpen ? composeInputId : undefined}
          disabled={inputDisabled}
          onClick={toggleComposeInput}
        >
          한글 입력
        </button>
      </div>
      {runtimeStatus !== "running" && (
        <div className="terminal-overlay" role="status" aria-live="polite">
          <div className="overlay-icon" aria-hidden="true">
            ■
          </div>
          <strong>{overlayTitle(pane, runtimeStatus)}</strong>
          <span>{overlayMessage(pane, runtimeStatus, codexSessionId, codexSessionResumable)}</span>
          <div className="overlay-actions">
            <button
              className="primary-button compact"
              type="button"
              onClick={() =>
                void (pane.kind === "codex" && !canResumeCodex ? startNewCodex() : restart())
              }
              disabled={!mutationAllowed || busy}
            >
              {busy
                ? "시작 중…"
                : canResumeCodex
                  ? "Codex 작업 재개"
                  : pane.kind === "codex"
                    ? "새 Codex 시작"
                    : "터미널 다시 시작"}
            </button>
            {canResumeCodex && (
              <button
                className="secondary-button compact"
                type="button"
                onClick={() => void startNewCodex()}
                disabled={!mutationAllowed || busy}
              >
                새 Codex 시작
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function createTerminalRenderer(
  screenReaderMode: boolean,
  cols?: number,
  rows?: number,
): TerminalRenderer {
  const terminal = new Terminal({
    ...(cols === undefined ? {} : { cols }),
    ...(rows === undefined ? {} : { rows }),
    cursorBlink: true,
    cursorStyle: "bar",
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: TERMINAL_FONT_SIZE,
    lineHeight: TERMINAL_LINE_HEIGHT,
    scrollback: MAX_TERMINAL_SCROLLBACK_ROWS,
    macOptionIsMeta: true,
    rightClickSelectsWord: true,
    screenReaderMode,
    theme: {
      background: "#101316",
      foreground: "#e5e9ed",
      cursor: "#f28a55",
      cursorAccent: "#101316",
      selectionBackground: "#31546e99",
      black: "#1c2227",
      red: "#f07178",
      green: "#9ccf7c",
      yellow: "#e6c384",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#c8d3dc",
      brightBlack: "#65727e",
      brightRed: "#ff8b92",
      brightGreen: "#b7e39a",
      brightYellow: "#f2d59b",
      brightBlue: "#9ab8ff",
      brightMagenta: "#d2b7ff",
      brightCyan: "#a1defe",
      brightWhite: "#f5f7f9",
    },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  return { terminal, fit, instanceId: nextTerminalInstanceId++ };
}

interface TerminalResizeFreezeController {
  begin(): void;
  rendered(): void;
  dispose(): void;
}

function createTerminalResizeFreeze(
  host: HTMLDivElement,
  terminal: Terminal,
): TerminalResizeFreezeController {
  let overlay: HTMLElement | null = null;
  let settleTimeout: ReturnType<typeof setTimeout> | null = null;
  let maximumTimeout: ReturnType<typeof setTimeout> | null = null;

  const clear = (): void => {
    if (settleTimeout !== null) clearTimeout(settleTimeout);
    if (maximumTimeout !== null) clearTimeout(maximumTimeout);
    settleTimeout = null;
    maximumTimeout = null;
    overlay?.remove();
    overlay = null;
    delete host.dataset.resizeFrozen;
  };

  const rendered = (): void => {
    if (!overlay) return;
    if (settleTimeout !== null) clearTimeout(settleTimeout);
    settleTimeout = setTimeout(clear, 96);
  };

  return {
    begin: () => {
      if (overlay) {
        rendered();
        return;
      }
      const terminalElement = terminal.element;
      const screen = terminalElement?.querySelector<HTMLElement>(".xterm-screen");
      if (!terminalElement || !screen) return;
      const hostBounds = host.getBoundingClientRect();
      const screenBounds = screen.getBoundingClientRect();
      overlay = terminalElement.cloneNode(false) as HTMLElement;
      overlay.classList.add("terminal-resize-freeze");
      overlay.appendChild(screen.cloneNode(true));
      for (const interactive of overlay.querySelectorAll(
        "textarea, input, button, select, [contenteditable]",
      )) {
        interactive.remove();
      }
      for (const rows of overlay.querySelectorAll<HTMLElement>(".xterm-rows")) {
        rows.classList.add("terminal-resize-freeze-rows");
      }
      overlay.setAttribute("aria-hidden", "true");
      overlay.inert = true;
      Object.assign(overlay.style, {
        left: `${screenBounds.left - hostBounds.left}px`,
        top: `${screenBounds.top - hostBounds.top}px`,
        width: `${screenBounds.width}px`,
        height: `${screenBounds.height}px`,
      });
      host.appendChild(overlay);
      host.dataset.resizeFrozen = "true";
      maximumTimeout = setTimeout(clear, 500);
    },
    rendered,
    dispose: clear,
  };
}

function terminalHostGeometry(host: HTMLElement): { width: number; height: number } {
  const bounds = host.getBoundingClientRect();
  return {
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  };
}

function terminalDimensions(terminal: Terminal): { cols: number; rows: number } {
  return {
    cols: Math.max(terminal.cols, 2),
    rows: Math.max(terminal.rows, 1),
  };
}

function incrementDatasetCount(host: HTMLElement, key: string): void {
  const current = Number(host.dataset[key] ?? "0");
  host.dataset[key] = String(Math.min(Number.MAX_SAFE_INTEGER, current + 1));
}

function publishTerminalDimensions(host: HTMLElement, terminal: Terminal): void {
  host.dataset.terminalCols = String(Math.max(terminal.cols, 2));
  host.dataset.terminalRows = String(Math.max(terminal.rows, 1));
}

function terminalBottomOffset(terminal: Terminal): number {
  const buffer = terminal.buffer.active;
  if (buffer.type === "alternate") return 0;
  return clampRestoreBottomOffset(buffer.baseY - buffer.viewportY);
}

function scrollToBottomOffset(terminal: Terminal, bottomOffset: number): void {
  const buffer = terminal.buffer.active;
  if (buffer.type === "alternate") return;
  const targetOffset = Math.min(buffer.baseY, clampRestoreBottomOffset(bottomOffset));
  if (targetOffset === 0 && buffer.baseY === buffer.viewportY) return;
  if (targetOffset === 0) {
    terminal.scrollToBottom();
    return;
  }
  terminal.scrollToLine(buffer.baseY - targetOffset);
  // xterm's DOM scrollbar converts line positions through fractional cell pixels. Correct the
  // occasional one-line rounding error (and an unsynchronised freshly opened viewport) from the
  // public buffer coordinates without reaching into xterm internals.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const actualOffset = buffer.baseY - buffer.viewportY;
    const correction = actualOffset - targetOffset;
    if (correction === 0) break;
    terminal.scrollLines(correction);
  }
}

function clampRestoreBottomOffset(bottomOffset: number): number {
  return Math.min(MAX_TERMINAL_SCROLLBACK_ROWS, Math.max(0, Math.round(bottomOffset)));
}

function isTerminalInputFocused(
  terminal: Terminal | null,
  composeInput: HTMLTextAreaElement | null,
): boolean {
  const active = document.activeElement;
  return active === terminal?.textarea || active === composeInput;
}

function MobileKeyButton({
  label,
  text,
  disabled,
  onPress,
}: {
  label: string;
  text: string;
  disabled: boolean;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onPointerDown={(event) => event.preventDefault()}
      onClick={onPress}
    >
      {text}
    </button>
  );
}

function runtimeLabel(pane: Pane, runtimeId: string | null): string {
  const profile = profileLabel(pane.launchProfile);
  if (!runtimeId) return profile;
  return pane.kind === "codex"
    ? `${profile} · runtime ${runtimeId.slice(0, 8)}`
    : `runtime ${runtimeId.slice(0, 8)}`;
}

function profileLabel(profile: string): string {
  if (profile === "codex-main") return "sol · xhigh";
  if (profile === "codex-quick") return "luna · medium";
  if (profile === "shell") return "shell";
  return profile;
}

function overlayTitle(pane: Pane, status: PaneStatus): string {
  if (status === "error") {
    return pane.kind === "codex" ? "Codex를 시작하지 못했습니다" : "터미널을 시작하지 못했습니다";
  }
  return pane.kind === "codex" ? "Codex가 중지되었습니다" : "터미널이 중지되었습니다";
}

function overlayMessage(
  pane: Pane,
  status: PaneStatus,
  codexSessionId: string | null,
  codexSessionResumable: boolean,
): ReactNode {
  if (status === "error" && pane.lastErrorCode) return launchErrorMessage(pane.lastErrorCode);
  if (pane.kind === "codex") {
    if (codexSessionId && codexSessionResumable) {
      return "저장된 Codex session ID로 이전 작업을 다시 열 수 있습니다.";
    }
    if (codexSessionId) {
      return (
        <>
          session ID는 인식했지만 재개 가능한 기록은 아직 확인되지 않았습니다. 새 Codex를 시작하거나
          Dev Terminal에서 <code>codex resume</code>을 실행해 주세요.
        </>
      );
    }
    return (
      <>
        자동으로 확인할 수 있는 session ID가 없습니다. 이전 작업은 Dev Terminal에서{" "}
        <code>codex resume</code>을 실행해 선택해 주세요.
      </>
    );
  }
  return "서버 재시작 후에는 명시적으로 새 터미널을 시작해야 합니다.";
}

function launchErrorMessage(code: ErrorCode): ReactNode {
  switch (code) {
    case "CODEX_EXECUTABLE_MISSING":
      return "Mac mini에서 Codex CLI 설치 경로를 확인해 주세요.";
    case "CODEX_AUTH_REQUIRED":
      return (
        <>
          Mac mini에서 <code>codex login</code>을 완료한 뒤 다시 시작해 주세요.
        </>
      );
    case "CODEX_CONFIG_INVALID":
      return (
        <>
          Mac mini에서 <code>codex doctor</code>로 설정을 확인해 주세요.
        </>
      );
    case "PTY_SPAWN_FAILED":
      return "호스트 프로세스를 시작하지 못했습니다. 서버 환경과 실행 권한을 확인해 주세요.";
    default:
      return "실행 준비에 실패했습니다. 서버 상태를 확인한 뒤 다시 시도해 주세요.";
  }
}

function statusLabel(status: PaneStatus): string {
  switch (status) {
    case "running":
      return "실행 중";
    case "stopped":
      return "중지됨";
    case "exited":
      return "종료됨";
    case "error":
      return "오류";
    case "ready":
      return "준비됨";
  }
}

function clipboardImageFrom(clipboard: DataTransfer | null): File | null {
  if (!clipboard) return null;
  for (const item of clipboard.items) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const image = item.getAsFile();
      if (image) return image;
    }
  }
  for (const file of clipboard.files) {
    if (file.type.startsWith("image/")) return file;
  }
  return null;
}

function clipboardAdvertisesImage(clipboard: DataTransfer | null): boolean {
  if (!clipboard) return false;
  return (
    Array.from(clipboard.types).some((type) => type.startsWith("image/")) ||
    Array.from(clipboard.items).some(
      (item) => item.kind === "file" && item.type.startsWith("image/"),
    )
  );
}

async function prepareClipboardPng(image: Blob): Promise<Uint8Array> {
  if (image.type === "image/png") return boundedClipboardBytes(await image.arrayBuffer());
  if (!image.type.startsWith("image/")) throw new Error("클립보드 항목이 이미지가 아닙니다.");

  const bitmap = await createImageBitmap(image);
  try {
    if (
      bitmap.width === 0 ||
      bitmap.height === 0 ||
      bitmap.width > 8192 ||
      bitmap.height > 8192 ||
      bitmap.width * bitmap.height > 40_000_000
    ) {
      throw new Error("이미지 크기는 8192px 및 4천만 픽셀 이하여야 합니다.");
    }
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("이미지를 PNG로 변환할 수 없습니다.");
    context.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("이미지를 PNG로 변환할 수 없습니다."));
      }, "image/png");
    });
    return boundedClipboardBytes(await png.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

function boundedClipboardBytes(buffer: ArrayBuffer): Uint8Array {
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) {
    throw new Error("클립보드 이미지는 16 MiB 이하여야 합니다.");
  }
  return new Uint8Array(buffer);
}
