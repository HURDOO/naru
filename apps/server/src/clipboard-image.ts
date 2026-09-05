import { spawn } from "node:child_process";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_CLIPBOARD_IMAGE_BYTES } from "@naru/contracts";
import { AppError } from "./errors.js";

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_IMAGE_DIMENSION = 8192;
const MAX_IMAGE_PIXELS = 40_000_000;
const APPLESCRIPT_TIMEOUT_MS = 5_000;
const APPLESCRIPT_LINES = [
  "on run argv",
  "set imageFile to POSIX file (item 1 of argv)",
  "set the clipboard to (read imageFile as «class PNGf»)",
  "end run",
] as const;

export interface ClipboardImageWriter {
  writePng(image: Uint8Array): Promise<void>;
}

export type AppleScriptRunner = (executable: string, args: readonly string[]) => Promise<void>;

export class MacClipboardImageWriter implements ClipboardImageWriter {
  readonly #executable: string;
  readonly #runner: AppleScriptRunner;

  constructor(executable = "/usr/bin/osascript", runner: AppleScriptRunner = runAppleScript) {
    this.#executable = executable;
    this.#runner = runner;
  }

  async writePng(image: Uint8Array): Promise<void> {
    validateClipboardPng(image);
    const directory = await mkdtemp(join(tmpdir(), "naru-clipboard-"));
    const imagePath = join(directory, "clipboard.png");
    let operationFailed = false;
    let operationError: unknown;
    try {
      await writeFile(imagePath, image, { flag: "wx", mode: 0o600 });
      const args = APPLESCRIPT_LINES.flatMap((line) => ["-e", line]);
      await this.#runner(this.#executable, [...args, "--", imagePath]);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }

    let cleanupError: unknown;
    try {
      await unlink(imagePath);
    } catch (error) {
      if (!isMissingPathError(error)) cleanupError = error;
    }
    try {
      await rmdir(directory);
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError !== undefined) throw toError(cleanupError, "Clipboard cleanup failed.");
    if (operationFailed) throw toError(operationError, "Mac clipboard command failed.");
  }
}

export function validateClipboardPng(image: Uint8Array): {
  width: number;
  height: number;
} {
  if (image.byteLength === 0 || image.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) {
    throw invalidImage("클립보드 이미지는 16 MiB 이하여야 합니다.");
  }
  if (image.byteLength < 33 || !PNG_SIGNATURE.every((byte, index) => image[index] === byte)) {
    throw invalidImage("PNG 이미지 형식이 올바르지 않습니다.");
  }
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const ihdrLength = view.getUint32(8);
  const ihdrType = String.fromCharCode(
    image[12] ?? 0,
    image[13] ?? 0,
    image[14] ?? 0,
    image[15] ?? 0,
  );
  if (ihdrLength !== 13 || ihdrType !== "IHDR") {
    throw invalidImage("PNG 헤더가 올바르지 않습니다.");
  }
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (
    width === 0 ||
    height === 0 ||
    width > MAX_IMAGE_DIMENSION ||
    height > MAX_IMAGE_DIMENSION ||
    width * height > MAX_IMAGE_PIXELS
  ) {
    throw invalidImage("이미지 크기는 8192px 및 4천만 픽셀 이하여야 합니다.");
  }
  return { width, height };
}

export function decodeClipboardImageChunk(data: string): Uint8Array {
  if (
    data.length === 0 ||
    data.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
  ) {
    throw invalidImage("이미지 조각의 base64 형식이 올바르지 않습니다.");
  }
  const decoded = Buffer.from(data, "base64");
  if (decoded.toString("base64") !== data) {
    throw invalidImage("이미지 조각의 base64 형식이 올바르지 않습니다.");
  }
  return decoded;
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === "ENOENT"
  );
}

function toError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

function invalidImage(message: string): AppError {
  return new AppError("REQUEST_INVALID", 400, message);
}

function runAppleScript(executable: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      stdio: "ignore",
      windowsHide: true,
    });
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Mac clipboard command timed out."));
    }, APPLESCRIPT_TIMEOUT_MS);
    timeout.unref();
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code === 0) finish();
      else finish(new Error("Mac clipboard command failed."));
    });
  });
}
