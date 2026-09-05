import { randomUUID } from "node:crypto";
import { ExecCommandSpecV0Schema, type CommandSpecV0 } from "@naru/contracts/durable-session/v0";
import type { DurableSessionClient } from "@naru/durable-session-client";
import { readPrivateJsonFile } from "@naru/durable-session-client/node";
import type { CliCommand } from "./arguments.js";
import type { CliWriter } from "./output.js";

export type CliNonInteractiveCommand = Exclude<CliCommand, { readonly name: "attach" | "control" }>;

export async function executeCliCommand(options: {
  readonly command: CliNonInteractiveCommand;
  readonly client: DurableSessionClient;
  readonly writer: CliWriter;
  readonly signal?: AbortSignal;
  readonly idempotencyKey?: () => string;
}): Promise<void> {
  const idempotencyKey = options.idempotencyKey ?? randomUUID;
  switch (options.command.name) {
    case "run": {
      const command = resolveCommandSpec(options.command);
      const result = await options.client.request(
        {
          operation: "createSession",
          idempotencyKey: idempotencyKey(),
          command,
        },
        requestOptions(options.signal),
      );
      options.writer.success("run", result);
      return;
    }
    case "list": {
      const result = await options.client.request(
        {
          operation: "listSessions",
          limit: options.command.limit,
          ...(options.command.cursor === undefined ? {} : { cursor: options.command.cursor }),
        },
        requestOptions(options.signal),
      );
      options.writer.success("list", result);
      return;
    }
    case "stop": {
      const result = await options.client.request(
        {
          operation: "stopSession",
          sessionId: options.command.sessionId,
          expectedSessionRevision: options.command.expectedSessionRevision,
          expectedRuntimeId: options.command.expectedRuntimeId,
          idempotencyKey: idempotencyKey(),
        },
        requestOptions(options.signal),
      );
      options.writer.success("stop", result);
      return;
    }
    case "watch":
      await watchEvents(options.command, options.client, options.writer, options.signal);
      return;
  }
}

function resolveCommandSpec(command: Extract<CliCommand, { readonly name: "run" }>): CommandSpecV0 {
  if (command.source.kind === "profile") {
    return {
      kind: "profile",
      profileId: command.source.profileId,
      cwd: { rootId: command.source.rootId, relativePath: command.source.relativePath },
      terminal: command.source.terminal,
    };
  }
  const parsed = ExecCommandSpecV0Schema.safeParse(readPrivateJsonFile(command.source.path));
  if (!parsed.success) {
    throw new Error("ARBITRARY_EXEC_SPEC_INVALID");
  }
  return parsed.data;
}

async function watchEvents(
  command: Extract<CliCommand, { readonly name: "watch" }>,
  client: DurableSessionClient,
  writer: CliWriter,
  signal?: AbortSignal,
): Promise<void> {
  let afterEventId = command.afterEventId;
  do {
    const result = await client.request(
      {
        operation: "waitForEvents",
        ...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
        ...(afterEventId === undefined ? {} : { afterEventId }),
        limit: command.limit,
        timeoutMs: command.timeoutMs,
      },
      requestOptions(signal),
    );
    writer.success("watch", result);
    afterEventId = result.events.at(-1)?.eventId ?? afterEventId;
  } while (!command.once);
}

function requestOptions(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}
