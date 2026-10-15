import {
  SPIKE_MODEL,
  SpikeClient,
  histogram,
  report,
  sessionOf,
  spikeConfig,
  waitFor,
  type OpenCodeEvent,
} from "./client.js";

/**
 * V12 server API scenarios: basic prompt/stream, permission ask/reply, abort and history read.
 * Usage: node --import tsx tests/spikes/opencode/v12-api.ts <basic|permission|abort|history> [sessionId]
 */
interface Session {
  readonly id: string;
  readonly parentID?: string;
}
interface MessagePart {
  readonly type: string;
  readonly tool?: string;
  readonly state?: { readonly status?: string };
}
interface Message {
  readonly info: {
    readonly role: string;
    readonly agent?: string;
    readonly modelID?: string;
    readonly error?: { readonly name?: string };
  };
  readonly parts: readonly MessagePart[];
}

const client = new SpikeClient(spikeConfig(), "v12-api");
const scenario = process.argv[2] ?? "basic";
const events: OpenCodeEvent[] = [];
const stream = client.subscribe("/event", (event) => events.push(event));
await stream.ready;

const idle = (sessionId: string, after: number) =>
  waitFor(
    () =>
      events.find(
        (event) =>
          event.type === "session.idle" &&
          sessionOf(event) === sessionId &&
          (event.receivedAt ?? 0) >= after,
      ),
    180_000,
    "session.idle",
  );

const summarizeMessages = (messages: readonly Message[]) =>
  messages.map((message) => ({
    role: message.info.role,
    agent: message.info.agent,
    model: message.info.modelID,
    error: message.info.error?.name,
    parts: message.parts.map((part) =>
      part.type === "tool" ? `tool:${part.tool}:${part.state?.status}` : part.type,
    ),
  }));

try {
  if (scenario === "basic") {
    const session = await client.api<Session>("POST", "/session", {
      title: "[naru-spike] v12 basic",
    });
    const started = Date.now();
    await client.api("POST", `/session/${session.id}/prompt_async`, {
      model: SPIKE_MODEL,
      parts: [{ type: "text", text: "[naru-spike] Reply with exactly PONG. Do not use tools." }],
    });
    await idle(session.id, started);
    const messages = await client.api<Message[]>("GET", `/session/${session.id}/message`);
    report("session", session.id);
    report("events", histogram(events, session.id));
    report("history", summarizeMessages(messages));
  } else if (scenario === "permission") {
    const session = await client.api<Session>("POST", "/session", {
      title: "[naru-spike] v12 permission",
      permission: [{ permission: "bash", pattern: "*", action: "ask" }],
    });
    const started = Date.now();
    await client.api("POST", `/session/${session.id}/prompt_async`, {
      model: SPIKE_MODEL,
      parts: [
        {
          type: "text",
          text: "[naru-spike] Use the bash tool to run exactly: echo naru-spike-permission. Then reply DONE.",
        },
      ],
    });
    const asked = await waitFor(
      () =>
        events.find(
          (event) => event.type.startsWith("permission.") && sessionOf(event) === session.id,
        ),
      120_000,
      "permission.asked",
    );
    const requestId = (asked.properties as { id: string }).id;
    const pending = await client.api<unknown[]>("GET", "/permission");
    report("permission.event", {
      type: asked.type,
      permission: (asked.properties as { permission?: string }).permission,
      hasToolRef: (asked.properties as { tool?: unknown }).tool !== undefined,
      pendingListed: pending.length,
    });
    await client.api("POST", `/permission/${requestId}/reply`, { reply: "once" });
    // A second client answering the same request (e.g. TUI and GUI both showing it).
    try {
      await client.api("POST", `/permission/${requestId}/reply`, { reply: "reject" });
      report("permission.secondReply", "accepted");
    } catch (error) {
      report("permission.secondReply", `rejected:${(error as { status?: number }).status}`);
    }
    await idle(session.id, started);
    const messages = await client.api<Message[]>("GET", `/session/${session.id}/message`);
    report("session", session.id);
    report(
      "permission.lifecycle",
      events
        .filter((event) => event.type.startsWith("permission.") && sessionOf(event) === session.id)
        .map((event) => event.type),
    );
    report("history", summarizeMessages(messages));
  } else if (scenario === "abort") {
    const session = await client.api<Session>("POST", "/session", {
      title: "[naru-spike] v12 abort",
      permission: [{ permission: "bash", pattern: "*", action: "allow" }],
    });
    const started = Date.now();
    await client.api("POST", `/session/${session.id}/prompt_async`, {
      model: SPIKE_MODEL,
      parts: [
        {
          type: "text",
          text: "[naru-spike] Use the bash tool to run exactly: sleep 60. Then reply DONE.",
        },
      ],
    });
    await waitFor(
      () =>
        events.find((event) => {
          if (event.type !== "message.part.updated" || sessionOf(event) !== session.id)
            return undefined;
          const part = (event.properties as { part?: MessagePart }).part;
          return part?.type === "tool" && part.state?.status === "running" ? event : undefined;
        }),
      120_000,
      "running tool",
    );
    const abortAt = Date.now();
    await client.api("POST", `/session/${session.id}/abort`);
    await idle(session.id, started);
    const messages = await client.api<Message[]>("GET", `/session/${session.id}/message`);
    report("session", session.id);
    report("abort.toIdleMs", Date.now() - abortAt);
    report("history", summarizeMessages(messages));
  } else if (scenario === "history") {
    const sessionId = process.argv[3];
    if (sessionId === undefined) throw new Error("history needs a session id");
    const session = await client.api<Session>("GET", `/session/${sessionId}`);
    const messages = await client.api<Message[]>("GET", `/session/${sessionId}/message`);
    const children = await client.api<Session[]>("GET", `/session/${sessionId}/children`);
    report("session", { id: session.id, parentID: session.parentID ?? null });
    report("history", summarizeMessages(messages));
    report(
      "children",
      children.map((child) => ({ id: child.id, parentID: child.parentID })),
    );
  } else {
    throw new Error(`unknown scenario ${scenario}`);
  }
} finally {
  stream.close();
}
