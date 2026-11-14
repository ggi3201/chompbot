import { afterEach, describe, expect, test } from "vitest";
import { randomUUID } from "crypto";
import { inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { chatItems, chatMessages, conversations } from "../../src/db/schema.js";
import { execDreamDigest } from "../../src/agents/tools/dream-digest.js";

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

// Test files share one DB, so assertions only look at this file's own rows. They
// are left in place: the FTS delete trigger on chat_messages fails on any delete.
const created: string[] = [];

function conversation(title: string) {
  const id = randomUUID();
  created.push(id);
  db.insert(conversations).values({ id, title, createdAt: ago(60), updatedAt: ago(1) }).run();
  return id;
}

function message(conversationId: string, role: "user" | "assistant", content: string, at: string) {
  db.insert(chatMessages).values({ id: randomUUID(), conversationId, role, content, createdAt: at }).run();
}

let seq = 0;
function command(conversationId: string, cmd: string, output: string, exitCode: number, at: string) {
  const payload = { kind: "command", command: cmd, output, exitCode, status: exitCode ? "failed" : "completed" };
  db.insert(chatItems).values({ id: randomUUID(), conversationId, turnId: "t", seq: seq++, kind: "command", payload: JSON.stringify(payload), createdAt: at, updatedAt: at }).run();
}

afterEach(() => {
  db.delete(chatItems).where(inArray(chatItems.conversationId, created)).run();
  created.length = 0;
});

describe("dream digest", () => {
  test("groups the same failure across conversations and flags pushback", () => {
    const a = conversation("Memory cleanup");
    const b = conversation("Proactive audit");
    message(a, "user", "count my memories", ago(50));
    command(a, "sqlite3 ~/chomp-prod/data/chomp.db 'select 1'", "Exit code 127\n/bin/bash: line 1: sqlite3: command not found", 127, ago(49));
    message(a, "assistant", "Used node instead.", ago(48));
    message(b, "user", "list rules", ago(30));
    command(b, "cd ~/chomp-prod/data && sqlite3 chomp.db '.tables'", "Exit code 127\n/bin/bash: line 1: sqlite3: command not found", 127, ago(29));
    command(b, "ls", "chomp.db", 0, ago(28));
    message(b, "user", "elo?", ago(10));

    const digest = execDreamDigest({ days: 7 });

    expect(digest).toMatch(/## Recurring failures[\s\S]*- 2× in 2 conv .*sqlite3: command not found/);
    expect(digest).toMatch(/## Pushback from the user\n- \[.*\] .{8}: "elo\?"/);
    expect(digest).toContain("### Memory cleanup");
    expect(digest).toContain("✗ $ sqlite3 ~/chomp-prod/data/chomp.db 'select 1' → /bin/bash: line 1: sqlite3: command not found");
    expect(digest).not.toContain("✗ $ ls");
  });

  test("leaves out what is older than the window", () => {
    const old = conversation("Last month");
    message(old, "user", "ancient question", new Date(Date.now() - 10 * 86_400_000).toISOString());
    expect(execDreamDigest({ days: 7 })).not.toContain("ancient question");
  });
});
