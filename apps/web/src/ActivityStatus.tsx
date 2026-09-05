import type { PaneActivityState } from "@naru/contracts";
import { ACTIVITY_PRESENTATION } from "./activity-presentation";

export function ActivityStatus({
  state,
  interactionRequiredCount = 0,
  showText = false,
  context,
  className = "",
}: {
  state: PaneActivityState;
  interactionRequiredCount?: number;
  showText?: boolean;
  context: string;
  className?: string;
}): React.JSX.Element {
  const presentation = ACTIVITY_PRESENTATION[state];
  const countText =
    state === "interaction-required" && interactionRequiredCount > 1
      ? ` ${interactionRequiredCount}개`
      : "";
  return (
    <span
      className={`activity-status activity-${state} ${className}`.trim()}
      role="img"
      aria-label={`${context}: ${presentation.label}${countText}`}
      title={`${presentation.label}${countText}`}
      data-activity-state={state}
    >
      <span className="activity-glyph" aria-hidden="true">
        {presentation.glyph}
      </span>
      {state === "interaction-required" && interactionRequiredCount > 1 && (
        <span className="activity-count" aria-hidden="true">
          {interactionRequiredCount}
        </span>
      )}
      {showText && <span className="activity-label">{presentation.label}</span>}
    </span>
  );
}
