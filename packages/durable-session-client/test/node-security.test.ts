import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DurableSessionClientError } from "../src/errors.js";
import { readPrivateCredentialFile } from "../src/node-security.js";

const CREDENTIAL = "fixture-client-credential-0123456789-ABCDEFGHIJ";

describe("Node private credential boundary", () => {
  it("reads an owner-only regular credential file", () => {
    const root = privateTemporaryDirectory();
    const file = join(root, "credential");
    writeFileSync(file, `${CREDENTIAL}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);

    expect(readPrivateCredentialFile(file)).toBe(CREDENTIAL);
  });

  it("rejects permissive files and symlink components", () => {
    const root = privateTemporaryDirectory();
    const permissive = join(root, "permissive");
    writeFileSync(permissive, CREDENTIAL, { mode: 0o644 });
    chmodSync(permissive, 0o644);
    expect(() => readPrivateCredentialFile(permissive)).toThrow(DurableSessionClientError);

    const real = join(root, "real");
    const linked = join(root, "linked");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, linked);
    const credential = join(real, "credential");
    writeFileSync(credential, CREDENTIAL, { mode: 0o600 });
    expect(() => readPrivateCredentialFile(join(linked, "credential"))).toThrow(
      DurableSessionClientError,
    );
  });
});

function privateTemporaryDirectory(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dsv0-t08-client-")));
  chmodSync(root, 0o700);
  return root;
}
