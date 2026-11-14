import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { eq } from "drizzle-orm";
import type { AgentProvider } from "@chomp/shared";
import { db } from "../db/index.js";
import { settings } from "../db/schema.js";

/** A model on one of the agent runtimes, paid by that runtime's login (subscription or API key). */
export interface BackgroundModel {
  provider: AgentProvider;
  model: string;
}

/** Tried in order when the user has not picked one: whichever runtime is logged in answers. */
const FALLBACKS: BackgroundModel[] = [
  { provider: "claude", model: "claude-haiku-5-5" },
  { provider: "codex", model: "gpt-6-luna" },
];
const TIMEOUT_MS = 120_000;

export function savedBackgroundModel(): BackgroundModel | null {
  const raw = db.select().from(settings).where(eq(settings.key, "background_model")).get()?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<BackgroundModel>;
    return (parsed.provider === "claude" || parsed.provider === "codex") && parsed.model ? { provider: parsed.provider, model: parsed.model } : null;
  } catch {
    return null;
  }
}

export interface BackgroundRequest {
  system: string;
  prompt: string;
  /** JSON schema: the reply is JSON matching it. Without one the reply is plain text. */
  schema?: Record<string, unknown>;
}

/**
 * One tool-less call for Chomp's own small jobs (memory extraction, widget classification, generate),
 * on the background model the user picked, else on the first runtime that answers. No API keys involved.
 */
export async function backgroundCompletion(request: BackgroundRequest): Promise<string> {
  const saved = savedBackgroundModel();
  const candidates = saved ? [saved] : FALLBACKS;
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await withTimeout(candidate.provider === "claude" ? askClaude(candidate.model, request) : askCodex(candidate.model, request));
    } catch (err) {
      lastError = err;
      console.warn(`[background-model] ${candidate.provider}/${candidate.model} failed:`, err instanceof Error ? err.message : err);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("No background model answered");
}

let claudePath: string | undefined;

/** The prompt travels over the SDK's stream, not the process arguments, so it never shows in `ps`. */
async function askClaude(model: string, { system, prompt, schema }: BackgroundRequest): Promise<string> {
  claudePath ??= execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
  const q = query({
    prompt,
    options: {
      model,
      systemPrompt: system,
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      // A structured answer is delivered as a tool call, which can take a second turn.
      maxTurns: 2,
      ...(schema ? { outputFormat: { type: "json_schema" as const, schema } } : {}),
      cwd: tmpdir(),
      pathToClaudeCodeExecutable: claudePath,
    },
  });
  try {
    for await (const m of q) {
      if (m.type !== "result") continue;
      if (m.subtype !== "success") throw new Error(`ended with ${m.subtype}`);
      if (schema) {
        if (!m.structured_output) throw new Error("no structured output");
        return JSON.stringify(m.structured_output);
      }
      return m.result;
    }
    throw new Error("no result");
  } finally {
    q.close();
  }
}

/** `codex exec` in a throwaway read-only sandbox; the prompt goes in on stdin, the last message comes back in a file. */
async function askCodex(model: string, { system, prompt, schema }: BackgroundRequest): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "chomp-bg-"));
  const out = join(dir, "last.txt");
  const input = [system, schema ? `Reply with JSON only, matching this schema:\n${JSON.stringify(schema)}` : "", prompt].filter(Boolean).join("\n\n");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        "codex",
        ["exec", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "-m", model, "-o", out, "-"],
        { cwd: dir, timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
        (err, _stdout, stderr) => (err ? reject(new Error(String(stderr).trim().split("\n").pop() || err.message)) : resolve()),
      );
      child.stdin?.end(input);
    });
    const text = (await readFile(out, "utf8")).trim();
    if (!text) throw new Error("empty reply");
    return text;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  void work.catch(() => {}); // if the timeout wins, a later rejection must not become unhandled
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), TIMEOUT_MS);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
