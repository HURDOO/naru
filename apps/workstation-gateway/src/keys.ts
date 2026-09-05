import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { join } from "node:path";
import {
  ensurePrivateDirectory,
  privateFileExists,
  readPrivateFile,
  writePrivateFileExclusive,
} from "./security.js";

export interface GatewayKeys {
  readonly signingPrivateKey: KeyObject;
  readonly signingPublicKey: KeyObject;
  readonly signingKeyId: string;
  readonly bootstrapDigestKey: Buffer;
  readonly ceremonyDigestKey: Buffer;
  readonly sessionDigestKey: Buffer;
  readonly credentialReferenceKey: Buffer;
}

export interface GatewayVerifierKey {
  readonly keyId: string;
  readonly algorithm: "Ed25519";
  readonly publicKeyPem: string;
}

export function loadOrCreateGatewayKeys(dataDirectory: string): GatewayKeys {
  const keysDirectory = join(dataDirectory, "keys");
  ensurePrivateDirectory(dataDirectory);
  ensurePrivateDirectory(keysDirectory);
  const signingPath = join(keysDirectory, "assertion-signing.pk8.pem");
  if (!privateFileExists(signingPath)) {
    const generated = generateKeyPairSync("ed25519");
    writePrivateFileExclusive(
      signingPath,
      generated.privateKey.export({ format: "pem", type: "pkcs8" }),
    );
  }
  const signingPrivateKey = createPrivateKey(readPrivateFile(signingPath));
  if (signingPrivateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Gateway assertion signing key must be Ed25519.");
  }
  const signingPublicKey = createPublicKey(signingPrivateKey);
  const publicDer = signingPublicKey.export({ format: "der", type: "spki" });
  const signingKeyId = `ed25519-${createHash("sha256").update(publicDer).digest("base64url")}`;
  return {
    signingPrivateKey,
    signingPublicKey,
    signingKeyId,
    bootstrapDigestKey: loadOrCreateSecret(keysDirectory, "bootstrap-digest.key"),
    ceremonyDigestKey: loadOrCreateSecret(keysDirectory, "ceremony-digest.key"),
    sessionDigestKey: loadOrCreateSecret(keysDirectory, "session-digest.key"),
    credentialReferenceKey: loadOrCreateSecret(keysDirectory, "credential-reference.key"),
  };
}

export function gatewayVerifierKey(keys: GatewayKeys): GatewayVerifierKey {
  return {
    keyId: keys.signingKeyId,
    algorithm: "Ed25519",
    publicKeyPem: keys.signingPublicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

function loadOrCreateSecret(directory: string, name: string): Buffer {
  const path = join(directory, name);
  if (!privateFileExists(path)) writePrivateFileExclusive(path, randomBytes(32));
  const secret = readPrivateFile(path);
  if (secret.byteLength !== 32) throw new Error(`Gateway key has an invalid length: ${name}`);
  return secret;
}
