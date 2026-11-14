import type { ChatItem, FileDiff } from "@chomp/shared";

export interface ChangedFile {
  path: string;
  /** How the file stands now: new in this chat, deleted, or edited. */
  kind: FileDiff["kind"];
  additions: number;
  deletions: number;
  /** Every change to it, oldest first. */
  changes: FileDiff[];
}

/**
 * The files a chat's agents changed, one row per path, in the order they were
 * first touched. A declined or failed edit changed nothing, so it is left out.
 */
export function changedFiles(items: ChatItem[]): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  for (const item of items) {
    if (item.kind !== "file_change" || item.status === "declined" || item.status === "failed") continue;
    for (const file of item.files) {
      const row = byPath.get(file.path);
      if (!row) {
        byPath.set(file.path, { path: file.path, kind: file.kind, additions: file.additions, deletions: file.deletions, changes: [file] });
        continue;
      }
      row.additions += file.additions;
      row.deletions += file.deletions;
      row.changes.push(file);
      // A file this chat created stays "new" through later edits, until it is deleted.
      row.kind = file.kind === "delete" ? "delete" : row.kind === "add" ? "add" : file.kind;
    }
  }
  return [...byPath.values()];
}
