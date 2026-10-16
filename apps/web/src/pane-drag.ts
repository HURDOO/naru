/** Dragging a Pane from the workspace list onto a workspace being edited (AP-D031). */
export const PANE_DRAG_TYPE = "application/x-naru-pane";

export function startPaneDrag(event: React.DragEvent, paneId: string): void {
  event.dataTransfer.setData(PANE_DRAG_TYPE, paneId);
  event.dataTransfer.effectAllowed = "copy";
}
