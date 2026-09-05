import { hashPassword } from "./password.js";

const interactive = process.stdin.isTTY && typeof process.stdin.setRawMode === "function";
const password = interactive ? await readHidden("새 Naru 비밀번호: ") : await readFromStdin();
const confirmation = interactive ? await readHidden("비밀번호 확인: ") : password;

if (password !== confirmation) {
  process.stderr.write("비밀번호가 일치하지 않습니다.\n");
  process.exitCode = 1;
} else {
  try {
    process.stdout.write(`${await hashPassword(password)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "비밀번호 해시 생성 실패"}\n`);
    process.exitCode = 1;
  }
}

async function readHidden(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const onData = (character: string): void => {
      if (character === "\u0003") {
        cleanup();
        reject(new Error("입력이 취소되었습니다."));
        return;
      }
      if (character === "\r" || character === "\n") {
        cleanup();
        process.stderr.write("\n");
        resolve(value);
        return;
      }
      if (character === "\u007f") {
        value = value.slice(0, -1);
        return;
      }
      value += character;
    };
    const cleanup = (): void => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    process.stdin.on("data", onData);
  });
}

async function readFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const unknownChunk: unknown = chunk;
    if (typeof unknownChunk === "string" || unknownChunk instanceof Uint8Array) {
      chunks.push(Buffer.from(unknownChunk));
    } else {
      throw new Error("표준 입력을 읽지 못했습니다.");
    }
  }
  return Buffer.concat(chunks).toString("utf8").trimEnd();
}
