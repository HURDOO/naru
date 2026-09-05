import {
  issueAcmeCertificate,
  safeAcmeErrorCode,
  verifyAcmeDnsAccess,
  type AcmeRenewalConfig,
} from "./acme-renewal.js";

const [command, hostname, zoneName, challengeName, tokenFile, stateDirectory, ...unexpected] =
  process.argv.slice(2);

try {
  if (
    command === undefined ||
    hostname === undefined ||
    zoneName === undefined ||
    challengeName === undefined ||
    tokenFile === undefined ||
    stateDirectory === undefined ||
    unexpected.length > 0
  ) {
    throw new Error("usage");
  }
  const config: AcmeRenewalConfig = {
    tokenFile,
    stateDirectory,
    repositoryDirectory: process.cwd(),
    hostname,
    zoneName,
    challengeName,
  };
  let result: unknown;
  switch (command) {
    case "verify":
      result = await verifyAcmeDnsAccess(config);
      break;
    case "issue-staging":
      result = await issueAcmeCertificate("staging", config, { force: true });
      break;
    case "issue-production":
      result = await issueAcmeCertificate("production", config, { force: true });
      break;
    case "renew-production":
      result = await issueAcmeCertificate("production", config);
      break;
    default:
      throw new Error("usage");
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  const errorCode =
    error instanceof Error && error.message === "usage" ? "USAGE" : safeAcmeErrorCode(error);
  process.stderr.write(`${JSON.stringify({ status: "failed", errorCode })}\n`);
  process.exitCode = 1;
}
