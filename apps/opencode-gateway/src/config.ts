import { createPublicKey, type KeyObject } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { ExactHttpsOriginSchema } from "@naru/contracts/workstation-gateway/v1";
import { z } from "zod";

export const OpenCodeGatewayConfigSchema = z
  .strictObject({
    version: z.literal(1),
    issuer: z.string().min(1),
    audience: z.literal("omo"),
    ownerSubject: z.string().min(1),
    browserOrigin: ExactHttpsOriginSchema,
    listenPort: z.number().int().min(1024).max(65535),
    upstreamPort: z.number().int().min(1024).max(65535),
    routePrefix: z.literal("/omo"),
    uiRoot: z.string().refine(isAbsolute),
    verifierKeysFile: z.string().refine(isAbsolute),
    passwordFile: z.string().refine(isAbsolute),
    opencodeExecutable: z.string().refine(isAbsolute),
    opencodeSha256: z.string().regex(/^[a-f0-9]{64}$/),
    defaultDirectory: z.string().refine(isAbsolute),
    allowedProjectRoots: z.array(z.string().refine(isAbsolute)).min(1),
  })
  .refine((config) => config.listenPort !== config.upstreamPort, "Listener ports must differ.");

export type OpenCodeGatewayConfig = z.infer<typeof OpenCodeGatewayConfigSchema>;

export function readOwnerFile(filename: string): Buffer {
  if (!isAbsolute(filename) || realpathSync(filename) !== filename)
    throw new Error("Noncanonical file.");
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error("File must be owner-only.");
  if (stat.uid !== process.getuid?.() || stat.size < 1 || stat.size > 1024 * 1024)
    throw new Error("Invalid private file.");
  return readFileSync(filename);
}

export function readConfig(filename: string): OpenCodeGatewayConfig {
  const config = OpenCodeGatewayConfigSchema.parse(
    JSON.parse(readOwnerFile(filename).toString("utf8")) as unknown,
  );
  for (const directory of [config.uiRoot, config.defaultDirectory, ...config.allowedProjectRoots]) {
    if (realpathSync(directory) !== directory || !lstatSync(directory).isDirectory())
      throw new Error("Noncanonical directory.");
  }
  if (!config.allowedProjectRoots.some((root) => isContained(root, config.defaultDirectory)))
    throw new Error("Default directory is outside approved roots.");
  return config;
}

export function readVerifierKeys(filename: string): ReadonlyMap<string, KeyObject> {
  const value: unknown = JSON.parse(readOwnerFile(filename).toString("utf8"));
  const parsed = z
    .strictObject({
      version: z.literal(1),
      keys: z
        .array(
          z.strictObject({
            keyId: z.string().min(1),
            algorithm: z.literal("Ed25519"),
            publicKeyPem: z.string().min(1).max(16384),
          }),
        )
        .min(1)
        .max(16),
    })
    .parse(value);
  const keys = new Map<string, KeyObject>();
  for (const item of parsed.keys) {
    const key = createPublicKey(item.publicKeyPem);
    if (keys.has(item.keyId) || key.type !== "public" || key.asymmetricKeyType !== "ed25519")
      throw new Error("Invalid verifier key.");
    keys.set(item.keyId, key);
  }
  return keys;
}

export function isContained(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}
