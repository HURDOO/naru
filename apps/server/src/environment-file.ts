import { createECDH, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { parseEnv } from "node:util";

const VAPID_ENVIRONMENT_NAMES = [
  "NARU_VAPID_PUBLIC_KEY",
  "NARU_VAPID_PRIVATE_KEY",
  "NARU_VAPID_SUBJECT",
] as const;

export interface SecureEnvironmentFile {
  path: string;
  values: NodeJS.ProcessEnv;
}

export function readSecureEnvironmentFile(filename: string): SecureEnvironmentFile {
  validateSecureEnvironmentFile(filename);
  return {
    path: filename,
    values: parseEnv(readFileSync(filename, "utf8")),
  };
}

export function loadSecureEnvironmentFile(filename: string): void {
  const { values } = readSecureEnvironmentFile(filename);
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && process.env[key] === undefined) process.env[key] = value;
  }
}

export interface InstalledVapidConfiguration {
  status: "configured";
  names: typeof VAPID_ENVIRONMENT_NAMES;
  subject: string;
}

export function installGeneratedVapidConfiguration(
  filename: string,
  subject: string,
): InstalledVapidConfiguration {
  validateSecureEnvironmentFile(filename);
  validateVapidSubject(subject);

  const contents = readFileSync(filename, "utf8");
  const environment = parseEnv(contents);
  if (VAPID_ENVIRONMENT_NAMES.some((name) => environment[name] !== undefined)) {
    throw new Error("VAPID configuration already exists; refusing to overwrite it.");
  }

  const keyPair = createECDH("prime256v1");
  keyPair.generateKeys();
  const publicKey = keyPair.getPublicKey().toString("base64url");
  const privateKey = keyPair.getPrivateKey().toString("base64url");
  const separator = contents.length === 0 || contents.endsWith("\n") ? "" : "\n";
  const nextContents = `${contents}${separator}\n# T32 Web Push VAPID configuration\nNARU_VAPID_PUBLIC_KEY=${publicKey}\nNARU_VAPID_PRIVATE_KEY=${privateKey}\nNARU_VAPID_SUBJECT=${JSON.stringify(subject)}\n`;
  const temporaryFile = join(dirname(filename), `.${basename(filename)}.vapid-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryFile,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, nextContents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryFile, filename);
    const directoryDescriptor = openSync(dirname(filename), constants.O_RDONLY);
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryFile);
    } catch {
      // The temporary file may not have been created or may already have been atomically renamed.
    }
    throw error;
  }

  validateSecureEnvironmentFile(filename);
  return { status: "configured", names: VAPID_ENVIRONMENT_NAMES, subject };
}

export function validateSecureEnvironmentFile(filename: string): void {
  if (!isAbsolute(filename)) {
    throw new Error("NARU_ENV_FILE must be an absolute path.");
  }

  const metadata = lstatSync(filename);
  if (metadata.isSymbolicLink()) {
    throw new Error("NARU_ENV_FILE must not be a symbolic link.");
  }
  if (!metadata.isFile()) {
    throw new Error("NARU_ENV_FILE must be a regular file.");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("NARU_ENV_FILE permissions must be 0600 or stricter.");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("NARU_ENV_FILE must be owned by the service user.");
  }
  if (realpathSync(filename) !== filename) {
    throw new Error("NARU_ENV_FILE path must be canonical.");
  }
}

function validateVapidSubject(subject: string): void {
  if (subject.trim() !== subject) {
    throw new Error("VAPID subject must not have surrounding whitespace.");
  }
  let parsed: URL;
  try {
    parsed = new URL(subject);
  } catch {
    throw new Error("VAPID subject must be an HTTPS or mailto URI.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "mailto:") {
    throw new Error("VAPID subject must be an HTTPS or mailto URI.");
  }
}
