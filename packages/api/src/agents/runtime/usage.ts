import { execFileSync } from "child_process";
import { homedir } from "os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentProvider, ProviderUsage, UsageWindow } from "@chomp/shared";
import { CodexRpc } from "./codex-rpc.js";

/**
 * Plan usage (5-hour and weekly windows) for the logged-in accounts, asked of
 * each CLI. Probing spawns the CLI, so answers are cached; a rate-limit event
 * from a running turn drops the cache so the next read is fresh.
 */

const CACHE_MS = 90_000;
const PROBE_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} did not answer`)), PROBE_TIMEOUT_MS).unref()),
  ]);
}

type ClaudeWindow = { utilization: number | null; resets_at: string | null } | null | undefined;

function claudeWindow(id: string, label: string, window: ClaudeWindow): UsageWindow | null {
  if (window?.utilization === null || window?.utilization === undefined) return null;
  return { id, label, percent: Math.round(window.utilization), ...(window.resets_at ? { resetsAt: window.resets_at } : {}) };
}

async function probeClaude(): Promise<ProviderUsage> {
  async function* idle() {
    await new Promise(() => {});
  }
  const claudePath = execFileSync("which", ["claude"], { encoding: "utf8" }).trim() || undefined;
  const probe = query({ prompt: idle(), options: { pathToClaudeCodeExecutable: claudePath, persistSession: false, cwd: homedir() } });
  try {
    const init = await withTimeout(probe.initializationResult(), "Claude Code");
    // Anthropic marks this call experimental; if it changes shape, the meter hides rather than breaking chat.
    const usage = await withTimeout(probe.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), "Claude Code");
    if (!usage.rate_limits_available) return { provider: "claude", available: false, windows: [] };
    const limits = usage.rate_limits as {
      five_hour?: ClaudeWindow;
      seven_day?: ClaudeWindow;
      model_scoped?: Array<{ display_name: string; utilization: number | null; resets_at: string | null }>;
    };
    const windows = [
      claudeWindow("five_hour", "5-hour limit", limits.five_hour),
      claudeWindow("weekly", "Weekly · all models", limits.seven_day),
      ...(limits.model_scoped ?? []).map((m) => claudeWindow(`weekly:${m.display_name}`, `Weekly · ${m.display_name}`, m)),
    ].filter((w): w is UsageWindow => w !== null);
    return { provider: "claude", available: true, plan: init.account.subscriptionType ?? usage.subscription_type ?? undefined, windows };
  } finally {
    probe.close();
  }
}

interface CodexWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

function codexWindowLabel(minutes: number | null): string {
  if (minutes === 10080) return "Weekly";
  if (minutes && minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  return "Limit";
}

async function probeCodex(): Promise<ProviderUsage> {
  const rpc = new CodexRpc([], { cwd: homedir(), env: process.env });
  try {
    await withTimeout(rpc.request("initialize", { clientInfo: { name: "chomp", version: "0.1.0" }, capabilities: { experimentalApi: true } }), "Codex");
    rpc.notify("initialized");
    const { rateLimits } = await withTimeout(
      rpc.request<{ rateLimits: { primary: CodexWindow | null; secondary: CodexWindow | null; planType: string | null } }>("account/rateLimits/read", {}),
      "Codex",
    );
    const windows = [rateLimits.primary, rateLimits.secondary]
      .filter((w): w is CodexWindow => !!w)
      .map((w, index): UsageWindow => ({
        id: index === 0 ? "primary" : "secondary",
        label: codexWindowLabel(w.windowDurationMins),
        percent: Math.round(w.usedPercent),
        ...(w.resetsAt ? { resetsAt: new Date(w.resetsAt * 1000).toISOString() } : {}),
      }));
    return { provider: "codex", available: true, plan: rateLimits.planType ?? undefined, windows };
  } finally {
    rpc.close();
  }
}

const cache = new Map<AgentProvider, { at: number; value: Promise<ProviderUsage> }>();

function cached(provider: AgentProvider, probe: () => Promise<ProviderUsage>): Promise<ProviderUsage> {
  const hit = cache.get(provider);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = probe().catch((err): ProviderUsage => {
    console.warn(`[usage] ${provider} limits unavailable:`, err instanceof Error ? err.message : err);
    return { provider, available: false, windows: [] };
  });
  cache.set(provider, { at: Date.now(), value });
  return value;
}

export function getUsageLimits(): Promise<ProviderUsage[]> {
  return Promise.all([cached("claude", probeClaude), cached("codex", probeCodex)]);
}

/** A running turn reported new usage; the next read probes again. */
export function invalidateUsage(provider: AgentProvider) {
  cache.delete(provider);
}
