import { frameText } from "./harness.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { appServer, Rpc, startThread, turn, type Frame } from "./harness.js";

const directory = process.env.NARU_SPIKE_DIRECTORY;
if (!directory) throw new Error("Fixture directory required");
const app = await appServer(directory, process.env);
const rpc = await Rpc.connect(app.socket, directory, "console");
const names = new Set(["turn/started", "turn/completed", "item/started", "item/completed"]);
rpc.socket.on("message", (data) => {
  const frame = JSON.parse(frameText(data)) as Frame;
  if (frame.method && names.has(frame.method)) process.stdout.write(`EVENT ${frame.method}\n`);
});
const threadId = await startThread(rpc);
await turn(rpc, threadId, "SPIKE_CONSOLE_SEED");
writeFileSync(join(directory, "bridge.json"), JSON.stringify({ socket: app.socket, threadId }), {
  mode: 0o600,
});
process.stdout.write("CONSOLE_READY\n");
process.stdin.resume();
process.stdin.on("data", () => process.stdout.write("CONSOLE_INPUT_IGNORED\n"));
let closing = false;
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const)
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    rpc.close();
    void app.close().finally(() => process.exit(0));
  });
