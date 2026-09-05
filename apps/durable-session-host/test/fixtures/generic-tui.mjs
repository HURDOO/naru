process.stdin.setEncoding("utf8");
process.stdin.setRawMode?.(true);
process.stdin.resume();

let counter = 0;
process.stdout.write("\u001b[?1049h\u001b[2J\u001b[HACTUAL-TUI-READY\r\n");
const ticker = setInterval(() => {
  counter += 1;
  process.stdout.write(`heartbeat:${counter}\r\n`);
}, 100);

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(ticker);
  process.stdout.write("\u001b[?1049l");
  process.exit(0);
}

process.stdin.on("data", (data) => {
  if (data.includes("q")) stop();
});
process.on("SIGHUP", stop);
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
