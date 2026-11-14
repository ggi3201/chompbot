/** A shell on the host. Its own holder process keeps it alive across Chomp restarts and deploys. */
export interface TerminalInfo {
  id: string;
  /** `home`, or `chat:<conversationId>` for a chat's project folder. */
  scope: string;
  cwd: string;
  shell: string;
  /** What the shell last set with an OSC title sequence; empty until it does. */
  title: string;
  cols: number;
  rows: number;
  createdAt: number;
  /** The holder's wire version. A holder started before a deploy keeps its old version. */
  protocol: number;
}

/** What the browser asks to open. The server picks the folder from the scope. */
export type TerminalScope = { scope: "home" } | { scope: "chat"; conversationId: string };

/**
 * Text frames from the browser. Keystrokes and paste go as binary frames of raw bytes instead.
 * `ack` counts output bytes the browser has drawn, so a fast program cannot flood a slow phone.
 */
export type TerminalClientMessage =
  | { type: "resize"; cols: number; rows: number }
  | { type: "ack"; bytes: number };

/** Text frames to the browser. Output goes as binary frames; the first after `attached` is the whole screen. */
export type TerminalServerMessage =
  | { type: "attached"; info: TerminalInfo }
  | { type: "size"; cols: number; rows: number }
  | { type: "title"; title: string }
  | { type: "exit"; code: number | null; signal: number | null }
  | { type: "error"; message: string };
