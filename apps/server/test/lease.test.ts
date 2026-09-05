import { describe, expect, it } from "vitest";
import { LeaseManager, type LeaseOwner, type SurfaceLeaseState } from "../src/lease.js";

describe("LeaseManager control surface", () => {
  it("keeps a healthy controller and opens a second browser as an observer", () => {
    const events: SurfaceEvent[] = [];
    const first = owner("11111111-1111-4111-8111-111111111111", events);
    const second = owner("22222222-2222-4222-8222-222222222222", events);
    const leases = new LeaseManager(100);

    expect(leases.acquire(first, "client-one", 0)).toMatchObject({
      generation: 1,
      replacedClient: false,
      acquisition: "initial",
      state: { role: "controller", controllerPresent: true },
    });
    expect(leases.acquire(second, "client-two", 10)).toMatchObject({
      generation: 1,
      replacedClient: false,
      state: { role: "observer", reason: "conflict", controllerPresent: true },
    });
    expect(events).toEqual([]);
    expect(leases.isCurrent(first, 1)).toBe(true);
    expect(leases.isCurrent(second, 1)).toBe(false);
    expect(leases.isMember(second, 1)).toBe(true);
  });

  it("changes role only after explicit takeover and fences the old generation", () => {
    const events: SurfaceEvent[] = [];
    const first = owner("11111111-1111-4111-8111-111111111111", events);
    const second = owner("22222222-2222-4222-8222-222222222222", events);
    const leases = new LeaseManager(100);
    leases.acquire(first, "client-one", 0);
    leases.acquire(second, "client-two", 10);

    expect(leases.takeover(second, 1, 20)).toMatchObject({
      generation: 2,
      role: "controller",
      reason: "preempted",
    });
    expect(
      events
        .filter(
          (event): event is Extract<SurfaceEvent, { state: SurfaceLeaseState }> => "state" in event,
        )
        .map(({ owner: id, state }) => ({ id, ...state })),
    ).toEqual([
      expect.objectContaining({ id: first.id, role: "observer", generation: 2 }),
      expect.objectContaining({ id: second.id, role: "controller", generation: 2 }),
    ]);
    expect(leases.isCurrent(first, 1)).toBe(false);
    expect(leases.isMember(first, 1)).toBe(false);
    expect(leases.isMember(first, 2)).toBe(true);
    expect(leases.isCurrent(second, 2)).toBe(true);
    expect(leases.takeover(first, 1, 30)).toBeUndefined();
  });

  it("does not treat a simultaneous socket with the same browser id as a reconnect", () => {
    const events: SurfaceEvent[] = [];
    const first = owner("11111111-1111-4111-8111-111111111111", events);
    const duplicate = owner("22222222-2222-4222-8222-222222222222", events);
    const leases = new LeaseManager(100);

    leases.acquire(first, "stable-browser", 0);
    expect(leases.acquire(duplicate, "stable-browser", 10)).toMatchObject({
      generation: 1,
      acquisition: "initial",
      state: { role: "observer", reason: "conflict" },
    });
  });

  it("publishes availability after release and lets only the latest generation acquire", () => {
    const events: SurfaceEvent[] = [];
    const first = owner("11111111-1111-4111-8111-111111111111", events);
    const second = owner("22222222-2222-4222-8222-222222222222", events);
    const leases = new LeaseManager(100);
    leases.acquire(first, "client-one", 0);
    leases.acquire(second, "client-two", 10);

    leases.release(first, 20);
    expect(events.at(-1)).toMatchObject({
      owner: second.id,
      state: { generation: 2, role: "observer", controllerPresent: false, reason: "released" },
    });
    expect(leases.acquireAvailable(second, 1, 30)).toBeUndefined();
    expect(leases.acquireAvailable(second, 2, 30)).toMatchObject({
      generation: 3,
      role: "controller",
      reason: "acquired",
    });
  });

  it("updates an existing observer when the released browser reconnects", () => {
    const events: SurfaceEvent[] = [];
    const first = owner("11111111-1111-4111-8111-111111111111", events);
    const observer = owner("22222222-2222-4222-8222-222222222222", events);
    const reconnected = owner("33333333-3333-4333-8333-333333333333", events);
    const leases = new LeaseManager(100);
    leases.acquire(first, "stable-browser", 0);
    leases.acquire(observer, "observer-browser", 10);
    leases.release(first, 20);
    events.length = 0;

    expect(leases.acquire(reconnected, "stable-browser", 30)).toMatchObject({
      generation: 3,
      acquisition: "reconnect",
      state: { role: "controller" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      owner: observer.id,
      state: {
        generation: 3,
        role: "observer",
        controllerPresent: true,
        reason: "reconnect",
      },
    });
  });

  it("expires only the stale controller and keeps observers connected", () => {
    const events: SurfaceEvent[] = [];
    const first = owner("11111111-1111-4111-8111-111111111111", events);
    const second = owner("22222222-2222-4222-8222-222222222222", events);
    const leases = new LeaseManager(100);
    leases.acquire(first, "client-one", 0);
    leases.acquire(second, "client-two", 10);
    leases.touch(second, 1, 90);

    leases.expire(100);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      owner: second.id,
      state: { controllerPresent: false, reason: "expired" },
    });
    expect(events[1]).toEqual({ owner: first.id, revoked: "expired" });
    expect(leases.isMember(second, 2)).toBe(true);
  });
});

type SurfaceEvent =
  { owner: string; state: SurfaceLeaseState } | { owner: string; revoked: string };

function owner(id: string, events: SurfaceEvent[]): LeaseOwner {
  return {
    id,
    update(state) {
      events.push({ owner: id, state });
    },
    revoke(reason) {
      events.push({ owner: id, revoked: reason });
    },
  };
}
