// V08 (Claude side): Naru-managed messaging through a stdio MCP stub whose sender identity is bound by
// a per-session token in the MCP server env. Native SendMessage is denied in these sessions.
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { ClaudeSpikeProcess, toolResults, toolUses } from "./claude-process.js";
import { spikeSettings } from "./hook-settings.js";
import { runDirectory, SPIKE_DIR } from "./spike-env.js";

const VERBATIM = [
  "Kiro의 기존 에이전트 시스템에 Hook/MCP로 가이드를 연결해 줘.",
  '"공식 확장 지점 우선" — 별도 에이전트 UI 재구현 금지 (SPIKE-V08)',
].join("\n");
const ORIGIN = "instr-user-17";

const run = runDirectory("v08");
const store = resolve(run, "naru-stub-store.json");
const registry = resolve(run, "naru-stub-registry.json");
const tokens = { a: randomBytes(24).toString("hex"), b: randomBytes(24).toString("hex") };
writeFileSync(
  registry,
  JSON.stringify({ tokens: { [tokens.a]: "agent-a", [tokens.b]: "agent-b" } }),
  {
    mode: 0o600,
  },
);

function mcpConfig(token: string | undefined): Record<string, unknown> {
  return {
    mcpServers: {
      naru: {
        command: process.execPath,
        args: [resolve(SPIKE_DIR, "naru-stub-mcp.mjs")],
        env: {
          NARU_STUB_STORE: store,
          NARU_STUB_REGISTRY: registry,
          ...(token === undefined ? {} : { NARU_STUB_SESSION_TOKEN: token }),
        },
      },
    },
  };
}

const allowed = ["--allowedTools", "mcp__naru__send_message", "mcp__naru__inbox"];
const processes: ClaudeSpikeProcess[] = [];
function start(name: string, token: string | undefined): ClaudeSpikeProcess {
  const child = new ClaudeSpikeProcess({
    name,
    runDirectory: run,
    mcpConfig: mcpConfig(token),
    extraArgs: allowed,
    settings: spikeSettings({ role: name, runDirectory: run, inbound: "refuse", sendAllow: "^$" }),
  });
  processes.push(child);
  return child;
}

const summary: Record<string, unknown> = { run };
try {
  const a = start("naru-spike-a", tokens.a);
  a.send(
    [
      "[naru-spike] Automated managed-messaging experiment.",
      `Call the naru send_message tool with to='agent-b', origin_instruction_id='${ORIGIN}' and`,
      "verbatim set to exactly the text between the markers (two lines, keep every character):",
      `<<<\n${VERBATIM}\n>>>`,
      "Then make a second send_message call to agent-b with verbatim 'SPOOF-ATTEMPT',",
      `origin_instruction_id='${ORIGIN}', and an extra argument from='agent-x'.`,
      "Do not use any other messaging tool. Report both tool results verbatim.",
    ].join("\n"),
  );
  await a.waitForResults(1, 180_000);

  const b = start("naru-spike-b", tokens.b);
  b.send("[naru-spike] Call the naru inbox tool exactly once and report its raw result.");
  const unbound = start("naru-spike-c", undefined);
  unbound.send("[naru-spike] Call the naru inbox tool exactly once and report its raw result.");
  await Promise.all([b.waitForResults(1, 180_000), unbound.waitForResults(1, 180_000)]);

  const stored = JSON.parse(readFileSync(store, "utf8")) as {
    messages: Array<Record<string, unknown>>;
    calls: Array<Record<string, unknown>>;
  };
  const aUses = toolUses(a.events);
  const sentVerbatim = aUses.find((use) => use.name === "mcp__naru__send_message")?.input as
    Record<string, unknown> | undefined;
  const bResults = toolResults(b.events);
  const bInbox = toolUses(b.events).find((use) => use.name === "mcp__naru__inbox");
  const delivered = bInbox === undefined ? undefined : bResults.get(bInbox.id);
  const first = stored.messages[0];
  summary.result = {
    aTools: aUses.map((use) => ({
      name: use.name,
      argKeys: Object.keys((use.input as object) ?? {}).sort(),
    })),
    aResults: [...toolResults(a.events).values()],
    storedCount: stored.messages.length,
    storedFrom: stored.messages.map((m) => m.from),
    storedOrigin: stored.messages.map((m) => m.origin_instruction_id),
    modelCopiedExactly: sentVerbatim?.verbatim === VERBATIM,
    transportPreserved: first?.verbatim === sentVerbatim?.verbatim,
    deliveredMatchesStore:
      delivered !== undefined &&
      first !== undefined &&
      delivered.includes(JSON.stringify(first.verbatim).slice(1, -1)),
    deliveredFromBound: delivered?.includes('"from":"agent-a"') ?? false,
    unboundResult: [...toolResults(unbound.events).values()],
    calls: stored.calls.map((call) => ({
      identity: call.identity,
      tool: call.tool,
      outcome: call.outcome,
      argKeys: call.argKeys,
      requestedProtocolVersion: call.requestedProtocolVersion,
    })),
  };
} finally {
  await Promise.all(processes.map((child) => child.close()));
  writeFileSync(resolve(run, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
  process.stdout.write(`summary: ${resolve(run, "summary.json")}\n`);
}
