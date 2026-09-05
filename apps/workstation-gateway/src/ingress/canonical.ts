import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function digestValue(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function assertSha256Digest(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("Approved plan digest must be a lowercase SHA-256 value.");
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortJson(record[key])]),
  );
}
