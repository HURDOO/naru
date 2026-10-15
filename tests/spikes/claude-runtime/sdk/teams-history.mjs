/* global process */
import { listSubagents, getSubagentMessages } from "@anthropic-ai/claude-agent-sdk";
const [sessionId, dir] = process.argv.slice(2);
const agents = await listSubagents(sessionId, { dir });
const out = [];
for (const agent of agents) {
  const messages = await getSubagentMessages(sessionId, agent, { dir });
  out.push({ agentIdPrefix: agent.slice(0, 6), messageCount: messages.length });
}
process.stdout.write(`${JSON.stringify({ item: "V07.teammate-history", subagents: out })}\n`);
