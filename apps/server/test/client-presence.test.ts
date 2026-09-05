import { describe, expect, it } from "vitest";
import {
  CLIENT_PRESENCE_HEARTBEAT_TTL_MS,
  ClientPresenceRegistry,
} from "../src/client-presence.js";

describe("ClientPresenceRegistry", () => {
  it("suppresses globally while either desktop or mobile is foreground and recently used", () => {
    const presence = new ClientPresenceRegistry();
    presence.observe("desktop", { visible: true, focused: true, interactionRevision: 1 }, 1_000);
    presence.observe("desktop", { visible: true, focused: true, interactionRevision: 1 }, 110_000);
    expect(presence.hasRecentlyActiveClient(2, 120_999)).toBe(true);
    expect(presence.hasRecentlyActiveClient(2, 121_000)).toBe(false);

    presence.observe("mobile", { visible: true, focused: true, interactionRevision: 1 }, 200_000);
    expect(presence.hasRecentlyActiveClient(2, 200_001)).toBe(true);
  });

  it("uses heartbeat freshness when an absent event or disconnect is lost", () => {
    const presence = new ClientPresenceRegistry();
    presence.observe("client", { visible: true, focused: true, interactionRevision: 1 }, 1_000);

    expect(presence.hasRecentlyActiveClient(60, 1_000 + CLIENT_PRESENCE_HEARTBEAT_TTL_MS)).toBe(
      true,
    );
    expect(presence.hasRecentlyActiveClient(60, 1_001 + CLIENT_PRESENCE_HEARTBEAT_TTL_MS)).toBe(
      false,
    );
  });

  it("immediately releases suppression for hidden, blurred, and disconnected clients", () => {
    const presence = new ClientPresenceRegistry();
    presence.observe("client", { visible: true, focused: true, interactionRevision: 1 }, 1_000);
    presence.observe("client", { visible: false, focused: false, interactionRevision: 1 }, 2_000);
    expect(presence.hasRecentlyActiveClient(2, 2_001)).toBe(false);

    presence.observe("client", { visible: true, focused: false, interactionRevision: 2 }, 3_000);
    expect(presence.hasRecentlyActiveClient(2, 3_001)).toBe(false);

    presence.remove("client");
    expect(presence.hasRecentlyActiveClient(2, 3_001)).toBe(false);
  });

  it("refreshes interaction time only for a new interaction revision or server-observed input", () => {
    const presence = new ClientPresenceRegistry();
    presence.observe("client", { visible: true, focused: true, interactionRevision: 1 }, 1_000);
    presence.observe("client", { visible: true, focused: true, interactionRevision: 1 }, 60_000);
    expect(presence.hasRecentlyActiveClient(1, 61_000)).toBe(false);

    presence.noteInteraction("client", 61_000);
    expect(presence.hasRecentlyActiveClient(1, 61_001)).toBe(true);

    presence.observe("client", { visible: true, focused: true, interactionRevision: 2 }, 70_000);
    expect(presence.hasRecentlyActiveClient(1, 70_001)).toBe(true);
  });
});
