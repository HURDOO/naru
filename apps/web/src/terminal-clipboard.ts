export interface TerminalClipboardPayload {
  image: Blob | null;
  text: string;
}

interface TerminalClipboardReader {
  read?: () => Promise<ClipboardItems>;
  readText?: () => Promise<string>;
}

export async function readTerminalClipboard(
  clipboard: TerminalClipboardReader,
): Promise<TerminalClipboardPayload> {
  let image: Blob | null = null;
  let text = "";
  let richReadError: Error | undefined;

  if (clipboard.read) {
    try {
      const items = await clipboard.read();
      for (const item of items) {
        const imageType = item.types.find((type) => type.startsWith("image/"));
        if (!image && imageType) image = await item.getType(imageType);
        if (!text && item.types.includes("text/plain")) {
          text = await (await item.getType("text/plain")).text();
        }
      }
    } catch (error: unknown) {
      richReadError = error instanceof Error ? error : new Error("클립보드를 읽지 못했습니다.");
    }
  }

  if (!text && clipboard.readText) {
    try {
      text = await clipboard.readText();
    } catch (error: unknown) {
      if (!image && richReadError === undefined) throw error;
    }
  }

  if (!image && !text && richReadError !== undefined) throw richReadError;
  return { image, text };
}
