#!/usr/bin/env node
/* global process */

import { once } from "node:events";

process.stdin.setEncoding("utf8");
process.stdin.setRawMode?.(true);
process.stdin.resume();

let input = "";
let work = Promise.resolve();

process.stdin.on("data", (data) => {
  input += data;
  let newline = input.indexOf("\n");
  while (newline >= 0) {
    const command = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (command) work = work.then(() => handle(command));
    newline = input.indexOf("\n");
  }
});

process.on("SIGHUP", () => process.exit(0));

async function handle(command) {
  const [operation, first, second] = command.split(" ");
  if (operation === "PING" && first && !second) {
    await write(`${first}\r\n`);
    return;
  }
  if (operation === "BURST" && first && second) {
    const lineCount = Number(first);
    if (!Number.isSafeInteger(lineCount) || lineCount < 1 || lineCount > 20_000) {
      throw new Error("Invalid BURST line count.");
    }
    for (let offset = 0; offset < lineCount; offset += 64) {
      const rows = [];
      const end = Math.min(offset + 64, lineCount);
      for (let index = offset; index < end; index += 1) {
        rows.push(
          `${second}_${String(index).padStart(5, "0")}_abcdefghijklmnopqrstuvwxyz0123456789`,
        );
      }
      await write(`${rows.join("\r\n")}\r\n`);
    }
    await write(`DONE_${second}\r\n`);
    return;
  }
  if (operation === "EXIT") process.exit(0);
  throw new Error("Unknown performance fixture command.");
}

async function write(data) {
  if (!process.stdout.write(data)) await once(process.stdout, "drain");
}
