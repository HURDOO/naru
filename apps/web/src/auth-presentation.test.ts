import { describe, expect, it } from "vitest";
import { passkeyMessageFrom } from "./auth-presentation";

describe("passkeyMessageFrom", () => {
  it.each(["NotAllowedError", "AbortError"])(
    "turns %s browser cancellation into an actionable fallback message",
    (name) => {
      expect(passkeyMessageFrom(new DOMException("browser detail", name))).toBe(
        "패스키 요청이 취소되었거나 제한 시간 안에 완료되지 않았습니다.",
      );
    },
  );

  it("distinguishes an unsupported authenticator", () => {
    expect(passkeyMessageFrom(new DOMException("browser detail", "NotSupportedError"))).toBe(
      "이 기기에서는 해당 패스키를 사용할 수 없습니다.",
    );
  });
});
