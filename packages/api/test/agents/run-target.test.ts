import { describe, expect, test } from "vitest";
import { resolveRun, runTargetFrom } from "../../src/agents/run-target.js";

const base = { provider: "claude", model: "opus", effort: "high", soulId: "alfred" } as const;

describe("resolveRun", () => {
  test("nothing asked for: the base applies", () => {
    expect(resolveRun({}, {}, base)).toEqual(base);
  });

  test("the same soul runs on a weaker model of the same provider", () => {
    expect(resolveRun({}, { model: "haiku" }, base)).toEqual({ provider: "claude", model: "haiku", effort: "high", soulId: "alfred" });
  });

  test("the same soul runs on another provider, without the base's model and effort", () => {
    expect(resolveRun({}, { provider: "codex" }, base)).toEqual({ provider: "codex", model: "gpt-6.1-sol", soulId: "alfred" });
  });

  test("a model without a provider picks its own provider", () => {
    expect(resolveRun({}, { model: "gpt-5.5" }, base)).toMatchObject({ provider: "codex", model: "gpt-5.5" });
    expect(resolveRun({}, { model: "sonnet" }, { provider: "codex", model: "gpt-5.5" })).toMatchObject({ provider: "claude", model: "sonnet" });
  });

  test("an @provider mention beats the composer and drops its model", () => {
    const chosen = { provider: "claude", model: "opus", effort: "max", soulId: "spicy" } as const;
    expect(resolveRun({ provider: "codex" }, chosen, base)).toEqual({ provider: "codex", model: "gpt-6.1-sol", soulId: "spicy" });
  });

  test("an @soul mention keeps the chosen model", () => {
    const chosen = { provider: "codex", model: "gpt-5.5" } as const;
    expect(resolveRun({ soulId: "spicy" }, chosen, base)).toEqual({ provider: "codex", model: "gpt-5.5", soulId: "spicy" });
  });

  test("no provider anywhere means Claude and no soul means the default soul", () => {
    expect(resolveRun({}, {}, {})).toEqual({ provider: "claude", model: "sonnet" });
  });
});

describe("access", () => {
  test("carries over like a soul, whatever the provider", () => {
    expect(resolveRun({ provider: "codex" }, {}, { ...base, access: "supervised" }).access).toBe("supervised");
    expect(resolveRun({}, { access: "full" }, { ...base, access: "supervised" }).access).toBe("full");
    expect(resolveRun({}, {}, base).access).toBeUndefined();
  });

  test("a saved target only counts a real mode", () => {
    expect(runTargetFrom({ access: "supervised" })).toEqual({ access: "supervised" });
    expect(runTargetFrom({ access: "root" })).toEqual({});
  });
});
