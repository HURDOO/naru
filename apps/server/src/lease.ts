import type { LeaseAcquisition, SurfaceRole, SurfaceStateReason } from "@naru/contracts";

export interface SurfaceLeaseState {
  readonly connectionId: string;
  readonly generation: number;
  readonly role: SurfaceRole;
  readonly controllerPresent: boolean;
  readonly reason: SurfaceStateReason;
}

export interface LeaseOwner {
  readonly id: string;
  update(state: SurfaceLeaseState): void;
  revoke(reason: "replaced" | "expired" | "logout" | "server_shutdown"): void;
}

interface SurfaceMember {
  readonly owner: LeaseOwner;
  readonly clientId: string;
  lastSeenAt: number;
}

interface RecentClient {
  readonly clientId: string;
  readonly releasedAt: number;
}

export interface GrantedLease {
  readonly generation: number;
  readonly replacedClient: boolean;
  readonly acquisition: LeaseAcquisition;
  readonly state: SurfaceLeaseState;
}

/**
 * Instance-wide Naru control-surface coordinator.
 *
 * All connected browsers remain members. Exactly one member may be the controller, while every
 * other healthy member is an observer. The monotonically increasing generation fences terminal
 * traffic and HTTP workspace/lifecycle mutations after an explicit transfer.
 */
export class LeaseManager {
  readonly #members = new Map<LeaseOwner, SurfaceMember>();
  #controller: SurfaceMember | undefined;
  #recentClient: RecentClient | undefined;
  #generation = 0;

  constructor(private readonly timeoutMs = 35_000) {}

  acquire(owner: LeaseOwner, clientId: string, now = Date.now()): GrantedLease {
    const existing = this.#members.get(owner);
    if (existing !== undefined) {
      existing.lastSeenAt = now;
      const acquisition: LeaseAcquisition = this.#controller === existing ? "reconnect" : "initial";
      return {
        generation: this.#generation,
        replacedClient: false,
        acquisition,
        state: this.#state(owner, acquisition === "reconnect" ? "reconnect" : "conflict"),
      };
    }

    const member = { owner, clientId, lastSeenAt: now };
    this.#members.set(owner, member);
    if (this.#controller === undefined) {
      const acquisition: LeaseAcquisition =
        this.#recentClient?.clientId === clientId &&
        now - this.#recentClient.releasedAt < this.timeoutMs
          ? "reconnect"
          : "initial";
      this.#generation += 1;
      this.#controller = member;
      this.#recentClient = undefined;
      this.#broadcast(acquisition, owner);
      return {
        generation: this.#generation,
        replacedClient: false,
        acquisition,
        state: this.#state(owner, acquisition),
      };
    }

    return {
      generation: this.#generation,
      replacedClient: false,
      acquisition: "initial",
      state: this.#state(owner, "conflict"),
    };
  }

  acquireAvailable(
    owner: LeaseOwner,
    expectedGeneration: number,
    now = Date.now(),
  ): SurfaceLeaseState | undefined {
    const member = this.#members.get(owner);
    if (
      member === undefined ||
      this.#controller !== undefined ||
      this.#generation !== expectedGeneration
    ) {
      return undefined;
    }
    member.lastSeenAt = now;
    this.#generation += 1;
    this.#controller = member;
    this.#recentClient = undefined;
    this.#broadcast("acquired");
    return this.#state(owner, "acquired");
  }

  takeover(
    owner: LeaseOwner,
    expectedGeneration: number,
    now = Date.now(),
  ): SurfaceLeaseState | undefined {
    const member = this.#members.get(owner);
    if (member === undefined || this.#generation !== expectedGeneration) return undefined;
    member.lastSeenAt = now;
    if (this.#controller === member) return this.#state(owner, "acquired");
    if (this.#controller === undefined)
      return this.acquireAvailable(owner, expectedGeneration, now);
    this.#generation += 1;
    this.#controller = member;
    this.#recentClient = undefined;
    this.#broadcast("preempted");
    return this.#state(owner, "preempted");
  }

  /** Whether this connection is the controller now, whatever generation it last saw. */
  isController(owner: LeaseOwner): boolean {
    return this.#controller?.owner === owner;
  }

  /** Whether any of the person's devices currently holds the control surface. */
  hasController(): boolean {
    return this.#controller !== undefined;
  }

  isMember(owner: LeaseOwner, generation: number): boolean {
    return this.#members.has(owner) && this.#generation === generation;
  }

  isCurrent(owner: LeaseOwner, generation: number): boolean {
    return this.#controller?.owner === owner && this.#generation === generation;
  }

  isCurrentConnection(connectionId: string, generation: number): boolean {
    return this.#controller?.owner.id === connectionId && this.#generation === generation;
  }

  touch(owner: LeaseOwner, generation: number, now = Date.now()): boolean {
    const member = this.#members.get(owner);
    if (member === undefined || this.#generation !== generation) return false;
    member.lastSeenAt = now;
    return true;
  }

  release(owner: LeaseOwner, now = Date.now()): void {
    const member = this.#members.get(owner);
    if (member === undefined) return;
    this.#members.delete(owner);
    if (this.#controller !== member) return;
    this.#recentClient = { clientId: member.clientId, releasedAt: now };
    this.#controller = undefined;
    this.#generation += 1;
    this.#broadcast("released");
  }

  expire(now = Date.now()): void {
    const controller = this.#controller;
    if (controller === undefined || now - controller.lastSeenAt < this.timeoutMs) return;
    this.#members.delete(controller.owner);
    this.#controller = undefined;
    this.#recentClient = { clientId: controller.clientId, releasedAt: now };
    this.#generation += 1;
    this.#broadcast("expired");
    controller.owner.revoke("expired");
  }

  shutdown(): void {
    const owners = [...this.#members.keys()];
    this.#members.clear();
    this.#controller = undefined;
    this.#recentClient = undefined;
    for (const owner of owners) owner.revoke("server_shutdown");
  }

  #state(owner: LeaseOwner, reason: SurfaceStateReason): SurfaceLeaseState {
    return {
      connectionId: owner.id,
      generation: this.#generation,
      role: this.#controller?.owner === owner ? "controller" : "observer",
      controllerPresent: this.#controller !== undefined,
      reason,
    };
  }

  #broadcast(reason: SurfaceStateReason, excludedOwner?: LeaseOwner): void {
    for (const member of this.#members.values()) {
      if (member.owner === excludedOwner) continue;
      member.owner.update(this.#state(member.owner, reason));
    }
  }
}
