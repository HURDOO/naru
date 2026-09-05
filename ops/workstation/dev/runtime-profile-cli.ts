import {
  assertProfilePortsAvailable,
  createNaruDevelopmentEnvironment,
  createRuntimeProfile,
  discoverRepositoryRoot,
  prepareRuntimeDirectories,
} from "./runtime-profile.js";

type Command = "show" | "check" | "prepare";

const { command, rootOverride } = parseArguments(process.argv.slice(2));
const repositoryRoot = discoverRepositoryRoot(rootOverride ?? process.cwd());
const profile = createRuntimeProfile(repositoryRoot);

if (command === "check" || command === "prepare") {
  await assertProfilePortsAvailable(profile);
}
if (command === "prepare") {
  prepareRuntimeDirectories(profile);
}

console.log(
  JSON.stringify(
    {
      status: "ok",
      command,
      profile,
      naruEnvironment: createNaruDevelopmentEnvironment(profile),
      portsChecked: command !== "show",
      directoriesPrepared: command === "prepare",
    },
    null,
    2,
  ),
);

function parseArguments(arguments_: readonly string[]): {
  readonly command: Command;
  readonly rootOverride?: string;
} {
  const commandValue = arguments_[0] ?? "show";
  if (commandValue !== "show" && commandValue !== "check" && commandValue !== "prepare") {
    throw new Error("Usage: runtime-profile-cli.ts <show|check|prepare> [--root <directory>]");
  }

  let rootOverride: string | undefined;
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument !== "--root" || rootOverride !== undefined) {
      throw new Error("Usage: runtime-profile-cli.ts <show|check|prepare> [--root <directory>]");
    }
    const value = arguments_[index + 1];
    if (value === undefined || value === "") {
      throw new Error("--root requires a directory.");
    }
    rootOverride = value;
    index += 1;
  }

  return rootOverride === undefined
    ? { command: commandValue }
    : { command: commandValue, rootOverride };
}
