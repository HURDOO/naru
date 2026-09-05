export function passkeyMessageFrom(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "AbortError") {
      return "패스키 요청이 취소되었거나 제한 시간 안에 완료되지 않았습니다.";
    }
    if (error.name === "InvalidStateError") return "이미 등록된 패스키입니다.";
    if (error.name === "NotSupportedError") {
      return "이 기기에서는 해당 패스키를 사용할 수 없습니다.";
    }
  }
  if (error instanceof Error) return error.message;
  return "요청을 처리하지 못했습니다.";
}
