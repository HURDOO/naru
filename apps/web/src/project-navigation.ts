import type { ConnectedProjectTarget, ProjectGroup } from "@naru/contracts";

export type ProjectGroupEntryAction =
  | { kind: "open-target-picker"; focusProjectId: string }
  | { kind: "select-target"; projectId: string }
  | { kind: "none" };

export function resolveProjectGroupEntry(
  group: ProjectGroup,
  selectedProjectId: string | null,
  sidebarOpen: boolean,
): ProjectGroupEntryAction {
  const connectedTargets = group.targets.filter(
    (target): target is ConnectedProjectTarget => target.registration === "connected",
  );
  const preferredTarget =
    connectedTargets.find((target) => target.projectId === selectedProjectId) ??
    connectedTargets[0];

  if (!preferredTarget) return { kind: "none" };
  if (!sidebarOpen && connectedTargets.length >= 2) {
    return { kind: "open-target-picker", focusProjectId: preferredTarget.projectId };
  }
  return { kind: "select-target", projectId: preferredTarget.projectId };
}
