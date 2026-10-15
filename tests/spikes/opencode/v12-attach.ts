import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
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
import { startPty } from "./pty.js";

/**
 * V12 live attach: an API client and `opencode attach --session` TUI on the same server session.
 * Checks history replay, live rendering of API-originated turns, API events for TUI-originated
 * turns, and behavior of overlapping writes (v1 prompt_async, v2 delivery queue/steer, TUI submit).
 */
interface Message {
  readonly info: { readonly id: string; readonly role: string; readonly error?: { name?: string } };
  readonly parts: readonly { readonly type: string; readonly text?: string }[];
}

const config = spikeConfig();
const client = new SpikeClient(config, "v12-attach");
const executable =
  process.env.OPENCODE_SPIKE_EXECUTABLE ?? join(homedir(), ".opencode/bin/opencode");
const events: OpenCodeEvent[] = [];
const stream = client.subscribe("/event", (event) => events.push(event));
await stream.ready;

const textOf = (messages: readonly Message[]) =>
  messages.map((message) => message.parts.map((part) => part.text ?? "").join(" ")).join("\n");
const messages = (id: string) => client.api<Message[]>("GET", `/session/${id}/message`);
const idleAfter = (id: string, after: number, timeoutMs = 240_000) =>
  waitFor(
    () =>
      events.find(
        (event) =>
          event.type === "session.idle" &&
          sessionOf(event) === id &&
          (event.receivedAt ?? 0) >= after,
      ),
    timeoutMs,
    "session.idle",
  );
const saveScreen = (name: string, screen: string) =>
  writeFileSync(join(config.logDirectory, `attach-${name}.txt`), screen, { mode: 0o600 });

// OPENCODE_SPIKE_PARENT creates the session as an API-made child (parentID) of that session.
const session = await client.api<{ id: string; parentID?: string }>("POST", "/session", {
  title: "[naru-spike] v12 attach",
  permission: [{ permission: "bash", pattern: "*", action: "allow" }],
  ...(process.env.OPENCODE_SPIKE_PARENT ? { parentID: process.env.OPENCODE_SPIKE_PARENT } : {}),
});
report("parentID", session.parentID ?? null);
report("session", session.id);

// 1. History created through the API before the TUI exists.
let started = Date.now();
await client.api("POST", `/session/${session.id}/prompt_async`, {
  model: SPIKE_MODEL,
  parts: [{ type: "text", text: "[naru-spike] Reply with exactly ALPHAONE. No tools." }],
});
await idleAfter(session.id, started);

// 2. Attach the official TUI to the running server session.
const password = readFileSync(process.env.OPENCODE_SPIKE_PASSWORD_FILE!, "utf8").trim();
const tui = startPty(executable, ["attach", config.baseUrl, "--session", session.id], {
  cwd: config.directory,
  env: {
    HOME: homedir(),
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: "en_US.UTF-8",
    OPENCODE_SERVER_PASSWORD: password,
  },
});
const results: Record<string, unknown> = {};
try {
  const replay = await tui
    .waitForScreen((screen) => screen.includes("ALPHAONE"), 60_000, "history replay")
    .then(() => true)
    .catch(() => false);
  saveScreen("1-replay", tui.screen());
  results.historyReplayed = replay;

  // 3. API-originated turn: does the attached TUI render it live?
  started = Date.now();
  await client.api("POST", `/session/${session.id}/prompt_async`, {
    model: SPIKE_MODEL,
    parts: [{ type: "text", text: "[naru-spike] Reply with exactly BRAVOTWO. No tools." }],
  });
  const liveApiTurn = await tui
    .waitForScreen((screen) => screen.includes("BRAVOTWO"), 120_000, "api turn in tui")
    .then(() => Date.now() - started)
    .catch(() => -1);
  saveScreen("2-api-turn", tui.screen());
  results.tuiRendersApiTurnMs = liveApiTurn;
  await idleAfter(session.id, started);

  // 4. TUI-originated turn: does the API stream see it?
  const beforeTui = (await messages(session.id)).length;
  started = Date.now();
  tui.type("[naru-spike] Reply with exactly CHARLIETHREE. No tools.");
  await new Promise((resolve) => setTimeout(resolve, 500));
  tui.type("\r");
  await idleAfter(session.id, started);
  const afterTui = await messages(session.id);
  saveScreen("3-tui-turn", tui.screen());
  results.tuiTurn = {
    newMessages: afterTui.length - beforeTui,
    apiSeesReply: textOf(afterTui).includes("CHARLIETHREE"),
    apiEventsForSession: histogram(
      events.filter((event) => (event.receivedAt ?? 0) >= started),
      session.id,
    ),
  };

  // 5. Overlapping writes while a turn is busy.
  started = Date.now();
  await client.api("POST", `/session/${session.id}/prompt_async`, {
    model: SPIKE_MODEL,
    parts: [
      {
        type: "text",
        text: "[naru-spike] Use the bash tool to run exactly: sleep 20. Then reply with exactly DELTAFOUR.",
      },
    ],
  });
  await waitFor(
    () =>
      events.find(
        (event) =>
          event.type === "session.status" &&
          sessionOf(event) === session.id &&
          (event.receivedAt ?? 0) >= started &&
          (event.properties as { status?: { type?: string } }).status?.type === "busy",
      ),
    60_000,
    "busy",
  );
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const overlap: Record<string, unknown> = {};
  try {
    await client.api("POST", `/session/${session.id}/prompt_async`, {
      model: SPIKE_MODEL,
      parts: [{ type: "text", text: "[naru-spike] Reply with exactly ECHOFIVE. No tools." }],
    });
    overlap.v1PromptAsyncWhileBusy = "accepted";
  } catch (error) {
    overlap.v1PromptAsyncWhileBusy = `rejected:${(error as { status?: number }).status}`;
  }
  tui.type("[naru-spike] Reply with exactly FOXTROTSIX. No tools.");
  await new Promise((resolve) => setTimeout(resolve, 500));
  tui.type("\r");
  overlap.tuiSubmitWhileBusy = "typed";
  for (const delivery of ["queue", "steer"] as const) {
    try {
      await client.api("POST", `/api/session/${session.id}/prompt`, {
        prompt: {
          text: `[naru-spike] Reply with exactly ${delivery === "queue" ? "GOLFSEVEN" : "HOTELEIGHT"}. No tools.`,
        },
        delivery,
      });
      overlap[`v2_${delivery}`] = "accepted";
    } catch (error) {
      const failure = error as { status?: number; body?: string };
      overlap[`v2_${delivery}`] =
        `rejected:${failure.status}:${(failure.body ?? "").slice(0, 160)}`;
    }
  }
  // Let every queued turn drain.
  await new Promise((resolve) => setTimeout(resolve, 90_000));
  const final = await messages(session.id);
  saveScreen("4-overlap", tui.screen());
  const markers = ["DELTAFOUR", "ECHOFIVE", "FOXTROTSIX", "GOLFSEVEN", "HOTELEIGHT"];
  overlap.order = final
    .filter((message) => message.info.role === "user")
    .map((message) => markers.find((marker) => textOf([message]).includes(marker)) ?? "earlier");
  overlap.replied = Object.fromEntries(
    markers.map((marker) => [
      marker,
      final.some(
        (message) => message.info.role === "assistant" && textOf([message]).includes(marker),
      ),
    ]),
  );
  overlap.errors = final
    .filter((message) => message.info.error !== undefined)
    .map((message) => message.info.error?.name);
  overlap.tuiShowsAllReplies = markers.map((marker) => [marker, tui.screen().includes(marker)]);
  results.overlap = overlap;
} finally {
  report("results", results);
  tui.close();
  stream.close();
}
