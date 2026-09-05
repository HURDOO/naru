import { randomUUID } from "node:crypto";
import {
  DurableSessionClient,
  DurableSessionClientError,
  DurableSessionProtocolError,
  DurableSessionStreamProtocolError,
} from "@naru/durable-session-client";
import {
  readPrivateCredentialFile,
  UdsHttpDurableSessionTransport,
} from "@naru/durable-session-client/node";
import { parseCliArguments } from "./arguments.js";
import { callerContextForRequest } from "./caller-context.js";
import { executeCliCommand } from "./commands.js";
import { SESSION_CLI_HELP } from "./help.js";
import { runInteractiveSession, type InteractiveTerminalRuntime } from "./interactive-session.js";
import { createCliWriter } from "./output.js";
import { CliUsageError } from "./usage-error.js";

export interface SessionCliIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

export interface RunSessionCliOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly io?: SessionCliIo;
  readonly nowMs?: () => number;
  readonly requestId?: () => string;
  readonly idempotencyKey?: () => string;
  readonly signal?: AbortSignal;
  readonly interactiveRuntime?: InteractiveTerminalRuntime;
}

export async function runSessionCli(
  argv: readonly string[],
  options: RunSessionCliOptions = {},
): Promise<number> {
  const io = options.io ?? processIo;
  const jsonRequested = argv.includes("--json");
  let commandName: string | null = null;
  let writer = createCliWriter({ json: jsonRequested, ...io });
  try {
    const parsed = parseCliArguments(argv, options.environment ?? process.env);
    if (parsed.mode === "help") {
      io.stdout(SESSION_CLI_HELP);
      return 0;
    }
    commandName = parsed.command.name;
    writer = createCliWriter({ json: parsed.json, ...io });
    if (parsed.command.name === "attach" || parsed.command.name === "control") {
      if (parsed.json) {
        throw new CliUsageError(
          "attach/control are interactive; use watch --json for machine-readable events.",
        );
      }
      const credential = readPrivateCredentialFile(parsed.connection.credentialFile);
      const nowMs = options.nowMs ?? Date.now;
      await runInteractiveSession({
        command: parsed.command,
        connection: parsed.connection,
        credential,
        ...(options.interactiveRuntime === undefined
          ? {}
          : { runtime: options.interactiveRuntime }),
        nowMs,
        requestId: () => (options.requestId ?? randomUUID)(),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return 0;
    }
    const credential = readPrivateCredentialFile(parsed.connection.credentialFile);
    const nowMs = options.nowMs ?? Date.now;
    const client = new DurableSessionClient({
      transport: new UdsHttpDurableSessionTransport({
        socketPath: parsed.connection.socketPath,
        appId: parsed.connection.appId,
        credential,
      }),
      callerContext: (request) => callerContextForRequest(parsed.connection, request, nowMs()),
      requestId: () => (options.requestId ?? randomUUID)(),
    });
    await executeCliCommand({
      command: parsed.command,
      client,
      writer,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    });
    return 0;
  } catch (error) {
    const failure = normalizeCliFailure(error);
    writer.failure(commandName, failure.code, failure.message);
    return failure.exitCode;
  }
}

interface CliFailure {
  readonly code: string;
  readonly message: string;
  readonly exitCode: number;
}

function normalizeCliFailure(error: unknown): CliFailure {
  if (error instanceof CliUsageError) {
    return { code: error.code, message: error.message, exitCode: 2 };
  }
  if (
    error instanceof DurableSessionProtocolError ||
    error instanceof DurableSessionStreamProtocolError
  ) {
    return { code: error.code, message: error.message, exitCode: protocolExitCode(error.code) };
  }
  if (error instanceof DurableSessionClientError) {
    return { code: error.code, message: error.message, exitCode: clientExitCode(error.code) };
  }
  if (error instanceof Error && error.message === "ARBITRARY_EXEC_SPEC_INVALID") {
    return {
      code: "ARBITRARY_EXEC_SPEC_INVALID",
      message: "Arbitrary exec spec did not match public protocol v0.",
      exitCode: 2,
    };
  }
  return { code: "INTERNAL_ERROR", message: "Session CLI failed.", exitCode: 1 };
}

function protocolExitCode(code: DurableSessionProtocolError["code"]): number {
  switch (code) {
    case "CAPABILITY_REQUIRED":
    case "COMMAND_POLICY_DENIED":
    case "ROOT_BOUNDARY_VIOLATION":
      return 4;
    case "RUNTIME_STALE":
    case "SESSION_REVISION_STALE":
    case "CONTROL_HELD":
    case "CONTROL_GENERATION_STALE":
    case "CONTROL_REQUEST_NOT_FOUND":
    case "CONTROL_REQUEST_EXPIRED":
    case "CONTROL_OFFER_NOT_FOUND":
    case "ATTACHMENT_NOT_CONTROLLER":
    case "ATTACHMENT_RESUME_REJECTED":
      return 5;
    case "SESSION_NOT_FOUND":
    case "SESSION_NOT_RUNNING":
    case "SESSION_STATE_INVALID":
    case "ATTACHMENT_NOT_FOUND":
    case "SESSION_LIMIT_REACHED":
      return 6;
    case "RESYNC_REQUIRED":
      return 7;
    case "REQUEST_INVALID":
    case "PROTOCOL_VERSION_UNSUPPORTED":
      return 2;
    case "INTERNAL_ERROR":
      return 1;
  }
}

function clientExitCode(code: DurableSessionClientError["code"]): number {
  switch (code) {
    case "CLIENT_REQUEST_INVALID":
    case "CALLER_CONTEXT_INVALID":
    case "PROTOCOL_RESPONSE_MISMATCH":
      return 2;
    case "PRIVATE_ENDPOINT_INVALID":
    case "CREDENTIAL_FILE_INVALID":
    case "PRIVATE_INPUT_INVALID":
    case "TRANSPORT_UNAVAILABLE":
    case "TRANSPORT_TIMEOUT":
    case "TRANSPORT_RESPONSE_INVALID":
    case "STREAM_QUEUE_OVERFLOW":
      return 3;
    case "REQUEST_ABORTED":
      return 130;
  }
}

const processIo: SessionCliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};
