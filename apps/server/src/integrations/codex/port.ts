import { relative, sep } from "node:path";
import type { IntegrationDescriptor, SessionView } from "@naru/contracts/durable-session/v0";
import {
  deriveIntegrationBootstrapKey,
  verifyIntegrationBootstrap,
} from "@naru/durable-session-integration";
import { z } from "zod";
import { readPrivateCredentialFile } from "@naru/durable-session-client/node";
import type { NaruRepository, PaneActivityChange, PaneContext } from "../../database.js";
import type { DurableHostConfig } from "../../durable-session-host-client.js";
import { CODEX_AGENT_LAUNCH_PROFILE, type PaneLaunchResolver } from "../../launch-profiles.js";
import type {
  CodexHookEvent,
  CodexIntegrationEventV1,
  CodexInteractionSnapshot,
} from "./events.js";
import { CodexRuntimeSemantics } from "./semantics.js";

export const NARU_CODEX_INTEGRATION_POLICY_REF = "naru-codex-v0" as const;
const FUTURE_BOOTSTRAP_SKEW_MS = 60_000;

const CodexDescriptorConfigSchema = z.strictObject({
  policyRef: z.literal(NARU_CODEX_INTEGRATION_POLICY_REF),
  bindingId: z.string().uuid(),
});

interface VerifiedCodexRuntime {
  readonly paneId: string;
  readonly hostSessionId: string;
  readonly runtimeId: string;
  readonly bindingId: string;
  readonly projectPath: string;
  readonly profileId: "codex-main" | "codex-quick";
  readonly recoverActiveTurn: boolean;
}

interface CodexRuntimeState extends VerifiedCodexRuntime {
  readonly semantics: CodexRuntimeSemantics;
  active: boolean;
  terminated: boolean;
  pendingEvents: CodexHookEvent[];
  pendingInteraction: CodexInteractionSnapshot | null;
}

export interface CodexLaunchPlan {
  readonly executable: string;
  readonly args: readonly string[];
  /** Managed Codex agents only: the relay's private runtime channel (never Codex's own env). */
  readonly environment?: Readonly<Record<string, string>>;
}

export interface NaruCodexIntegrationPort {
  descriptor(bindingId: string): IntegrationDescriptor;
  preflight(paneId: string): void;
  launch(bootstrap: string): CodexLaunchPlan;
  acceptHook(bootstrap: string, event: CodexHookEvent): boolean;
  acceptInteraction(bootstrap: string, snapshot: CodexInteractionSnapshot): boolean;
  bindRuntime(paneId: string, session: SessionView): void;
  observeInput(paneId: string, runtimeId: string, data: string): void;
  observeOutput(paneId: string, runtimeId: string, data: string): void;
  observeExit(paneId: string, runtimeId: string, exitCode: number | null): void;
  markStopping(paneId: string, runtimeId: string): void;
  cancelStopping(paneId: string, runtimeId: string): void;
  disposeRuntime(paneId: string, runtimeId: string): void;
  onActivity(listener: (change: PaneActivityChange) => void): () => void;
  onEvent(listener: (event: CodexIntegrationEventV1) => void): () => void;
}

export class NaruCodexIntegration implements NaruCodexIntegrationPort {
  readonly #bootstrapKey: Buffer;
  readonly #runtimes = new Map<string, CodexRuntimeState>();
  readonly #activityListeners = new Set<(change: PaneActivityChange) => void>();
  readonly #eventListeners = new Set<(event: CodexIntegrationEventV1) => void>();

  constructor(
    private readonly repository: NaruRepository,
    private readonly config: DurableHostConfig,
    private readonly launchProfiles: PaneLaunchResolver,
    private readonly now: () => number = Date.now,
  ) {
    this.#bootstrapKey = deriveIntegrationBootstrapKey(
      readPrivateCredentialFile(config.credentialFile),
    );
  }

  descriptor(bindingId: string): IntegrationDescriptor {
    return {
      kind: "codex",
      config: { policyRef: NARU_CODEX_INTEGRATION_POLICY_REF, bindingId },
    };
  }

  preflight(paneId: string): void {
    this.launchProfiles.resolve(this.#requireCodexPane(paneId));
  }

  launch(bootstrap: string): CodexLaunchPlan {
    const verified = this.#verify(bootstrap, "launch");
    const context = this.#requireCodexPane(verified.paneId);
    const command = this.launchProfiles.resolve(context);
    if (
      !this.repository.claimIntegrationLaunch(
        verified.bindingId,
        verified.hostSessionId,
        verified.runtimeId,
      )
    ) {
      throw new Error("Codex integration launch is stale or already consumed.");
    }
    const current = this.#runtimes.get(verified.paneId);
    const state =
      current !== undefined &&
      current.hostSessionId === verified.hostSessionId &&
      current.runtimeId === verified.runtimeId &&
      current.bindingId === verified.bindingId
        ? current
        : this.#state({ ...verified, recoverActiveTurn: false });
    this.#runtimes.set(verified.paneId, state);
    this.#emitEvent(state, {
      eventKind: "launch.requested",
      profileId: verified.profileId,
      recovery:
        context.pane.codexSessionResumable && context.pane.codexSessionId !== null
          ? "semantic-resume"
          : "new",
    });
    return {
      executable: command.file,
      args: [...command.args],
      ...(command.launcherEnvironment === undefined
        ? {}
        : { environment: { ...command.launcherEnvironment } }),
    };
  }

  acceptHook(bootstrap: string, event: CodexHookEvent): boolean {
    try {
      const verified = this.#verify(bootstrap, "hook");
      if (event.cwd !== verified.projectPath) return false;
      const state = this.#runtimes.get(verified.paneId) ?? this.#state(verified);
      if (
        state.hostSessionId !== verified.hostSessionId ||
        state.runtimeId !== verified.runtimeId ||
        state.bindingId !== verified.bindingId ||
        state.terminated
      ) {
        return false;
      }
      this.#runtimes.set(verified.paneId, state);
      if (!state.active) {
        if (state.pendingEvents.length >= 32) return false;
        state.pendingEvents.push(event);
        return true;
      }
      this.#applyHook(state, event);
      return true;
    } catch {
      return false;
    }
  }

  acceptInteraction(bootstrap: string, snapshot: CodexInteractionSnapshot): boolean {
    try {
      const verified = this.#verify(bootstrap, "hook");
      if (snapshot.cwd !== verified.projectPath) return false;
      const state = this.#runtimes.get(verified.paneId) ?? this.#state(verified);
      if (
        state.hostSessionId !== verified.hostSessionId ||
        state.runtimeId !== verified.runtimeId ||
        state.bindingId !== verified.bindingId ||
        state.terminated
      ) {
        return false;
      }
      this.#runtimes.set(verified.paneId, state);
      if (!state.active) {
        const pending = state.pendingInteraction;
        if (pending !== null && pending.streamId !== snapshot.streamId) return false;
        if (pending === null || snapshot.sequence > pending.sequence) {
          state.pendingInteraction = snapshot;
        }
        return true;
      }
      return state.semantics.acceptInteraction(snapshot);
    } catch {
      return false;
    }
  }

  bindRuntime(paneId: string, session: SessionView): void {
    if (session.runtimeId === null || session.lifecycle !== "running") return;
    const context = this.#requireCodexPane(paneId);
    const link = this.repository.getPaneSessionLink(paneId);
    if (
      link?.state !== "linked" ||
      link.sessionId !== session.sessionId ||
      link.integrationBindingId === null
    ) {
      return;
    }
    const verified: VerifiedCodexRuntime = {
      paneId,
      hostSessionId: session.sessionId,
      runtimeId: session.runtimeId,
      bindingId: link.integrationBindingId,
      projectPath: context.projectPath,
      profileId: requireCodexProfile(context.pane.launchProfile),
      recoverActiveTurn: link.integrationLaunchRuntimeId === session.runtimeId,
    };
    let state = this.#runtimes.get(paneId);
    if (
      state === undefined ||
      state.hostSessionId !== verified.hostSessionId ||
      state.runtimeId !== verified.runtimeId ||
      state.bindingId !== verified.bindingId
    ) {
      state = this.#state(verified);
      this.#runtimes.set(paneId, state);
    }
    const activity = context.pane.activity;
    if (activity.runtimeId !== session.runtimeId) {
      this.#emitActivity(this.repository.beginPaneRuntime(paneId, session.runtimeId));
    }
    const wasActive = state.active;
    state.active = true;
    if (!wasActive) this.#emitEvent(state, { eventKind: "runtime.bound" });
    const interaction = state.pendingInteraction;
    state.pendingInteraction = null;
    if (interaction !== null) state.semantics.acceptInteraction(interaction);
    const pending = state.pendingEvents.splice(0);
    for (const event of pending) this.#applyHook(state, event);
  }

  observeInput(paneId: string, runtimeId: string, data: string): void {
    const state = this.#current(paneId, runtimeId);
    state?.semantics.observeInput(data);
  }

  observeOutput(paneId: string, runtimeId: string, data: string): void {
    const state = this.#current(paneId, runtimeId);
    state?.semantics.observeOutput(data);
  }

  observeExit(paneId: string, runtimeId: string, exitCode: number | null): void {
    const state = this.#current(paneId, runtimeId);
    if (state === null) return;
    state.semantics.observeExit(exitCode);
    state.active = false;
    state.terminated = true;
  }

  markStopping(paneId: string, runtimeId: string): void {
    const state = this.#current(paneId, runtimeId);
    state?.semantics.markStopping();
  }

  cancelStopping(paneId: string, runtimeId: string): void {
    const state = this.#current(paneId, runtimeId);
    state?.semantics.cancelStopping();
  }

  disposeRuntime(paneId: string, runtimeId: string): void {
    const state = this.#runtimes.get(paneId);
    if (state?.runtimeId === runtimeId) this.#runtimes.delete(paneId);
  }

  onActivity(listener: (change: PaneActivityChange) => void): () => void {
    this.#activityListeners.add(listener);
    return () => this.#activityListeners.delete(listener);
  }

  onEvent(listener: (event: CodexIntegrationEventV1) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  #verify(bootstrap: string, phase: "launch" | "hook"): VerifiedCodexRuntime {
    const claims = verifyIntegrationBootstrap(bootstrap, this.#bootstrapKey);
    if (
      claims.appId !== this.config.appId ||
      claims.subject !== this.config.subject ||
      claims.integration.kind !== "codex" ||
      claims.issuedAtMs > this.now() + FUTURE_BOOTSTRAP_SKEW_MS
    ) {
      throw new Error("Codex integration bootstrap binding mismatch.");
    }
    const descriptor = CodexDescriptorConfigSchema.parse(claims.integration.config);
    const link = this.repository.getPaneSessionLinkByIntegrationBinding(descriptor.bindingId);
    if (link === undefined) throw new Error("Codex integration binding is unavailable.");
    const context = this.#requireCodexPane(link.paneId);
    const profileId = requireCodexProfile(context.pane.launchProfile);
    if (claims.profileId !== profileId || !this.#cwdMatches(context, claims.cwd)) {
      throw new Error("Codex integration launch context mismatch.");
    }
    const state = this.#runtimes.get(link.paneId);
    const pendingMatches =
      phase === "launch" &&
      link.state === "pending" &&
      (link.pendingOperation === "create" || link.pendingOperation === "start") &&
      (link.sessionId === null || link.sessionId === claims.sessionId);
    const linkedLaunchMatches =
      phase === "launch" &&
      link.state === "linked" &&
      link.sessionId === claims.sessionId &&
      context.pane.status === "running";
    const currentMatches =
      phase === "hook" &&
      link.state === "linked" &&
      link.sessionId === claims.sessionId &&
      context.pane.status === "running" &&
      context.pane.activity.runtimeId === claims.runtimeId;
    const preparedHookMatches =
      phase === "hook" &&
      state !== undefined &&
      state.hostSessionId === claims.sessionId &&
      state.runtimeId === claims.runtimeId &&
      state.bindingId === descriptor.bindingId;
    if (!pendingMatches && !linkedLaunchMatches && !currentMatches && !preparedHookMatches) {
      throw new Error("Codex integration runtime is stale.");
    }
    return {
      paneId: link.paneId,
      hostSessionId: claims.sessionId,
      runtimeId: claims.runtimeId,
      bindingId: descriptor.bindingId,
      projectPath: context.projectPath,
      profileId,
      recoverActiveTurn: link.integrationLaunchRuntimeId === claims.runtimeId,
    };
  }

  #cwdMatches(context: PaneContext, cwd: { rootId: string; relativePath: string }): boolean {
    const root = this.config.roots.find((candidate) => candidate.rootId === cwd.rootId);
    if (root === undefined) return false;
    return relative(root.path, context.projectPath).split(sep).join("/") === cwd.relativePath;
  }

  #requireCodexPane(paneId: string): PaneContext {
    const context = this.repository.getPaneContext(paneId);
    if (context === undefined || context.pane.kind !== "codex") {
      throw new Error("Codex integration Pane is unavailable.");
    }
    return context;
  }

  #state(verified: VerifiedCodexRuntime): CodexRuntimeState {
    const stateReference: { current: CodexRuntimeState | null } = { current: null };
    const semantics = new CodexRuntimeSemantics({
      repository: this.repository,
      paneId: verified.paneId,
      runtimeId: verified.runtimeId,
      now: this.now,
      recoverActiveTurn: verified.recoverActiveTurn,
      emitActivity: (change) => this.#emitActivity(change),
      onSession: (event) => {
        const state = stateReference.current;
        if (state === null) return;
        if (event.sessionId === null) {
          this.#emitEvent(state, {
            eventKind: "session.cleared",
            source: event.source,
          });
          return;
        }
        this.#emitEvent(state, {
          eventKind: "session.identified",
          codexSessionId: event.sessionId,
          resumable: event.resumable,
          source: event.source,
        });
      },
      onActivity: (activity) => {
        const state = stateReference.current;
        if (state === null) return;
        this.#emitEvent(state, { eventKind: "activity.changed", state: activity });
      },
    });
    const state = {
      ...verified,
      semantics,
      active: false,
      terminated: false,
      pendingEvents: [],
      pendingInteraction: null,
    };
    stateReference.current = state;
    return state;
  }

  #current(paneId: string, runtimeId: string): CodexRuntimeState | null {
    const state = this.#runtimes.get(paneId);
    return state?.active === true && state.runtimeId === runtimeId ? state : null;
  }

  #applyHook(state: CodexRuntimeState, event: CodexHookEvent): void {
    state.semantics.acceptHook(event);
  }

  #emitActivity(change: PaneActivityChange): void {
    for (const listener of this.#activityListeners) listener(change);
  }

  #emitEvent(
    state: CodexRuntimeState,
    event:
      | { readonly eventKind: "runtime.bound" }
      | {
          readonly eventKind: "launch.requested";
          readonly profileId: "codex-main" | "codex-quick";
          readonly recovery: "new" | "semantic-resume";
        }
      | {
          readonly eventKind: "session.identified";
          readonly codexSessionId: string;
          readonly source: "startup" | "resume" | "clear" | "status" | "exit-hint" | "relay";
          readonly resumable: boolean;
        }
      | {
          readonly eventKind: "session.cleared";
          readonly source: "transition";
        }
      | {
          readonly eventKind: "activity.changed";
          readonly state:
            | "idle"
            | "running"
            | "interaction-required"
            | "completed"
            | "canceled"
            | "server-stopped"
            | "failed";
        },
  ): void {
    const output = {
      version: 1,
      integrationKind: "codex",
      paneId: state.paneId,
      hostSessionId: state.hostSessionId,
      runtimeId: state.runtimeId,
      occurredAtMs: this.now(),
      ...event,
    } as CodexIntegrationEventV1;
    for (const listener of this.#eventListeners) listener(output);
  }
}

function requireCodexProfile(profileId: string): "codex-main" | "codex-quick" {
  if (profileId === "codex-main" || profileId === "codex-quick") return profileId;
  // A Naru-managed Codex agent runs under the Host's codex-main profile (AP-T13).
  if (profileId === CODEX_AGENT_LAUNCH_PROFILE) return "codex-main";
  throw new Error("Codex integration profile is unavailable.");
}
