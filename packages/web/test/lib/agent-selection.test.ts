import { describe, expect, it } from "vitest";
import type { AgentProviderModels } from "@chomp/shared";
import { effortLabel, resolveSelection } from "../../src/lib/agent-selection";

const providers: AgentProviderModels[] = [
  {
    provider: "claude",
    agentName: "claude",
    available: true,
    models: [
      { id: "opus", label: "Opus 5.5", efforts: ["low", "high", "max"], defaultEffort: "high", supportsFast: true, featured: true },
      { id: "haiku", label: "Haiku 5.5", efforts: [], supportsFast: false, featured: false },
    ],
  },
  {
    provider: "codex",
    agentName: "codex",
    available: false,
    reason: "Not logged in",
    models: [{ id: "gpt", label: "GPT", efforts: ["low"], supportsFast: false, featured: true }],
  },
];

describe("resolveSelection", () => {
  it("keeps the soul whatever the engine, since souls are not tied to one", () => {
    expect(resolveSelection(providers, { provider: "claude", soulId: "alfred", model: "opus" })?.soulId).toBe("alfred");
    expect(resolveSelection(providers, { provider: "codex", soulId: "alfred", model: "gpt" })?.soulId).toBe("alfred");
  });

  it("defaults to the first available provider's featured model and its default effort", () => {
    expect(resolveSelection(providers)).toEqual({ provider: "claude", model: "opus", effort: "high", fast: false, access: "full" });
  });

  it("falls back when the stored provider is unavailable", () => {
    expect(resolveSelection(providers, { provider: "codex", model: "gpt", access: "supervised" }))
      .toMatchObject({ provider: "claude", model: "opus", access: "supervised" });
  });

  it("drops an effort the model lacks and fast where unsupported", () => {
    expect(resolveSelection(providers, { provider: "claude", model: "opus", effort: "xhigh", fast: true, access: "full" }))
      .toMatchObject({ effort: "high", fast: true });
    expect(resolveSelection(providers, { provider: "claude", model: "haiku", effort: "high", fast: true, access: "full" }))
      .toEqual({ provider: "claude", model: "haiku", fast: false, access: "full" });
  });

  it("returns nothing when no provider is available", () => {
    expect(resolveSelection([])).toBeUndefined();
  });

  it("labels efforts in sentence case", () => {
    expect(effortLabel("xhigh")).toBe("Extra high");
    expect(effortLabel("turbo")).toBe("Turbo");
  });
});
