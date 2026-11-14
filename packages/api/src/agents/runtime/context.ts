import { eq } from "drizzle-orm";
import type { SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import type { ContextUsage } from "@chomp/shared";
import { db } from "../../db/index.js";
import { conversations } from "../../db/schema.js";

/** Claude's /context breakdown, without the free space and the compaction reserve. */
export function claudeContextUsage(report: SDKControlGetContextUsageResponse): ContextUsage {
  return {
    provider: "claude",
    model: report.model,
    usedTokens: report.totalTokens,
    maxTokens: report.rawMaxTokens,
    percent: report.percentage,
    categories: report.categories
      .filter((c) => c.kind === "used" && c.tokens > 0)
      .map((c) => ({ name: c.name, tokens: c.tokens })),
    updatedAt: new Date().toISOString(),
  };
}

interface CodexTokenUsage {
  last?: { totalTokens?: number };
  modelContextWindow?: number | null;
}

/**
 * Codex's `thread/tokenUsage/updated`: the last request's total is what the
 * window holds now (the running total counts every request of the thread).
 */
export function codexContextUsage(usage: CodexTokenUsage, model?: string): ContextUsage | null {
  const used = usage.last?.totalTokens;
  const max = usage.modelContextWindow;
  if (!used || !max) return null;
  return {
    provider: "codex",
    ...(model ? { model } : {}),
    usedTokens: used,
    maxTokens: max,
    percent: Math.round((used / max) * 100),
    categories: [],
    updatedAt: new Date().toISOString(),
  };
}

export function saveContextUsage(conversationId: string, usage: ContextUsage) {
  if (!conversationId) return;
  db.update(conversations).set({ contextUsage: JSON.stringify(usage) }).where(eq(conversations.id, conversationId)).run();
}

export function readContextUsage(conversationId: string): ContextUsage | null {
  const row = db.select({ contextUsage: conversations.contextUsage }).from(conversations).where(eq(conversations.id, conversationId)).get();
  if (!row?.contextUsage) return null;
  try {
    return JSON.parse(row.contextUsage) as ContextUsage;
  } catch {
    return null;
  }
}
