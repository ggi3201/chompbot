import { execFileSync } from "child_process";
import { homedir } from "os";
import { query, type ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { AgentModelOption, AgentProviderModels } from "@chomp/shared";
import { CodexRpc } from "./codex-rpc.js";

/**
 * The model picker's catalogue, asked of the CLIs themselves: Claude Code's
 * initialize response and Codex's `model/list`. Both answer for the account
 * that is logged in, so the list never offers a model the login cannot use.
 */

const CACHE_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 30_000;

/** Claude Code reports which efforts a model accepts but not its default. These
 *  match what Claude Code picks when none is given (Sonnet runs high). */
const CLAUDE_DEFAULT_EFFORT: Record<string, string> = { "claude-sonnet-5-5": "high" };

/** The short aliases are the current generation; dated ids go under "Show more". */
const CLAUDE_FEATURED = ["opus", "sonnet", "fable", "haiku"];

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} did not answer in ${PROBE_TIMEOUT_MS / 1000}s`)), PROBE_TIMEOUT_MS).unref()),
  ]);
}

function claudeOption(model: ModelInfo): AgentModelOption {
  const efforts = model.supportedEffortLevels ?? [];
  const resolved = model.resolvedModel ?? model.value;
  const defaultEffort = CLAUDE_DEFAULT_EFFORT[resolved] ?? (efforts.includes("medium") ? "medium" : undefined);
  return {
    id: model.value,
    label: model.displayName,
    description: model.description,
    efforts,
    defaultEffort,
    supportsFast: !!model.supportsFastMode,
    featured: CLAUDE_FEATURED.includes(model.value),
  };
}

async function probeClaude(): Promise<AgentModelOption[]> {
  async function* idle() {
    // Never yields: the probe only needs the initialize handshake, no API call.
    await new Promise(() => {});
  }
  let claudePath: string | undefined;
  try {
    claudePath = execFileSync("which", ["claude"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    throw new Error("Claude Code is not installed");
  }
  const probe = query({ prompt: idle(), options: { pathToClaudeCodeExecutable: claudePath, persistSession: false, cwd: homedir() } });
  try {
    const init = await withTimeout(probe.initializationResult(), "Claude Code");
    if (!init.account.subscriptionType && !init.account.apiKeySource && !init.account.tokenSource) {
      throw new Error("Claude Code is not logged in. Run `claude auth login` on the server.");
    }
    const models = init.models.filter((m) => m.value !== "default").map(claudeOption);
    return [...models.filter((m) => m.featured).sort((a, b) => CLAUDE_FEATURED.indexOf(a.id) - CLAUDE_FEATURED.indexOf(b.id)), ...models.filter((m) => !m.featured)];
  } finally {
    probe.close();
  }
}

interface CodexModel {
  id: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
  defaultReasoningEffort: string;
  serviceTiers: Array<{ id: string }>;
}

async function probeCodex(): Promise<AgentModelOption[]> {
  const rpc = new CodexRpc([], { cwd: homedir(), env: process.env });
  try {
    await withTimeout(rpc.request("initialize", { clientInfo: { name: "chomp", version: "0.1.0" }, capabilities: { experimentalApi: true } }), "Codex");
    rpc.notify("initialized");
    const account = await withTimeout(rpc.request<{ account: unknown }>("account/read", {}), "Codex");
    if (!account.account) throw new Error("Codex is not logged in. Run `codex login` on the server.");
    const { data } = await withTimeout(rpc.request<{ data: CodexModel[] }>("model/list", {}), "Codex");
    const visible = data.filter((m) => !m.hidden).sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
    return visible.map((m, index) => ({
      id: m.id,
      label: m.displayName,
      description: m.description,
      efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
      defaultEffort: m.defaultReasoningEffort,
      supportsFast: m.serviceTiers.some((tier) => tier.id === "priority"),
      featured: index < 4,
    }));
  } finally {
    rpc.close();
  }
}


const cache = new Map<string, { at: number; value: Promise<AgentProviderModels> }>();

function cached(provider: "claude" | "codex", probe: () => Promise<AgentModelOption[]>): Promise<AgentProviderModels> {
  const hit = cache.get(provider);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = probe().then(
    (models): AgentProviderModels => ({ provider, available: true, models }),
    (err): AgentProviderModels => ({ provider, available: false, reason: err instanceof Error ? err.message : String(err), models: [] }),
  );
  cache.set(provider, { at: Date.now(), value });
  // A failed probe (not logged in yet) should not stick for ten minutes.
  void value.then((c) => {
    if (!c.available) cache.delete(provider);
  });
  return value;
}

export function getClaudeModels(): Promise<AgentProviderModels> {
  return cached("claude", probeClaude);
}

export function getCodexModels(): Promise<AgentProviderModels> {
  return cached("codex", probeCodex);
}

/** Is this effort one the model accepts? Unknown models pass through untouched. */
export async function validEffort(provider: "claude" | "codex", model: string | undefined, effort: string | undefined): Promise<string | undefined> {
  if (!effort) return undefined;
  const catalogue = await (provider === "claude" ? getClaudeModels() : getCodexModels());
  const option = catalogue.models.find((m) => m.id === model);
  if (!option) return effort;
  return option.efforts.includes(effort) ? effort : undefined;
}
