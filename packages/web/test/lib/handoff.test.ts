import { describe, expect, it } from "vitest";
import type { AgentModelOption, AgentProviderModels, AgentSelection } from "@chomp/shared";
import { parseHandoff } from "../../src/lib/handoff";

const efforts = ["low", "medium", "high", "xhigh", "max"];

function model(id: string, label: string, extra: Partial<AgentModelOption> = {}): AgentModelOption {
  return { id, label, efforts, defaultEffort: "medium", supportsFast: false, featured: true, ...extra };
}

// The order and names the server sends, trimmed.
const providers: AgentProviderModels[] = [
  {
    provider: "claude",
    available: true,
    models: [model("opus", "Opus 5.5", { supportsFast: true }), model("sonnet", "Sonnet 5.5"), model("haiku", "Haiku 5.5"), model("claude-sonnet-5", "Sonnet 5", { featured: false })],
  },
  {
    provider: "codex",
    available: true,
    models: [model("gpt-6.1-sol", "GPT-6.1-Sol", { efforts: [...efforts, "ultra"] }), model("gpt-6-luna", "GPT-6-Luna", { featured: false })],
  },
];

const current: AgentSelection = { provider: "claude", model: "opus", effort: "high", fast: false, access: "full", soulId: "alfred" };

describe("parseHandoff", () => {
  it("is null for anything but the command, and keeps the current choice when no settings are named", () => {
    expect(parseHandoff("hello", providers, current)).toBeNull();
    expect(parseHandoff("/handoffs", providers, current)).toBeNull();
    expect(parseHandoff("/handoff", providers, current)).toEqual({ target: current, goal: "" });
  });

  it("reads model and effort, keeping soul and access, and drops the old effort on a bare model change", () => {
    const parsed = parseHandoff("/handoff sonnet 5.5 high", providers, current);
    expect(parsed).toEqual({ target: { ...current, model: "sonnet", effort: "high" }, goal: "" });
    // The old effort is dropped when the model changes and none is named.
    expect(parseHandoff("/handoff haiku", providers, current)?.target.effort).toBeUndefined();
  });

  it("matches a full name before a short one", () => {
    expect(parseHandoff("/handoff sonnet 5", providers, current)?.target.model).toBe("claude-sonnet-5");
    expect(parseHandoff("/handoff sonnet", providers, current)?.target.model).toBe("sonnet");
  });

  it("crosses engines by model name or by engine", () => {
    const byName = parseHandoff("/handoff luna max", providers, current)?.target;
    expect(byName).toMatchObject({ provider: "codex", model: "gpt-6-luna", effort: "max" });
    const byEngine = parseHandoff("/handoff codex ultra", providers, current)?.target;
    expect(byEngine).toMatchObject({ provider: "codex", effort: "ultra" });
    expect(byEngine?.model).toBeUndefined();
  });

  it("takes only leading words as settings; the rest is the task", () => {
    const parsed = parseHandoff("/handoff opus fast then fix the sonnet high bug", providers, current);
    expect(parsed?.target).toMatchObject({ model: "opus", effort: "high", fast: true });
    expect(parsed?.goal).toBe("then fix the sonnet high bug");
    expect(parseHandoff("/handoff fix the tests", providers, current)).toEqual({ target: current, goal: "fix the tests" });
  });
});
