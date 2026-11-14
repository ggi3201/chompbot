/** Ctrl and Alt as the phone's key bar latches them: held for the next key, then let go. */
export interface Modifiers {
  ctrl: boolean;
  alt: boolean;
}

export const NO_MODIFIERS: Modifiers = { ctrl: false, alt: false };

export type Arrow = "up" | "down" | "right" | "left";
const ARROW_FINAL: Record<Arrow, string> = { up: "A", down: "B", right: "C", left: "D" };

/** Ctrl plus a character, as a terminal sends it: @, A to Z and [ \ ] ^ _ map onto 0 to 31, space onto NUL, ? onto DEL. */
function controlCode(char: string): string | null {
  if (char === " ") return "\x00";
  if (char === "?") return "\x7f";
  const code = char.toUpperCase().charCodeAt(0);
  return code >= 0x40 && code <= 0x5f ? String.fromCharCode(code & 0x1f) : null;
}

/** What typed text becomes with the latched modifiers. Ctrl acts on a single character only; Alt prefixes ESC. */
export function withModifiers(data: string, mods: Modifiers): string {
  const controlled = mods.ctrl && data.length === 1 ? (controlCode(data) ?? data) : data;
  return mods.alt ? `\x1b${controlled}` : controlled;
}

/** An arrow key's bytes. Programs like vim and less switch the cursor keys to application mode, which changes them. */
export function arrowKey(arrow: Arrow, mods: Modifiers, applicationCursor: boolean): string {
  const final = ARROW_FINAL[arrow];
  const modifier = 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
  if (modifier > 1) return `\x1b[1;${modifier}${final}`;
  return applicationCursor ? `\x1bO${final}` : `\x1b[${final}`;
}

export type BarKey =
  | { label: string; name: string; text: string }
  | { label: string; name: string; modifier: keyof Modifiers }
  | { label: string; name: string; arrow: Arrow };

/** The keys a phone keyboard lacks, in the order a shell needs them most. */
export const KEY_BAR: BarKey[] = [
  { label: "esc", name: "Escape", text: "\x1b" },
  { label: "tab", name: "Tab", text: "\t" },
  { label: "ctrl", name: "Control", modifier: "ctrl" },
  { label: "alt", name: "Alt", modifier: "alt" },
  { label: "←", name: "Left", arrow: "left" },
  { label: "↑", name: "Up", arrow: "up" },
  { label: "↓", name: "Down", arrow: "down" },
  { label: "→", name: "Right", arrow: "right" },
  { label: "|", name: "Pipe", text: "|" },
  { label: "~", name: "Tilde", text: "~" },
  { label: "/", name: "Slash", text: "/" },
  { label: "-", name: "Dash", text: "-" },
];

/** The bytes a key-bar key sends, given the latched modifiers and the terminal's cursor mode. */
export function barKeyBytes(key: BarKey, mods: Modifiers, applicationCursor: boolean): string | null {
  if ("arrow" in key) return arrowKey(key.arrow, mods, applicationCursor);
  if ("text" in key) return withModifiers(key.text, mods);
  return null;
}
