import { describe, expect, it, vi } from "vitest";
import { createClientId } from "./client-id";

describe("createClientId", () => {
  it("uses the secure-context randomUUID implementation when available", () => {
    const randomUUID = vi.fn(() => "11111111-1111-4111-8111-111111111111");
    const fill = vi.fn();

    expect(createClientId({ randomUUID, fill })).toBe("11111111-1111-4111-8111-111111111111");
    expect(randomUUID).toHaveBeenCalledOnce();
    expect(fill).not.toHaveBeenCalled();
  });

  it("creates an RFC 4122 version 4 ID from getRandomValues bytes on LAN HTTP", () => {
    const id = createClientId({
      fill(bytes) {
        bytes.fill(0);
      },
    });

    expect(id).toBe("00000000-0000-4000-8000-000000000000");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
