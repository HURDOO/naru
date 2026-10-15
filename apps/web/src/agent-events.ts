import type { AgentEvent } from "@naru/contracts/naru-agent/v1";

/** Merges a new page of events into the view's window, oldest first, without duplicates. */
export function mergeEvents(
  current: readonly AgentEvent[],
  incoming: readonly AgentEvent[],
  cap: number,
): AgentEvent[] {
  if (incoming.length === 0) return current as AgentEvent[];
  const last = current.at(-1)?.seq ?? 0;
  const merged = [...current, ...incoming.filter((event) => event.seq > last)];
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

/** What one agent did or what happened to it: its own actions and events about it. */
export function agentEvents(events: readonly AgentEvent[], agentSessionId: string): AgentEvent[] {
  return events.filter(
    (event) =>
      event.subjectId === agentSessionId ||
      (event.actor.kind === "agent" && event.actor.agentSessionId === agentSessionId),
  );
}
