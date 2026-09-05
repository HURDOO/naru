export type LogLevel = "info" | "warn" | "error";

export interface StructuredLogEntry extends Record<string, unknown> {
  timestamp: string;
  level: LogLevel;
  event: string;
}

export type StructuredLogSink = (entry: StructuredLogEntry) => void;

export type CounterName =
  | "httpErrors"
  | "loginFailures"
  | "loginRateLimited"
  | "loginSuccesses"
  | "ptyLaunchFailures"
  | "websocketTakeovers";

export interface OperationalMetrics {
  counters: Record<CounterName, number>;
  gauges: {
    activePtys: number;
    activeSessions: number;
    activeWebSockets: number;
  };
}

const REDACTED = "[Redacted]";
const SENSITIVE_KEYS = new Set([
  "authorization",
  "attestationobject",
  "authenticatordata",
  "challenge",
  "clientdatajson",
  "cookie",
  "credential",
  "credentialid",
  "csrf",
  "csrftoken",
  "data",
  "env",
  "environment",
  "input",
  "output",
  "password",
  "passwordhash",
  "publickey",
  "rawid",
  "response",
  "secret",
  "serializedstate",
  "sessionsecret",
  "signature",
  "terminaldata",
  "terminalinput",
  "terminaloutput",
  "token",
  "userhandle",
]);

export class Observability {
  readonly #counters: Record<CounterName, number> = {
    httpErrors: 0,
    loginFailures: 0,
    loginRateLimited: 0,
    loginSuccesses: 0,
    ptyLaunchFailures: 0,
    websocketTakeovers: 0,
  };

  constructor(private readonly sink: StructuredLogSink = () => undefined) {}

  increment(counter: CounterName): void {
    this.#counters[counter] += 1;
  }

  event(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    const sanitized = sanitizeLogFields(fields);
    this.sink({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...sanitized,
    });
  }

  metrics(gauges: OperationalMetrics["gauges"]): OperationalMetrics {
    return {
      counters: { ...this.#counters },
      gauges: { ...gauges },
    };
  }
}

export function sanitizeLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  return sanitizeRecord(fields, new WeakSet<object>());
}

export function safeErrorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { errorType: "UnknownError" };
  const fields: Record<string, unknown> = { errorType: error.name || "Error" };
  if ("code" in error && typeof error.code === "string") fields.errorCode = error.code;
  if ("statusCode" in error && typeof error.statusCode === "number") {
    fields.statusCode = error.statusCode;
  }
  return fields;
}

function sanitizeRecord(
  value: Record<string, unknown>,
  seen: WeakSet<object>,
): Record<string, unknown> {
  if (seen.has(value)) return { circular: "[Circular]" };
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) ? REDACTED : sanitizeValue(child, seen);
  }
  return result;
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === undefined
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return safeErrorFields(value);
  if (value instanceof Uint8Array) return `[Binary ${value.byteLength} bytes]`;
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value.map((child) => sanitizeValue(child, seen));
  }
  if (typeof value === "object") {
    return sanitizeRecord(value as Record<string, unknown>, seen);
  }
  return `[Unsupported ${typeof value}]`;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return SENSITIVE_KEYS.has(normalized);
}
