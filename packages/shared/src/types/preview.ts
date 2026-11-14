// The preview pane's wire protocol on /ws/preview. One Chromium page per chat runs on the
// host; agents drive it with the preview_* tools, and the pane streams it and sends input back.
// Frames go as binary messages: a big-endian uint16 CSS width, a uint16 CSS height, then JPEG bytes.

export type PreviewPreset = "desktop" | "tablet" | "mobile" | "custom";
export type PreviewColorScheme = "system" | "light" | "dark";

export interface PreviewViewport {
  /** desktop fills the pane; tablet and mobile are fixed sizes the pane scales to fit. */
  preset: PreviewPreset;
  width: number;
  height: number;
  colorScheme: PreviewColorScheme;
}

export interface PreviewPage {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  viewport: PreviewViewport;
}

export type PreviewServerStatus = "starting" | "running" | "exited";

export interface PreviewServer {
  name: string;
  port: number;
  url: string;
  status: PreviewServerStatus;
  exitCode: number | null;
}

export interface PreviewState {
  /** Null until something opens a page, and again after an idle page is closed. */
  page: PreviewPage | null;
  /** The page an idle close left, so the pane can offer it again. */
  lastUrl: string | null;
  /** Why the last page closed, when nobody asked it to: a crash, idle time, or room for another chat's page. */
  closedBecause: string | null;
  /** The chat's project's `.claude/launch.json` entries. */
  configs: { name: string; port: number }[];
  configError: string | null;
  servers: PreviewServer[];
}

/** What the pane's output panel follows: the page's console, or a dev server Chomp started. */
export type PreviewLogSource = { kind: "console" } | { kind: "server"; name: string };

export interface PreviewLogLine {
  at: number;
  stream: "out" | "err";
  text: string;
}

/** An element the user pointed at in the pane, found in the real page. */
export interface PreviewElement {
  /** Role and accessible name, such as `button "Add to cart"`. */
  label: string;
  /** A CSS selector that finds it again with document.querySelector. */
  selector: string;
  /** Where it is, in the page's CSS pixels. */
  box: { x: number; y: number; width: number; height: number };
  /** Its visible text, cut short. */
  text: string;
  /** A JPEG of it and a little around it, base64. Only when asked for. */
  crop?: string;
}

export type PreviewServerMessage =
  | { type: "state"; state: PreviewState }
  /** Where the agent just acted, in CSS pixels of the page, so the pane can show it. */
  | { type: "agent"; action: string; x: number | null; y: number | null }
  | { type: "logs"; source: PreviewLogSource; lines: PreviewLogLine[]; reset: boolean }
  | { type: "exposed"; url: string }
  | { type: "inspected"; id: number; element: PreviewElement | null }
  | { type: "error"; message: string };

export type PreviewMouseButton = "left" | "middle" | "right" | "none";

export type PreviewClientMessage =
  | { type: "pane"; width: number; height: number; dpr: number; dark: boolean }
  /** modifiers is the CDP bit mask: Alt 1, Ctrl 2, Meta 4, Shift 8. */
  | { type: "mouse"; event: "down" | "up" | "move"; x: number; y: number; button: PreviewMouseButton; clickCount: number; modifiers: number }
  | { type: "wheel"; x: number; y: number; dx: number; dy: number }
  /** A Playwright key, such as "Enter" or "ControlOrMeta+a". */
  | { type: "press"; key: string }
  | { type: "text"; text: string }
  | { type: "navigate"; url: string }
  | { type: "history"; action: "back" | "forward" | "reload" }
  | { type: "preset"; preset: "desktop" | "tablet" | "mobile" }
  | { type: "start"; name: string }
  | { type: "stop"; name: string }
  /** Follow one source's output; null stops following. */
  | { type: "logs"; source: PreviewLogSource | null }
  /** Make the page reachable from the viewer's own device, for Open in new tab. */
  | { type: "expose" }
  /** What is at a point of the page, for pointing at it; crop adds a picture of it. */
  | { type: "inspect"; id: number; x: number; y: number; crop: boolean };
