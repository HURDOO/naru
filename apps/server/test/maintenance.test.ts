import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabaseBackupFromFile } from "../src/database-backup.js";
import type { DiscordMaintenanceNotification } from "../src/discord-notifier.js";
import {
  assertInteractiveMaintenanceInvocation,
  assertMainLaunchdService,
  executeQueuedMaintenance,
  inspectDeploymentSource,
  parseLaunchdServicePrint,
  parseMaintenanceConfirmationArgument,
  planProductionMaintenance,
  prepareAndQueueProductionMaintenance,
  readLatestMaintenanceResult,
  renderMaintenanceLaunchdTemplate,
  resolveMaintenanceInstallation,
  runMaintenanceTransition,
  type MaintenanceInstallation,
  type MaintenanceRequest,
  type MaintenanceTransitionAdapter,
} from "../src/maintenance.js";
import {
  verifyReleaseManifest,
  writeReleaseManifest,
  type RunningServiceReport,
} from "../src/operations.js";

const temporaryDirectories: string[] = [];
const oneTimeConfirmationId = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("maintenance transition", () => {
  it("restarts the current release without changing the active symlink", async () => {
    const steps: string[] = [];
    const result = await runMaintenanceTransition(
      maintenanceRequest("restart"),
      transitionAdapter(steps),
    );

    expect(steps).toEqual(["validate:old-release", "stop", "start", "verify:old-release"]);
    expect(result).toMatchObject({
      status: "succeeded",
      effectiveRelease: "old-release",
      manualRecoveryRequired: false,
    });
  });

  it("stops, activates, starts, and verifies a deploy in order", async () => {
    const steps: string[] = [];
    const request = maintenanceRequest("deploy");
    const result = await runMaintenanceTransition(request, transitionAdapter(steps));

    expect(steps).toEqual([
      "validate:new-release",
      "stop",
      "activate:new-release",
      "start",
      "verify:new-release",
    ]);
    expect(result).toMatchObject({
      status: "succeeded",
      effectiveRelease: "new-release",
      manualRecoveryRequired: false,
      service: { status: "ok" },
    });
  });

  it("rolls code back when the new release fails runtime verification", async () => {
    const steps: string[] = [];
    const adapter = transitionAdapter(steps, { failTargetVerification: true });
    const result = await runMaintenanceTransition(maintenanceRequest("deploy"), adapter);

    expect(steps).toEqual([
      "validate:new-release",
      "stop",
      "activate:new-release",
      "start",
      "verify:new-release",
      "stop",
      "activate:old-release",
      "start",
      "verify:old-release",
    ]);
    expect(result).toMatchObject({
      status: "rolled_back",
      effectiveRelease: "old-release",
      manualRecoveryRequired: false,
    });
  });

  it("leaves a verified backup and requests manual recovery when rollback also fails", async () => {
    const steps: string[] = [];
    const adapter = transitionAdapter(steps, {
      failTargetVerification: true,
      failRollbackVerification: true,
    });
    const result = await runMaintenanceTransition(maintenanceRequest("deploy"), adapter);

    expect(result).toMatchObject({
      status: "failed",
      manualRecoveryRequired: true,
      backupFile: "/private/tmp/naru-backup.sqlite",
    });
    expect(steps.at(-1)).toBe("stop");
  });

  it("does not stop the service when target validation fails", async () => {
    const steps: string[] = [];
    const adapter = transitionAdapter(steps, { failValidation: true });
    const result = await runMaintenanceTransition(maintenanceRequest("deploy"), adapter);

    expect(steps).toEqual(["validate:new-release"]);
    expect(result).toMatchObject({
      status: "failed",
      effectiveRelease: "old-release",
      manualRecoveryRequired: false,
    });
  });
});

describe("queued maintenance worker", () => {
  it("accepts only fresh UUID confirmation arguments from interactive contexts", () => {
    expect(
      parseMaintenanceConfirmationArgument(`--confirm-pty-loss=${oneTimeConfirmationId}`),
    ).toBe(oneTimeConfirmationId);
    expect(() => parseMaintenanceConfirmationArgument("--confirm-pty-loss")).toThrow(
      /one-time confirmation command/,
    );
    expect(() => parseMaintenanceConfirmationArgument("--confirm-pty-loss=not-a-uuid")).toThrow(
      /one-time confirmation command/,
    );

    expect(() => assertInteractiveMaintenanceInvocation({})).not.toThrow();
    expect(() => assertInteractiveMaintenanceInvocation({ XPC_SERVICE_NAME: "0" })).not.toThrow();
    expect(() =>
      assertInteractiveMaintenanceInvocation({ XPC_SERVICE_NAME: "com.naru.agent" }),
    ).not.toThrow();
    expect(() =>
      assertInteractiveMaintenanceInvocation({
        XPC_SERVICE_NAME: "com.naru.first-install.7d282aba8517",
      }),
    ).toThrow(/not another launchd service/);
  });

  it("returns a read-only restart plan until the exact confirmation is supplied", async () => {
    const fixture = queuedMaintenanceFixture();
    const pointerBefore = readFileSync(fixture.pointerFile, "utf8");
    const backupsBefore = readdirSync(fixture.installation.backupDirectory).sort();
    const plan = await planProductionMaintenance(
      "restart",
      fixture.oldReleaseDirectory,
      undefined,
      {
        uid: fixture.uid,
        homeDirectory: fixture.homeDirectory,
        preflight: (_environmentFile, rootDirectory) => productionPreflight(rootDirectory),
        verifyService: () =>
          Promise.resolve({
            ...serviceReport(),
            metrics: { activePtys: 3, activeSessions: 1, activeWebSockets: 1 },
          }),
        captureCommand: () => launchdOutput(fixture.installation),
        createId: () => oneTimeConfirmationId,
      },
    );

    expect(plan).toMatchObject({
      status: "confirmation_required",
      action: "restart",
      activePtys: 3,
      targetRelease: fixture.oldReleaseId,
      notificationConfiguration: "disabled",
      confirmationId: oneTimeConfirmationId,
      confirmationCommand: `naru-ops restart --confirm-pty-loss=${oneTimeConfirmationId}`,
    });
    expect(readFileSync(fixture.pointerFile, "utf8")).toBe(pointerBefore);
    expect(readdirSync(fixture.installation.backupDirectory).sort()).toEqual(backupsBefore);
  });

  it("issues a new one-time confirmation for each read-only plan", async () => {
    const fixture = queuedMaintenanceFixture();
    const pointerBefore = readFileSync(fixture.pointerFile, "utf8");
    const createId = idSequence();
    const options = {
      uid: fixture.uid,
      homeDirectory: fixture.homeDirectory,
      preflight: (_environmentFile: string, rootDirectory: string) =>
        productionPreflight(rootDirectory),
      verifyService: () => Promise.resolve(serviceReport()),
      captureCommand: () => launchdOutput(fixture.installation),
      createId,
    };

    const first = await planProductionMaintenance(
      "restart",
      fixture.oldReleaseDirectory,
      undefined,
      options,
    );
    const second = await planProductionMaintenance(
      "restart",
      fixture.oldReleaseDirectory,
      undefined,
      options,
    );

    expect(first.confirmationId).not.toBe(second.confirmationId);
    expect(first.confirmationCommand).toContain(first.confirmationId);
    expect(second.confirmationCommand).toContain(second.confirmationId);
    expect(readFileSync(fixture.pointerFile, "utf8")).toBe(pointerBefore);
    expect(readdirSync(fixture.installation.confirmationDirectory)).toEqual([]);
  });

  it("serializes confirmed requests and leaves no queue lock after rejecting a busy worker", async () => {
    const fixture = queuedMaintenanceFixture();
    const notifications: DiscordMaintenanceNotification[] = [];

    await expect(
      prepareAndQueueProductionMaintenance(
        "restart",
        fixture.oldReleaseDirectory,
        undefined,
        oneTimeConfirmationId,
        {
          uid: fixture.uid,
          homeDirectory: fixture.homeDirectory,
          preflight: (_environmentFile, rootDirectory) => productionPreflight(rootDirectory),
          verifyService: () => Promise.resolve(serviceReport()),
          captureCommand: () => launchdOutput(fixture.installation),
          sendNotification(_secretFile, notification) {
            notifications.push(notification);
            return Promise.resolve({ status: "sent", httpStatus: 200 });
          },
        },
      ),
    ).rejects.toThrow(/already queued or running/);
    expect(existsSync(fixture.installation.queueLockFile)).toBe(false);
    expect(readdirSync(fixture.installation.confirmationDirectory)).toEqual([]);
    expect(notifications).toEqual([]);
  });

  it("rejects a confirmed request from another LaunchAgent before any side effect", async () => {
    const fixture = queuedMaintenanceFixture();
    const backupsBefore = readdirSync(fixture.installation.backupDirectory).sort();
    const requestsBefore = readdirSync(fixture.installation.requestDirectory).sort();
    const notifications: DiscordMaintenanceNotification[] = [];

    await expect(
      prepareAndQueueProductionMaintenance(
        "restart",
        fixture.oldReleaseDirectory,
        undefined,
        oneTimeConfirmationId,
        {
          uid: fixture.uid,
          homeDirectory: fixture.homeDirectory,
          invocationEnvironment: {
            XPC_SERVICE_NAME: "com.naru.first-install.7d282aba8517",
          },
          sendNotification(_secretFile, notification) {
            notifications.push(notification);
            return Promise.resolve({ status: "sent", httpStatus: 200 });
          },
        },
      ),
    ).rejects.toThrow(/not another launchd service/);

    expect(readdirSync(fixture.installation.backupDirectory).sort()).toEqual(backupsBefore);
    expect(readdirSync(fixture.installation.requestDirectory).sort()).toEqual(requestsBefore);
    expect(readdirSync(fixture.installation.confirmationDirectory)).toEqual([]);
    expect(notifications).toEqual([]);
  });

  it("consumes one confirmation once across concurrent and sequential replays", async () => {
    const fixture = queuedMaintenanceFixture();
    rmSync(fixture.pointerFile);
    writeFileSync(fixture.installation.maintenanceLaunchAgentFile, "<plist/>", { mode: 0o600 });
    const backupsBefore = readdirSync(fixture.installation.backupDirectory).sort();
    const requestsBefore = readdirSync(fixture.installation.requestDirectory).sort();
    let notificationCount = 0;
    let signalPreparationStarted!: () => void;
    let releasePreparation!: (delivery: { status: "sent"; httpStatus: 200 }) => void;
    const preparationStarted = new Promise<void>((resolve) => {
      signalPreparationStarted = resolve;
    });
    const preparationGate = new Promise<{ status: "sent"; httpStatus: 200 }>((resolve) => {
      releasePreparation = resolve;
    });
    const createId = idSequence();
    const options = {
      uid: fixture.uid,
      homeDirectory: fixture.homeDirectory,
      preflight: (_environmentFile: string, rootDirectory: string) =>
        productionPreflight(rootDirectory),
      verifyService: () => Promise.resolve(serviceReport()),
      createId,
      sendNotification() {
        notificationCount += 1;
        signalPreparationStarted();
        return preparationGate;
      },
      captureCommand(executable: string, args: readonly string[]) {
        if (executable === "/usr/bin/plutil") {
          return installedPlistValue(fixture, args.at(-1) ?? "", args[1] ?? "");
        }
        if (executable !== "/bin/launchctl") throw new Error("Unexpected executable");
        if (args[0] === "print" && args[1] === fixture.installation.mainServiceTarget) {
          return launchdOutput(fixture.installation);
        }
        if (args[0] === "print" && args[1] === fixture.installation.maintenanceServiceTarget) {
          return maintenanceLaunchdOutput(fixture.installation);
        }
        if (args[0] === "kickstart") return "";
        throw new Error(`Unexpected launchctl operation: ${args.join(" ")}`);
      },
    };

    const first = prepareAndQueueProductionMaintenance(
      "restart",
      fixture.oldReleaseDirectory,
      undefined,
      oneTimeConfirmationId,
      options,
    );
    await preparationStarted;

    await expect(
      prepareAndQueueProductionMaintenance(
        "restart",
        fixture.oldReleaseDirectory,
        undefined,
        oneTimeConfirmationId,
        options,
      ),
    ).rejects.toThrow(/being queued/);
    expect(notificationCount).toBe(1);

    releasePreparation({ status: "sent", httpStatus: 200 });
    const report = await first;
    const resultFile = join(fixture.installation.resultDirectory, `${report.requestId}.json`);
    const completed = JSON.parse(readFileSync(resultFile, "utf8")) as Record<string, unknown>;
    writePrivateJson(resultFile, {
      ...completed,
      status: "succeeded",
      stage: "completed",
      updatedAt: "2026-08-18T03:00:00.000Z",
    });
    const backupsAfterFirst = readdirSync(fixture.installation.backupDirectory).sort();
    const requestsAfterFirst = readdirSync(fixture.installation.requestDirectory).sort();

    await expect(
      prepareAndQueueProductionMaintenance(
        "restart",
        fixture.oldReleaseDirectory,
        undefined,
        oneTimeConfirmationId,
        options,
      ),
    ).rejects.toThrow(/already used/);

    expect(notificationCount).toBe(1);
    expect(backupsAfterFirst).toHaveLength(backupsBefore.length + 2);
    expect(readdirSync(fixture.installation.backupDirectory).sort()).toEqual(backupsAfterFirst);
    expect(requestsAfterFirst).toHaveLength(requestsBefore.length + 1);
    expect(readdirSync(fixture.installation.requestDirectory).sort()).toEqual(requestsAfterFirst);
    const receipts = readdirSync(fixture.installation.confirmationDirectory);
    expect(receipts).toEqual([`${oneTimeConfirmationId}.json`]);
    expect(
      statSync(join(fixture.installation.confirmationDirectory, receipts[0] ?? "")).mode & 0o777,
    ).toBe(0o600);
    expect(existsSync(fixture.installation.queueLockFile)).toBe(false);
  });

  it("does not repeat notifications when an admitted preparation fails", async () => {
    const fixture = queuedMaintenanceFixture();
    rmSync(fixture.pointerFile);
    const backupsBefore = readdirSync(fixture.installation.backupDirectory).sort();
    const requestsBefore = readdirSync(fixture.installation.requestDirectory).sort();
    const notifications: DiscordMaintenanceNotification[] = [];
    const options = {
      uid: fixture.uid,
      homeDirectory: fixture.homeDirectory,
      preflight: (_environmentFile: string, rootDirectory: string) =>
        productionPreflight(rootDirectory),
      verifyService: () => Promise.resolve(serviceReport()),
      createId: idSequence(),
      sendNotification(_secretFile: string, notification: DiscordMaintenanceNotification) {
        notifications.push(notification);
        return Promise.resolve({ status: "sent" as const, httpStatus: 200 });
      },
      captureCommand(executable: string, args: readonly string[]) {
        if (executable === "/usr/bin/plutil") {
          return installedPlistValue(fixture, args.at(-1) ?? "", args[1] ?? "");
        }
        if (
          executable === "/bin/launchctl" &&
          args[0] === "print" &&
          args[1] === fixture.installation.mainServiceTarget
        ) {
          return launchdOutput(fixture.installation);
        }
        throw new Error(`Unexpected command: ${executable} ${args.join(" ")}`);
      },
    };

    await expect(
      prepareAndQueueProductionMaintenance(
        "restart",
        fixture.oldReleaseDirectory,
        undefined,
        oneTimeConfirmationId,
        options,
      ),
    ).rejects.toThrow();
    expect(notifications).toMatchObject([
      { event: "preparing", phase: "preparation" },
      { event: "failed", phase: "preparation" },
    ]);

    await expect(
      prepareAndQueueProductionMaintenance(
        "restart",
        fixture.oldReleaseDirectory,
        undefined,
        oneTimeConfirmationId,
        options,
      ),
    ).rejects.toThrow(/already used/);
    expect(notifications).toHaveLength(2);
    expect(readdirSync(fixture.installation.backupDirectory).sort()).toEqual(backupsBefore);
    expect(readdirSync(fixture.installation.requestDirectory).sort()).toEqual(requestsBefore);
    expect(readdirSync(fixture.installation.confirmationDirectory)).toEqual([
      `${oneTimeConfirmationId}.json`,
    ]);
  });

  it("records and announces a failed handoff when the maintenance worker cannot start", async () => {
    const fixture = queuedMaintenanceFixture();
    rmSync(fixture.pointerFile);
    writeFileSync(fixture.installation.maintenanceLaunchAgentFile, "<plist/>", { mode: 0o600 });
    const notifications: DiscordMaintenanceNotification[] = [];

    await expect(
      prepareAndQueueProductionMaintenance(
        "restart",
        fixture.oldReleaseDirectory,
        undefined,
        oneTimeConfirmationId,
        {
          uid: fixture.uid,
          homeDirectory: fixture.homeDirectory,
          preflight: (_environmentFile, rootDirectory) => productionPreflight(rootDirectory),
          verifyService: () => Promise.resolve(serviceReport()),
          createId: idSequence(),
          sendNotification(_secretFile, notification) {
            notifications.push(notification);
            return Promise.resolve({ status: "sent", httpStatus: 200 });
          },
          captureCommand(executable, args) {
            if (executable === "/usr/bin/plutil") {
              return installedPlistValue(fixture, args.at(-1) ?? "", args[1] ?? "");
            }
            if (executable !== "/bin/launchctl") throw new Error("Unexpected executable");
            if (args[0] === "print" && args[1] === fixture.installation.mainServiceTarget) {
              return launchdOutput(fixture.installation);
            }
            if (args[0] === "print" && args[1] === fixture.installation.maintenanceServiceTarget) {
              return maintenanceLaunchdOutput(fixture.installation);
            }
            if (args[0] === "kickstart") throw new Error("maintenance kickstart failed");
            throw new Error(`Unexpected launchctl operation: ${args.join(" ")}`);
          },
        },
      ),
    ).rejects.toThrow(/kickstart failed/);

    expect(
      readLatestMaintenanceResult(fixture.oldReleaseDirectory, {
        uid: fixture.uid,
        homeDirectory: fixture.homeDirectory,
      }),
    ).toMatchObject({
      status: "failed",
      stage: "completed",
      effectiveRelease: fixture.oldReleaseId,
      notificationDelivery: "sent",
    });
    expect(notifications).toMatchObject([
      { event: "preparing", phase: "preparation" },
      { event: "failed", phase: "preparation" },
    ]);
    expect(existsSync(fixture.installation.queueLockFile)).toBe(false);
  });

  it("archives the inspected commit, validates it, and queues a confirmed deploy", async () => {
    const fixture = queuedMaintenanceFixture();
    rmSync(fixture.pointerFile);
    rmSync(join(fixture.installation.releasesDirectory, fixture.newReleaseId), {
      recursive: true,
    });

    const fixtureRoot = dirname(fixture.installation.opsRoot);
    const source = join(fixtureRoot, "editor");
    const archiveDirectory = join(fixtureRoot, "archives");
    mkdirSync(source, { mode: 0o700 });
    mkdirSync(archiveDirectory, { mode: 0o700 });
    createNaruSourceFixture(source);
    writeFileSync(fixture.installation.maintenanceLaunchAgentFile, "<plist/>", { mode: 0o600 });

    const sourceCommit = `${fixture.newReleaseId}${"c".repeat(28)}`;
    const gitCapture = gitFixtureCommand(source, "", sourceCommit);
    const validationCommands: string[][] = [];
    let observedBuildEnvironment: NodeJS.ProcessEnv | undefined;
    let archivedCommit = "";
    let archiveFile = "";
    let maintenanceKickstarted = false;
    const notifications: DiscordMaintenanceNotification[] = [];

    const report = await prepareAndQueueProductionMaintenance(
      "deploy",
      fixture.oldReleaseDirectory,
      source,
      oneTimeConfirmationId,
      {
        uid: fixture.uid,
        homeDirectory: fixture.homeDirectory,
        privateTemporaryDirectory: archiveDirectory,
        preflight: (_environmentFile, rootDirectory) => productionPreflight(rootDirectory),
        verifyService: () => Promise.resolve(serviceReport()),
        createId: idSequence(),
        now: () => new Date("2026-08-18T02:00:00.000Z"),
        captureCommand(executable, args) {
          if (executable === "/usr/bin/git") return gitCapture(executable, args);
          if (executable === "/usr/bin/plutil") {
            return installedPlistValue(fixture, args.at(-1) ?? "", args[1] ?? "");
          }
          if (executable !== "/bin/launchctl") throw new Error("Unexpected executable");
          if (args[0] === "print" && args[1] === fixture.installation.mainServiceTarget) {
            return launchdOutput(fixture.installation);
          }
          if (args[0] === "print" && args[1] === fixture.installation.maintenanceServiceTarget) {
            return maintenanceLaunchdOutput(fixture.installation);
          }
          if (args[0] === "kickstart") {
            maintenanceKickstarted = true;
            return "";
          }
          throw new Error(`Unexpected launchctl operation: ${args.join(" ")}`);
        },
        runCommand(executable, args, options) {
          if (executable === "/usr/bin/git") {
            archivedCommit = args[4] ?? "";
            archiveFile = (args.find((value) => value.startsWith("--output=")) ?? "").slice(9);
            writeFileSync(archiveFile, "archive", { mode: 0o666 });
            return;
          }
          if (executable === "/usr/bin/tar") {
            const stagingDirectory = args[args.indexOf("-C") + 1];
            if (stagingDirectory === undefined) throw new Error("Missing staging directory");
            createCandidateContents(stagingDirectory, fixture.oldReleaseDirectory);
            return;
          }
          if (executable === "/opt/homebrew/bin/pnpm") {
            validationCommands.push([...args]);
            observedBuildEnvironment = options?.env;
            return;
          }
          throw new Error(`Unexpected build executable: ${executable}`);
        },
        sendNotification(secretFile, notification) {
          expect(secretFile).toBe(fixture.installation.discordWebhookFile);
          notifications.push(notification);
          return Promise.reject(new Error("Discord unavailable"));
        },
      },
    );

    expect(report).toMatchObject({
      status: "queued",
      action: "deploy",
      activeRelease: fixture.oldReleaseId,
      targetRelease: fixture.newReleaseId,
      notificationDelivery: "failed",
    });
    expect(notifications).toMatchObject([{ event: "preparing", phase: "preparation" }]);
    expect(archivedCommit).toBe(sourceCommit);
    expect(statSync(archiveFile).mode & 0o777).toBe(0o600);
    expect(validationCommands).toEqual([
      ["install", "--frozen-lockfile", "--prod=false"],
      ["format"],
      ["lint"],
      ["typecheck"],
      ["test"],
      ["build"],
      ["test:operations"],
      ["test:production-smoke"],
    ]);
    expect(observedBuildEnvironment?.NODE_ENV).toBeUndefined();
    expect(Object.keys(observedBuildEnvironment ?? {}).some((key) => key.startsWith("NARU_"))).toBe(
      false,
    );
    expect(maintenanceKickstarted).toBe(true);
    expect(existsSync(fixture.installation.queueLockFile)).toBe(false);
    expect(() =>
      verifyReleaseManifest(
        join(fixture.installation.releasesDirectory, fixture.newReleaseId),
        fixture.newReleaseId,
      ),
    ).not.toThrow();
  });

  it("executes a private deploy request after the main service hands it off", async () => {
    const fixture = queuedMaintenanceFixture();
    let mainServiceRunning = true;
    const notifications: DiscordMaintenanceNotification[] = [];
    let persistedStatusWhenNotified = "";
    const result = await executeQueuedMaintenance(
      fixture.pointerFile,
      fixture.oldReleaseDirectory,
      {
        uid: fixture.uid,
        homeDirectory: fixture.homeDirectory,
        preflight: (_environmentFile, rootDirectory) => productionPreflight(rootDirectory),
        verifyService: () => Promise.resolve(serviceReport()),
        sleep: () => Promise.resolve(),
        createId: idSequence(),
        now: () => new Date("2026-08-18T01:00:00.000Z"),
        sendNotification(secretFile, notification) {
          expect(secretFile).toBe(fixture.installation.discordWebhookFile);
          persistedStatusWhenNotified = String(
            (
              JSON.parse(
                readFileSync(
                  join(
                    fixture.installation.resultDirectory,
                    "22222222-2222-4222-8222-222222222222.json",
                  ),
                  "utf8",
                ),
              ) as { status?: unknown }
            ).status,
          );
          notifications.push(notification);
          return Promise.resolve({ status: "sent", httpStatus: 200 });
        },
        captureCommand(executable, args) {
          if (executable === "/usr/bin/plutil") {
            return plistValue(fixture, args[1] ?? "");
          }
          if (executable !== "/bin/launchctl") throw new Error("Unexpected executable");
          if (args[0] === "print") {
            if (!mainServiceRunning) throw missingLaunchdServiceError();
            return launchdOutput(fixture.installation);
          }
          if (args[0] === "bootout") {
            mainServiceRunning = false;
            return "";
          }
          if (args[0] === "bootstrap") {
            mainServiceRunning = true;
            return "";
          }
          throw new Error(`Unexpected launchctl operation: ${args.join(" ")}`);
        },
      },
    );

    expect(result).toMatchObject({
      status: "succeeded",
      effectiveRelease: fixture.newReleaseId,
      notificationDelivery: "sent",
      service: { readiness: "ready" },
    });
    expect(notifications).toMatchObject([
      {
        event: "succeeded",
        phase: "worker",
        action: "deploy",
        activePtys: 2,
        effectiveRelease: fixture.newReleaseId,
      },
    ]);
    expect(persistedStatusWhenNotified).toBe("succeeded");
    expect(readlinkSync(join(fixture.installation.releasesDirectory, "current"))).toBe(
      fixture.newReleaseId,
    );
    expect(mainServiceRunning).toBe(true);
  });

  it("does not mistake a launchctl inspection failure for an unloaded main service", async () => {
    const fixture = queuedMaintenanceFixture();
    const mutations: string[] = [];

    const result = await executeQueuedMaintenance(
      fixture.pointerFile,
      fixture.oldReleaseDirectory,
      {
        uid: fixture.uid,
        homeDirectory: fixture.homeDirectory,
        preflight: (_environmentFile, rootDirectory) => productionPreflight(rootDirectory),
        verifyService: () => Promise.resolve(serviceReport()),
        sleep: () => Promise.resolve(),
        createId: idSequence(),
        captureCommand(executable, args) {
          if (executable === "/usr/bin/plutil") {
            return plistValue(fixture, args[1] ?? "");
          }
          if (executable !== "/bin/launchctl") throw new Error("Unexpected executable");
          if (args[0] === "print") throw new Error("launchctl inspection unavailable");
          mutations.push(args[0] ?? "unknown");
          return "";
        },
      },
    );

    expect(result).toMatchObject({
      status: "failed",
      effectiveRelease: fixture.oldReleaseId,
      manualRecoveryRequired: false,
    });
    expect(mutations).toEqual([]);
    expect(readlinkSync(fixture.installation.currentLink)).toBe(fixture.oldReleaseId);
  });

  it("rejects a permissive backup before stopping the main service", async () => {
    const fixture = queuedMaintenanceFixture();
    chmodSync(fixture.backupFile, 0o644);

    const result = await executeQueuedMaintenance(
      fixture.pointerFile,
      fixture.oldReleaseDirectory,
      {
        uid: fixture.uid,
        homeDirectory: fixture.homeDirectory,
        preflight: (_environmentFile, rootDirectory) => productionPreflight(rootDirectory),
        captureCommand: () => {
          throw new Error("The service must not be touched");
        },
      },
    );

    expect(result).toMatchObject({
      status: "failed",
      effectiveRelease: fixture.oldReleaseId,
      manualRecoveryRequired: false,
    });
  });

  it("rejects an active release directory with non-private permissions", () => {
    const fixture = queuedMaintenanceFixture();
    chmodSync(fixture.oldReleaseDirectory, 0o755);

    expect(() =>
      resolveMaintenanceInstallation(fixture.oldReleaseDirectory, {
        uid: fixture.uid,
        homeDirectory: fixture.homeDirectory,
      }),
    ).toThrow(/owner or permissions/);
  });
});

describe("launchd maintenance boundaries", () => {
  it("parses and accepts only the expected running main service", () => {
    const installation = installationFixture("/private/tmp/Naru");
    const output = launchdOutput(installation);
    expect(parseLaunchdServicePrint(output)).toEqual({
      state: "running",
      program: "/opt/homebrew/opt/node@24/bin/node",
      workingDirectory: installation.currentLink,
      environmentFile: installation.environmentFile,
    });
    expect(() => assertMainLaunchdService(output, installation)).not.toThrow();
    expect(() =>
      assertMainLaunchdService(output.replace("state = running", "state = exited"), installation),
    ).toThrow(/not running/);
    expect(() =>
      assertMainLaunchdService(output.replace("node@24", "node@26"), installation),
    ).toThrow(/Node 24/);
  });

  it("renders a one-shot maintenance LaunchAgent without unresolved values", () => {
    const rendered = renderMaintenanceLaunchdTemplate(
      "<string>__LABEL__</string><string>__NODE_EXECUTABLE__</string><string>__WORKING_DIRECTORY__</string><string>__MAINTENANCE_ENTRY__</string><string>__REQUEST_POINTER_FILE__</string><string>__HELPER_DIRECTORY__</string><string>__STANDARD_OUT_PATH__</string><string>__STANDARD_ERROR_PATH__</string>",
      {
        label: "com.naru&maintenance",
        nodeExecutable: "/opt/node@24/bin/node",
        workingDirectory: "/tmp/Naru & Current",
        requestPointerFile: "/tmp/Naru/current-request.json",
        standardOutPath: "/tmp/Naru/maintenance.out.log",
        standardErrorPath: "/tmp/Naru/maintenance.err.log",
      },
    );

    expect(rendered).toContain("com.naru&amp;maintenance");
    expect(rendered).toContain("/tmp/Naru &amp; Current/apps/server/dist/maintenance-cli.js");
    expect(rendered).toContain("/tmp/Naru &amp; Current/ops/bin");
    expect(rendered).not.toMatch(/__[A-Z_]+__/);
  });
});

describe("deployment source", () => {
  it("accepts only a clean committed Naru repository root", () => {
    const root = temporaryDirectory();
    const source = join(root, "editor");
    mkdirSync(source, { mode: 0o700 });
    createNaruSourceFixture(source);
    const installation = installationFixture(join(root, "Naru"));
    const capture = gitFixtureCommand(source, "");

    expect(inspectDeploymentSource(source, installation, capture)).toEqual({
      sourceDirectory: realpathSync(source),
      commit: "a".repeat(40),
      releaseId: "a".repeat(12),
      branch: "main",
      candidateExists: false,
    });
  });

  it("rejects uncommitted and untracked deployment input", () => {
    const root = temporaryDirectory();
    const source = join(root, "editor");
    mkdirSync(source, { mode: 0o700 });
    const installation = installationFixture(join(root, "Naru"));

    expect(() =>
      inspectDeploymentSource(source, installation, gitFixtureCommand(source, " M docs/SPEC.md")),
    ).toThrow(/clean Git tree/);
  });
});

function transitionAdapter(
  steps: string[],
  options: {
    failValidation?: boolean;
    failTargetVerification?: boolean;
    failRollbackVerification?: boolean;
  } = {},
): MaintenanceTransitionAdapter {
  return {
    validateTarget(request) {
      steps.push(`validate:${request.targetRelease}`);
      return options.failValidation
        ? Promise.reject(new Error("candidate invalid"))
        : Promise.resolve();
    },
    stopMainService() {
      steps.push("stop");
      return Promise.resolve();
    },
    activate(releaseId) {
      steps.push(`activate:${releaseId}`);
      return Promise.resolve();
    },
    startMainService() {
      steps.push("start");
      return Promise.resolve();
    },
    verifyMainService(releaseId) {
      steps.push(`verify:${releaseId}`);
      if (releaseId === "new-release" && options.failTargetVerification) {
        return Promise.reject(new Error("new release failed"));
      }
      if (releaseId === "old-release" && options.failRollbackVerification) {
        return Promise.reject(new Error("old release failed"));
      }
      return Promise.resolve(serviceReport());
    },
  };
}

function maintenanceRequest(action: "restart" | "deploy"): MaintenanceRequest {
  return {
    formatVersion: 1,
    requestId: "11111111-1111-4111-8111-111111111111",
    action,
    requestedAt: "2026-08-18T00:00:00.000Z",
    requestedByUid: 501,
    activeRelease: "old-release",
    targetRelease: action === "deploy" ? "new-release" : "old-release",
    sourceCommit: action === "deploy" ? "a".repeat(40) : null,
    backupFile: "/private/tmp/naru-backup.sqlite",
    activePtys: 3,
  };
}

function serviceReport(): RunningServiceReport {
  return {
    status: "ok",
    health: "ok",
    readiness: "ready",
    listeners: ["10.23.45.10"],
    metrics: { activePtys: 0, activeSessions: 0, activeWebSockets: 0 },
  };
}

function installationFixture(opsRoot: string): MaintenanceInstallation {
  const releasesDirectory = join(opsRoot, "releases");
  const currentLink = join(releasesDirectory, "current");
  return {
    uid: 501,
    opsRoot,
    releasesDirectory,
    currentLink,
    activeReleaseDirectory: join(releasesDirectory, "old-release"),
    activeReleaseId: "old-release",
    environmentFile: join(opsRoot, "env", "naru.env"),
    discordWebhookFile: join(opsRoot, "env", "discord-webhook.url"),
    backupDirectory: join(opsRoot, "backups"),
    maintenanceDirectory: join(opsRoot, "maintenance"),
    confirmationDirectory: join(opsRoot, "maintenance", "confirmations"),
    requestDirectory: join(opsRoot, "maintenance", "requests"),
    resultDirectory: join(opsRoot, "maintenance", "results"),
    requestPointerFile: join(opsRoot, "maintenance", "current-request.json"),
    queueLockFile: join(opsRoot, "maintenance", "queue.lock"),
    mainLaunchAgentFile: "/Users/test/Library/LaunchAgents/com.naru.agent.plist",
    maintenanceLaunchAgentFile: "/Users/test/Library/LaunchAgents/com.naru.maintenance.plist",
    mainServiceTarget: "gui/501/com.naru.agent",
    maintenanceServiceTarget: "gui/501/com.naru.maintenance",
  };
}

function launchdOutput(installation: MaintenanceInstallation): string {
  return [
    "state = running",
    "program = /opt/homebrew/opt/node@24/bin/node",
    `working directory = ${installation.currentLink}`,
    `NARU_ENV_FILE => ${installation.environmentFile}`,
  ].join("\n");
}

function maintenanceLaunchdOutput(installation: MaintenanceInstallation): string {
  return [
    "state = not running",
    "program = /opt/homebrew/opt/node@24/bin/node",
    `working directory = ${installation.currentLink}`,
  ].join("\n");
}

function missingLaunchdServiceError(): Error & { status: number; stderr: string } {
  return Object.assign(new Error("Could not find service"), {
    status: 113,
    stderr: "Bad request. Could not find service in domain.",
  });
}

function createNaruSourceFixture(source: string): void {
  const files: Record<string, string> = {
    "PROJECT_BRIEF.md": "brief\n",
    "AGENTS.md": "agents\n",
    "package.json": '{"name":"naru"}\n',
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "pnpm-workspace.yaml": "packages: []\n",
    "apps/server/package.json": '{"name":"@naru/server"}\n',
    "ops/launchd/com.naru.agent.plist.template": "agent\n",
    "ops/launchd/com.naru.maintenance.plist.template": "maintenance\n",
    "ops/bin/naru-ops": "#!/bin/sh\n",
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    const filename = join(source, relativePath);
    mkdirSync(join(filename, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(filename, contents, {
      mode: relativePath === "ops/bin/naru-ops" ? 0o700 : 0o600,
    });
  }
}

function gitFixtureCommand(source: string, status: string, commit = "a".repeat(40)) {
  const releaseId = commit.slice(0, 12);
  return (_executable: string, args: readonly string[]): string => {
    const operation = args.slice(2).join(" ");
    if (operation === "rev-parse --show-toplevel") return `${source}\n`;
    if (operation === "status --porcelain=v1 --untracked-files=all") return `${status}\n`;
    if (operation === "rev-parse HEAD") return `${commit}\n`;
    if (operation === "rev-parse --short=12 HEAD") return `${releaseId}\n`;
    if (operation === "rev-parse --abbrev-ref HEAD") return "main\n";
    throw new Error(`Unexpected git operation: ${operation}`);
  };
}

interface QueuedMaintenanceFixture {
  uid: number;
  homeDirectory: string;
  pointerFile: string;
  oldReleaseDirectory: string;
  oldReleaseId: string;
  newReleaseId: string;
  backupFile: string;
  installation: MaintenanceInstallation;
}

function queuedMaintenanceFixture(): QueuedMaintenanceFixture {
  const root = temporaryDirectory();
  const opsRoot = join(root, "Naru");
  const releasesDirectory = join(opsRoot, "releases");
  const environmentDirectory = join(opsRoot, "env");
  const backupDirectory = join(opsRoot, "backups");
  const maintenanceDirectory = join(opsRoot, "maintenance");
  const confirmationDirectory = join(maintenanceDirectory, "confirmations");
  const requestDirectory = join(maintenanceDirectory, "requests");
  const resultDirectory = join(maintenanceDirectory, "results");
  const dataDirectory = join(opsRoot, "data");
  const projectRoot = join(root, "projects");
  const homeDirectory = join(root, "home");
  const launchAgents = join(homeDirectory, "Library", "LaunchAgents");
  for (const directory of [
    opsRoot,
    releasesDirectory,
    environmentDirectory,
    backupDirectory,
    maintenanceDirectory,
    confirmationDirectory,
    requestDirectory,
    resultDirectory,
    dataDirectory,
    projectRoot,
    launchAgents,
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }

  const oldReleaseId = "a".repeat(12);
  const newReleaseId = "b".repeat(12);
  const oldReleaseDirectory = createReleaseFixture(releasesDirectory, oldReleaseId);
  createReleaseFixture(releasesDirectory, newReleaseId);
  symlinkSync(oldReleaseId, join(releasesDirectory, "current"), "dir");
  const currentLink = join(releasesDirectory, "current");
  const codexExecutable = join(root, "codex");
  writeFileSync(codexExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });

  const databaseFile = join(dataDirectory, "naru.sqlite");
  const database = new Database(databaseFile);
  database.exec(
    "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (3, 'now');",
  );
  database.close();
  chmodSync(databaseFile, 0o600);
  const backup = createDatabaseBackupFromFile(
    databaseFile,
    backupDirectory,
    oldReleaseId,
    "pre-deploy",
  );

  const validPasswordHash = [
    "scrypt",
    "32768",
    "8",
    "1",
    Buffer.alloc(16, 1).toString("base64url"),
    Buffer.alloc(64, 2).toString("base64url"),
  ].join("$");
  const environmentFile = join(environmentDirectory, "naru.env");
  writeFileSync(
    environmentFile,
    [
      ["NODE_ENV", "production"],
      ["SHELL", "/bin/sh"],
      ["NARU_HOST", "127.0.0.1"],
      ["NARU_PORT", "4174"],
      ["NARU_ALLOWED_ORIGINS", "http://127.0.0.1:4174"],
      ["NARU_PROJECT_ROOTS", projectRoot],
      ["NARU_AUTH_MODE", "app-managed"],
      ["NARU_PASSWORD_HASH", validPasswordHash],
      ["NARU_SESSION_SECRET", "a-production-session-secret-with-many-symbols-12345"],
      ["NARU_DATA_DIR", dataDirectory],
      ["NARU_WEB_DIST", join(currentLink, "apps/web/dist")],
      ["NARU_CODEX_PATH", codexExecutable],
    ]
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );

  const uid = process.getuid?.() ?? 501;
  const requestId = "22222222-2222-4222-8222-222222222222";
  const requestedAt = "2026-08-18T00:00:00.000Z";
  const request: MaintenanceRequest = {
    formatVersion: 1,
    requestId,
    action: "deploy",
    requestedAt,
    requestedByUid: uid,
    activeRelease: oldReleaseId,
    targetRelease: newReleaseId,
    sourceCommit: `${newReleaseId}${"c".repeat(28)}`,
    backupFile: backup.backupFile,
    activePtys: 2,
  };
  const result = {
    formatVersion: 1,
    requestId,
    action: "deploy",
    status: "queued",
    stage: "queued",
    activeRelease: oldReleaseId,
    targetRelease: newReleaseId,
    effectiveRelease: oldReleaseId,
    backupFile: backup.backupFile,
    requestedAt,
    updatedAt: requestedAt,
    message: "queued",
    manualRecoveryRequired: false,
    service: null,
  };
  const pointerFile = join(maintenanceDirectory, "current-request.json");
  writePrivateJson(join(requestDirectory, `${requestId}.json`), request);
  writePrivateJson(join(resultDirectory, `${requestId}.json`), result);
  writePrivateJson(pointerFile, { formatVersion: 1, requestId });

  const mainLaunchAgentFile = join(launchAgents, "com.naru.agent.plist");
  writeFileSync(mainLaunchAgentFile, "<plist/>", { mode: 0o600 });
  const installation: MaintenanceInstallation = {
    ...installationFixture(opsRoot),
    uid,
    activeReleaseDirectory: oldReleaseDirectory,
    activeReleaseId: oldReleaseId,
    mainLaunchAgentFile,
    maintenanceLaunchAgentFile: join(launchAgents, "com.naru.maintenance.plist"),
    mainServiceTarget: `gui/${uid}/com.naru.agent`,
    maintenanceServiceTarget: `gui/${uid}/com.naru.maintenance`,
  };

  return {
    uid,
    homeDirectory,
    pointerFile,
    oldReleaseDirectory,
    oldReleaseId,
    newReleaseId,
    backupFile: backup.backupFile,
    installation,
  };
}

function createCandidateContents(stagingDirectory: string, activeReleaseDirectory: string): void {
  mkdirSync(join(stagingDirectory, "node_modules"), { recursive: true, mode: 0o700 });
  for (const filename of [
    "apps/server/dist/index.js",
    "apps/server/dist/maintenance-cli.js",
    "apps/server/dist/operations-cli.js",
    "apps/web/dist/index.html",
    "ops/bin/naru-ops",
    "ops/launchd/com.naru.agent.plist.template",
    "ops/launchd/com.naru.maintenance.plist.template",
    "package.json",
    "pnpm-lock.yaml",
  ]) {
    const target = join(stagingDirectory, filename);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const activeFile = join(activeReleaseDirectory, filename);
    const contents = filename.startsWith("ops/launchd/")
      ? readFileSync(activeFile, "utf8")
      : `candidate:${filename}\n`;
    writeFileSync(target, contents, {
      mode: filename === "ops/bin/naru-ops" ? 0o700 : 0o600,
    });
  }
}

function createReleaseFixture(parent: string, releaseId: string): string {
  const release = join(parent, releaseId);
  mkdirSync(join(release, "node_modules"), { recursive: true, mode: 0o700 });
  for (const filename of [
    "apps/server/dist/index.js",
    "apps/server/dist/maintenance-cli.js",
    "apps/server/dist/operations-cli.js",
    "apps/web/dist/index.html",
    "ops/bin/naru-ops",
    "ops/launchd/com.naru.agent.plist.template",
    "ops/launchd/com.naru.maintenance.plist.template",
    "package.json",
    "pnpm-lock.yaml",
  ]) {
    const target = join(release, filename);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, `${releaseId}:${filename}\n`, {
      mode: filename === "ops/bin/naru-ops" ? 0o700 : 0o600,
    });
  }
  writeReleaseManifest(release, releaseId);
  return release;
}

function productionPreflight(rootDirectory: string) {
  return {
    status: "ok" as const,
    nodeVersion: "24.19.0",
    host: "127.0.0.1",
    port: 4174,
    origin: "http://127.0.0.1:4174",
    sessionCookieName: "naru_session",
    projectRootCount: 1,
    allowedClientCount: 0,
    dataDirectoryReady: true,
    webBuildReady: true,
    shellExecutableReady: true,
    codexExecutableConfigured: true,
    tlsReady: false,
    rootDirectory,
  };
}

function plistValue(fixture: QueuedMaintenanceFixture, keyPath: string): string {
  return installedPlistValue(fixture, fixture.installation.mainLaunchAgentFile, keyPath);
}

function installedPlistValue(
  fixture: QueuedMaintenanceFixture,
  plist: string,
  keyPath: string,
): string {
  const path = `${join(fixture.installation.currentLink, "ops/bin")}:/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  const maintenanceValues: Record<string, string> = {
    Label: "com.naru.maintenance",
    "ProgramArguments.0": "/opt/homebrew/opt/node@24/bin/node",
    "ProgramArguments.1": join(
      fixture.installation.currentLink,
      "apps/server/dist/maintenance-cli.js",
    ),
    "ProgramArguments.2": fixture.installation.requestPointerFile,
    WorkingDirectory: fixture.installation.currentLink,
    "EnvironmentVariables.PATH": path,
  };
  const values: Record<string, string> = {
    Label: "com.naru.agent",
    "ProgramArguments.0": "/opt/homebrew/opt/node@24/bin/node",
    "ProgramArguments.1": join(fixture.installation.currentLink, "apps/server/dist/index.js"),
    WorkingDirectory: fixture.installation.currentLink,
    "EnvironmentVariables.NARU_ENV_FILE": fixture.installation.environmentFile,
    "EnvironmentVariables.PATH": path,
  };
  const value =
    plist === fixture.installation.maintenanceLaunchAgentFile
      ? maintenanceValues[keyPath]
      : values[keyPath];
  if (value === undefined) throw new Error(`Unexpected plist key: ${keyPath}`);
  return `${value}\n`;
}

function writePrivateJson(filename: string, value: unknown): void {
  writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function idSequence(): () => string {
  let value = 0;
  return () => {
    value += 1;
    return `33333333-3333-4333-8333-${String(value).padStart(12, "0")}`;
  };
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "naru-maintenance-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
