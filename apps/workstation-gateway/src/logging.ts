export interface GatewayLogRecord {
  readonly level: "info" | "warn" | "error";
  readonly event:
    | "gateway.started"
    | "gateway.stopping"
    | "gateway.stopped"
    | "auth.bootstrap-created"
    | "auth.registration-succeeded"
    | "auth.authentication-succeeded"
    | "auth.session-revoked"
    | "auth.request-denied"
    | "proxy.request-started"
    | "proxy.request-failed"
    | "proxy.websocket-closed"
    | "storage.failed";
  readonly appId?: string;
  readonly code?: string;
  readonly diagnosticId?: string;
}

export interface GatewayLogger {
  write(record: GatewayLogRecord): void;
}

export class JsonStderrGatewayLogger implements GatewayLogger {
  write(record: GatewayLogRecord): void {
    process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`);
  }
}

export const silentGatewayLogger: GatewayLogger = { write: () => undefined };
