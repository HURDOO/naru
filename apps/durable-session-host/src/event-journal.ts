import type {
  DurableSessionCallerContext,
  DurableSessionJournalEvent,
  SessionId,
} from "@naru/contracts/durable-session/v0";
import { HostOperationError } from "./host-error.js";

export interface JournalReadResult {
  readonly events: readonly DurableSessionJournalEvent[];
  readonly cursor: string | null;
}

export class BoundedEventJournal {
  readonly #limit: number;
  readonly #events: DurableSessionJournalEvent[] = [];
  readonly #listeners = new Set<() => void>();

  constructor(limit: number) {
    this.#limit = limit;
  }

  append(event: DurableSessionJournalEvent): void {
    this.#events.push(event);
    while (this.#events.length > this.#limit) this.#events.shift();
    for (const listener of this.#listeners) queueMicrotask(listener);
  }

  read(
    caller: DurableSessionCallerContext,
    options: {
      readonly sessionId?: SessionId;
      readonly afterEventId?: string;
      readonly limit: number;
    },
  ): JournalReadResult {
    let start = 0;
    if (options.afterEventId !== undefined) {
      const index = this.#events.findIndex((event) => event.eventId === options.afterEventId);
      if (index < 0) {
        throw new HostOperationError(
          "RESYNC_REQUIRED",
          "Event cursor is outside the bounded journal.",
        );
      }
      start = index + 1;
    }

    const events = this.#events
      .slice(start)
      .filter((event) => this.#visibleTo(caller, event, options.sessionId))
      .slice(0, options.limit);
    return {
      events,
      cursor: events.at(-1)?.eventId ?? options.afterEventId ?? null,
    };
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #visibleTo(
    caller: DurableSessionCallerContext,
    event: DurableSessionJournalEvent,
    sessionId: SessionId | undefined,
  ): boolean {
    if (sessionId !== undefined && event.sessionId !== sessionId) return false;
    return caller.sessionScope.kind === "all" || caller.sessionScope.ids.includes(event.sessionId);
  }
}
