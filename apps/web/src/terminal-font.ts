export const TERMINAL_FONT_FAMILY =
  '"D2Coding", "SFMono-Regular", "Cascadia Code", Menlo, monospace';
export const TERMINAL_FONT_SIZE = 13;
export const TERMINAL_LINE_HEIGHT = 1.2;

const TERMINAL_FONT_SAMPLE = "Naru 한글 Aa0";
const TERMINAL_FONT_DESCRIPTORS = [
  `400 ${TERMINAL_FONT_SIZE}px "D2Coding"`,
  `700 ${TERMINAL_FONT_SIZE}px "D2Coding"`,
] as const;

interface FontFaceLoader {
  load: (font: string, text?: string) => Promise<unknown>;
}

interface FontFaceChecker {
  check: (font: string, text?: string) => boolean;
}

let terminalFontsReady: Promise<boolean> | null = null;

export async function loadTerminalFontFaces(fonts: FontFaceLoader): Promise<void> {
  await Promise.all(
    TERMINAL_FONT_DESCRIPTORS.map((descriptor) => fonts.load(descriptor, TERMINAL_FONT_SAMPLE)),
  );
}

export function terminalFontFacesReady(fonts: FontFaceChecker): boolean {
  return TERMINAL_FONT_DESCRIPTORS.every((descriptor) =>
    fonts.check(descriptor, TERMINAL_FONT_SAMPLE),
  );
}

export function areTerminalFontsReady(): boolean {
  return typeof document === "undefined" || !document.fonts
    ? true
    : terminalFontFacesReady(document.fonts);
}

export function ensureTerminalFontsLoaded(): Promise<boolean> {
  if (typeof document === "undefined" || !document.fonts) return Promise.resolve(true);
  terminalFontsReady ??= loadTerminalFontFaces(document.fonts).then(
    () => true,
    () => {
      terminalFontsReady = null;
      return false;
    },
  );
  return terminalFontsReady;
}
