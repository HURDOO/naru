import { useSyncExternalStore } from "react";

/** Browser helpers shared by the agent screens (AP-D022). */

/** Enter sends, Shift+Enter breaks the line; never while a Korean IME is composing. */
export function submitOnEnter(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
  if (event.keyCode === 229) return;
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}

/** Grows a textarea with its content up to `maxRows`. */
export function autosize(element: HTMLTextAreaElement | null, maxRows = 8): void {
  if (element === null) return;
  element.style.height = "auto";
  const line = Number.parseFloat(getComputedStyle(element).lineHeight) || 22;
  element.style.height = `${Math.min(element.scrollHeight, line * maxRows + 4)}px`;
}

/** True while the viewport matches `query` (phone layouts switch structure, not only styles). */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", notify);
      return () => list.removeEventListener("change", notify);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export const PHONE = "(max-width: 600px)";
