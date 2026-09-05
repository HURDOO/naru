export class CliUsageError extends Error {
  readonly name = "CliUsageError";
  readonly code = "USAGE" as const;
}
