import { createHash } from "node:crypto";
import {
  installGeneratedVapidConfiguration,
  readSecureEnvironmentFile,
} from "../../../apps/server/src/environment-file.js";
import type { WorkstationInstanceLayout } from "./model.js";
import { atomicWritePrivateFile, createPrivateCredential } from "./security.js";
import { renderEnvironmentFile } from "./configuration.js";

const VAPID_PUBLIC_KEY = "NARU_VAPID_PUBLIC_KEY";
const VAPID_PRIVATE_KEY = "NARU_VAPID_PRIVATE_KEY";
const VAPID_SUBJECT = "NARU_VAPID_SUBJECT";

export interface InstalledCredentialSummary {
  readonly hostCredential: "created" | "preserved";
  readonly localSessionCliCredential: "created" | "preserved" | "not-installed";
  readonly vapidKeyPair: "created" | "preserved";
  readonly vapidSubject: string;
  readonly vapidPublicKeyFingerprint: string;
}

export function installOrUpdateInstanceCredentials(
  layout: WorkstationInstanceLayout,
  naruEnvironment: Readonly<Record<string, string>>,
  options: { readonly localSessionCli: boolean },
): InstalledCredentialSummary {
  const hostCredential = createPrivateCredential(layout.files.hostCredential, layout.uid);
  const localSessionCliCredential = options.localSessionCli
    ? createPrivateCredential(layout.files.localSessionCliCredential, layout.uid)
    : "not-installed";
  let vapidKeyPair: InstalledCredentialSummary["vapidKeyPair"];

  try {
    const existing = readSecureEnvironmentFile(layout.files.naruEnvironment).values;
    const publicKey = requireEnvironmentValue(existing, VAPID_PUBLIC_KEY);
    const privateKey = requireEnvironmentValue(existing, VAPID_PRIVATE_KEY);
    requireEnvironmentValue(existing, VAPID_SUBJECT);
    atomicWritePrivateFile(
      layout.files.naruEnvironment,
      renderEnvironmentFile({
        ...naruEnvironment,
        [VAPID_PUBLIC_KEY]: publicKey,
        [VAPID_PRIVATE_KEY]: privateKey,
        [VAPID_SUBJECT]: layout.browser.vapidSubject,
      }),
      layout.uid,
      { replace: true },
    );
    vapidKeyPair = "preserved";
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    atomicWritePrivateFile(
      layout.files.naruEnvironment,
      renderEnvironmentFile(naruEnvironment),
      layout.uid,
    );
    installGeneratedVapidConfiguration(layout.files.naruEnvironment, layout.browser.vapidSubject);
    vapidKeyPair = "created";
  }

  const installed = readSecureEnvironmentFile(layout.files.naruEnvironment).values;
  const publicKey = requireEnvironmentValue(installed, VAPID_PUBLIC_KEY);
  const subject = requireEnvironmentValue(installed, VAPID_SUBJECT);
  return {
    hostCredential,
    localSessionCliCredential,
    vapidKeyPair,
    vapidSubject: subject,
    vapidPublicKeyFingerprint: createHash("sha256").update(publicKey).digest("hex"),
  };
}

function requireEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value === "") {
    throw new Error(`Existing private environment is missing ${name}; refusing implicit rotation.`);
  }
  return value;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
