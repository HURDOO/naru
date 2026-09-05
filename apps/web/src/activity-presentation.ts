import type { PaneActivityState } from "@naru/contracts";

export const ACTIVITY_PRESENTATION: Record<PaneActivityState, { glyph: string; label: string }> = {
  "interaction-required": { glyph: "!", label: "입력 필요" },
  failed: { glyph: "×", label: "실패" },
  completed: { glyph: "✓", label: "완료" },
  canceled: { glyph: "−", label: "사용자 취소" },
  "server-stopped": { glyph: "■", label: "서버 중지" },
  running: { glyph: "…", label: "실행 중" },
  idle: { glyph: "○", label: "대기" },
};

export function activityLabel(state: PaneActivityState): string {
  return ACTIVITY_PRESENTATION[state].label;
}
