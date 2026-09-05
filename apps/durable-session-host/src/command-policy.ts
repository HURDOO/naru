import type { CommandSpecV0, RuntimeId, SessionId } from "@naru/contracts/durable-session/v0";
import { DURABLE_SESSION_LIMITS } from "@naru/contracts/durable-session/v0";
import {
  createIntegrationBootstrap,
  DURABLE_SESSION_INTEGRATION_BOOTSTRAP_ENV,
} from "@naru/durable-session-integration";
import type {
  DurableSessionHostConfig,
  HostEnvironmentPolicy,
  HostIntegrationPolicy,
  HostProfileConfig,
  HostResourcePolicy,
} from "./config.js";
import { HostOperationError } from "./host-error.js";
import type { ResolvedLaunchCommand } from "./runtime.js";
import { canonicalDirectory, canonicalExecutable, resolveInsideRoot } from "./security.js";

export type Restartability = "profile-reference" | "runtime-only";

const MAX_HOST_INTEGRATION_CONFIG_BYTES = 4 * 1024;

export type HostCommandResolutionContext =
  | {
      readonly mode: "validate";
      readonly appId: string;
    }
  | {
      readonly mode: "runtime";
      readonly appId: string;
      readonly subject: string;
      readonly sessionId: SessionId;
      readonly runtimeId: RuntimeId;
      readonly issuedAtMs: number;
      readonly integrationBootstrapKey: Uint8Array;
    };

interface PreparedResourcePolicy {
  readonly config: HostResourcePolicy;
  readonly allowedExecutables: ReadonlySet<string>;
}

export class HostCommandPolicy {
  readonly #roots: ReadonlyMap<string, string>;
  readonly #profiles: ReadonlyMap<string, HostProfileConfig>;
  readonly #environmentPolicies: ReadonlyMap<string, HostEnvironmentPolicy>;
  readonly #resourcePolicies: ReadonlyMap<string, PreparedResourcePolicy>;
  readonly #integrationPolicies: ReadonlyMap<string, HostIntegrationPolicy>;

  constructor(
    config: DurableSessionHostConfig,
    private readonly hostEnvironment = process.env,
  ) {
    this.#roots = new Map(
      config.roots.map((root) => {
        try {
          return [root.rootId, canonicalDirectory(root.path)] as const;
        } catch {
          throw new Error(`Configured root is unavailable: ${root.rootId}`);
        }
      }),
    );
    this.#profiles = new Map(config.profiles.map((profile) => [profile.profileId, profile]));
    this.#environmentPolicies = new Map(
      config.environmentPolicies.map((policy) => [policy.envPolicyId, policy]),
    );
    this.#resourcePolicies = new Map(
      config.resourcePolicies.map((policy) => [
        policy.resourcePolicyId,
        {
          config: policy,
          allowedExecutables: new Set(
            policy.allowedExecutables.map((executable) => {
              try {
                return canonicalExecutable(executable);
              } catch {
                throw new Error(
                  `Resource policy has an unavailable executable: ${policy.resourcePolicyId}`,
                );
              }
            }),
          ),
        },
      ]),
    );
    this.#integrationPolicies = new Map(
      config.integrationPolicies.map((policy) => [policy.policyRef, policy]),
    );
    for (const profile of config.profiles) this.#validateProfile(profile);
  }

  restartability(command: CommandSpecV0): Restartability {
    return command.kind === "profile" && command.integration === undefined
      ? "profile-reference"
      : "runtime-only";
  }

  resolve(
    command: CommandSpecV0,
    integrationContext?: HostCommandResolutionContext,
  ): ResolvedLaunchCommand {
    const root = this.#roots.get(command.cwd.rootId);
    if (root === undefined) {
      throw new HostOperationError(
        "ROOT_BOUNDARY_VIOLATION",
        "Requested root is not configured for this Host.",
      );
    }

    let cwd: string;
    try {
      cwd = resolveInsideRoot(root, command.cwd.relativePath);
    } catch {
      throw new HostOperationError(
        "ROOT_BOUNDARY_VIOLATION",
        "Requested working directory is outside the configured root.",
      );
    }

    const launch =
      command.kind === "profile"
        ? this.#resolveProfile(command.profileId)
        : {
            executable: command.executable,
            args: command.args,
            envPolicyId: command.envPolicyId,
            resourcePolicyId: command.resourcePolicyId,
          };
    const environmentPolicy = this.#environmentPolicies.get(launch.envPolicyId);
    const resource = this.#resourcePolicies.get(launch.resourcePolicyId);
    if (environmentPolicy === undefined || resource === undefined) {
      throw new HostOperationError(
        "COMMAND_POLICY_DENIED",
        "Command references an unknown Host policy.",
      );
    }

    let executable: string;
    try {
      executable = canonicalExecutable(launch.executable);
    } catch {
      throw new HostOperationError(
        "COMMAND_POLICY_DENIED",
        "Executable is unavailable or is not an executable regular file.",
      );
    }
    if (!resource.allowedExecutables.has(executable)) {
      throw new HostOperationError(
        "COMMAND_POLICY_DENIED",
        "Executable is outside the selected resource policy.",
      );
    }
    if (
      command.terminal.cols > resource.config.maxCols ||
      command.terminal.rows > resource.config.maxRows
    ) {
      throw new HostOperationError(
        "COMMAND_POLICY_DENIED",
        "Terminal dimensions exceed the selected resource policy.",
      );
    }
    const argumentCharacters = launch.args.reduce((total, argument) => total + argument.length, 0);
    if (argumentCharacters > DURABLE_SESSION_LIMITS.argumentTotalCharacters) {
      throw new HostOperationError("COMMAND_POLICY_DENIED", "Command arguments are too large.");
    }

    const environment = this.#buildEnvironment(environmentPolicy, command.terminal.term, cwd);
    if (command.integration !== undefined) {
      this.#resolveIntegrationPolicy(command, integrationContext?.appId);
      if (integrationContext?.mode === "runtime") {
        environment[DURABLE_SESSION_INTEGRATION_BOOTSTRAP_ENV] = createIntegrationBootstrap(
          {
            version: 0,
            appId: integrationContext.appId,
            subject: integrationContext.subject,
            sessionId: integrationContext.sessionId,
            runtimeId: integrationContext.runtimeId,
            profileId: requireProfileId(command),
            cwd: command.cwd,
            integration: command.integration,
            issuedAtMs: integrationContext.issuedAtMs,
          },
          integrationContext.integrationBootstrapKey,
        );
      } else if (integrationContext?.mode !== "validate") {
        throw new HostOperationError(
          "COMMAND_POLICY_DENIED",
          "Integration command is missing an authenticated app binding.",
        );
      }
    }

    return {
      executable,
      args: [...launch.args],
      cwd,
      environment,
      terminal: {
        cols: command.terminal.cols,
        rows: command.terminal.rows,
        ...(command.terminal.term === undefined ? {} : { term: command.terminal.term }),
      },
      resourcePolicyId: resource.config.resourcePolicyId,
      scrollbackRows: resource.config.scrollbackRows,
      outputRingCharacters: resource.config.outputRingCharacters,
      stopTimeoutMs: resource.config.stopTimeoutMs,
    };
  }

  #resolveIntegrationPolicy(
    command: CommandSpecV0,
    appId: string | undefined,
  ): HostIntegrationPolicy {
    if (command.kind !== "profile") {
      throw new HostOperationError(
        "COMMAND_POLICY_DENIED",
        "Integration commands must use an allowlisted Host profile.",
      );
    }
    const descriptor = command.integration;
    const config = descriptor?.config;
    const policyRef = config?.policyRef;
    if (descriptor === undefined || config === undefined || typeof policyRef !== "string") {
      throw new HostOperationError(
        "COMMAND_POLICY_DENIED",
        "Integration descriptor is missing its Host policy reference.",
      );
    }
    const policy = this.#integrationPolicies.get(policyRef);
    if (
      policy === undefined ||
      appId === undefined ||
      policy.appId !== appId ||
      policy.integrationKind !== descriptor.kind ||
      !policy.profileIds.includes(command.profileId)
    ) {
      throw new HostOperationError(
        "COMMAND_POLICY_DENIED",
        "Integration descriptor is outside the Host integration policy.",
      );
    }
    const keys = Object.keys(config);
    if (
      keys.some((key) => !policy.configKeys.includes(key)) ||
      Buffer.byteLength(JSON.stringify(config), "utf8") > MAX_HOST_INTEGRATION_CONFIG_BYTES
    ) {
      throw new HostOperationError(
        "COMMAND_POLICY_DENIED",
        "Integration descriptor config is outside the Host integration policy.",
      );
    }
    return policy;
  }

  #resolveProfile(profileId: string): {
    readonly executable: string;
    readonly args: readonly string[];
    readonly envPolicyId: string;
    readonly resourcePolicyId: string;
  } {
    const profile = this.#profiles.get(profileId);
    if (profile === undefined) {
      throw new HostOperationError("COMMAND_POLICY_DENIED", "Requested profile is not configured.");
    }
    return profile;
  }

  #validateProfile(profile: HostProfileConfig): void {
    const environmentPolicy = this.#environmentPolicies.get(profile.envPolicyId);
    const resource = this.#resourcePolicies.get(profile.resourcePolicyId);
    if (environmentPolicy === undefined || resource === undefined) {
      throw new Error(`Profile references an unavailable policy: ${profile.profileId}`);
    }
    let executable: string;
    try {
      executable = canonicalExecutable(profile.executable);
    } catch {
      throw new Error(`Profile executable is unavailable: ${profile.profileId}`);
    }
    if (!resource.allowedExecutables.has(executable)) {
      throw new Error(`Profile executable is outside its resource policy: ${profile.profileId}`);
    }
    const argumentCharacters = profile.args.reduce((total, argument) => total + argument.length, 0);
    if (argumentCharacters > DURABLE_SESSION_LIMITS.argumentTotalCharacters) {
      throw new Error(`Profile arguments are too large: ${profile.profileId}`);
    }
  }

  #buildEnvironment(policy: HostEnvironmentPolicy, term: string | undefined, cwd: string) {
    const environment: Record<string, string> = {};
    for (const name of policy.inherit) {
      const value = this.hostEnvironment[name];
      if (value !== undefined) environment[name] = value;
    }
    Object.assign(environment, policy.values);
    environment.TERM = term ?? "xterm-256color";
    environment.PWD = cwd;
    return environment;
  }
}

function requireProfileId(command: CommandSpecV0): string {
  if (command.kind !== "profile") {
    throw new HostOperationError("COMMAND_POLICY_DENIED", "Integration profile is unavailable.");
  }
  return command.profileId;
}
