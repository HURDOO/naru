import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createDatabaseBackupFromFile,
  verifyDatabaseBackup,
  type DatabaseBackupResult,
} from "./database-backup.js";
import { loadConfig, type AppConfig } from "./config.js";
import {
  inspectDiscordWebhookConfiguration,
  sendDiscordMaintenanceNotification,
  type DiscordMaintenanceNotification,
  type DiscordMaintenanceNotificationEvent,
  type DiscordMaintenanceNotificationSender,
  type DiscordNotificationDelivery,
  type DiscordNotificationDeliveryStatus,
  type DiscordWebhookConfigurationStatus,
} from "./discord-notifier.js";
import { readSecureEnvironmentFile } from "./environment-file.js";
import {
  activateRelease,
  preflightProductionEnvironmentFile,
  verifyReleaseManifest,
  verifyRunningProductionService,
  writeReleaseManifest,
  type ProductionPreflightReport,
  type RunningServiceReport,
} from "./operations.js";

export const MAIN_SERVICE_LABEL = "com.naru.agent";
export const MAINTENANCE_SERVICE_LABEL = "com.naru.maintenance";
export const PRODUCTION_NODE_EXECUTABLE = "/opt/homebrew/opt/node@24/bin/node";
export const MAINTENANCE_CONFIRMATION_PREFIX = "--confirm-pty-loss=";

const MAINTENANCE_FORMAT_VERSION = 1;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SERVICE_START_ATTEMPTS = 3;
const SERVICE_VERIFY_ATTEMPTS = 30;
const MAINTENANCE_HANDOFF_DELAY_MS = 1_500;
const BUILD_PATH = "/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
const PNPM_EXECUTABLE = "/opt/homebrew/bin/pnpm";
const GIT_EXECUTABLE = "/usr/bin/git";
const TAR_EXECUTABLE = "/usr/bin/tar";
const LAUNCHCTL_EXECUTABLE = "/bin/launchctl";
const PLUTIL_EXECUTABLE = "/usr/bin/plutil";

export type MaintenanceAction = "restart" | "deploy";
export type MaintenanceStage =
  | "queued"
  | "validating"
  | "stopping"
  | "activating"
  | "starting"
  | "verifying"
  | "rolling_back"
  | "completed";

export interface DeploymentSource {
  sourceDirectory: string;
  commit: string;
  releaseId: string;
  branch: string;
  candidateExists: boolean;
}

export interface MaintenanceInstallation {
  uid: number;
  opsRoot: string;
  releasesDirectory: string;
  currentLink: string;
  activeReleaseDirectory: string;
  activeReleaseId: string;
  environmentFile: string;
  discordWebhookFile: string;
  backupDirectory: string;
  maintenanceDirectory: string;
  confirmationDirectory: string;
  requestDirectory: string;
  resultDirectory: string;
  requestPointerFile: string;
  queueLockFile: string;
  mainLaunchAgentFile: string;
  maintenanceLaunchAgentFile: string;
  mainServiceTarget: string;
  maintenanceServiceTarget: string;
}

export interface MaintenancePlan {
  status: "confirmation_required";
  action: MaintenanceAction;
  activeRelease: string;
  targetRelease: string;
  activePtys: number;
  activeSessions: number;
  activeWebSockets: number;
  notificationConfiguration: DiscordWebhookConfigurationStatus;
  source: DeploymentSource | null;
  warning: string;
  confirmationId: string;
  confirmationCommand: string;
}

export interface MaintenanceRequest {
  formatVersion: number;
  requestId: string;
  action: MaintenanceAction;
  requestedAt: string;
  requestedByUid: number;
  activeRelease: string;
  targetRelease: string;
  sourceCommit: string | null;
  backupFile: string;
  activePtys: number;
}

export interface MaintenanceResult {
  formatVersion: number;
  requestId: string;
  action: MaintenanceAction;
  status: "queued" | "running" | "succeeded" | "recovered" | "rolled_back" | "failed";
  stage: MaintenanceStage;
  activeRelease: string;
  targetRelease: string;
  effectiveRelease: string;
  backupFile: string;
  requestedAt: string;
  updatedAt: string;
  message: string;
  manualRecoveryRequired: boolean;
  notificationDelivery: DiscordNotificationDeliveryStatus;
  service: RunningServiceReport | null;
}

export interface QueuedMaintenanceReport {
  status: "queued";
  requestId: string;
  action: MaintenanceAction;
  activeRelease: string;
  targetRelease: string;
  activePtys: number;
  backupFile: string;
  notificationDelivery: DiscordNotificationDeliveryStatus;
  statusCommand: "naru-ops status";
  message: string;
}

interface CaptureCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

interface RunCommandOptions extends CaptureCommandOptions {
  inheritOutput?: boolean;
}

export type CaptureCommand = (
  executable: string,
  args: readonly string[],
  options?: CaptureCommandOptions,
) => string;

export type RunCommand = (
  executable: string,
  args: readonly string[],
  options?: RunCommandOptions,
) => void;

export interface MaintenanceHostOptions {
  uid?: number;
  homeDirectory?: string;
  nodeVersion?: string;
  captureCommand?: CaptureCommand;
  runCommand?: RunCommand;
  verifyService?: (config: AppConfig) => Promise<RunningServiceReport>;
  preflight?: (environmentFile: string, rootDirectory: string) => ProductionPreflightReport;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  createId?: () => string;
  privateTemporaryDirectory?: string;
  sendNotification?: DiscordMaintenanceNotificationSender;
  invocationEnvironment?: NodeJS.ProcessEnv;
}

interface ResolvedMaintenanceHostOptions {
  uid: number;
  homeDirectory: string;
  nodeVersion: string;
  captureCommand: CaptureCommand;
  runCommand: RunCommand;
  verifyService: (config: AppConfig) => Promise<RunningServiceReport>;
  preflight: (environmentFile: string, rootDirectory: string) => ProductionPreflightReport;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => Date;
  createId: () => string;
  privateTemporaryDirectory: string;
  sendNotification: DiscordMaintenanceNotificationSender;
  invocationEnvironment: NodeJS.ProcessEnv;
}

export interface MaintenanceTransitionAdapter {
  validateTarget(request: MaintenanceRequest): Promise<void>;
  stopMainService(): Promise<void>;
  activate(releaseId: string): Promise<void>;
  startMainService(): Promise<void>;
  verifyMainService(releaseId: string): Promise<RunningServiceReport>;
}

export function parseMaintenanceConfirmationArgument(value: string): string {
  if (!value.startsWith(MAINTENANCE_CONFIRMATION_PREFIX)) {
    throw new Error(
      "Use the one-time confirmation command printed by a fresh read-only naru-ops plan.",
    );
  }
  const confirmationId = value.slice(MAINTENANCE_CONFIRMATION_PREFIX.length);
  assertMaintenanceConfirmationId(confirmationId);
  return confirmationId;
}

export function assertInteractiveMaintenanceInvocation(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const serviceName = environment.XPC_SERVICE_NAME;
  if (
    serviceName !== undefined &&
    serviceName !== "" &&
    serviceName !== "0" &&
    serviceName !== MAIN_SERVICE_LABEL
  ) {
    throw new Error(
      "Confirmed Naru maintenance must run from an interactive Naru or SSH shell, not another launchd service.",
    );
  }
}

export function resolveMaintenanceInstallation(
  releaseDirectory: string,
  options: MaintenanceHostOptions = {},
): MaintenanceInstallation {
  const host = resolveHostOptions(options);
  assertAbsolutePath(releaseDirectory, "active release directory");
  const canonicalRelease = realpathSync(releaseDirectory);
  const releaseMetadata = lstatSync(canonicalRelease);
  if (releaseMetadata.isSymbolicLink() || !releaseMetadata.isDirectory()) {
    throw new Error("The active release must be a regular directory.");
  }

  const releasesDirectory = dirname(canonicalRelease);
  if (basename(releasesDirectory) !== "releases") {
    throw new Error("The helper must run from an installed Naru release.");
  }
  const opsRoot = dirname(releasesDirectory);
  assertPrivateDirectory(opsRoot, "Naru operations root", host.uid);
  assertPrivateDirectory(releasesDirectory, "Naru releases directory", host.uid);

  const activeReleaseId = basename(canonicalRelease);
  assertSafeIdentifier(activeReleaseId, "active release ID");
  assertPrivateDirectory(canonicalRelease, "active release", host.uid);
  const currentLink = join(releasesDirectory, "current");
  const currentMetadata = lstatSync(currentLink);
  if (!currentMetadata.isSymbolicLink()) {
    throw new Error("The active release path must be a symbolic link.");
  }
  if (
    readlinkSync(currentLink) !== activeReleaseId ||
    realpathSync(currentLink) !== canonicalRelease
  ) {
    throw new Error("This helper is not running from the active Naru release.");
  }
  verifyReleaseManifest(canonicalRelease, activeReleaseId);

  const environmentFile = join(opsRoot, "env", "naru.env");
  readSecureEnvironmentFile(environmentFile);
  const userLaunchAgents = join(host.homeDirectory, "Library", "LaunchAgents");

  return {
    uid: host.uid,
    opsRoot,
    releasesDirectory,
    currentLink,
    activeReleaseDirectory: canonicalRelease,
    activeReleaseId,
    environmentFile,
    discordWebhookFile: join(opsRoot, "env", "discord-webhook.url"),
    backupDirectory: join(opsRoot, "backups"),
    maintenanceDirectory: join(opsRoot, "maintenance"),
    confirmationDirectory: join(opsRoot, "maintenance", "confirmations"),
    requestDirectory: join(opsRoot, "maintenance", "requests"),
    resultDirectory: join(opsRoot, "maintenance", "results"),
    requestPointerFile: join(opsRoot, "maintenance", "current-request.json"),
    queueLockFile: join(opsRoot, "maintenance", "queue.lock"),
    mainLaunchAgentFile: join(userLaunchAgents, `${MAIN_SERVICE_LABEL}.plist`),
    maintenanceLaunchAgentFile: join(userLaunchAgents, `${MAINTENANCE_SERVICE_LABEL}.plist`),
    mainServiceTarget: `gui/${host.uid}/${MAIN_SERVICE_LABEL}`,
    maintenanceServiceTarget: `gui/${host.uid}/${MAINTENANCE_SERVICE_LABEL}`,
  };
}

export async function planProductionMaintenance(
  action: MaintenanceAction,
  activeReleaseDirectory: string,
  sourceDirectory: string | undefined,
  options: MaintenanceHostOptions = {},
): Promise<MaintenancePlan> {
  const host = resolveHostOptions(options);
  const confirmationId = host.createId();
  assertMaintenanceConfirmationId(confirmationId);
  return (
    await inspectProductionMaintenance(
      action,
      activeReleaseDirectory,
      sourceDirectory,
      confirmationId,
      host,
    )
  ).plan;
}

async function inspectProductionMaintenance(
  action: MaintenanceAction,
  activeReleaseDirectory: string,
  sourceDirectory: string | undefined,
  confirmationId: string,
  host: ResolvedMaintenanceHostOptions,
): Promise<{ installation: MaintenanceInstallation; plan: MaintenancePlan }> {
  assertMaintenanceConfirmationId(confirmationId);
  const installation = resolveMaintenanceInstallation(activeReleaseDirectory, host);
  host.preflight(installation.environmentFile, installation.activeReleaseDirectory);
  const { values } = readSecureEnvironmentFile(installation.environmentFile);
  const config = loadConfig(values, installation.activeReleaseDirectory);

  const launchdOutput = host.captureCommand(LAUNCHCTL_EXECUTABLE, [
    "print",
    installation.mainServiceTarget,
  ]);
  assertMainLaunchdService(launchdOutput, installation);
  const service = await host.verifyService(config);

  const source =
    action === "deploy"
      ? inspectDeploymentSource(requiredValue(sourceDirectory), installation, host.captureCommand)
      : null;
  const targetRelease = source?.releaseId ?? installation.activeReleaseId;
  const command =
    action === "deploy"
      ? `naru-ops deploy ${MAINTENANCE_CONFIRMATION_PREFIX}${confirmationId}`
      : `naru-ops restart ${MAINTENANCE_CONFIRMATION_PREFIX}${confirmationId}`;

  return {
    installation,
    plan: {
      status: "confirmation_required",
      action,
      activeRelease: installation.activeReleaseId,
      targetRelease,
      activePtys: service.metrics.activePtys,
      activeSessions: service.metrics.activeSessions,
      activeWebSockets: service.metrics.activeWebSockets,
      notificationConfiguration: inspectDiscordWebhookConfiguration(
        installation.discordWebhookFile,
        installation.uid,
      ),
      source,
      warning:
        `이 작업은 현재 실행 중인 PTY ${service.metrics.activePtys}개를 종료합니다. ` +
        "Codex session ID 자동 복구는 보장되지 않으며 Dev Terminal의 codex resume picker가 수동 복구 경로입니다.",
      confirmationId,
      confirmationCommand: command,
    },
  };
}

export function inspectDeploymentSource(
  sourceDirectory: string,
  installation: MaintenanceInstallation,
  captureCommand: CaptureCommand = defaultCaptureCommand,
): DeploymentSource {
  assertAbsolutePath(sourceDirectory, "source directory");
  const canonicalSource = realpathSync(sourceDirectory);
  const metadata = lstatSync(canonicalSource);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("The deployment source must be a regular directory.");
  }
  if (
    canonicalSource === installation.opsRoot ||
    canonicalSource.startsWith(`${installation.opsRoot}/`)
  ) {
    throw new Error("The deployment source must not be inside the Naru operations root.");
  }

  const topLevel = captureCommand(GIT_EXECUTABLE, [
    "-C",
    canonicalSource,
    "rev-parse",
    "--show-toplevel",
  ]).trim();
  if (realpathSync(topLevel) !== canonicalSource) {
    throw new Error("Run naru-ops deploy from the Naru repository root.");
  }
  const status = captureCommand(GIT_EXECUTABLE, [
    "-C",
    canonicalSource,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]).trim();
  if (status.length > 0) {
    throw new Error("Deployment requires a clean Git tree; commit or preserve every change first.");
  }

  assertNaruSourceTree(canonicalSource);
  const commit = captureCommand(GIT_EXECUTABLE, [
    "-C",
    canonicalSource,
    "rev-parse",
    "HEAD",
  ]).trim();
  const releaseId = captureCommand(GIT_EXECUTABLE, [
    "-C",
    canonicalSource,
    "rev-parse",
    "--short=12",
    "HEAD",
  ]).trim();
  const branch = captureCommand(GIT_EXECUTABLE, [
    "-C",
    canonicalSource,
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]).trim();
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error("Git HEAD is not a full commit ID.");
  if (!/^[0-9a-f]{12,64}$/.test(releaseId) || !commit.startsWith(releaseId)) {
    throw new Error("Git short commit ID does not match HEAD.");
  }
  const candidateDirectory = join(installation.releasesDirectory, releaseId);
  if (releaseId === installation.activeReleaseId) {
    throw new Error("This commit is already the active release; use naru-ops restart.");
  }
  const candidateExists = existsSync(candidateDirectory);
  if (candidateExists) verifyReleaseManifest(candidateDirectory, releaseId);

  return { sourceDirectory: canonicalSource, commit, releaseId, branch, candidateExists };
}

export async function prepareAndQueueProductionMaintenance(
  action: MaintenanceAction,
  activeReleaseDirectory: string,
  sourceDirectory: string | undefined,
  confirmationId: string,
  options: MaintenanceHostOptions = {},
): Promise<QueuedMaintenanceReport> {
  const host = resolveHostOptions(options);
  assertInteractiveMaintenanceInvocation(host.invocationEnvironment);
  assertMaintenanceConfirmationId(confirmationId);
  const { installation, plan } = await inspectProductionMaintenance(
    action,
    activeReleaseDirectory,
    sourceDirectory,
    confirmationId,
    host,
  );

  const requestState: { created: MaintenanceRequest | null } = { created: null };
  let admitted = false;
  let preparationDelivery: DiscordNotificationDeliveryStatus = "disabled";

  try {
    ensureMaintenanceDirectories(installation);
    return await withMaintenanceQueueLock(installation, host, async () => {
      assertNoMaintenanceInProgress(installation);
      consumeMaintenanceConfirmation(confirmationId, plan, installation, host);
      admitted = true;
      preparationDelivery = (
        await deliverMaintenanceNotification(host, installation, {
          event: "preparing",
          phase: "preparation",
          action,
          activeRelease: plan.activeRelease,
          targetRelease: plan.targetRelease,
          activePtys: plan.activePtys,
          occurredAt: host.now().toISOString(),
        })
      ).status;
      if (action === "deploy" && !requiredValue(plan.source).candidateExists) {
        prepareCandidateRelease(requiredValue(plan.source), installation, host);
      }
      const targetReleaseDirectory = join(installation.releasesDirectory, plan.targetRelease);
      verifyReleaseManifest(targetReleaseDirectory, plan.targetRelease);
      if (action === "deploy") {
        assertLaunchdTemplatesUnchanged(
          installation.activeReleaseDirectory,
          targetReleaseDirectory,
        );
      }
      host.preflight(installation.environmentFile, targetReleaseDirectory);
      resolveMaintenanceInstallation(activeReleaseDirectory, host);
      assertLaunchAgentFile(installation.mainLaunchAgentFile, installation.uid);
      assertMainLaunchAgentPlist(installation, host.captureCommand);
      ensureMaintenanceLaunchAgentReady(installation, host);

      const { values } = readSecureEnvironmentFile(installation.environmentFile);
      const config = loadConfig(values, installation.activeReleaseDirectory);
      const service = await host.verifyService(config);
      const refreshedPlan: MaintenancePlan = {
        ...plan,
        activePtys: service.metrics.activePtys,
        activeSessions: service.metrics.activeSessions,
        activeWebSockets: service.metrics.activeWebSockets,
        warning:
          `이 작업은 현재 실행 중인 PTY ${service.metrics.activePtys}개를 종료합니다. ` +
          "Codex session ID 자동 복구는 보장되지 않으며 Dev Terminal의 codex resume picker가 수동 복구 경로입니다.",
      };
      const backup = createDatabaseBackupFromFile(
        resolve(config.dataDir, "naru.sqlite"),
        installation.backupDirectory,
        installation.activeReleaseId,
        action === "deploy" ? "pre-deploy" : "pre-restart",
      );
      verifyDatabaseBackup(backup.backupFile);

      const request = createMaintenanceRequest(
        refreshedPlan,
        installation,
        backup,
        preparationDelivery,
        host,
      );
      requestState.created = request;
      kickstartMaintenanceLaunchAgent(installation, host);
      return {
        status: "queued",
        requestId: request.requestId,
        action,
        activeRelease: request.activeRelease,
        targetRelease: request.targetRelease,
        activePtys: request.activePtys,
        backupFile: request.backupFile,
        notificationDelivery: preparationDelivery,
        statusCommand: "naru-ops status",
        message:
          "유지보수 작업을 별도 launchd job에 인계했습니다. 이 터미널은 곧 끊기며 재접속 뒤 naru-ops status로 결과를 확인할 수 있습니다.",
      };
    });
  } catch (error) {
    if (!admitted) throw error;
    const createdRequest = requestState.created;
    let preparationFailure: MaintenanceResult | null = null;
    if (createdRequest !== null) {
      preparationFailure = {
        ...completedResult(
          createdRequest,
          "failed",
          createdRequest.activeRelease,
          `유지보수 worker를 시작하지 못했습니다: ${safeMaintenanceError(error)}`,
          false,
          null,
        ),
        notificationDelivery: preparationDelivery,
      };
      writeMaintenanceResult(
        resultFileFor(installation, createdRequest.requestId),
        installation.uid,
        preparationFailure,
        host.createId(),
      );
    }
    const failureDelivery = await deliverMaintenanceNotification(host, installation, {
      event: "failed",
      phase: "preparation",
      action,
      activeRelease: plan.activeRelease,
      targetRelease: plan.targetRelease,
      effectiveRelease: plan.activeRelease,
      activePtys: plan.activePtys,
      manualRecoveryRequired: false,
      occurredAt: host.now().toISOString(),
    });
    if (createdRequest !== null && preparationFailure !== null) {
      writeMaintenanceResult(
        resultFileFor(installation, createdRequest.requestId),
        installation.uid,
        { ...preparationFailure, notificationDelivery: failureDelivery.status },
        host.createId(),
      );
    }
    throw error;
  }
}

export function readLatestMaintenanceResult(
  activeReleaseDirectory: string,
  options: MaintenanceHostOptions = {},
): MaintenanceResult | { status: "none"; message: string } {
  const installation = resolveMaintenanceInstallation(activeReleaseDirectory, options);
  if (!existsSync(installation.requestPointerFile)) {
    return { status: "none", message: "기록된 Naru 유지보수 작업이 없습니다." };
  }
  const pointer = readMaintenancePointer(installation.requestPointerFile, installation);
  const resultFile = resultFileFor(installation, pointer.requestId);
  if (!existsSync(resultFile)) {
    throw new Error("The latest maintenance result file is missing.");
  }
  return parseMaintenanceResult(readPrivateJson(resultFile, installation.uid));
}

function prepareCandidateRelease(
  source: DeploymentSource,
  installation: MaintenanceInstallation,
  host: ResolvedMaintenanceHostOptions,
): string {
  accessSync(PRODUCTION_NODE_EXECUTABLE, constants.X_OK);
  accessSync(PNPM_EXECUTABLE, constants.X_OK);
  const suffix = host.createId();
  const stagingDirectory = join(
    installation.releasesDirectory,
    `.preparing-${source.releaseId}-${suffix}`,
  );
  const finalDirectory = join(installation.releasesDirectory, source.releaseId);
  const archiveFile = join(
    host.privateTemporaryDirectory,
    `naru-${source.releaseId}-${suffix}.tar`,
  );
  if (existsSync(stagingDirectory) || existsSync(finalDirectory) || existsSync(archiveFile)) {
    throw new Error("A deployment staging path already exists; refusing to overwrite it.");
  }
  mkdirSync(stagingDirectory, { mode: PRIVATE_DIRECTORY_MODE });

  host.runCommand(
    GIT_EXECUTABLE,
    [
      "-C",
      source.sourceDirectory,
      "archive",
      "--format=tar",
      source.commit,
      `--output=${archiveFile}`,
    ],
    { timeoutMs: 60_000 },
  );
  const archiveMetadata = lstatSync(archiveFile);
  if (
    archiveMetadata.isSymbolicLink() ||
    !archiveMetadata.isFile() ||
    archiveMetadata.uid !== installation.uid
  ) {
    throw new Error("The deployment archive must be a regular file owned by the service user.");
  }
  chmodSync(archiveFile, PRIVATE_FILE_MODE);
  host.runCommand(TAR_EXECUTABLE, ["-xf", archiveFile, "-C", stagingDirectory], {
    timeoutMs: 60_000,
  });
  assertLaunchdTemplatesUnchanged(installation.activeReleaseDirectory, stagingDirectory);

  const buildEnvironment = childBuildEnvironment(process.env);
  const validationCommands: readonly (readonly string[])[] = [
    ["install", "--frozen-lockfile", "--prod=false"],
    ["format"],
    ["lint"],
    ["typecheck"],
    ["test"],
    ["build"],
    ["test:operations"],
    ["test:production-smoke"],
  ];
  for (const args of validationCommands) {
    host.runCommand(PNPM_EXECUTABLE, args, {
      cwd: stagingDirectory,
      env: buildEnvironment,
      timeoutMs: 15 * 60_000,
      inheritOutput: true,
    });
  }

  writeReleaseManifest(stagingDirectory, source.releaseId);
  renameSync(stagingDirectory, finalDirectory);
  return finalDirectory;
}

function createMaintenanceRequest(
  plan: MaintenancePlan,
  installation: MaintenanceInstallation,
  backup: DatabaseBackupResult,
  notificationDelivery: DiscordNotificationDeliveryStatus,
  host: ResolvedMaintenanceHostOptions,
): MaintenanceRequest {
  ensureMaintenanceDirectories(installation);
  const requestId = host.createId();
  const request: MaintenanceRequest = {
    formatVersion: MAINTENANCE_FORMAT_VERSION,
    requestId,
    action: plan.action,
    requestedAt: host.now().toISOString(),
    requestedByUid: installation.uid,
    activeRelease: plan.activeRelease,
    targetRelease: plan.targetRelease,
    sourceCommit: plan.source?.commit ?? null,
    backupFile: backup.backupFile,
    activePtys: plan.activePtys,
  };
  const requestFile = requestFileFor(installation, requestId);
  const resultFile = resultFileFor(installation, requestId);
  writePrivateJsonExclusive(requestFile, request);
  writePrivateJsonExclusive(resultFile, initialMaintenanceResult(request, notificationDelivery));
  writeMaintenancePointer(installation, requestId, host.createId());
  return request;
}

function ensureMaintenanceLaunchAgentReady(
  installation: MaintenanceInstallation,
  host: ResolvedMaintenanceHostOptions,
): void {
  assertLaunchAgentFile(installation.maintenanceLaunchAgentFile, installation.uid);
  assertMaintenanceLaunchAgentPlist(installation, host.captureCommand);

  let serviceOutput = printLaunchdService(
    host.captureCommand,
    installation.maintenanceServiceTarget,
  );
  if (serviceOutput === null) {
    host.captureCommand(LAUNCHCTL_EXECUTABLE, [
      "bootstrap",
      `gui/${installation.uid}`,
      installation.maintenanceLaunchAgentFile,
    ]);
    serviceOutput = host.captureCommand(LAUNCHCTL_EXECUTABLE, [
      "print",
      installation.maintenanceServiceTarget,
    ]);
  }
  assertMaintenanceLaunchdService(serviceOutput, installation);
}

function kickstartMaintenanceLaunchAgent(
  installation: MaintenanceInstallation,
  host: ResolvedMaintenanceHostOptions,
): void {
  host.captureCommand(LAUNCHCTL_EXECUTABLE, ["kickstart", installation.maintenanceServiceTarget]);
}

function ensureMaintenanceDirectories(installation: MaintenanceInstallation): void {
  for (const directory of [
    installation.maintenanceDirectory,
    installation.confirmationDirectory,
    installation.requestDirectory,
    installation.resultDirectory,
  ]) {
    if (!existsSync(directory)) mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE });
    assertPrivateDirectory(directory, "maintenance directory", installation.uid);
  }
  if (!existsSync(installation.backupDirectory)) {
    mkdirSync(installation.backupDirectory, { mode: PRIVATE_DIRECTORY_MODE });
  }
  assertPrivateDirectory(installation.backupDirectory, "backup directory", installation.uid);
}

function consumeMaintenanceConfirmation(
  confirmationId: string,
  plan: MaintenancePlan,
  installation: MaintenanceInstallation,
  host: ResolvedMaintenanceHostOptions,
): void {
  assertMaintenanceConfirmationId(confirmationId);
  const receiptFile = join(installation.confirmationDirectory, `${confirmationId}.json`);
  try {
    writePrivateJsonExclusive(receiptFile, {
      formatVersion: MAINTENANCE_FORMAT_VERSION,
      confirmationId,
      action: plan.action,
      activeRelease: plan.activeRelease,
      targetRelease: plan.targetRelease,
      acceptedAt: host.now().toISOString(),
    });
  } catch (error) {
    if (existsSync(receiptFile)) {
      throw new Error(
        "This maintenance confirmation was already used; run a fresh read-only naru-ops plan.",
        { cause: error },
      );
    }
    throw error;
  }
}

async function withMaintenanceQueueLock<T>(
  installation: MaintenanceInstallation,
  host: ResolvedMaintenanceHostOptions,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    writePrivateJsonExclusive(installation.queueLockFile, {
      formatVersion: MAINTENANCE_FORMAT_VERSION,
      ownerUid: installation.uid,
      createdAt: host.now().toISOString(),
    });
  } catch (error) {
    if (existsSync(installation.queueLockFile)) {
      throw new Error("Another Naru maintenance request is being queued.", { cause: error });
    }
    throw error;
  }

  const createdLock = lstatSync(installation.queueLockFile);
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    try {
      releaseMaintenanceQueueLock(installation, createdLock.ino);
    } catch (cleanupError) {
      throw new AggregateError(
        [asError(error), asError(cleanupError)],
        "Naru maintenance failed and its queue lock could not be released.",
        { cause: cleanupError },
      );
    }
    throw asError(error);
  }
  releaseMaintenanceQueueLock(installation, createdLock.ino);
  return result;
}

function releaseMaintenanceQueueLock(
  installation: MaintenanceInstallation,
  createdInode: number,
): void {
  const currentLock = lstatSync(installation.queueLockFile);
  if (
    !currentLock.isFile() ||
    currentLock.isSymbolicLink() ||
    currentLock.uid !== installation.uid ||
    (currentLock.mode & 0o077) !== 0 ||
    currentLock.ino !== createdInode
  ) {
    throw new Error("The Naru maintenance queue lock changed unexpectedly.");
  }
  unlinkSync(installation.queueLockFile);
}

function assertNoMaintenanceInProgress(installation: MaintenanceInstallation): void {
  if (!existsSync(installation.requestPointerFile)) return;
  const pointer = readMaintenancePointer(installation.requestPointerFile, installation);
  const resultFile = resultFileFor(installation, pointer.requestId);
  if (!existsSync(resultFile)) {
    throw new Error("The latest maintenance request has no result file; inspect it manually.");
  }
  const result = parseMaintenanceResult(readPrivateJson(resultFile, installation.uid));
  if (result.status === "queued" || result.status === "running") {
    throw new Error("Another Naru maintenance request is already queued or running.");
  }
}

function initialMaintenanceResult(
  request: MaintenanceRequest,
  notificationDelivery: DiscordNotificationDeliveryStatus,
): MaintenanceResult {
  return {
    formatVersion: MAINTENANCE_FORMAT_VERSION,
    requestId: request.requestId,
    action: request.action,
    status: "queued",
    stage: "queued",
    activeRelease: request.activeRelease,
    targetRelease: request.targetRelease,
    effectiveRelease: request.activeRelease,
    backupFile: request.backupFile,
    requestedAt: request.requestedAt,
    updatedAt: request.requestedAt,
    message: "유지보수 작업이 대기 중입니다.",
    manualRecoveryRequired: false,
    notificationDelivery,
    service: null,
  };
}

export async function executeQueuedMaintenance(
  requestPointerFile: string,
  runtimeReleaseDirectory: string,
  options: MaintenanceHostOptions = {},
): Promise<MaintenanceResult> {
  const host = resolveHostOptions(options);
  const installation = resolveMaintenanceInstallation(runtimeReleaseDirectory, host);
  if (resolve(requestPointerFile) !== installation.requestPointerFile) {
    throw new Error("The maintenance worker received an unexpected request pointer.");
  }
  const pointer = readMaintenancePointer(requestPointerFile, installation);
  const requestFile = requestFileFor(installation, pointer.requestId);
  const resultFile = resultFileFor(installation, pointer.requestId);
  const request = parseMaintenanceRequest(readPrivateJson(requestFile, installation.uid));
  let adapter: MaintenanceTransitionAdapter;
  try {
    assertMaintenanceRequestPaths(request, installation, requestFile);
    if (request.activeRelease !== installation.activeReleaseId) {
      throw new Error("The active release changed after the maintenance request was created.");
    }

    updateMaintenanceResult(
      resultFile,
      installation.uid,
      (result) => ({
        ...result,
        status: "running",
        stage: "validating",
        updatedAt: host.now().toISOString(),
        message: "릴리스, 환경 설정과 DB 백업을 다시 검증하고 있습니다.",
      }),
      host.createId(),
    );

    adapter = createTransitionAdapter(installation, host);
    await host.sleep(MAINTENANCE_HANDOFF_DELAY_MS);
  } catch (error) {
    const failure = carryForwardNotificationDelivery(
      resultFile,
      installation.uid,
      completedResult(
        request,
        "failed",
        installation.activeReleaseId,
        `유지보수 worker가 서비스를 중지하기 전에 요청을 거부했습니다: ${safeMaintenanceError(error)}`,
        false,
        null,
      ),
    );
    writeMaintenanceResult(resultFile, installation.uid, failure, host.createId());
    const notifiedFailure = await attachFinalMaintenanceNotification(
      failure,
      request,
      installation,
      host,
    );
    writeMaintenanceResult(resultFile, installation.uid, notifiedFailure, host.createId());
    return notifiedFailure;
  }

  const finalResult = carryForwardNotificationDelivery(
    resultFile,
    installation.uid,
    await runMaintenanceTransition(request, adapter, (stage, message) => {
      updateMaintenanceResult(
        resultFile,
        installation.uid,
        (result) => ({
          ...result,
          status: "running",
          stage,
          updatedAt: host.now().toISOString(),
          message,
        }),
        host.createId(),
      );
    }),
  );
  writeMaintenanceResult(resultFile, installation.uid, finalResult, host.createId());
  const notifiedResult = await attachFinalMaintenanceNotification(
    finalResult,
    request,
    installation,
    host,
  );
  writeMaintenanceResult(resultFile, installation.uid, notifiedResult, host.createId());
  return notifiedResult;
}

function carryForwardNotificationDelivery(
  resultFile: string,
  uid: number,
  result: MaintenanceResult,
): MaintenanceResult {
  const current = parseMaintenanceResult(readPrivateJson(resultFile, uid));
  return { ...result, notificationDelivery: current.notificationDelivery };
}

async function attachFinalMaintenanceNotification(
  result: MaintenanceResult,
  request: MaintenanceRequest,
  installation: MaintenanceInstallation,
  host: ResolvedMaintenanceHostOptions,
): Promise<MaintenanceResult> {
  const delivery = await deliverMaintenanceNotification(host, installation, {
    event: finalNotificationEvent(result.status),
    phase: "worker",
    action: request.action,
    activeRelease: request.activeRelease,
    targetRelease: request.targetRelease,
    effectiveRelease: result.effectiveRelease,
    activePtys: request.activePtys,
    manualRecoveryRequired: result.manualRecoveryRequired,
    occurredAt: host.now().toISOString(),
  });
  return { ...result, notificationDelivery: delivery.status };
}

export async function runMaintenanceTransition(
  request: MaintenanceRequest,
  adapter: MaintenanceTransitionAdapter,
  onStage: (stage: MaintenanceStage, message: string) => void = () => undefined,
): Promise<MaintenanceResult> {
  let mainServiceStopped = false;
  let targetActivated = false;
  try {
    onStage("validating", "대상 릴리스와 검증된 DB 백업을 확인하고 있습니다.");
    await adapter.validateTarget(request);
    onStage("stopping", `실행 중이던 PTY ${request.activePtys}개를 종료하고 있습니다.`);
    await adapter.stopMainService();
    mainServiceStopped = true;

    if (request.action === "deploy") {
      onStage("activating", `릴리스 ${request.targetRelease}을 활성화하고 있습니다.`);
      await adapter.activate(request.targetRelease);
      targetActivated = true;
    }

    onStage("starting", "Naru LaunchAgent를 다시 시작하고 있습니다.");
    await adapter.startMainService();
    onStage("verifying", "단일 listener, health와 readiness를 확인하고 있습니다.");
    const service = await adapter.verifyMainService(request.targetRelease);
    return completedResult(
      request,
      "succeeded",
      request.targetRelease,
      "Naru 유지보수 작업과 실행 후 검증이 완료됐습니다.",
      false,
      service,
    );
  } catch (error) {
    const primaryMessage = safeMaintenanceError(error);
    if (!mainServiceStopped) {
      return completedResult(
        request,
        "failed",
        request.activeRelease,
        `서비스를 중지하기 전에 작업이 거부됐습니다: ${primaryMessage}`,
        false,
        null,
      );
    }

    onStage("rolling_back", "실패한 기동을 정리하고 이전 서비스 상태로 복구하고 있습니다.");
    let recoveryRelease = targetActivated ? request.targetRelease : request.activeRelease;
    try {
      await bestEffortStop(adapter);
      if (request.action === "deploy" && targetActivated) {
        await adapter.activate(request.activeRelease);
        recoveryRelease = request.activeRelease;
      }
      await adapter.startMainService();
      const service = await adapter.verifyMainService(request.activeRelease);
      if (request.action === "deploy") {
        return completedResult(
          request,
          "rolled_back",
          request.activeRelease,
          `새 릴리스 검증이 실패해 이전 릴리스로 복구했습니다: ${primaryMessage}`,
          false,
          service,
        );
      }
      return completedResult(
        request,
        "recovered",
        request.activeRelease,
        `첫 재기동 시도가 실패했지만 현재 릴리스로 복구했습니다: ${primaryMessage}`,
        false,
        service,
      );
    } catch (recoveryError) {
      await bestEffortStop(adapter);
      return completedResult(
        request,
        "failed",
        recoveryRelease,
        `자동 복구에 실패했습니다. 배포 오류: ${primaryMessage}; 복구 오류: ${safeMaintenanceError(
          recoveryError,
        )}`,
        true,
        null,
      );
    }
  }
}

function createTransitionAdapter(
  installation: MaintenanceInstallation,
  host: ResolvedMaintenanceHostOptions,
): MaintenanceTransitionAdapter {
  return {
    async validateTarget(request) {
      const targetDirectory = join(installation.releasesDirectory, request.targetRelease);
      verifyReleaseManifest(targetDirectory, request.targetRelease);
      assertBackupInsideOperationsRoot(request.backupFile, installation);
      verifyDatabaseBackup(request.backupFile);
      host.preflight(installation.environmentFile, targetDirectory);
      assertLaunchAgentFile(installation.mainLaunchAgentFile, installation.uid);
      assertMainLaunchAgentPlist(installation, host.captureCommand);
      await Promise.resolve();
    },
    async stopMainService() {
      stopMainService(installation, host);
      await Promise.resolve();
    },
    async activate(releaseId) {
      activateRelease(installation.releasesDirectory, releaseId);
      await Promise.resolve();
    },
    async startMainService() {
      await startMainService(installation, host);
    },
    async verifyMainService(releaseId) {
      const releaseDirectory = join(installation.releasesDirectory, releaseId);
      const { values } = readSecureEnvironmentFile(installation.environmentFile);
      const config = loadConfig(values, releaseDirectory);
      return retryVerifyService(config, host);
    },
  };
}

function stopMainService(
  installation: MaintenanceInstallation,
  host: ResolvedMaintenanceHostOptions,
): void {
  const output = printLaunchdService(host.captureCommand, installation.mainServiceTarget);
  if (output === null) return;
  let bootoutError: unknown;
  try {
    host.captureCommand(
      LAUNCHCTL_EXECUTABLE,
      ["bootout", "--wait", installation.mainServiceTarget],
      { timeoutMs: 30_000 },
    );
  } catch (error) {
    bootoutError = error;
  }
  const stillLoaded = printLaunchdService(host.captureCommand, installation.mainServiceTarget);
  if (stillLoaded !== null) {
    if (bootoutError instanceof Error) throw bootoutError;
    throw new Error("The Naru LaunchAgent remained loaded after bootout.", {
      cause: bootoutError,
    });
  }
}

async function startMainService(
  installation: MaintenanceInstallation,
  host: ResolvedMaintenanceHostOptions,
): Promise<void> {
  for (let attempt = 1; attempt <= SERVICE_START_ATTEMPTS; attempt += 1) {
    const existing = printLaunchdService(host.captureCommand, installation.mainServiceTarget);
    if (existing !== null) return;
    try {
      host.captureCommand(LAUNCHCTL_EXECUTABLE, [
        "bootstrap",
        `gui/${installation.uid}`,
        installation.mainLaunchAgentFile,
      ]);
    } catch (error) {
      const loaded = printLaunchdService(host.captureCommand, installation.mainServiceTarget);
      if (loaded !== null) return;
      if (attempt === SERVICE_START_ATTEMPTS) throw error;
    }
    await host.sleep(1_000);
  }
}

async function retryVerifyService(
  config: AppConfig,
  host: ResolvedMaintenanceHostOptions,
): Promise<RunningServiceReport> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SERVICE_VERIFY_ATTEMPTS; attempt += 1) {
    try {
      return await host.verifyService(config);
    } catch (error) {
      lastError = error;
      if (attempt < SERVICE_VERIFY_ATTEMPTS) await host.sleep(1_000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Production verification failed.");
}

async function bestEffortStop(adapter: MaintenanceTransitionAdapter): Promise<void> {
  try {
    await adapter.stopMainService();
  } catch {
    // Recovery continues so the previous release can still be activated and started.
  }
}

function completedResult(
  request: MaintenanceRequest,
  status: Extract<
    MaintenanceResult["status"],
    "succeeded" | "recovered" | "rolled_back" | "failed"
  >,
  effectiveRelease: string,
  message: string,
  manualRecoveryRequired: boolean,
  service: RunningServiceReport | null,
): MaintenanceResult {
  return {
    formatVersion: MAINTENANCE_FORMAT_VERSION,
    requestId: request.requestId,
    action: request.action,
    status,
    stage: "completed",
    activeRelease: request.activeRelease,
    targetRelease: request.targetRelease,
    effectiveRelease,
    backupFile: request.backupFile,
    requestedAt: request.requestedAt,
    updatedAt: new Date().toISOString(),
    message,
    manualRecoveryRequired,
    notificationDelivery: "disabled",
    service,
  };
}

function finalNotificationEvent(
  status: MaintenanceResult["status"],
): DiscordMaintenanceNotificationEvent {
  switch (status) {
    case "succeeded":
    case "recovered":
    case "rolled_back":
    case "failed":
      return status;
    case "queued":
    case "running":
      throw new Error("A non-final maintenance result cannot send a final notification.");
  }
}

async function deliverMaintenanceNotification(
  host: ResolvedMaintenanceHostOptions,
  installation: MaintenanceInstallation,
  notification: DiscordMaintenanceNotification,
): Promise<DiscordNotificationDelivery> {
  try {
    const delivery = await host.sendNotification(installation.discordWebhookFile, notification);
    if (
      delivery.status === "sent" ||
      delivery.status === "failed" ||
      delivery.status === "disabled"
    ) {
      return delivery;
    }
    return { status: "failed" };
  } catch {
    return { status: "failed" };
  }
}

export interface LaunchdServiceInspection {
  state: string;
  program: string;
  workingDirectory: string;
  environmentFile: string | null;
}

export function parseLaunchdServicePrint(output: string): LaunchdServiceInspection {
  return {
    state: requiredLaunchdField(output, "state"),
    program: requiredLaunchdField(output, "program"),
    workingDirectory: requiredLaunchdField(output, "working directory"),
    environmentFile: optionalLaunchdEnvironment(output, "NARU_ENV_FILE"),
  };
}

export function assertMainLaunchdService(
  output: string,
  installation: MaintenanceInstallation,
): void {
  const service = parseLaunchdServicePrint(output);
  if (service.state !== "running") throw new Error("The Naru LaunchAgent is not running.");
  if (service.program !== PRODUCTION_NODE_EXECUTABLE) {
    throw new Error("The Naru LaunchAgent is not using the fixed Node 24 executable.");
  }
  if (service.workingDirectory !== installation.currentLink) {
    throw new Error("The Naru LaunchAgent working directory does not use releases/current.");
  }
  if (service.environmentFile !== installation.environmentFile) {
    throw new Error("The Naru LaunchAgent environment file does not match this installation.");
  }
}

function assertMaintenanceLaunchdService(
  output: string,
  installation: MaintenanceInstallation,
): void {
  const service = parseLaunchdServicePrint(output);
  if (service.program !== PRODUCTION_NODE_EXECUTABLE) {
    throw new Error("The maintenance LaunchAgent is not using the fixed Node 24 executable.");
  }
  if (service.workingDirectory !== installation.currentLink) {
    throw new Error("The maintenance LaunchAgent working directory does not use releases/current.");
  }
  if (service.state !== "not running") {
    throw new Error("The Naru maintenance LaunchAgent is not idle.");
  }
}

export interface MaintenanceLaunchdTemplateValues {
  label: string;
  nodeExecutable: string;
  workingDirectory: string;
  requestPointerFile: string;
  standardOutPath: string;
  standardErrorPath: string;
}

export function renderMaintenanceLaunchdTemplate(
  template: string,
  values: MaintenanceLaunchdTemplateValues,
): string {
  const replacements: Record<string, string> = {
    __LABEL__: values.label,
    __NODE_EXECUTABLE__: values.nodeExecutable,
    __WORKING_DIRECTORY__: values.workingDirectory,
    __MAINTENANCE_ENTRY__: join(values.workingDirectory, "apps/server/dist/maintenance-cli.js"),
    __REQUEST_POINTER_FILE__: values.requestPointerFile,
    __HELPER_DIRECTORY__: join(values.workingDirectory, "ops/bin"),
    __STANDARD_OUT_PATH__: values.standardOutPath,
    __STANDARD_ERROR_PATH__: values.standardErrorPath,
  };
  let rendered = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    if (!isAbsolute(value) && placeholder !== "__LABEL__") {
      throw new Error(`${placeholder} must be an absolute path.`);
    }
    rendered = rendered.replaceAll(placeholder, escapeXml(value));
  }
  if (/__[A-Z_]+__/.test(rendered)) {
    throw new Error("Maintenance launchd template has unresolved values.");
  }
  return rendered;
}

function assertMaintenanceLaunchAgentPlist(
  installation: MaintenanceInstallation,
  captureCommand: CaptureCommand,
): void {
  assertPlistValue(
    installation.maintenanceLaunchAgentFile,
    "Label",
    MAINTENANCE_SERVICE_LABEL,
    captureCommand,
  );
  assertPlistValue(
    installation.maintenanceLaunchAgentFile,
    "ProgramArguments.0",
    PRODUCTION_NODE_EXECUTABLE,
    captureCommand,
  );
  assertPlistValue(
    installation.maintenanceLaunchAgentFile,
    "ProgramArguments.1",
    join(installation.currentLink, "apps/server/dist/maintenance-cli.js"),
    captureCommand,
  );
  assertPlistValue(
    installation.maintenanceLaunchAgentFile,
    "ProgramArguments.2",
    installation.requestPointerFile,
    captureCommand,
  );
  assertPlistValue(
    installation.maintenanceLaunchAgentFile,
    "WorkingDirectory",
    installation.currentLink,
    captureCommand,
  );
  assertPlistValue(
    installation.maintenanceLaunchAgentFile,
    "EnvironmentVariables.PATH",
    launchdPath(installation),
    captureCommand,
  );
  assertPlistMissing(installation.maintenanceLaunchAgentFile, "RunAtLoad", captureCommand);
  assertPlistMissing(installation.maintenanceLaunchAgentFile, "KeepAlive", captureCommand);
}

function assertMainLaunchAgentPlist(
  installation: MaintenanceInstallation,
  captureCommand: CaptureCommand,
): void {
  assertPlistValue(installation.mainLaunchAgentFile, "Label", MAIN_SERVICE_LABEL, captureCommand);
  assertPlistValue(
    installation.mainLaunchAgentFile,
    "ProgramArguments.0",
    PRODUCTION_NODE_EXECUTABLE,
    captureCommand,
  );
  assertPlistValue(
    installation.mainLaunchAgentFile,
    "ProgramArguments.1",
    join(installation.currentLink, "apps/server/dist/index.js"),
    captureCommand,
  );
  assertPlistValue(
    installation.mainLaunchAgentFile,
    "WorkingDirectory",
    installation.currentLink,
    captureCommand,
  );
  assertPlistValue(
    installation.mainLaunchAgentFile,
    "EnvironmentVariables.NARU_ENV_FILE",
    installation.environmentFile,
    captureCommand,
  );
  assertPlistValue(
    installation.mainLaunchAgentFile,
    "EnvironmentVariables.PATH",
    launchdPath(installation),
    captureCommand,
  );
}

function assertPlistValue(
  plist: string,
  keyPath: string,
  expected: string,
  captureCommand: CaptureCommand,
): void {
  const actual = captureCommand(PLUTIL_EXECUTABLE, [
    "-extract",
    keyPath,
    "raw",
    "-o",
    "-",
    plist,
  ]).trim();
  if (actual !== expected) throw new Error(`LaunchAgent ${keyPath} does not match Naru.`);
}

function assertPlistMissing(plist: string, keyPath: string, captureCommand: CaptureCommand): void {
  const actual = tryCaptureCommand(captureCommand, PLUTIL_EXECUTABLE, [
    "-extract",
    keyPath,
    "raw",
    "-o",
    "-",
    plist,
  ]);
  if (actual !== null) throw new Error(`LaunchAgent ${keyPath} must not be configured.`);
}

function launchdPath(installation: MaintenanceInstallation): string {
  return `${join(installation.currentLink, "ops/bin")}:${BUILD_PATH}`;
}

function assertLaunchAgentFile(filename: string, uid: number): void {
  const metadata = lstatSync(filename);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("The LaunchAgent plist must be a regular file.");
  }
  if (metadata.uid !== uid || (metadata.mode & 0o022) !== 0) {
    throw new Error("The LaunchAgent plist owner or permissions are unsafe.");
  }
}

interface MaintenancePointer {
  formatVersion: number;
  requestId: string;
}

function writeMaintenancePointer(
  installation: MaintenanceInstallation,
  requestId: string,
  uniqueSuffix: string,
): void {
  if (existsSync(installation.requestPointerFile)) {
    readPrivateJson(installation.requestPointerFile, installation.uid);
  }
  const temporaryFile = join(
    installation.maintenanceDirectory,
    `.current-request-${uniqueSuffix}.json`,
  );
  writePrivateJsonExclusive(temporaryFile, {
    formatVersion: MAINTENANCE_FORMAT_VERSION,
    requestId,
  });
  renameSync(temporaryFile, installation.requestPointerFile);
}

function readMaintenancePointer(
  filename: string,
  installation: MaintenanceInstallation,
): MaintenancePointer {
  const value = readPrivateJson(filename, installation.uid);
  if (!isRecord(value)) throw new Error("Invalid maintenance request pointer.");
  if (
    value.formatVersion !== MAINTENANCE_FORMAT_VERSION ||
    typeof value.requestId !== "string" ||
    !isUuid(value.requestId)
  ) {
    throw new Error("Invalid maintenance request pointer.");
  }
  return { formatVersion: MAINTENANCE_FORMAT_VERSION, requestId: value.requestId };
}

function parseMaintenanceRequest(value: unknown): MaintenanceRequest {
  if (!isRecord(value)) throw new Error("Invalid maintenance request.");
  const action = value.action;
  const sourceCommit = value.sourceCommit;
  if (
    value.formatVersion !== MAINTENANCE_FORMAT_VERSION ||
    typeof value.requestId !== "string" ||
    !isUuid(value.requestId) ||
    (action !== "restart" && action !== "deploy") ||
    typeof value.requestedAt !== "string" ||
    !Number.isInteger(value.requestedByUid) ||
    typeof value.activeRelease !== "string" ||
    typeof value.targetRelease !== "string" ||
    !isSafeIdentifier(value.activeRelease) ||
    !isSafeIdentifier(value.targetRelease) ||
    (sourceCommit !== null &&
      (typeof sourceCommit !== "string" || !/^[0-9a-f]{40,64}$/.test(sourceCommit))) ||
    typeof value.backupFile !== "string" ||
    !isAbsolute(value.backupFile) ||
    !Number.isInteger(value.activePtys) ||
    (value.activePtys as number) < 0
  ) {
    throw new Error("Invalid maintenance request.");
  }
  return value as unknown as MaintenanceRequest;
}

function parseMaintenanceResult(value: unknown): MaintenanceResult {
  if (!isRecord(value)) throw new Error("Invalid maintenance result.");
  const request = parseMaintenanceRequest({
    formatVersion: value.formatVersion,
    requestId: value.requestId,
    action: value.action,
    requestedAt: value.requestedAt,
    requestedByUid: 0,
    activeRelease: value.activeRelease,
    targetRelease: value.targetRelease,
    sourceCommit: null,
    backupFile: value.backupFile,
    activePtys: 0,
  });
  const statuses = new Set([
    "queued",
    "running",
    "succeeded",
    "recovered",
    "rolled_back",
    "failed",
  ]);
  const stages = new Set<MaintenanceStage>([
    "queued",
    "validating",
    "stopping",
    "activating",
    "starting",
    "verifying",
    "rolling_back",
    "completed",
  ]);
  const notificationDelivery = value.notificationDelivery ?? "disabled";
  if (
    typeof value.status !== "string" ||
    !statuses.has(value.status) ||
    typeof value.stage !== "string" ||
    !stages.has(value.stage as MaintenanceStage) ||
    typeof value.effectiveRelease !== "string" ||
    !isSafeIdentifier(value.effectiveRelease) ||
    typeof value.updatedAt !== "string" ||
    typeof value.message !== "string" ||
    typeof value.manualRecoveryRequired !== "boolean" ||
    (notificationDelivery !== "sent" &&
      notificationDelivery !== "failed" &&
      notificationDelivery !== "disabled") ||
    (value.service !== null && !isRecord(value.service))
  ) {
    throw new Error("Invalid maintenance result.");
  }
  return {
    ...(value as unknown as MaintenanceResult),
    requestId: request.requestId,
    action: request.action,
    notificationDelivery,
  };
}

function assertMaintenanceRequestPaths(
  request: MaintenanceRequest,
  installation: MaintenanceInstallation,
  requestFile: string,
): void {
  if (request.requestedByUid !== installation.uid) {
    throw new Error("The maintenance request owner does not match the service user.");
  }
  if (requestFile !== requestFileFor(installation, request.requestId)) {
    throw new Error("The maintenance request path is outside the request directory.");
  }
  if (request.action === "restart" && request.targetRelease !== request.activeRelease) {
    throw new Error("A restart request cannot change the active release.");
  }
  if (
    request.action === "deploy" &&
    (request.sourceCommit === null ||
      !/^[0-9a-f]{12,64}$/.test(request.targetRelease) ||
      !request.sourceCommit.startsWith(request.targetRelease) ||
      request.targetRelease === request.activeRelease)
  ) {
    throw new Error("A deploy request does not match its source commit.");
  }
  assertBackupInsideOperationsRoot(request.backupFile, installation);
}

function assertBackupInsideOperationsRoot(
  backupFile: string,
  installation: MaintenanceInstallation,
): void {
  if (dirname(backupFile) !== installation.backupDirectory) {
    throw new Error("The maintenance backup must be inside the Naru backup directory.");
  }
  assertPrivateRegularFile(backupFile, "maintenance backup", installation.uid);
  assertPrivateRegularFile(
    `${backupFile}.manifest.json`,
    "maintenance backup manifest",
    installation.uid,
  );
}

function requestFileFor(installation: MaintenanceInstallation, requestId: string): string {
  if (!isUuid(requestId)) throw new Error("Invalid maintenance request ID.");
  return join(installation.requestDirectory, `${requestId}.json`);
}

function resultFileFor(installation: MaintenanceInstallation, requestId: string): string {
  if (!isUuid(requestId)) throw new Error("Invalid maintenance request ID.");
  return join(installation.resultDirectory, `${requestId}.json`);
}

function updateMaintenanceResult(
  resultFile: string,
  uid: number,
  update: (result: MaintenanceResult) => MaintenanceResult,
  uniqueSuffix: string,
): void {
  const current = parseMaintenanceResult(readPrivateJson(resultFile, uid));
  writeMaintenanceResult(resultFile, uid, update(current), uniqueSuffix);
}

function writeMaintenanceResult(
  resultFile: string,
  uid: number,
  result: MaintenanceResult,
  uniqueSuffix: string,
): void {
  const metadata = lstatSync(resultFile);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.uid !== uid) {
    throw new Error("The maintenance result file is unsafe.");
  }
  const temporaryFile = join(dirname(resultFile), `.result-${uniqueSuffix}.json`);
  writePrivateJsonExclusive(temporaryFile, result);
  renameSync(temporaryFile, resultFile);
}

function readPrivateJson(filename: string, uid: number): unknown {
  assertPrivateRegularFile(filename, "maintenance state file", uid);
  return JSON.parse(readFileSync(filename, "utf8")) as unknown;
}

function writePrivateJsonExclusive(filename: string, value: unknown): void {
  writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: PRIVATE_FILE_MODE,
  });
}

function assertNaruSourceTree(sourceDirectory: string): void {
  for (const relativePath of [
    "PROJECT_BRIEF.md",
    "AGENTS.md",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "apps/server/package.json",
    "ops/launchd/com.naru.agent.plist.template",
    "ops/launchd/com.naru.maintenance.plist.template",
    "ops/bin/naru-ops",
  ]) {
    const metadata = lstatSync(join(sourceDirectory, relativePath));
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Naru source file ${relativePath} must be a regular file.`);
    }
  }
  const packageJson = JSON.parse(readFileSync(join(sourceDirectory, "package.json"), "utf8")) as {
    name?: unknown;
  };
  if (packageJson.name !== "naru") throw new Error("The deployment source is not the Naru repo.");
}

function assertLaunchdTemplatesUnchanged(
  activeReleaseDirectory: string,
  candidateReleaseDirectory: string,
): void {
  for (const relativePath of [
    "ops/launchd/com.naru.agent.plist.template",
    "ops/launchd/com.naru.maintenance.plist.template",
  ]) {
    if (
      readFileSync(join(activeReleaseDirectory, relativePath), "utf8") !==
      readFileSync(join(candidateReleaseDirectory, relativePath), "utf8")
    ) {
      throw new Error(
        "LaunchAgent template changes require the manual install procedure in docs/OPERATIONS.md.",
      );
    }
  }
}

function childBuildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && key !== "NODE_ENV" && !key.startsWith("NARU_")) {
      environment[key] = value;
    }
  }
  environment.PATH = BUILD_PATH;
  return environment;
}

function assertPrivateDirectory(directory: string, label: string, uid: number): void {
  const metadata = lstatSync(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a regular directory.`);
  }
  if (metadata.uid !== uid || (metadata.mode & 0o077) !== 0) {
    throw new Error(`${label} owner or permissions must be the service user and 0700 or stricter.`);
  }
}

function assertPrivateRegularFile(filename: string, label: string, uid: number): void {
  const metadata = lstatSync(filename);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.uid !== uid ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error(`${label} has unsafe ownership or permissions.`);
  }
}

function requiredLaunchdField(output: string, field: string): string {
  const prefix = `${field} = `;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  throw new Error(`launchctl output is missing ${field}.`);
}

function optionalLaunchdEnvironment(output: string, key: string): string | null {
  const prefix = `${key} => `;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return null;
}

function tryCaptureCommand(
  captureCommand: CaptureCommand,
  executable: string,
  args: readonly string[],
): string | null {
  try {
    return captureCommand(executable, args);
  } catch {
    return null;
  }
}

function printLaunchdService(captureCommand: CaptureCommand, serviceTarget: string): string | null {
  try {
    return captureCommand(LAUNCHCTL_EXECUTABLE, ["print", serviceTarget]);
  } catch (error) {
    if (isMissingLaunchdServiceError(error)) return null;
    throw error;
  }
}

function isMissingLaunchdServiceError(error: unknown): boolean {
  if (!isRecord(error) || error.status !== 113) return false;
  const details = [error.stderr, error.message]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  return details.includes("Could not find service");
}

function defaultCaptureCommand(
  executable: string,
  args: readonly string[],
  options: CaptureCommandOptions = {},
): string {
  return execFileSync(executable, [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function defaultRunCommand(
  executable: string,
  args: readonly string[],
  options: RunCommandOptions = {},
): void {
  execFileSync(executable, [...args], {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs,
    stdio: options.inheritOutput ? "inherit" : "ignore",
  });
}

function resolveHostOptions(options: MaintenanceHostOptions): ResolvedMaintenanceHostOptions {
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined || !Number.isInteger(uid) || uid < 0) {
    throw new Error("Naru maintenance requires a macOS user launchd domain.");
  }
  const preflight =
    options.preflight ??
    ((environmentFile: string, rootDirectory: string) =>
      preflightProductionEnvironmentFile(environmentFile, rootDirectory, {
        nodeVersion: options.nodeVersion ?? process.versions.node,
      }));
  return {
    uid,
    homeDirectory: options.homeDirectory ?? homedir(),
    nodeVersion: options.nodeVersion ?? process.versions.node,
    captureCommand: options.captureCommand ?? defaultCaptureCommand,
    runCommand: options.runCommand ?? defaultRunCommand,
    verifyService: options.verifyService ?? verifyRunningProductionService,
    preflight,
    sleep: options.sleep ?? (async (milliseconds) => delay(milliseconds)),
    now: options.now ?? (() => new Date()),
    createId: options.createId ?? randomUUID,
    privateTemporaryDirectory: options.privateTemporaryDirectory ?? "/private/tmp",
    invocationEnvironment: options.invocationEnvironment ?? process.env,
    sendNotification:
      options.sendNotification ??
      ((secretFile, notification) =>
        sendDiscordMaintenanceNotification(secretFile, notification, { uid })),
  };
}

function safeMaintenanceError(error: unknown): string {
  if (!(error instanceof Error)) return "Naru maintenance failed.";
  return error.message.replaceAll(/[\r\n\t]+/g, " ").slice(0, 500);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Naru maintenance failed.", { cause: error });
}

function requiredValue<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Required value is missing.");
  return value;
}

function assertAbsolutePath(value: string, label: string): void {
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
}

function assertSafeIdentifier(value: string, label: string): void {
  if (!isSafeIdentifier(value)) throw new Error(`${label} contains unsupported characters.`);
}

function assertMaintenanceConfirmationId(value: string): void {
  if (!isUuid(value)) {
    throw new Error(
      "Use the one-time confirmation command printed by a fresh read-only naru-ops plan.",
    );
  }
}

function isSafeIdentifier(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
