import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installGeneratedVapidConfiguration,
  loadSecureEnvironmentFile,
  readSecureEnvironmentFile,
  validateSecureEnvironmentFile,
} from "../src/environment-file.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  delete process.env.NARU_ENVIRONMENT_FILE_TEST;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("secure production environment files", () => {
  it("reads a canonical service-user-owned 0600 file", () => {
    const filename = temporaryEnvironmentFile("NARU_HOST=127.0.0.1\n");

    expect(readSecureEnvironmentFile(filename)).toEqual({
      path: filename,
      values: { NARU_HOST: "127.0.0.1" },
    });
  });

  it("rejects group-readable files, symbolic links, and relative paths", () => {
    const filename = temporaryEnvironmentFile("NARU_HOST=127.0.0.1\n");
    chmodSync(filename, 0o640);
    expect(() => validateSecureEnvironmentFile(filename)).toThrow(/0600 or stricter/);

    chmodSync(filename, 0o600);
    const link = join(realpathSync(join(filename, "..")), "linked.env");
    symlinkSync(filename, link);
    expect(() => validateSecureEnvironmentFile(link)).toThrow(/symbolic link/);
    expect(() => validateSecureEnvironmentFile("relative.env")).toThrow(/absolute path/);
  });

  it("does not override values explicitly provided by launchd", () => {
    const filename = temporaryEnvironmentFile("NARU_ENVIRONMENT_FILE_TEST=file-value\n");
    process.env.NARU_ENVIRONMENT_FILE_TEST = "launchd-value";

    loadSecureEnvironmentFile(filename);

    expect(process.env.NARU_ENVIRONMENT_FILE_TEST).toBe("launchd-value");
  });

  it("atomically installs a generated VAPID pair without returning either key", () => {
    const filename = temporaryEnvironmentFile("EXISTING_SECRET=preserved\n");

    const result = installGeneratedVapidConfiguration(filename, "https://naru.example.test:8443");

    expect(result).toEqual({
      status: "configured",
      names: ["NARU_VAPID_PUBLIC_KEY", "NARU_VAPID_PRIVATE_KEY", "NARU_VAPID_SUBJECT"],
      subject: "https://naru.example.test:8443",
    });
    expect(JSON.stringify(result)).not.toMatch(/PUBLIC_KEY=|PRIVATE_KEY=/);
    const { values } = readSecureEnvironmentFile(filename);
    expect(values.EXISTING_SECRET).toBe("preserved");
    expect(Buffer.from(values.NARU_VAPID_PUBLIC_KEY ?? "", "base64url")).toHaveLength(65);
    expect(Buffer.from(values.NARU_VAPID_PRIVATE_KEY ?? "", "base64url")).toHaveLength(32);
    expect(values.NARU_VAPID_SUBJECT).toBe("https://naru.example.test:8443");
    expect(statSync(filename).mode & 0o777).toBe(0o600);
  });

  it("refuses to overwrite an existing or partial VAPID configuration", () => {
    const filename = temporaryEnvironmentFile("NARU_VAPID_PRIVATE_KEY=existing-private-value\n");
    const before = readFileSync(filename, "utf8");

    expect(() =>
      installGeneratedVapidConfiguration(filename, "https://naru.example.test:8443"),
    ).toThrow(/refusing to overwrite/);
    expect(readFileSync(filename, "utf8")).toBe(before);
  });

  it("rejects a non-contact VAPID subject before changing the environment file", () => {
    const filename = temporaryEnvironmentFile("NARU_HOST=127.0.0.1\n");
    const before = readFileSync(filename, "utf8");

    expect(() =>
      installGeneratedVapidConfiguration(filename, "file:///private/tmp/contact"),
    ).toThrow(/HTTPS or mailto/);
    expect(readFileSync(filename, "utf8")).toBe(before);
  });
});

function temporaryEnvironmentFile(contents: string): string {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "naru-env-test-"));
  temporaryDirectories.push(directory);
  const filename = join(directory, "naru.env");
  writeFileSync(filename, contents, { mode: 0o600 });
  return filename;
}
