import { createRequire } from "node:module";
import { chmodSync, existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { discoverRepositoryRoot } from "./runtime-profile.js";

interface SqliteStatement {
  get(): unknown;
}

interface SqliteDatabase {
  prepare(source: string): SqliteStatement;
  close(): void;
}

interface SqliteConstructor {
  new (filename: string): SqliteDatabase;
}

interface Disposable {
  dispose(): void;
}

interface PtyProcess {
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): Disposable;
  kill(signal?: string): void;
}

interface NodePtyModule {
  spawn(
    file: string,
    args: readonly string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
    },
  ): PtyProcess;
}

const repositoryRoot = discoverRepositoryRoot();
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor !== 24) {
  throw new Error(`Native preflight requires Node 24 LTS; received ${process.version}.`);
}

const requireFromServer = createRequire(join(repositoryRoot, "apps/server/package.json"));
const sqliteEntry = realpathSync(requireFromServer.resolve("better-sqlite3"));
const nodePtyEntry = realpathSync(requireFromServer.resolve("node-pty"));
const nodePtyPackage = realpathSync(requireFromServer.resolve("node-pty/package.json"));
assertDependencyInsideWorktree(repositoryRoot, sqliteEntry);
assertDependencyInsideWorktree(repositoryRoot, nodePtyEntry);
assertDependencyInsideWorktree(repositoryRoot, nodePtyPackage);

const Database = requireFromServer("better-sqlite3") as SqliteConstructor;
const database = new Database(":memory:");
let sqliteResult: unknown;
try {
  sqliteResult = database.prepare("SELECT 24 AS node_major").get();
} finally {
  database.close();
}

const nodePty = requireFromServer("node-pty") as NodePtyModule;
if (typeof nodePty.spawn !== "function") {
  throw new Error("node-pty loaded without its native spawn entrypoint.");
}
const helper = prepareNodePtyHelper(nodePtyPackage);
const ptyOutput = await runPtySmoke(nodePty, repositoryRoot);

console.log(
  JSON.stringify(
    {
      status: "ok",
      repositoryRoot,
      node: process.version,
      modulesAbi: process.versions.modules,
      betterSqlite3: {
        entry: sqliteEntry,
        result: sqliteResult,
      },
      nodePty: {
        entry: nodePtyEntry,
        helper,
        output: ptyOutput,
      },
    },
    null,
    2,
  ),
);

function assertDependencyInsideWorktree(root: string, dependencyEntry: string): void {
  const pathFromRoot = relative(root, dependencyEntry);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) {
    throw new Error(`Native dependency resolved outside the current worktree: ${dependencyEntry}`);
  }
}

function prepareNodePtyHelper(packageJson: string): {
  readonly path: string;
  readonly executableBitAdded: boolean;
} {
  const packageRoot = dirname(packageJson);
  const candidates = [
    join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    join(packageRoot, "build", "Release", "spawn-helper"),
  ];
  const helper = candidates.find((candidate) => existsSync(candidate));
  if (helper === undefined) {
    throw new Error("node-pty spawn-helper was not installed.");
  }
  assertDependencyInsideWorktree(repositoryRoot, realpathSync(helper));
  const mode = statSync(helper).mode;
  const executableBitAdded = (mode & 0o100) === 0;
  if (executableBitAdded) chmodSync(helper, mode | 0o100);
  return { path: realpathSync(helper), executableBitAdded };
}

function runPtySmoke(nodePty: NodePtyModule, cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const terminal = nodePty.spawn("/bin/sh", ["-c", "printf naru-node24-pty-ok"], {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TERM: "xterm-256color",
      },
    });
    let output = "";
    const dataSubscription = terminal.onData((data) => {
      output += data;
    });
    const timeout = setTimeout(() => {
      terminal.kill();
      reject(new Error("node-pty smoke timed out."));
    }, 5_000);
    const exitSubscription = terminal.onExit(({ exitCode, signal }) => {
      clearTimeout(timeout);
      dataSubscription.dispose();
      exitSubscription.dispose();
      const normalizedOutput = output.replace(/\r/g, "");
      if (exitCode !== 0 || (signal ?? 0) !== 0) {
        reject(new Error(`node-pty smoke exited with code ${exitCode}, signal ${signal ?? 0}.`));
        return;
      }
      if (normalizedOutput !== "naru-node24-pty-ok") {
        reject(
          new Error(`node-pty returned unexpected output: ${JSON.stringify(normalizedOutput)}`),
        );
        return;
      }
      resolvePromise(normalizedOutput);
    });
  });
}
