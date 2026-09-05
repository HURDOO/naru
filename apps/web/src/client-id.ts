interface ClientIdRandomSource {
  randomUUID?: () => string;
  fill(bytes: Uint8Array<ArrayBuffer>): void;
}

export function createClientId(source: ClientIdRandomSource = browserRandomSource()): string {
  if (source.randomUUID) return source.randomUUID();

  const bytes = new Uint8Array(new ArrayBuffer(16));
  source.fill(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function browserRandomSource(): ClientIdRandomSource {
  return {
    ...(typeof crypto.randomUUID === "function" ? { randomUUID: () => crypto.randomUUID() } : {}),
    fill(bytes) {
      crypto.getRandomValues(bytes);
    },
  };
}
