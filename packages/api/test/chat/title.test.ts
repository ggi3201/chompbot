import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { expect, test, vi } from "vitest";

// A fake `claude -p`: records its arguments and stdin, answers like Haiku would.
const calls = vi.hoisted(() => [] as { args: string[]; stdin: string }[]);
vi.mock("child_process", async (original) => ({
  ...(await original<typeof import("child_process")>()),
  spawn: (_cmd: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stdin: { end: (stdin: string) => {
      calls.push({ args, stdin });
      setImmediate(() => { child.stdout.emit("data", JSON.stringify({ result: '"Sidebar tags and rename."\nextra' })); child.emit("close", 0); });
    } } });
    return child;
  },
}));

const { db } = await import("../../src/db/index.js");
const { chatMessages, conversations } = await import("../../src/db/schema.js");
const { suggestTitle } = await import("../../src/chat/title.js");

function chat(messages: [string, string][]): string {
  const id = randomUUID();
  db.insert(conversations).values({ id, createdAt: "2026-11-07T00:00:00Z", updatedAt: "2026-11-07T00:00:00Z" }).run();
  messages.forEach(([role, content], i) => db.insert(chatMessages).values({ id: randomUUID(), conversationId: id, role, content, createdAt: `2026-11-07T00:00:${String(i).padStart(2, "0")}Z` }).run());
  return id;
}

test("a chat with no messages gets no title and no model call", async () => {
  expect(await suggestTitle(chat([]))).toBeNull();
  expect(calls).toHaveLength(0);
});

test("Haiku names the chat from its latest eight messages, oldest first", async () => {
  const messages: [string, string][] = Array.from({ length: 10 }, (_, i) => [i % 2 ? "assistant" : "user", `message ${i}`]);
  expect(await suggestTitle(chat(messages))).toBe("Sidebar tags and rename");
  const { args, stdin } = calls[0];
  expect(args).toContain("haiku");
  expect(stdin).not.toContain("message 1\n");
  expect(stdin.indexOf("user: message 2")).toBeLessThan(stdin.indexOf("assistant: message 9"));
});
