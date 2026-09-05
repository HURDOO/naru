import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID, X509Certificate } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestTlsGeneration {
  readonly generation: string;
  readonly directory: string;
  readonly privateKeyFile: string;
  readonly certificateFile: string;
  readonly fingerprint256: string;
}

export interface TestTlsState {
  readonly root: string;
  readonly stateDirectory: string;
  createGeneration(generation: string, serverName?: string): TestTlsGeneration;
  publish(generation: string): void;
}

export function createTestTlsState(serverName = "naru.example.test"): TestTlsState {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "naru-tls-test-")));
  const stateDirectory = join(root, "tls");
  const generationsDirectory = join(stateDirectory, "generations");
  mkdirSync(generationsDirectory, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  chmodSync(stateDirectory, 0o700);
  chmodSync(generationsDirectory, 0o700);

  return {
    root,
    stateDirectory,
    createGeneration(generation, certificateServerName = serverName) {
      const directory = join(generationsDirectory, generation);
      const privateKeyFile = join(directory, "private-key.pem");
      const certificateFile = join(directory, "full-chain.pem");
      mkdirSync(directory, { mode: 0o700 });
      execFileSync(
        "/usr/bin/openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          privateKeyFile,
          "-out",
          certificateFile,
          "-days",
          "2",
          "-set_serial",
          `0x${randomBytes(12).toString("hex")}`,
          "-subj",
          `/CN=${certificateServerName}`,
          "-addext",
          `subjectAltName=DNS:${certificateServerName}`,
        ],
        { stdio: "pipe" },
      );
      chmodSync(privateKeyFile, 0o600);
      chmodSync(certificateFile, 0o600);
      const certificate = new X509Certificate(readFileSync(certificateFile));
      return {
        generation,
        directory,
        privateKeyFile,
        certificateFile,
        fingerprint256: certificate.fingerprint256,
      };
    },
    publish(generation) {
      const temporaryPointer = join(stateDirectory, `.current-${randomUUID()}.json`);
      writeFileSync(temporaryPointer, `${JSON.stringify({ formatVersion: 1, generation })}\n`, {
        mode: 0o600,
      });
      renameSync(temporaryPointer, join(stateDirectory, "current.json"));
    },
  };
}
