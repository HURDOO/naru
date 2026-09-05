import type { RuntimeId, SessionId } from "@naru/contracts/durable-session/v0";

export interface HostLogRecord {
  readonly level: "info" | "warn" | "error";
  readonly event:
    | "host.started"
    | "host.stopping"
    | "host.stopped"
    | "session.created"
    | "session.started"
    | "session.stopping"
    | "session.exited"
    | "session.forgotten"
    | "session.recovered"
    | "request.denied"
    | "runtime.spawn-failed"
    | "runtime.output-failed"
    | "runtime.kill-failed"
    | "metadata.failed"
    | "transport.error";
  readonly sessionId?: SessionId;
  readonly runtimeId?: RuntimeId;
  readonly code?: string;
  readonly diagnosticId?: string;
}

export interface HostLogger {
  write(record: HostLogRecord): void;
}

export class JsonStderrHostLogger implements HostLogger {
  write(record: HostLogRecord): void {
    process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`);
  }
}

export const silentHostLogger: HostLogger = { write: () => undefined };
