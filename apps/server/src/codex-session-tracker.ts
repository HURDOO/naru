import { CodexSessionIdSchema } from "@naru/contracts";

const MAX_COMMAND_LENGTH = 128;
const MAX_CAPTURE_LENGTH = 64 * 1024;
const MAX_EXIT_CAPTURE_LENGTH = 8 * 1024;
const STATUS_CAPTURE_WINDOW_MS = 10_000;
const SESSION_TRANSITION_CAPTURE_WINDOW_MS = 10_000;
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const LABELED_SESSION_ID = new RegExp(
  `\\b(?:session|chat)(?:[\\s_-]*id)?\\b[\\s:|=\\-│]{1,32}(${UUID_PATTERN})`,
  "i",
);
const SESSION_ID_LABEL = /\b(?:session|chat)(?:[\s_-]*id)?\b[\s:|=\-│]/i;
const RESUME_SESSION_ID = new RegExp(
  `\\bto continue this session,\\s*run\\s+codex\\s+resume\\s+(${UUID_PATTERN})\\b`,
  "i",
);
const TRAILING_RESUME_SESSION_ID = new RegExp(
  `\\bto continue this session,\\s*run\\s+codex\\s+resume\\s+(${UUID_PATTERN})\\b\\s*$`,
  "i",
);
const NAMED_RESUME_SESSION_ID = new RegExp(
  `\\bto continue this session,\\s*run\\s+codex\\s+resume,\\s*then select[^\\r\\n]{0,256}\\((${UUID_PATTERN})\\)`,
  "i",
);
const TRAILING_NAMED_RESUME_SESSION_ID = new RegExp(
  `\\bto continue this session,\\s*run\\s+codex\\s+resume,\\s*then select[^\\r\\n]{0,256}\\((${UUID_PATTERN})\\)\\s*$`,
  "i",
);
const RESUME_HINT_LABEL = /\bto continue this session,\s*run\b/i;

interface CodexSessionTrackerOptions {
  now?: () => number;
  maxCaptureLength?: number;
  maxExitCaptureLength?: number;
  captureWindowMs?: number;
}

/**
 * Captures only identifiers from explicit Codex lifecycle surfaces: the labeled
 * `/status` row and the exact resume hint printed as Codex exits. `/new` and
 * `/resume` are session-identity transitions: Codex can print the previous
 * session's resume hint after switching, so that identifier is remembered only
 * to reject it as the current session.
 * Terminal content is kept in bounded memory and is never logged or persisted; only
 * a validated UUID is returned to callers.
 */
export class CodexSessionTracker {
  readonly #now: () => number;
  readonly #maxCaptureLength: number;
  readonly #maxExitCaptureLength: number;
  readonly #captureWindowMs: number;
  #command = "";
  #commandOverflowed = false;
  #armedAt: number | null = null;
  #output = "";
  #sawStatusLabel = false;
  #exitOutput = "";
  #sessionTransitionArmedAt: number | null = null;
  #sessionTransitionOutput = "";
  #sawSessionTransitionResumeHint = false;
  #previousSessionId: string | null = null;
  #exitCaptureBlockedBySessionTransition = false;

  constructor(options: CodexSessionTrackerOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxCaptureLength = options.maxCaptureLength ?? MAX_CAPTURE_LENGTH;
    this.#maxExitCaptureLength = options.maxExitCaptureLength ?? MAX_EXIT_CAPTURE_LENGTH;
    this.#captureWindowMs = options.captureWindowMs ?? STATUS_CAPTURE_WINDOW_MS;
  }

  /** Returns true when `/new` or `/resume` invalidates the pane's current session ID. */
  observeInput(data: string): boolean {
    let changedSessionIdentity = false;
    const input = data.replaceAll("\u001b[200~", "").replaceAll("\u001b[201~", "");
    for (const character of input) {
      if (character === "\r" || character === "\n") {
        const submittedSessionTransition = this.#submitCommand();
        changedSessionIdentity ||= submittedSessionTransition;
        continue;
      }
      if (character === "\b" || character === "\u007f") {
        if (!this.#commandOverflowed) this.#command = this.#command.slice(0, -1);
        continue;
      }
      if (character === "\u0015") {
        this.#command = "";
        this.#commandOverflowed = false;
        continue;
      }
      if (character < " " || character === "\u007f" || this.#commandOverflowed) continue;
      if (this.#command.length >= MAX_COMMAND_LENGTH) {
        this.#command = "";
        this.#commandOverflowed = true;
        continue;
      }
      this.#command += character;
    }
    return changedSessionIdentity;
  }

  observeOutput(data: string, currentScreen?: () => string): string | null {
    this.#rememberExitOutput(data);
    this.#observeSessionTransitionOutput(data, currentScreen);
    if (this.#armedAt === null) return null;
    if (this.#now() - this.#armedAt > this.#captureWindowMs) {
      this.#disarm();
      return null;
    }
    if (this.#output.length + data.length > this.#maxCaptureLength) {
      this.#disarm();
      return null;
    }

    this.#output += data;
    this.#sawStatusLabel ||= SESSION_ID_LABEL.test(stripTerminalControls(this.#output));
    const fromOutput = findLabeledSessionId(this.#output);
    if (fromOutput !== null) {
      this.#exitCaptureBlockedBySessionTransition = false;
      this.#disarmSessionTransition();
      this.#disarm();
      return fromOutput;
    }

    const fromScreen =
      this.#sawStatusLabel && currentScreen ? findLabeledSessionId(currentScreen()) : null;
    if (fromScreen !== null) {
      this.#exitCaptureBlockedBySessionTransition = false;
      this.#disarmSessionTransition();
      this.#disarm();
    }
    return fromScreen;
  }

  /** Returns the current session ID only when the process ended with Codex's exact resume hint. */
  observeExit(): string | null {
    const candidate = findTrailingResumeSessionId(this.#exitOutput);
    this.#exitOutput = "";
    if (
      this.#exitCaptureBlockedBySessionTransition ||
      candidate === null ||
      candidate === this.#previousSessionId
    ) {
      return null;
    }
    return candidate;
  }

  #submitCommand(): boolean {
    const command = this.#commandOverflowed ? "" : this.#command.trim();
    this.#command = "";
    this.#commandOverflowed = false;
    if (command === "/status") {
      this.#armedAt = this.#now();
      this.#output = "";
      this.#sawStatusLabel = false;
      return false;
    }
    if (/^\/(?:new|resume)(?:\s|$)/.test(command)) {
      this.#disarm();
      this.#sessionTransitionArmedAt = this.#now();
      this.#sessionTransitionOutput = "";
      this.#sawSessionTransitionResumeHint = false;
      this.#previousSessionId = null;
      this.#exitCaptureBlockedBySessionTransition = true;
      return true;
    } else if (command !== "") {
      this.#disarm();
    }
    return false;
  }

  #disarm(): void {
    this.#armedAt = null;
    this.#output = "";
    this.#sawStatusLabel = false;
  }

  #rememberExitOutput(data: string): void {
    this.#exitOutput = boundedTail(this.#exitOutput + data, this.#maxExitCaptureLength);
  }

  #observeSessionTransitionOutput(data: string, currentScreen?: () => string): void {
    if (this.#sessionTransitionArmedAt === null) return;
    if (this.#now() - this.#sessionTransitionArmedAt > SESSION_TRANSITION_CAPTURE_WINDOW_MS) {
      this.#disarmSessionTransition();
      return;
    }
    if (this.#sessionTransitionOutput.length + data.length > this.#maxCaptureLength) {
      this.#disarmSessionTransition();
      return;
    }

    this.#sessionTransitionOutput += data;
    this.#sawSessionTransitionResumeHint ||= RESUME_HINT_LABEL.test(
      stripTerminalControls(this.#sessionTransitionOutput),
    );
    const fromOutput = findResumeSessionId(this.#sessionTransitionOutput);
    const fromScreen =
      fromOutput === null && this.#sawSessionTransitionResumeHint && currentScreen
        ? findResumeSessionId(currentScreen())
        : null;
    const previousSessionId = fromOutput ?? fromScreen;
    if (previousSessionId === null) return;

    this.#previousSessionId = previousSessionId;
    this.#exitCaptureBlockedBySessionTransition = false;
    this.#exitOutput = "";
    this.#disarmSessionTransition();
  }

  #disarmSessionTransition(): void {
    this.#sessionTransitionArmedAt = null;
    this.#sessionTransitionOutput = "";
    this.#sawSessionTransitionResumeHint = false;
  }
}

function findLabeledSessionId(data: string): string | null {
  const match = stripTerminalControls(data).match(LABELED_SESSION_ID);
  const candidate = match?.[1];
  if (!candidate) return null;
  const parsed = CodexSessionIdSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function findResumeSessionId(data: string): string | null {
  const normalized = stripTerminalControls(data);
  return (
    parseSessionId(normalized.match(RESUME_SESSION_ID)?.[1]) ??
    parseSessionId(normalized.match(NAMED_RESUME_SESSION_ID)?.[1])
  );
}

function findTrailingResumeSessionId(data: string): string | null {
  const normalized = stripTerminalControls(data);
  return (
    parseSessionId(normalized.match(TRAILING_RESUME_SESSION_ID)?.[1]) ??
    parseSessionId(normalized.match(TRAILING_NAMED_RESUME_SESSION_ID)?.[1])
  );
}

function parseSessionId(candidate: string | undefined): string | null {
  if (!candidate) return null;
  const parsed = CodexSessionIdSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function boundedTail(data: string, maximumLength: number): string {
  return data.length <= maximumLength ? data : data.slice(-maximumLength);
}

function stripTerminalControls(data: string): string {
  /* eslint-disable no-control-regex -- These expressions intentionally remove terminal controls. */
  return data
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, " ")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, " ")
    .replace(/\u001b[()][0-2A-Z]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
  /* eslint-enable no-control-regex */
}
