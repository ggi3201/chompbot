import type { ITerminalOptions, ITheme } from "@xterm/xterm";

/**
 * Graphite for a terminal: the sidebar's darker well, text in the app's primary, the ember cursor and selection.
 * The sixteen colors are the app's category hues; red, yellow and magenta lean warm so nothing reads purple.
 */
export const GRAPHITE: ITheme = {
  background: "#0f0f10",
  foreground: "#ededed",
  cursor: "#f2a33a",
  cursorAccent: "#1a1206",
  selectionBackground: "rgba(242, 163, 58, 0.28)",
  selectionInactiveBackground: "rgba(237, 237, 237, 0.10)",
  scrollbarSliderBackground: "rgba(237, 237, 237, 0.10)",
  scrollbarSliderHoverBackground: "rgba(237, 237, 237, 0.18)",
  scrollbarSliderActiveBackground: "rgba(242, 163, 58, 0.45)",
  black: "#232325",
  red: "#e5675f",
  green: "#4cc38a",
  yellow: "#f2a33a",
  blue: "#7aa5e0",
  magenta: "#d68ba8",
  cyan: "#6cb6c8",
  white: "#d4d4d8",
  brightBlack: "#6b6b72",
  brightRed: "#f08f86",
  brightGreen: "#8fd9b4",
  brightYellow: "#f5c27e",
  brightBlue: "#a5c3ee",
  brightMagenta: "#e5b3c6",
  brightCyan: "#9ccfdb",
  brightWhite: "#ededed",
};

export const TERMINAL_FONT = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

export const FONT_SIZES = { min: 10, max: 20, phone: 12, desktop: 13 } as const;

export function terminalOptions(fontSize: number): ITerminalOptions {
  return {
    theme: GRAPHITE,
    fontFamily: TERMINAL_FONT,
    fontSize,
    fontWeight: 400,
    fontWeightBold: 600,
    lineHeight: 1.25,
    cursorBlink: true,
    cursorStyle: "block",
    cursorInactiveStyle: "outline",
    scrollback: 10_000,
    allowProposedApi: true,
    // Option is Meta, as in a Mac terminal, so Alt-b and Alt-f move by word in the shell.
    macOptionIsMeta: true,
    macOptionClickForcesSelection: true,
    rightClickSelectsWord: true,
    drawBoldTextInBrightColors: false,
    minimumContrastRatio: 1,
  };
}

/** Geist Mono comes from a stylesheet; xterm measures its cells once, so the font must be ready first. */
export async function loadTerminalFont(fontSize: number): Promise<void> {
  await Promise.all([400, 600].map((weight) => document.fonts.load(`${weight} ${fontSize}px "Geist Mono"`))).catch(() => {});
}
