import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CommandSpecV0,
  AttachmentId,
  ControlOfferId,
  ControlRequestId,
  DurableSessionCallerContext,
  RuntimeId,
  EventId,
  SessionId,
  TerminalSize,
} from "@naru/contracts/durable-session/v0";
import { DurableSessionHostConfigSchema, type DurableSessionHostConfig } from "../src/config.js";
import type {
  RuntimeCallbacks,
  RuntimeExit,
  RuntimeHandle,
  RuntimePort,
  RuntimeSpawnRequest,
} from "../src/runtime.js";
import type { HostClock, HostIds } from "../src/session-service.js";

export const TEST_CREDENTIAL = "fixture-host-credential-0123456789-ABCDEFGHIJ";
export const TEST_IDS = {
  session1: "00000000-0000-4000-8000-000000000001" as SessionId,
  session2: "00000000-0000-4000-8000-000000000002" as SessionId,
  session3: "00000000-0000-4000-8000-000000000003" as SessionId,
  runtime1: "10000000-0000-4000-8000-000000000001" as RuntimeId,
  runtime2: "10000000-0000-4000-8000-000000000002" as RuntimeId,
  runtime3: "10000000-0000-4000-8000-000000000003" as RuntimeId,
  attachment1: "11000000-0000-4000-8000-000000000001" as AttachmentId,
  attachment2: "11000000-0000-4000-8000-000000000002" as AttachmentId,
  attachment3: "11000000-0000-4000-8000-000000000003" as AttachmentId,
  controlRequest1: "12000000-0000-4000-8000-000000000001" as ControlRequestId,
  controlOffer1: "13000000-0000-4000-8000-000000000001" as ControlOfferId,
  diagnostic1: "20000000-0000-4000-8000-000000000001",
  diagnostic2: "20000000-0000-4000-8000-000000000002",
} as const;

export class FakeClock implements HostClock {
  constructor(public value = 1_000) {}

  nowMs(): number {
    this.value += 1;
    return this.value;
  }
}

export class FakeIds implements HostIds {
  readonly #sessions = [TEST_IDS.session1, TEST_IDS.session2, TEST_IDS.session3];
  readonly #runtimes = [TEST_IDS.runtime1, TEST_IDS.runtime2, TEST_IDS.runtime3];
  readonly #diagnostics = [TEST_IDS.diagnostic1, TEST_IDS.diagnostic2];
  readonly #attachments = [TEST_IDS.attachment1, TEST_IDS.attachment2, TEST_IDS.attachment3];
  readonly #controlRequests = [TEST_IDS.controlRequest1];
  readonly #controlOffers = [TEST_IDS.controlOffer1];
  #event = 1;

  sessionId(): SessionId {
    const value = this.#sessions.shift();
    if (value === undefined) throw new Error("No fixture Session ID remains.");
    return value;
  }

  runtimeId(): RuntimeId {
    const value = this.#runtimes.shift();
    if (value === undefined) throw new Error("No fixture runtime ID remains.");
    return value;
  }

  attachmentId(): AttachmentId {
    const value = this.#attachments.shift();
    if (value === undefined) throw new Error("No fixture attachment ID remains.");
    return value;
  }

  controlRequestId(): ControlRequestId {
    return this.#controlRequests.shift() ?? fixtureUuid("12", 99);
  }

  controlOfferId(): ControlOfferId {
    return this.#controlOffers.shift() ?? fixtureUuid("13", 99);
  }

  eventId(): EventId {
    return fixtureUuid("14", this.#event++);
  }

  diagnosticId(): string {
    return this.#diagnostics.shift() ?? "20000000-0000-4000-8000-000000000099";
  }
}

function fixtureUuid(prefix: string, ordinal: number): string {
  return `${prefix}000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
}

interface FakeRuntimeRecord {
  readonly request: RuntimeSpawnRequest;
  readonly callbacks: RuntimeCallbacks;
  readonly handle: RuntimeHandle;
  resolveExit: (event: RuntimeExit) => void;
  exited: boolean;
  readonly writes: string[];
  readonly resizes: TerminalSize[];
  readonly kills: (string | undefined)[];
}

export class FakeRuntimePort implements RuntimePort {
  readonly records: FakeRuntimeRecord[] = [];
  failNextSpawn = false;
  autoExitOnKill = true;

  spawn(request: RuntimeSpawnRequest, callbacks: RuntimeCallbacks): RuntimeHandle {
    if (this.failNextSpawn) {
      this.failNextSpawn = false;
      throw new Error("fixture spawn failure");
    }
    let resolveExit = (event: RuntimeExit): void => {
      void event;
    };
    const exited = new Promise<RuntimeExit>((resolvePromise) => {
      resolveExit = resolvePromise;
    });
    const record: FakeRuntimeRecord = {
      request,
      callbacks,
      resolveExit,
      exited: false,
      writes: [],
      resizes: [],
      kills: [],
      handle: undefined as never,
    };
    const handle: RuntimeHandle = {
      sessionId: request.sessionId,
      runtimeId: request.runtimeId,
      pid: 10_000 + this.records.length,
      exited,
      write: (data) => record.writes.push(data),
      resize: (terminal) => record.resizes.push(terminal),
      kill: (signal) => {
        record.kills.push(signal);
        if (this.autoExitOnKill) queueMicrotask(() => this.exit(request.runtimeId, 0, null));
      },
    };
    Object.assign(record, { handle });
    this.records.push(record);
    return handle;
  }

  data(runtimeId: RuntimeId, data: string): void {
    this.#record(runtimeId).callbacks.onData(data);
  }

  exit(runtimeId: RuntimeId, exitCode: number, signal: number | null): void {
    const record = this.#record(runtimeId);
    if (record.exited) return;
    record.exited = true;
    const event = { exitCode, signal };
    record.callbacks.onExit(event);
    record.resolveExit(event);
  }

  #record(runtimeId: RuntimeId): FakeRuntimeRecord {
    const record = this.records.find((candidate) => candidate.request.runtimeId === runtimeId);
    if (record === undefined) throw new Error(`Unknown fake runtime: ${runtimeId}`);
    return record;
  }
}

export interface HostFixture {
  readonly root: string;
  readonly credentialFile: string;
  readonly config: DurableSessionHostConfig;
}

export function createHostFixture(): HostFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dsv0-t05-")));
  chmodSync(root, 0o700);
  const projectRoot = join(root, "projects");
  const project = join(projectRoot, "sample");
  const dataDirectory = join(root, "data");
  const runtimeDirectory = join(root, "runtime");
  const credentialsDirectory = join(root, "credentials");
  for (const directory of [
    projectRoot,
    project,
    dataDirectory,
    runtimeDirectory,
    credentialsDirectory,
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  const credentialFile = join(credentialsDirectory, "fixture-app");
  writeFileSync(credentialFile, `${TEST_CREDENTIAL}\n`, { mode: 0o600 });
  chmodSync(credentialFile, 0o600);
  const executable = realpathSync(process.execPath);
  const config = DurableSessionHostConfigSchema.parse({
    version: 1,
    dataDirectory,
    socketPath: join(runtimeDirectory, "host.sock"),
    roots: [{ rootId: "projects", path: projectRoot }],
    profiles: [
      {
        profileId: "fixture",
        executable,
        args: [],
        envPolicyId: "safe-env",
        resourcePolicyId: "fixture-resource",
      },
    ],
    environmentPolicies: [{ envPolicyId: "safe-env", inherit: [], values: { FIXTURE_SAFE: "1" } }],
    resourcePolicies: [
      {
        resourcePolicyId: "fixture-resource",
        allowedExecutables: [executable],
        maxCols: 200,
        maxRows: 100,
        scrollbackRows: 100,
        outputRingCharacters: 128 * 1_024,
        stopTimeoutMs: 100,
      },
    ],
    appRegistrations: [
      {
        appId: "fixture-app",
        credentialFile,
        capabilities: [
          "session:observe",
          "control:request",
          "control:preempt",
          "session:create:profile",
          "session:create:arbitrary",
          "session:start",
          "session:stop",
          "session:forget",
          "profile:use",
          "session:read-sensitive-metadata",
        ],
        subjectScope: { kind: "all" },
        sessionScope: { kind: "all" },
        profileScope: { kind: "all" },
        rootScope: { kind: "all" },
        maxCallerTtlMs: 60_000,
      },
    ],
    sessionLimit: 10,
    requestBodyBytes: 128 * 1_024,
    idempotencyTtlMs: 30_000,
  });
  return { root, credentialFile, config };
}

export function ownerCaller(nowMs = 1_000): DurableSessionCallerContext {
  return {
    appId: "fixture-app",
    subject: "fixture-owner",
    capabilities: [
      "session:observe",
      "control:request",
      "control:preempt",
      "session:create:profile",
      "session:create:arbitrary",
      "session:start",
      "session:stop",
      "session:forget",
      "profile:use",
      "session:read-sensitive-metadata",
    ],
    sessionScope: { kind: "all" },
    profileScope: { kind: "all" },
    rootScope: { kind: "all" },
    expiresAtMs: nowMs + 50_000,
  };
}

export function profileCommand(): CommandSpecV0 {
  return {
    kind: "profile",
    profileId: "fixture",
    cwd: { rootId: "projects", relativePath: "sample" },
    terminal: { cols: 80, rows: 24, term: "xterm-256color" },
  };
}

export function execCommand(secretArgument = "safe-argument"): CommandSpecV0 {
  return {
    kind: "exec",
    executable: realpathSync(process.execPath),
    args: [secretArgument],
    cwd: { rootId: "projects", relativePath: "sample" },
    terminal: { cols: 80, rows: 24 },
    envPolicyId: "safe-env",
    resourcePolicyId: "fixture-resource",
  };
}
