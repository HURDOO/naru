import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadGatewayVerifierKeys } from "../src/gateway-auth.js";

describe("Gateway verifier key file", () => {
  it("loads a canonical owner-only Ed25519 key set", () => {
    const { path } = writeKeysFile();
    const keys = loadGatewayVerifierKeys(path);
    expect([...keys.keys()]).toEqual(["gateway-key"]);
    expect(keys.get("gateway-key")?.asymmetricKeyType).toBe("ed25519");
  });

  it("rejects writable-by-others files, symlinks, duplicate IDs, and non-Ed25519 keys", () => {
    const permissive = writeKeysFile();
    chmodSync(permissive.path, 0o644);
    expect(() => loadGatewayVerifierKeys(permissive.path)).toThrow(/0600 or stricter/);

    const target = writeKeysFile();
    const symlink = join(target.directory, "verifier-link.json");
    symlinkSync(target.path, symlink);
    expect(() => loadGatewayVerifierKeys(symlink)).toThrow(/not a symlink/);

    const duplicate = writeKeysFile({ duplicate: true });
    expect(() => loadGatewayVerifierKeys(duplicate.path)).toThrow(/duplicate key ID/);

    const rsa = writeKeysFile({ keyType: "rsa" });
    expect(() => loadGatewayVerifierKeys(rsa.path)).toThrow(/must be Ed25519/);
  });
});

function writeKeysFile(
  options: { readonly duplicate?: boolean; readonly keyType?: "ed25519" | "rsa" } = {},
): { readonly directory: string; readonly path: string } {
  const directory = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "naru-gateway-keys-")));
  const path = join(directory, "verifier-keys.json");
  const keyPair =
    options.keyType === "rsa"
      ? generateKeyPairSync("rsa", { modulusLength: 2048 })
      : generateKeyPairSync("ed25519");
  const key = {
    keyId: "gateway-key",
    algorithm: "Ed25519",
    publicKeyPem: keyPair.publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
  writeFileSync(
    path,
    JSON.stringify({ version: 1, keys: options.duplicate ? [key, key] : [key] }),
    { mode: 0o600 },
  );
  return { directory, path: realpathSync(path) };
}
