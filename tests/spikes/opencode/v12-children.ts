import {
  SPIKE_MODEL,
  SpikeClient,
  report,
  sessionOf,
  spikeConfig,
  waitFor,
  type OpenCodeEvent,
} from "./client.js";

/**
 * V12 child-session trace (L1 lifecycle, L2 live transcript, L3 interaction, L4 attach).
 * Usage: node --import tsx tests/spikes/opencode/v12-children.ts <sync|background|intervene>
 *   sync       parent calls `task` (run_in_background=false) for a `general` child
 *   background parent calls OmO `task` with run_in_background=true
 *   intervene  background child runs `sleep`; spike aborts it and prompts a second child directly
 */
interface Session {
  readonly id: string;
  readonly parentID?: string;
  readonly title?: string;
}
interface Message {
  readonly info: {
    readonly id: string;
    readonly role: string;
    readonly agent?: string;
    readonly error?: { readonly name?: string };
  };
  readonly parts: readonly {
    readonly type: string;
    readonly tool?: string;
    readonly synthetic?: boolean;
    readonly text?: string;
  }[];
}

const client = new SpikeClient(spikeConfig(), "v12-children");
const mode = process.argv[2] ?? "sync";
const events: OpenCodeEvent[] = [];
const stream = client.subscribe("/event", (event) => events.push(event));
await stream.ready;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const parent = await client.api<Session>("POST", "/session", {
  title: `[naru-spike] v12 children ${mode}`,
  permission: [{ permission: "bash", pattern: "*", action: "allow" }],
});
report("parent", parent.id);

const childCreated = () =>
  events.filter((event) => {
    if (event.type !== "session.created") return false;
    const info = (event.properties as { info?: Session }).info;
    return info?.parentID === parent.id;
  });
const childIds = () =>
  childCreated().map((event) => (event.properties as { info: Session }).info.id);

const prompts: Record<string, string> = {
  sync:
    "[naru-spike] Call the task tool exactly once with subagent_type general and run_in_background false. " +
    "The child prompt must be: use the bash tool to run exactly `sleep 8 && ls`, then reply with exactly CHILDSYNC. " +
    "After the task returns, reply with exactly PARENTSYNC.",
  background:
    "[naru-spike] Call the task tool exactly once with subagent_type general and run_in_background true. " +
    "The child prompt must be: use the bash tool to run exactly `sleep 8 && ls`, then reply with exactly CHILDBG. " +
    "Do not wait for it and do not call background_output. Reply with exactly PARENTLAUNCHED.",
  intervene:
    "[naru-spike] Call the task tool twice in parallel, both with subagent_type general and run_in_background true. " +
    "First child prompt: use the bash tool to run exactly `sleep 120`, then reply with exactly CHILDLONG. " +
    "Second child prompt: reply with exactly CHILDIDLE and stop. " +
    "Do not wait for them. Reply with exactly PARENTLAUNCHED.",
};
const started = Date.now();
await client.api("POST", `/session/${parent.id}/prompt_async`, {
  model: SPIKE_MODEL,
  parts: [{ type: "text", text: prompts[mode] }],
});

const findings: Record<string, unknown> = {};
try {
  await waitFor(() => (childIds().length > 0 ? true : undefined), 180_000, "child session");
  const firstChild = childIds()[0]!;
  findings.L1_childCreatedEvent = { parentMatches: true, msAfterPrompt: Date.now() - started };

  // L2: are child transcript events streamed while the child runs?
  const childPartEvents = () =>
    events.filter(
      (event) => event.type.startsWith("message.part") && sessionOf(event) === firstChild,
    );
  await waitFor(() => (childPartEvents().length > 0 ? true : undefined), 120_000, "child parts");
  findings.L2_childPartEventsStreamed = true;

  if (mode === "intervene") {
    await waitFor(() => (childIds().length >= 2 ? true : undefined), 120_000, "second child");
    await sleep(15_000);
    const children = await client.api<Session[]>("GET", `/session/${parent.id}/children`);
    const childMessages = await Promise.all(
      children.map(async (child) => ({
        child,
        messages: await client.api<Message[]>("GET", `/session/${child.id}/message`),
      })),
    );
    const longChild = childMessages.find(({ messages }) =>
      messages.some((message) => message.parts.some((part) => part.text?.includes("sleep 120"))),
    );
    const idleChild = childMessages.find((entry) => entry !== longChild);
    findings.childrenEndpoint = children.map((child) => ({
      parentMatches: child.parentID === parent.id,
    }));
    if (longChild !== undefined) {
      const abortAt = Date.now();
      await client.api("POST", `/session/${longChild.child.id}/abort`);
      await waitFor(
        () =>
          events.find(
            (event) =>
              event.type === "session.idle" &&
              sessionOf(event) === longChild.child.id &&
              (event.receivedAt ?? 0) >= abortAt,
          ),
        60_000,
        "child idle after abort",
      );
      findings.L3_individualAbortMs = Date.now() - abortAt;
      const parentStatus = await client.api<Record<string, { type: string }>>(
        "GET",
        "/session/status",
      );
      findings.parentStatusAfterChildAbort = parentStatus[parent.id]?.type ?? "idle";
    }
    if (idleChild !== undefined) {
      const directAt = Date.now();
      await client.api("POST", `/session/${idleChild.child.id}/prompt_async`, {
        model: SPIKE_MODEL,
        parts: [
          { type: "text", text: "[naru-spike] Direct message: reply with exactly CHILDDIRECT." },
        ],
      });
      await waitFor(
        () =>
          events.find(
            (event) =>
              event.type === "session.idle" &&
              sessionOf(event) === idleChild.child.id &&
              (event.receivedAt ?? 0) >= directAt,
          ),
        120_000,
        "direct child reply",
      );
      const after = await client.api<Message[]>("GET", `/session/${idleChild.child.id}/message`);
      findings.L3_directMessageToChild = after.some(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.some((part) => part.text?.includes("CHILDDIRECT")),
      );
    }
  }

  // Let the parent (and background completion notifications) settle.
  await sleep(mode === "sync" ? 5_000 : 60_000);
  const parentMessages = await client.api<Message[]>("GET", `/session/${parent.id}/message`);
  findings.parentTimeline = parentMessages.map((message) => ({
    role: message.info.role,
    agent: message.info.agent,
    error: message.info.error?.name,
    parts: message.parts.map((part) =>
      part.type === "tool"
        ? `tool:${part.tool}`
        : part.synthetic === true
          ? `${part.type}(synthetic)`
          : part.type,
    ),
  }));
  findings.parentGotUnpromptedTurn =
    parentMessages.filter((message) => message.info.role === "user").length > 1;
  const children = await client.api<Session[]>("GET", `/session/${parent.id}/children`);
  findings.childrenCount = children.length;
  findings.childEventTypes = [
    ...new Set(
      events
        .filter((event) => children.some((child) => sessionOf(event) === child.id))
        .map((event) => event.type),
    ),
  ];
} finally {
  report("findings", findings);
  stream.close();
}
