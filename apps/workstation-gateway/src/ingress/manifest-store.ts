import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { assertPrivateRegularFile, ensurePrivateDirectory } from "../security.js";
import { canonicalJson, digestValue } from "./canonical.js";
import {
  WORKSTATION_NETWORK_SCHEMA_VERSION,
  WORKSTATION_NETWORK_TASK_ID,
  type NetworkOwnershipManifest,
} from "./model.js";

const ManifestSchema = z.strictObject({
  schemaVersion: z.literal(WORKSTATION_NETWORK_SCHEMA_VERSION),
  taskId: z.literal(WORKSTATION_NETWORK_TASK_ID),
  packageId: z.literal("@naru/workstation-gateway"),
  instanceId: z.string().min(1).max(128),
  profileId: z.string().min(1).max(128),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  applyStateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  unrelatedStateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  resource: z.strictObject({
    profileId: z.string().min(1).max(128),
    hostPort: z.string().min(3).max(512),
    httpsPort: z.number().int().min(1).max(65_535),
    mountPath: z.literal("/"),
    proxy: z.string().url().max(2_048),
  }),
  state: z.enum(["pending", "active", "rolled-back"]),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export class NetworkManifestStore {
  constructor(
    readonly directory: string,
    readonly instanceId: string,
  ) {}

  read(profileId: string): NetworkOwnershipManifest | undefined {
    if (!existsSync(this.directory)) return undefined;
    ensurePrivateDirectory(this.directory);
    const path = this.path(profileId);
    try {
      assertPrivateRegularFile(path);
    } catch (error) {
      if (isMissingFileError(error)) return undefined;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
      throw new Error("Ingress ownership manifest is not valid JSON.");
    }
    const manifest = ManifestSchema.parse(value);
    if (
      manifest.instanceId !== this.instanceId ||
      manifest.profileId !== profileId ||
      manifest.resource.profileId !== profileId
    ) {
      throw new Error("Ingress ownership manifest identity does not match its requested profile.");
    }
    return manifest;
  }

  write(manifest: NetworkOwnershipManifest): void {
    ensurePrivateDirectory(this.directory);
    const parsed = ManifestSchema.parse(manifest);
    if (parsed.instanceId !== this.instanceId || parsed.profileId !== parsed.resource.profileId) {
      throw new Error("Ingress ownership manifest identity is inconsistent.");
    }
    const target = this.path(parsed.profileId);
    try {
      assertPrivateRegularFile(target);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    const temporary = join(this.directory, `.manifest-${randomUUID()}.tmp`);
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, `${canonicalJson(parsed)}\n`, "utf8");
      fsyncSync(descriptor);
      fchmodSync(descriptor, 0o600);
    } finally {
      closeSync(descriptor);
    }
    const stat = lstatSync(temporary);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o177) !== 0) {
      throw new Error("Temporary ingress manifest is not a private regular file.");
    }
    renameSync(temporary, target);
    assertPrivateRegularFile(target);
  }

  path(profileId: string): string {
    return join(this.directory, `${digestValue([this.instanceId, profileId])}.json`);
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
