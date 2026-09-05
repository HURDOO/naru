import type { TerminalDescriptor } from "@naru/contracts/durable-session/v0";
import { CliUsageError } from "./usage-error.js";

export interface CliConnectionOptions {
  readonly socketPath: string;
  readonly appId: string;
  readonly credentialFile: string;
  readonly subject: string;
  readonly callerTtlMs: number;
}

export interface CliRunProfileCommand {
  readonly name: "run";
  readonly source: {
    readonly kind: "profile";
    readonly profileId: string;
    readonly rootId: string;
    readonly relativePath: string;
    readonly terminal: TerminalDescriptor;
  };
}

export interface CliRunExecCommand {
  readonly name: "run";
  readonly source: {
    readonly kind: "exec-file";
    readonly path: string;
  };
}

export type CliCommand =
  | CliRunProfileCommand
  | CliRunExecCommand
  | {
      readonly name: "list";
      readonly cursor?: string;
      readonly limit: number;
    }
  | {
      readonly name: "watch";
      readonly sessionId?: string;
      readonly afterEventId?: string;
      readonly limit: number;
      readonly timeoutMs: number;
      readonly once: boolean;
    }
  | {
      readonly name: "stop";
      readonly sessionId: string;
      readonly expectedSessionRevision: number;
      readonly expectedRuntimeId: string;
    }
  | { readonly name: "attach"; readonly sessionId: string }
  | { readonly name: "control"; readonly sessionId: string };

export interface ParsedCliInvocation {
  readonly mode: "execute";
  readonly json: boolean;
  readonly connection: CliConnectionOptions;
  readonly command: CliCommand;
}

export interface ParsedCliHelp {
  readonly mode: "help";
}

export function parseCliArguments(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): ParsedCliInvocation | ParsedCliHelp {
  const cursor = new ArgumentCursor(argv);
  let json = false;
  let socketPath = environment.DURABLE_SESSION_SOCKET_PATH;
  let appId = environment.DURABLE_SESSION_APP_ID;
  let credentialFile = environment.DURABLE_SESSION_CREDENTIAL_FILE;
  let subject = environment.DURABLE_SESSION_SUBJECT;
  let callerTtlMs = optionalPositiveInteger(environment.DURABLE_SESSION_CALLER_TTL_MS, 60_000);

  while (cursor.peek()?.startsWith("--") === true) {
    const option = cursor.take();
    switch (option) {
      case "--help":
        return { mode: "help" };
      case "--json":
        json = true;
        break;
      case "--socket":
        socketPath = cursor.valueFor(option);
        break;
      case "--app-id":
        appId = cursor.valueFor(option);
        break;
      case "--credential-file":
        credentialFile = cursor.valueFor(option);
        break;
      case "--subject":
        subject = cursor.valueFor(option);
        break;
      case "--caller-ttl-ms":
        callerTtlMs = positiveInteger(cursor.valueFor(option), option);
        break;
      default:
        throw new CliUsageError("Unknown global option. Run durable-session --help.");
    }
  }

  const commandName = cursor.take();
  if (commandName === undefined) throw new CliUsageError("A command is required.");
  const command = parseCommand(commandName, cursor);
  return {
    mode: "execute",
    json,
    connection: {
      socketPath: requiredConnectionValue(socketPath, "--socket"),
      appId: requiredConnectionValue(appId, "--app-id"),
      credentialFile: requiredConnectionValue(credentialFile, "--credential-file"),
      subject: requiredConnectionValue(subject, "--subject"),
      callerTtlMs,
    },
    command,
  };
}

function parseCommand(commandName: string, cursor: ArgumentCursor): CliCommand {
  switch (commandName) {
    case "run":
      return parseRun(cursor);
    case "list":
      return parseList(cursor);
    case "watch":
      return parseWatch(cursor);
    case "stop":
      return parseStop(cursor);
    case "attach":
    case "control": {
      const sessionId = cursor.positional("SESSION_ID");
      cursor.done();
      return { name: commandName, sessionId };
    }
    default:
      throw new CliUsageError("Unknown command. Run durable-session --help.");
  }
}

function parseRun(cursor: ArgumentCursor): CliRunProfileCommand | CliRunExecCommand {
  let profileId: string | undefined;
  let rootId: string | undefined;
  let relativePath = "";
  let cols = 80;
  let rows = 24;
  let term: string | undefined;
  let execFile: string | undefined;
  let allowArbitraryExec = false;
  while (cursor.peek() !== undefined) {
    const option = cursor.take();
    switch (option) {
      case "--profile":
        profileId = cursor.valueFor(option);
        break;
      case "--root":
        rootId = cursor.valueFor(option);
        break;
      case "--cwd":
        relativePath = cursor.valueFor(option);
        break;
      case "--cols":
        cols = positiveInteger(cursor.valueFor(option), option);
        break;
      case "--rows":
        rows = positiveInteger(cursor.valueFor(option), option);
        break;
      case "--term":
        term = cursor.valueFor(option);
        break;
      case "--exec-spec":
        execFile = cursor.valueFor(option);
        break;
      case "--allow-arbitrary-exec":
        allowArbitraryExec = true;
        break;
      default:
        throw new CliUsageError("Unknown run option. Run durable-session --help.");
    }
  }

  if (execFile !== undefined) {
    if (profileId !== undefined || rootId !== undefined) {
      throw new CliUsageError("Profile and arbitrary exec modes cannot be combined.");
    }
    if (!allowArbitraryExec) {
      throw new CliUsageError("Arbitrary exec requires --allow-arbitrary-exec.");
    }
    return { name: "run", source: { kind: "exec-file", path: execFile } };
  }
  if (allowArbitraryExec) {
    throw new CliUsageError("--allow-arbitrary-exec requires --exec-spec.");
  }
  if (profileId === undefined || rootId === undefined) {
    throw new CliUsageError("Profile run requires --profile and --root.");
  }
  return {
    name: "run",
    source: {
      kind: "profile",
      profileId,
      rootId,
      relativePath,
      terminal: { cols, rows, ...(term === undefined ? {} : { term }) },
    },
  };
}

function parseList(cursor: ArgumentCursor): Extract<CliCommand, { readonly name: "list" }> {
  let cursorValue: string | undefined;
  let limit = 100;
  while (cursor.peek() !== undefined) {
    const option = cursor.take();
    switch (option) {
      case "--cursor":
        cursorValue = cursor.valueFor(option);
        break;
      case "--limit":
        limit = positiveInteger(cursor.valueFor(option), option);
        break;
      default:
        throw new CliUsageError("Unknown list option. Run durable-session --help.");
    }
  }
  return { name: "list", limit, ...(cursorValue === undefined ? {} : { cursor: cursorValue }) };
}

function parseWatch(cursor: ArgumentCursor): Extract<CliCommand, { readonly name: "watch" }> {
  let sessionId: string | undefined;
  if (cursor.peek()?.startsWith("--") === false) sessionId = cursor.take();
  let afterEventId: string | undefined;
  let limit = 100;
  let timeoutMs = 30_000;
  let once = false;
  while (cursor.peek() !== undefined) {
    const option = cursor.take();
    switch (option) {
      case "--after":
        afterEventId = cursor.valueFor(option);
        break;
      case "--limit":
        limit = positiveInteger(cursor.valueFor(option), option);
        break;
      case "--timeout-ms":
        timeoutMs = positiveInteger(cursor.valueFor(option), option);
        break;
      case "--once":
        once = true;
        break;
      default:
        throw new CliUsageError("Unknown watch option. Run durable-session --help.");
    }
  }
  return {
    name: "watch",
    limit,
    timeoutMs,
    once,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(afterEventId === undefined ? {} : { afterEventId }),
  };
}

function parseStop(cursor: ArgumentCursor): Extract<CliCommand, { readonly name: "stop" }> {
  const sessionId = cursor.positional("SESSION_ID");
  let expectedSessionRevision: number | undefined;
  let expectedRuntimeId: string | undefined;
  while (cursor.peek() !== undefined) {
    const option = cursor.take();
    switch (option) {
      case "--revision":
        expectedSessionRevision = nonnegativeInteger(cursor.valueFor(option), option);
        break;
      case "--runtime":
        expectedRuntimeId = cursor.valueFor(option);
        break;
      default:
        throw new CliUsageError("Unknown stop option. Run durable-session --help.");
    }
  }
  if (expectedSessionRevision === undefined || expectedRuntimeId === undefined) {
    throw new CliUsageError("Stop requires --revision and --runtime fencing values.");
  }
  return { name: "stop", sessionId, expectedSessionRevision, expectedRuntimeId };
}

class ArgumentCursor {
  #index = 0;

  constructor(readonly values: readonly string[]) {}

  peek(): string | undefined {
    return this.values[this.#index];
  }

  take(): string | undefined {
    const value = this.peek();
    if (value !== undefined) this.#index += 1;
    return value;
  }

  valueFor(option: string): string {
    const value = this.take();
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(`${option} requires a value.`);
    }
    return value;
  }

  positional(label: string): string {
    const value = this.take();
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(`${label} is required.`);
    }
    return value;
  }

  done(): void {
    if (this.peek() !== undefined) throw new CliUsageError("Unexpected command argument.");
  }
}

function requiredConnectionValue(value: string | undefined, option: string): string {
  if (value === undefined || value.length === 0) {
    throw new CliUsageError(`${option} or its corresponding environment setting is required.`);
  }
  return value;
}

function positiveInteger(value: string, option: string): number {
  const parsed = nonnegativeInteger(value, option);
  if (parsed === 0) throw new CliUsageError(`${option} must be greater than zero.`);
  return parsed;
}

function nonnegativeInteger(value: string, option: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new CliUsageError(`${option} must be a nonnegative integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new CliUsageError(`${option} is outside the supported integer range.`);
  }
  return parsed;
}

function optionalPositiveInteger(value: string | undefined, fallback: number): number {
  return value === undefined ? fallback : positiveInteger(value, "DURABLE_SESSION_CALLER_TTL_MS");
}
