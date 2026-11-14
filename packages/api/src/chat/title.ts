import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { AgentProvider } from "@chomp/shared";
import { db } from "../db/index.js";
import { chatMessages, conversations } from "../db/schema.js";

const TITLE_PROMPT = "Name this chat in 2-6 words, based on the user's first message. Reply with the title only: no quotes, no trailing punctuation, same language as the message.";
const RETITLE_PROMPT = "Name this chat in 2-6 words, based on what it is about now: the latest messages matter most. Reply with the title only: no quotes, no trailing punctuation, in the language the messages are written in, even when they name a place.";

// Same logins the chat runners use (Claude Code / Codex subscription), no API key. cwd is a scratch
// dir so no project CLAUDE.md / AGENTS.md loads.
const scratch = join(tmpdir(), "chomp-title");

function run(cmd: string, args: string[], stdin: string): Promise<string> {
  mkdirSync(scratch, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: scratch, stdio: ["pipe", "pipe", "ignore"], timeout: 30_000 });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}`))));
    child.stdin.end(stdin);
  });
}

// Naked `claude -p`: no settings, MCP or tools, ~$0.0003 and ~3s instead of booting the whole harness.
async function askHaiku(prompt: string, message: string): Promise<string> {
  const out = await run("claude", [
    "-p", "--model", "haiku", "--restricted", "--strict-mcp-config", "--tools", "",
    "--no-session-persistence", "--exclude-dynamic-system-prompt-sections",
    "--system-prompt", prompt, "--output-format", "json",
  ], message);
  return String(JSON.parse(out).result ?? "");
}

// shortcut: hardcoded model id, update if Codex retires gpt-6-luna.
async function askLuna(prompt: string, message: string): Promise<string> {
  const outFile = join(scratch, `${randomUUID()}.txt`);
  try {
    await run("codex", [
      "exec", "-m", "gpt-6-luna", "-c", "model_reasoning_effort=low", "--skip-git-repo-check",
      "--ephemeral", "--ignore-user-config", "--sandbox", "read-only", "-o", outFile, "-",
    ], `${prompt}\n\nMessage:\n${message}`);
    return readFileSync(outFile, "utf8");
  } finally {
    rmSync(outFile, { force: true });
  }
}

/** The first line of a model reply, stripped of quotes and a trailing full stop; null for a fragment. */
function cleanTitle(raw: string): string | null {
  const title = raw.trim().split("\n")[0].replace(/^["'`]+|["'`.]+$/g, "").slice(0, 80);
  return title.length < 3 ? null : title;
}

/** Fire-and-forget: replace the placeholder title with a model-written one, using the chat's own provider. Never throws. */
export function generateTitleInBackground(conversationId: string, firstMessage: string, provider: AgentProvider): void {
  if (!firstMessage.trim()) return;
  (provider === "claude" ? askHaiku : askLuna)(TITLE_PROMPT, firstMessage.slice(0, 2000))
    .then((raw) => {
      const title = cleanTitle(raw); // keep the placeholder over a fragment
      if (title) db.update(conversations).set({ title }).where(eq(conversations.id, conversationId)).run();
    })
    .catch(() => {});
}

/** A Haiku-written title for what the chat is about now, from its latest messages. Does not save it. */
export async function suggestTitle(conversationId: string): Promise<string | null> {
  const recent = db.select({ role: chatMessages.role, content: chatMessages.content })
    .from(chatMessages)
    .where(and(eq(chatMessages.conversationId, conversationId), inArray(chatMessages.role, ["user", "assistant"])))
    .orderBy(desc(chatMessages.createdAt))
    .limit(8)
    .all()
    .reverse();
  if (recent.length === 0) return null;
  const transcript = recent.map((m) => `${m.role}: ${m.content.slice(0, 600)}`).join("\n\n");
  return cleanTitle(await askHaiku(RETITLE_PROMPT, transcript));
}
