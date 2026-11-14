import type { TerminalInfo } from "@chomp/shared";

/** A folder as a person reads it: the home folder as ~, anything else by its last name. */
export function folderLabel(cwd: string): string {
  const home = cwd.match(/^\/(?:home|Users)\/[^/]+/)?.[0];
  if (home && cwd === home) return "~";
  return cwd.split("/").filter(Boolean).pop() ?? cwd;
}

/**
 * A tab's name: what the shell or program titled it, else its folder.
 * Shells title themselves `user@host: dir`; the user and host are the same on every tab, so they go.
 */
export function terminalLabel(info: Pick<TerminalInfo, "cwd" | "title">, liveTitle?: string): string {
  const title = (liveTitle || info.title).replace(/^[^@\s]+@[^:\s]+:\s*/, "").trim();
  return title || folderLabel(info.cwd);
}
