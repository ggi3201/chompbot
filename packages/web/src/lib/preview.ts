import type { ChatItem, PreviewElement } from "@chomp/shared";

// The first line of preview_start's output. Failed calls have none.
const PREVIEW_URL = /Preview open at (https?:\/\/[^\s"\\]+)/;

/** The chat's latest preview_start call that opened a page. */
export function latestPreview(items: ChatItem[]): { itemId: string; url: string } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind !== "tool_call" || !item.tool.endsWith("__preview_start")) continue;
    const url = item.output?.match(PREVIEW_URL)?.[1];
    if (url) return { itemId: item.id, url };
  }
  return null;
}

export const PREVIEW_VIEWS = ["open", "close", "docked", "floating", "full", "pop_out", "browser_tab"] as const;
export type PreviewView = (typeof PREVIEW_VIEWS)[number];

// The first line of preview_window's output, so the web chat can follow the agent.
const PREVIEW_WINDOW = new RegExp(`Preview window: (${PREVIEW_VIEWS.join("|")})\\b`);

/** The chat's preview_window calls that succeeded, oldest first. */
export function previewWindowCalls(items: ChatItem[]): { itemId: string; view: PreviewView; createdAt: string }[] {
  return items.flatMap((item) => {
    if (item.kind !== "tool_call" || !item.tool.endsWith("__preview_window")) return [];
    const view = item.output?.match(PREVIEW_WINDOW)?.[1] as PreviewView | undefined;
    return view ? [{ itemId: item.id, view, createdAt: item.createdAt }] : [];
  });
}

/** Keeps a window wholly on screen, so its toolbar stays reachable however it was dragged or the viewport shrank. */
export function clampRect(rect: PreviewRect, viewport: { width: number; height: number }): PreviewRect {
  const width = Math.min(rect.width, viewport.width);
  const height = Math.min(rect.height, viewport.height);
  return {
    width,
    height,
    x: Math.max(0, Math.min(rect.x, viewport.width - width)),
    y: Math.max(0, Math.min(rect.y, viewport.height - height)),
  };
}

export interface PreviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** The page's size on screen: its own CSS size, shrunk to fit the pane but never grown past it. */
export function fitFrame(frame: Size, pane: Size): Size {
  const scale = Math.min(1, pane.width / frame.width, pane.height / frame.height);
  return { width: Math.floor(frame.width * scale), height: Math.floor(frame.height * scale) };
}

/** A pointer on the shown frame, as CSS pixels of the page. */
export function pagePoint(client: { x: number; y: number }, shown: DOMRect | { left: number; top: number; width: number; height: number }, frame: Size) {
  return {
    x: ((client.x - shown.left) / shown.width) * frame.width,
    y: ((client.y - shown.top) / shown.height) * frame.height,
  };
}

/** CDP's modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function modifierMask(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

const NAMED_KEYS = new Set([
  "Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown", "Insert", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
]);

/**
 * The Playwright key for a keydown the page must get as a key press, or null when the text it types
 * arrives as input instead (which also covers phone keyboards and IME). Cmd and Ctrl both become
 * ControlOrMeta, so Cmd+A on a Mac selects all in the host's Chromium. Paste arrives as a paste event.
 */
export function pressedKey(e: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): string | null {
  const shortcut = e.ctrlKey || e.metaKey;
  if (!NAMED_KEYS.has(e.key) && !shortcut && !e.altKey) return null;
  if (["Control", "Meta", "Shift", "Alt"].includes(e.key)) return null;
  if (shortcut && e.key.toLowerCase() === "v") return null;
  const mods = [shortcut && "ControlOrMeta", e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean);
  return [...mods, e.key].join("+");
}

/** A wheel event's delta in pixels, whatever unit the device reports. */
export function wheelPixels(delta: number, mode: number): number {
  return delta * ([1, 16, 400][mode] ?? 1);
}

/** Something the user pointed at in the preview, with what they said about it. */
export interface PreviewMark {
  id: number;
  url: string;
  element: PreviewElement;
  comment: string;
}

const round = (n: number) => Math.round(n);

/**
 * What the agent reads about the marks, after the user's own words. The pictures go as attachments,
 * in the same order, so mark N is picture N.
 */
export function marksMessage(marks: PreviewMark[]): string {
  if (marks.length === 0) return "";
  const pages = [...new Set(marks.map((m) => m.url))];
  const lines = marks.map((m, i) => {
    const { box } = m.element;
    const where = pages.length > 1 ? ` on ${m.url}` : "";
    const said = m.comment.trim() ? `: ${m.comment.trim()}` : "";
    return `${i + 1}. ${m.element.label}, \`${m.element.selector}\`, at ${round(box.x)},${round(box.y)} size ${round(box.width)}x${round(box.height)}${where}${said}`;
  });
  const head = pages.length === 1 ? `Pointed at in the preview (${pages[0]}):` : "Pointed at in the preview:";
  return [head, ...lines, "Each has a picture attached, in the same order."].join("\n");
}
