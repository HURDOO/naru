import type { AgentTask } from "@naru/contracts/naru-agent/v1";

/**
 * Lays tasks out by dependency depth for the Project graph: a task sits one level after the
 * deepest task it depends on. Dependencies outside the list are ignored, and a dependency cycle
 * (Core rejects them, but the view must not hang) is cut where it closes.
 */
export function taskLevels(tasks: readonly AgentTask[]): AgentTask[][] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const levelOf = (task: AgentTask): number => {
    const known = depth.get(task.id);
    if (known !== undefined) return known;
    if (visiting.has(task.id)) return -1;
    visiting.add(task.id);
    let level = 0;
    for (const dependencyId of task.dependsOn) {
      const dependency = byId.get(dependencyId);
      if (dependency !== undefined) level = Math.max(level, levelOf(dependency) + 1);
    }
    visiting.delete(task.id);
    depth.set(task.id, level);
    return level;
  };
  const levels: AgentTask[][] = [];
  for (const task of tasks) {
    const level = levelOf(task);
    (levels[level] ??= []).push(task);
  }
  // Each level above 0 holds a dependency of the level after it, so the array has no holes.
  for (const level of levels) {
    level.sort(
      (left, right) =>
        right.priority - left.priority || left.createdAt.localeCompare(right.createdAt),
    );
  }
  return levels;
}
