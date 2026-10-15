import { relative, sep } from "node:path";
import type { IntegrationDescriptor, SessionView } from "@naru/contracts/durable-session/v0";
import {
  deriveIntegrationBootstrapKey,
  verifyIntegrationBootstrap,
} from "@naru/durable-session-integration";
import { readPrivateCredentialFile } from "@naru/durable-session-client/node";
import { z } from "zod";
import type { ClaudeActivityEvent } from "../../claude-activity-events.js";
import { ClaudeActivitySemantics } from "../../claude-activity-semantics.js";
import type { NaruRepository, PaneActivityChange, PaneContext } from "../../database.js";
import type { DurableHostConfig } from "../../durable-session-host-client.js";
import type { PaneLaunchResolver } from "../../launch-profiles.js";

export const NARU_CLAUDE_INTEGRATION_POLICY_REF = "naru-claude-v0" as const;
const FUTURE_BOOTSTRAP_SKEW_MS = 60_000;

const DescriptorSchema = z.strictObject({
  policyRef: z.literal(NARU_CLAUDE_INTEGRATION_POLICY_REF),
  bindingId: z.string().uuid(),
});

interface VerifiedClaudeRuntime {
  readonly paneId: string;
  readonly hostSessionId: string;
  readonly runtimeId: string;
  readonly bindingId: string;
  readonly projectPath: string;
}

interface ClaudeRuntimeState extends VerifiedClaudeRuntime {
  readonly semantics: ClaudeActivitySemantics;
  active: boolean;
  terminated: boolean;
  pendingEvents: ClaudeActivityEvent[];
}

export interface ClaudeLaunchPlan {
  readonly executable: string;
  readonly args: readonly string[];
  /** Additions for the launched process (managed agent runner channel only). */
  readonly environment?: Readonly<Record<string, string>>;
}

export interface NaruClaudeIntegrationPort {
  descriptor(bindingId: string): IntegrationDescriptor;
  preflight(paneId: string): void;
  launch(bootstrap: string): ClaudeLaunchPlan;
  acceptHook(bootstrap: string, event: ClaudeActivityEvent): boolean;
  bindRuntime(paneId: string, session: SessionView): void;
  markStopping(paneId: string, runtimeId: string): void;
  cancelStopping(paneId: string, runtimeId: string): void;
  observeExit(paneId: string, runtimeId: string, exitCode: number | null): void;
  disposeRuntime(paneId: string, runtimeId: string): void;
  onActivity(listener: (change: PaneActivityChange) => void): () => void;
}

/** Naru-owned interpretation of a Host-signed, current Claude runtime. */
export class NaruClaudeIntegration implements NaruClaudeIntegrationPort {
  readonly #bootstrapKey: Buffer;
  readonly #runtimes = new Map<string, ClaudeRuntimeState>();
  readonly #activityListeners = new Set<(change: PaneActivityChange) => void>();

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
      kind: "claude",
      config: { policyRef: NARU_CLAUDE_INTEGRATION_POLICY_REF, bindingId },
    };
  }

  preflight(paneId: string): void {
    const context = this.#requireClaudePane(paneId);
    if (this.launchProfiles.preflight === undefined) this.launchProfiles.resolve(context);
    else this.launchProfiles.preflight(context);
  }

  launch(bootstrap: string): ClaudeLaunchPlan {
    const verified = this.#verify(bootstrap, "launch");
    const command = this.launchProfiles.resolve(this.#requireClaudePane(verified.paneId));
    if (
      !this.repository.claimIntegrationLaunch(
        verified.bindingId,
        verified.hostSessionId,
        verified.runtimeId,
      )
    ) {
      throw new Error("Claude integration launch is stale or already consumed.");
    }
    const current = this.#runtimes.get(verified.paneId);
    const state =
      current !== undefined &&
      current.hostSessionId === verified.hostSessionId &&
      current.runtimeId === verified.runtimeId &&
      current.bindingId === verified.bindingId
        ? current
        : this.#state(verified, false);
    this.#runtimes.set(verified.paneId, state);
    return {
      executable: command.file,
      args: [...command.args],
      ...(command.launcherEnvironment === undefined
        ? {}
        : { environment: { ...command.launcherEnvironment } }),
    };
  }

  acceptHook(bootstrap: string, event: ClaudeActivityEvent): boolean {
    try {
      const verified = this.#verify(bootstrap, "hook");
      if (event.cwd !== verified.projectPath) return false;
      const state = this.#runtimes.get(verified.paneId) ?? this.#state(verified, false);
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
      } else {
        state.semantics.accept(event);
      }
      return true;
    } catch {
      return false;
    }
  }

  bindRuntime(paneId: string, session: SessionView): void {
    if (session.runtimeId === null || session.lifecycle !== "running") return;
    const context = this.#requireClaudePane(paneId);
    const link = this.repository.getPaneSessionLink(paneId);
    if (
      link?.state !== "linked" ||
      link.sessionId !== session.sessionId ||
      link.integrationBindingId === null
    ) {
      return;
    }
    const verified: VerifiedClaudeRuntime = {
      paneId,
      hostSessionId: session.sessionId,
      runtimeId: session.runtimeId,
      bindingId: link.integrationBindingId,
      projectPath: context.projectPath,
    };
    let state = this.#runtimes.get(paneId);
    if (
      state === undefined ||
      state.hostSessionId !== verified.hostSessionId ||
      state.runtimeId !== verified.runtimeId ||
      state.bindingId !== verified.bindingId
    ) {
      state = this.#state(
        verified,
        link.integrationLaunchRuntimeId === session.runtimeId &&
          context.pane.activity.runtimeId === session.runtimeId,
      );
      this.#runtimes.set(paneId, state);
    }
    if (context.pane.activity.runtimeId !== session.runtimeId) {
      this.#emitActivity(this.repository.beginPaneRuntime(paneId, session.runtimeId));
    }
    state.active = true;
    for (const event of state.pendingEvents.splice(0)) state.semantics.accept(event);
  }

  markStopping(paneId: string, runtimeId: string): void {
    this.#current(paneId, runtimeId)?.semantics.markStopping();
  }

  cancelStopping(paneId: string, runtimeId: string): void {
    this.#current(paneId, runtimeId)?.semantics.cancelStopping();
  }

  observeExit(paneId: string, runtimeId: string, exitCode: number | null): void {
    const state = this.#current(paneId, runtimeId);
    if (state === null) return;
    state.semantics.observeExit(exitCode);
    state.terminated = true;
    state.active = false;
  }

  disposeRuntime(paneId: string, runtimeId: string): void {
    const state = this.#runtimes.get(paneId);
    if (state?.runtimeId === runtimeId) this.#runtimes.delete(paneId);
  }

  onActivity(listener: (change: PaneActivityChange) => void): () => void {
    this.#activityListeners.add(listener);
    return () => this.#activityListeners.delete(listener);
  }

  #verify(bootstrap: string, phase: "launch" | "hook"): VerifiedClaudeRuntime {
    const claims = verifyIntegrationBootstrap(bootstrap, this.#bootstrapKey);
    if (
      claims.appId !== this.config.appId ||
      claims.subject !== this.config.subject ||
      claims.integration.kind !== "claude" ||
      claims.profileId !== "claude-code" ||
      claims.issuedAtMs > this.now() + FUTURE_BOOTSTRAP_SKEW_MS
    ) {
      throw new Error("Claude integration bootstrap binding mismatch.");
    }
    const descriptor = DescriptorSchema.parse(claims.integration.config);
    const link = this.repository.getPaneSessionLinkByIntegrationBinding(descriptor.bindingId);
    if (link === undefined) throw new Error("Claude integration binding is unavailable.");
    const context = this.#requireClaudePane(link.paneId);
    const root = this.config.roots.find((candidate) => candidate.rootId === claims.cwd.rootId);
    if (
      root === undefined ||
      relative(root.path, context.projectPath).split(sep).join("/") !== claims.cwd.relativePath
    ) {
      throw new Error("Claude integration cwd mismatch.");
    }
    const state = this.#runtimes.get(link.paneId);
    const pendingLaunch =
      phase === "launch" &&
      link.state === "pending" &&
      (link.pendingOperation === "create" || link.pendingOperation === "start") &&
      (link.sessionId === null || link.sessionId === claims.sessionId);
    const linkedLaunch =
      phase === "launch" &&
      link.state === "linked" &&
      link.sessionId === claims.sessionId &&
      context.pane.status === "running";
    const currentHook =
      phase === "hook" &&
      link.state === "linked" &&
      link.sessionId === claims.sessionId &&
      context.pane.status === "running" &&
      context.pane.activity.runtimeId === claims.runtimeId;
    const preparedHook =
      phase === "hook" &&
      state !== undefined &&
      state.hostSessionId === claims.sessionId &&
      state.runtimeId === claims.runtimeId &&
      state.bindingId === descriptor.bindingId;
    if (!pendingLaunch && !linkedLaunch && !currentHook && !preparedHook) {
      throw new Error("Claude integration runtime is stale.");
    }
    return {
      paneId: link.paneId,
      hostSessionId: claims.sessionId,
      runtimeId: claims.runtimeId,
      bindingId: descriptor.bindingId,
      projectPath: context.projectPath,
    };
  }

  #requireClaudePane(paneId: string): PaneContext {
    const context = this.repository.getPaneContext(paneId);
    if (context === undefined || context.pane.kind !== "claude") {
      throw new Error("Claude integration Pane is unavailable.");
    }
    return context;
  }

  #state(verified: VerifiedClaudeRuntime, recoverActiveTurn: boolean): ClaudeRuntimeState {
    return {
      ...verified,
      semantics: new ClaudeActivitySemantics({
        repository: this.repository,
        paneId: verified.paneId,
        runtimeId: verified.runtimeId,
        emitActivity: (change) => this.#emitActivity(change),
        recoverActiveTurn,
      }),
      active: false,
      terminated: false,
      pendingEvents: [],
    };
  }

  #current(paneId: string, runtimeId: string): ClaudeRuntimeState | null {
    const state = this.#runtimes.get(paneId);
    return state?.active === true && state.runtimeId === runtimeId ? state : null;
  }

  #emitActivity(change: PaneActivityChange): void {
    for (const listener of this.#activityListeners) listener(change);
  }
}
