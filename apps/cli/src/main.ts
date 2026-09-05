#!/usr/bin/env node
import { runSessionCli } from "./runner.js";

const controller = new AbortController();
const abort = (): void => controller.abort();
process.once("SIGINT", abort);
process.once("SIGTERM", abort);

process.exitCode = await runSessionCli(process.argv.slice(2), { signal: controller.signal });
process.off("SIGINT", abort);
process.off("SIGTERM", abort);
