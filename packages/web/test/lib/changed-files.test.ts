import { describe, expect, it } from "vitest";
import type { ChatItem, ChatItemStatus, FileDiff } from "@chomp/shared";
import { changedFiles } from "../../src/lib/changed-files";

let seq = 0;
function change(files: Array<Partial<FileDiff> & { path: string }>, status: ChatItemStatus = "completed"): ChatItem {
  seq += 1;
  return {
    id: `i${seq}`,
    conversationId: "c1",
    turnId: "t1",
    seq,
    updatedAt: "2026-11-03T10:00:00Z",
    kind: "file_change",
    status,
    files: files.map((f) => ({ kind: "update", diff: "", additions: 0, deletions: 0, ...f })),
  } as ChatItem;
}

describe("changedFiles", () => {
  it("adds up every change to a path, in first-touched order", () => {
    const rows = changedFiles([
      change([{ path: "b.ts", additions: 2, deletions: 1 }]),
      change([{ path: "a.ts", additions: 5 }, { path: "b.ts", additions: 1, deletions: 3 }]),
    ]);
    expect(rows.map((r) => [r.path, r.additions, r.deletions, r.changes.length])).toEqual([
      ["b.ts", 3, 4, 2],
      ["a.ts", 5, 0, 1],
    ]);
  });

  it("leaves out edits that were declined or failed", () => {
    expect(changedFiles([change([{ path: "x.ts", additions: 9 }], "declined"), change([{ path: "y.ts" }], "failed")])).toEqual([]);
  });

  it("keeps a file new through later edits, and deleted once deleted", () => {
    const [created] = changedFiles([change([{ path: "n.ts", kind: "add" }]), change([{ path: "n.ts" }])]);
    expect(created.kind).toBe("add");
    const [gone] = changedFiles([change([{ path: "n.ts", kind: "add" }]), change([{ path: "n.ts", kind: "delete" }])]);
    expect(gone.kind).toBe("delete");
  });
});
