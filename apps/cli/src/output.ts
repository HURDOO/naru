import type {
  DurableSessionJournalEvent,
  DurableSessionOperationResult,
  SessionView,
} from "@naru/contracts/durable-session/v0";

export const SESSION_CLI_OUTPUT_VERSION = 1 as const;

export interface CliWriter {
  readonly json: boolean;
  success(command: string, result: DurableSessionOperationResult): void;
  failure(command: string | null, code: string, message: string): void;
}

export function createCliWriter(options: {
  readonly json: boolean;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}): CliWriter {
  return {
    json: options.json,
    success: (command, result) => {
      if (options.json) {
        options.stdout(
          `${JSON.stringify({
            version: SESSION_CLI_OUTPUT_VERSION,
            command,
            ok: true,
            result: safeResult(result),
          })}\n`,
        );
        return;
      }
      options.stdout(renderHumanSuccess(result));
    },
    failure: (command, code, message) => {
      if (options.json) {
        options.stdout(
          `${JSON.stringify({
            version: SESSION_CLI_OUTPUT_VERSION,
            command,
            ok: false,
            error: { code, message },
          })}\n`,
        );
        return;
      }
      options.stderr(`${code}: ${singleLine(message)}\n`);
    },
  };
}

function safeResult(result: DurableSessionOperationResult): unknown {
  switch (result.operation) {
    case "openAttachment":
    case "resumeAttachment": {
      const attachment = result.attachment;
      return {
        operation: result.operation,
        attachment: {
          sessionId: attachment.sessionId,
          attachmentId: attachment.attachmentId,
          runtimeId: attachment.runtimeId,
          role: attachment.role,
          controllerGeneration: attachment.controllerGeneration,
          resumeExpiresAtMs: attachment.resumeExpiresAtMs,
          appId: attachment.appId,
          subject: attachment.subject,
        },
      };
    }
    case "requestSnapshot":
    case "resyncAttachment": {
      const snapshot = result.snapshot;
      return {
        operation: result.operation,
        snapshot: {
          sessionId: snapshot.sessionId,
          attachmentId: snapshot.attachmentId,
          runtimeId: snapshot.runtimeId,
          sequence: snapshot.sequence,
          terminal: snapshot.terminal,
          terminalState: "redacted",
        },
      };
    }
    case "readEvents":
    case "waitForEvents":
      return { ...result, events: result.events.map(safeJournalEvent) };
    default:
      return result;
  }
}

function safeJournalEvent(event: DurableSessionJournalEvent): unknown {
  if (event.type !== "integration.event") return event;
  return { ...event, payload: "redacted" };
}

function renderHumanSuccess(result: DurableSessionOperationResult): string {
  switch (result.operation) {
    case "createSession":
      return `created ${renderSession(result.session)}\n`;
    case "listSessions":
      return result.sessions.length === 0
        ? "no sessions\n"
        : `${result.sessions.map(renderSession).join("\n")}\n`;
    case "stopSession":
      return `stopped ${renderSession(result.session)}\n`;
    case "waitForEvents":
    case "readEvents":
      return result.events.length === 0
        ? "no events\n"
        : `${result.events.map(renderEvent).join("\n")}\n`;
    default:
      return `${result.operation} ok\n`;
  }
}

function renderSession(session: SessionView): string {
  return [
    session.sessionId,
    session.lifecycle,
    `revision=${session.sessionRevision}`,
    `runtime=${session.runtimeId ?? "none"}`,
    `generation=${session.controllerGeneration}`,
  ].join(" ");
}

function renderEvent(event: DurableSessionJournalEvent): string {
  return `${event.eventId} ${event.sessionId} ${event.type}`;
}

function singleLine(value: string): string {
  return value.replaceAll(/[\r\n\t]+/g, " ").slice(0, 500);
}
