import { describe, expect, it } from "vitest";
import { parseCliArguments } from "../src/arguments.js";
import { CliUsageError } from "../src/usage-error.js";

const connection = [
  "--socket",
  "/private/tmp/fixture.sock",
  "--app-id",
  "fixture-app",
  "--credential-file",
  "/private/tmp/fixture.credential",
  "--subject",
  "fixture-owner",
] as const;

describe("Session CLI argument contract", () => {
  it("parses a profile run without shell interpolation", () => {
    expect(
      parseCliArguments(
        [
          "--json",
          ...connection,
          "run",
          "--profile",
          "fixture-profile",
          "--root",
          "projects",
          "--cwd",
          "sample",
          "--cols",
          "100",
          "--rows",
          "30",
        ],
        {},
      ),
    ).toMatchObject({
      mode: "execute",
      json: true,
      command: {
        name: "run",
        source: {
          kind: "profile",
          profileId: "fixture-profile",
          rootId: "projects",
          relativePath: "sample",
          terminal: { cols: 100, rows: 30 },
        },
      },
    });
  });

  it("requires explicit arbitrary-exec opt-in and a private spec path", () => {
    expect(() =>
      parseCliArguments([...connection, "run", "--exec-spec", "/private/tmp/spec.json"], {}),
    ).toThrow(CliUsageError);
    expect(
      parseCliArguments(
        [...connection, "run", "--exec-spec", "/private/tmp/spec.json", "--allow-arbitrary-exec"],
        {},
      ),
    ).toMatchObject({
      command: { name: "run", source: { kind: "exec-file", path: "/private/tmp/spec.json" } },
    });
  });

  it("requires optimistic fencing for stop", () => {
    expect(() =>
      parseCliArguments([...connection, "stop", "10000000-0000-4000-8000-000000000001"], {}),
    ).toThrow(CliUsageError);
    expect(
      parseCliArguments(
        [
          ...connection,
          "stop",
          "10000000-0000-4000-8000-000000000001",
          "--revision",
          "3",
          "--runtime",
          "20000000-0000-4000-8000-000000000001",
        ],
        {},
      ),
    ).toMatchObject({
      command: {
        name: "stop",
        expectedSessionRevision: 3,
        expectedRuntimeId: "20000000-0000-4000-8000-000000000001",
      },
    });
  });

  it("accepts an explicit caller lifetime without putting credentials in argv", () => {
    expect(
      parseCliArguments(["--caller-ttl-ms", "45000", ...connection, "list"], {}),
    ).toMatchObject({
      connection: { callerTtlMs: 45_000 },
    });
    expect(() => parseCliArguments(["--caller-ttl-ms", "0", ...connection, "list"], {})).toThrow(
      CliUsageError,
    );
  });
});
