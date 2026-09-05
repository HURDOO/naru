import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_REPOSITORY_ROOT = resolve(import.meta.dirname, "..");

const forbiddenFilenamePatterns = [
  /(^|\/)\.env(?:\.|$)/u,
  /(^|\/).+\.(?:db|log|pem|secret|sqlite|sqlite-shm|sqlite-wal)$/iu,
  /(^|\/)(?:coverage|dist|node_modules|playwright-report|test-results)(?:\/|$)/u,
];

const contentPatterns = [
  ["private-user-path", /\/Users\/(?!example(?:\/|$)|test(?:\/|$))[^/\s"'`]+/gu],
  ["private-key", /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/gu],
  ["github-token", /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})/gu],
  ["openai-token", /\bsk-[A-Za-z0-9_-]{20,}\b/gu],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/gu],
  [
    "discord-webhook",
    /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/gu,
  ],
  ["url-credential", /https?:\/\/[^\s/:]+:[^\s/@]+@/gu],
];

const forbiddenDocumentationReferences = [
  ["private-project-brief-reference", /\bPROJECT_BRIEF\.md\b/gu],
  ["private-proposal-reference", /\bDURABLE_SESSION_V0_PROPOSAL\.md\b/gu],
  ["private-handoff-reference", /\bTARGET_ACCEPTANCE_HANDOFF\.md\b/gu],
  ["missing-evidence-template-reference", /\bevidence\.template\.json\b/gu],
];

export function scanRepository(repositoryRoot = DEFAULT_REPOSITORY_ROOT, options = {}) {
  const root = realpathSync(repositoryRoot);
  const indexEntries = readIndex(root);
  if (indexEntries.length === 0) {
    throw new Error("public:scan requires a Git index with the complete public allowlist");
  }

  const findings = [];
  const indexedPaths = new Set(indexEntries.map((entry) => entry.path));
  const historicalPaths = readHistoricalPaths(root);
  const objectLocations = new Map();

  for (const entry of indexEntries) {
    addObjectLocation(objectLocations, entry.oid, `index:${entry.path}`);
    scanFilename(entry.path, `index:${entry.path}`, findings);
  }
  for (const path of historicalPaths) scanFilename(path, `history:${path}`, findings);

  for (const object of readReachableObjects(root)) {
    addObjectLocation(
      objectLocations,
      object.oid,
      object.path === undefined ? `object:${object.oid.slice(0, 12)}` : `history:${object.path}`,
    );
  }

  const denylist = readPrivateDenylist(root, options.denylistFile);
  let scannedObjects = 0;
  for (const [oid, locations] of objectLocations) {
    const type = gitText(root, ["cat-file", "-t", oid]).trim();
    if (type === "tree") continue;
    const contents = gitBuffer(root, ["cat-file", type, oid]);
    scanContent(
      contents,
      [...locations].sort()[0] ?? `object:${oid.slice(0, 12)}`,
      findings,
      denylist,
    );
    scannedObjects += 1;
  }

  for (const entry of indexEntries) {
    if (!entry.path.endsWith(".md")) continue;
    const source = gitBuffer(root, ["cat-file", "blob", entry.oid]).toString("utf8");
    scanDocumentation(entry.path, source, indexedPaths, findings);
  }

  return {
    files: indexEntries.length,
    objects: scannedObjects,
    findings: deduplicateFindings(findings),
  };
}

function readIndex(root) {
  const output = gitText(root, ["ls-files", "--stage", "-z"]);
  return output
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const separator = record.indexOf("\t");
      if (separator < 0) throw new Error("Git index entry is malformed");
      const [mode, oid, stage] = record.slice(0, separator).split(" ");
      const path = record.slice(separator + 1);
      if (!mode || !oid || stage !== "0" || path.length === 0) {
        throw new Error("public:scan requires a conflict-free stage-zero Git index");
      }
      return { oid, path };
    });
}

function readHistoricalPaths(root) {
  const output = gitText(root, ["log", "--all", "--format=", "--name-only", "-z"]);
  return new Set(
    output
      .split("\0")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function readReachableObjects(root) {
  const output = gitText(root, ["rev-list", "--objects", "--all"]);
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(" ");
      return separator < 0
        ? { oid: line }
        : { oid: line.slice(0, separator), path: line.slice(separator + 1) };
    });
}

function scanFilename(path, location, findings) {
  if (
    forbiddenFilenamePatterns.some(
      (pattern) => pattern.test(path) && path !== ".env.example" && !path.endsWith(".env.example"),
    )
  ) {
    findings.push({ code: "forbidden-filename", location });
  }
}

function scanContent(buffer, location, findings, denylist) {
  const source = buffer.toString("utf8");
  for (const [code, pattern] of contentPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(source)) findings.push({ code, location });
  }
  for (const literal of denylist) {
    if (source.includes(literal)) findings.push({ code: "private-denylist-match", location });
  }
}

function scanDocumentation(filename, source, indexedPaths, findings) {
  for (const [code, pattern] of forbiddenDocumentationReferences) {
    pattern.lastIndex = 0;
    if (pattern.test(source)) findings.push({ code, location: `index:${filename}` });
  }

  const links = source.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/gu);
  for (const match of links) {
    const rawTarget = match[1];
    if (rawTarget === undefined || isExternalOrPageLink(rawTarget)) continue;
    const target = normalizeDocumentationTarget(filename, rawTarget);
    if (target === null) continue;
    const exists =
      indexedPaths.has(target) || [...indexedPaths].some((path) => path.startsWith(`${target}/`));
    if (!exists) {
      findings.push({ code: "missing-local-documentation-link", location: `index:${filename}` });
    }
  }
}

function normalizeDocumentationTarget(filename, rawTarget) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawTarget.replace(/^<|>$/g, ""));
  } catch {
    return null;
  }
  const withoutFragment = decoded.split("#", 1)[0]?.split("?", 1)[0];
  if (!withoutFragment || withoutFragment.startsWith("/")) return null;
  const normalized = posix.normalize(posix.join(posix.dirname(filename), withoutFragment));
  return normalized === ".." || normalized.startsWith("../")
    ? null
    : normalized.replace(/\/$/u, "");
}

function isExternalOrPageLink(target) {
  return (
    target.startsWith("#") || target.startsWith("/") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target)
  );
}

function readPrivateDenylist(root, configuredPath) {
  if (configuredPath === undefined || configuredPath === "") return [];
  if (!isAbsolute(configuredPath)) {
    throw new Error(
      "NARU_PUBLIC_SCAN_DENYLIST_FILE must be an absolute path outside the repository",
    );
  }
  const path = realpathSync(configuredPath);
  const pathFromRoot = relative(root, path);
  if (pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..")) {
    throw new Error("NARU_PUBLIC_SCAN_DENYLIST_FILE must stay outside the repository");
  }
  if (!lstatSync(path).isFile()) {
    throw new Error("NARU_PUBLIC_SCAN_DENYLIST_FILE must be a regular file");
  }
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && !value.startsWith("#"));
}

function addObjectLocation(locations, oid, location) {
  const current = locations.get(oid) ?? new Set();
  current.add(location);
  locations.set(oid, current);
}

function deduplicateFindings(findings) {
  return [
    ...new Map(
      findings.map((finding) => [`${finding.code}\0${finding.location}`, finding]),
    ).values(),
  ].sort((left, right) =>
    `${left.location}\0${left.code}`.localeCompare(`${right.location}\0${right.code}`),
  );
}

function gitText(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitBuffer(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = scanRepository(DEFAULT_REPOSITORY_ROOT, {
    denylistFile: process.env.NARU_PUBLIC_SCAN_DENYLIST_FILE,
  });
  if (result.findings.length > 0) {
    process.stderr.write(`${JSON.stringify({ status: "blocked", ...result }, null, 2)}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify({ status: "ok", ...result })}\n`);
  }
}
