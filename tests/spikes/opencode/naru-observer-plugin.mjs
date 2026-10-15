/* global process */
import { appendFileSync } from "node:fs";

/**
 * V12 spike OpenCode plugin, injected only into the spike server through OPENCODE_CONFIG_CONTENT.
 * It records redacted hook metadata (types, IDs, tool names, lengths; never message text), can
 * deny configured tools in `tool.execute.before`, injects a per-session shell env value, and offers
 * a `naru_whoami` tool whose identity comes from the server-provided ToolContext.
 */
export const NaruSpikeObserver = async () => {
  const file = process.env.NARU_SPIKE_PLUGIN_LOG;
  const blocked = new Set(
    (process.env.NARU_SPIKE_BLOCK_TOOLS ?? "").split(",").filter((tool) => tool !== ""),
  );
  const log = (record) => {
    if (file) appendFileSync(file, `${JSON.stringify({ t: Date.now(), ...record })}\n`);
  };
  const sessionOf = (properties) =>
    properties?.sessionID ?? properties?.info?.sessionID ?? properties?.part?.sessionID;
  return {
    event: async ({ event }) => {
      const properties = event.properties ?? {};
      log({
        hook: "event",
        type: event.type,
        sessionID: event.type === "session.created" ? properties.info?.id : sessionOf(properties),
        parentID:
          event.type === "session.created" ? (properties.info?.parentID ?? null) : undefined,
      });
    },
    "chat.message": async (input, output) => {
      const text = output.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("");
      log({
        hook: "chat.message",
        sessionID: input.sessionID,
        agent: input.agent,
        partTypes: output.parts.map((part) => part.type),
        textLength: text.length,
        startsWithSystemReminder: text.trimStart().startsWith("<system-reminder>"),
      });
    },
    "tool.execute.before": async (input) => {
      log({ hook: "tool.execute.before", tool: input.tool, sessionID: input.sessionID });
      if (blocked.has(input.tool)) throw new Error(`NARU_POLICY_DENIED: ${input.tool}`);
    },
    "tool.execute.after": async (input) => {
      log({ hook: "tool.execute.after", tool: input.tool, sessionID: input.sessionID });
    },
    "permission.ask": async (input) => {
      log({
        hook: "permission.ask",
        sessionID: input.sessionID,
        permission: input.type ?? input.permission,
      });
    },
    "shell.env": async (input, output) => {
      output.env.NARU_SPIKE_SESSION = input.sessionID ?? "none";
      log({ hook: "shell.env", sessionID: input.sessionID ?? null });
    },
    tool: {
      naru_whoami: {
        description: "Return the identity Naru would bind to this calling OpenCode session.",
        args: {},
        async execute(_args, context) {
          log({ hook: "tool.naru_whoami", sessionID: context.sessionID, agent: context.agent });
          return `NARU_WHOAMI session=${context.sessionID} agent=${context.agent}`;
        },
      },
    },
  };
};
