import type { ClientPresence } from "@naru/contracts";

export const CLIENT_PRESENCE_HEARTBEAT_TTL_MS = 35_000;

interface ClientPresenceState extends ClientPresence {
  lastHeartbeatAt: number;
  lastInteractionAt: number;
}

export class ClientPresenceRegistry {
  readonly #clients = new Map<string, ClientPresenceState>();

  observe(clientId: string, presence: ClientPresence, now = Date.now()): void {
    const previous = this.#clients.get(clientId);
    this.#clients.set(clientId, {
      ...presence,
      lastHeartbeatAt: now,
      lastInteractionAt:
        previous === undefined || previous.interactionRevision !== presence.interactionRevision
          ? now
          : previous.lastInteractionAt,
    });
  }

  noteInteraction(clientId: string, now = Date.now()): void {
    const presence = this.#clients.get(clientId);
    if (presence) presence.lastInteractionAt = now;
  }

  remove(clientId: string): void {
    this.#clients.delete(clientId);
  }

  hasRecentlyActiveClient(inactivityDelayMinutes: number, now = Date.now()): boolean {
    const inactivityDelayMs = inactivityDelayMinutes * 60_000;
    for (const presence of this.#clients.values()) {
      if (
        presence.visible &&
        presence.focused &&
        now - presence.lastHeartbeatAt <= CLIENT_PRESENCE_HEARTBEAT_TTL_MS &&
        now - presence.lastInteractionAt < inactivityDelayMs
      ) {
        return true;
      }
    }
    return false;
  }
}
