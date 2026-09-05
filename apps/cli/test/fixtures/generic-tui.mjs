#!/usr/bin/env node
/* global clearInterval, process, setInterval */

let counter = 0;
let closed = false;

function render() {
  const columns = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  process.stdout.write(
    `\u001b[H\u001b[2Jdurable-session generic TUI\r\n` +
      `counter=${counter}\r\n` +
      `geometry=${columns}x${rows}\r\n` +
      "keys: + increment, r reset, q quit",
  );
}

function close() {
  if (closed) return;
  closed = true;
  clearInterval(timer);
  process.stdout.write("\u001b[?1049l");
  process.exitCode = 0;
}

process.stdout.write("\u001b[?1049h");
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", (data) => {
  for (const key of data) {
    if (key === "q" || key === "\u0003") {
      close();
      return;
    }
    if (key === "+") counter += 1;
    if (key === "r") counter = 0;
  }
  render();
});
process.stdout.on("resize", render);
process.once("SIGTERM", close);
process.once("SIGHUP", close);

const timer = setInterval(() => {
  counter += 1;
  render();
}, 250);
render();
