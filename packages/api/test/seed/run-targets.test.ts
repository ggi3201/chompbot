import { test, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { channelTarget } from "../../src/agents/run-target.js";
import { db } from "../../src/db/index.js";
import { settings, souls } from "../../src/db/schema.js";
import { routeMessage } from "../../src/ollama/triage.js";
import { moveAgentToTarget } from "../../src/seed/run-targets.js";

const NOW = "2026-05-04T12:00:00.000Z";

function insertSoul(id: string, name: string): void {
  db.insert(souls).values({ id, name, description: "", content: `You are ${name}.`, createdAt: NOW, updatedAt: NOW }).run();
}

beforeEach(() => {
  db.delete(settings).where(eq(settings.key, "run_target")).run();
  db.delete(settings).where(eq(settings.key, "run_target_discord")).run();
  db.delete(settings).where(eq(settings.key, "run_target_telegram")).run();
  db.delete(souls).run();
});

test("a channel's own target beats the overall default", () => {
  db.insert(settings).values({ key: "run_target", value: JSON.stringify({ provider: "claude", model: "opus" }) }).run();
  db.insert(settings).values({ key: "run_target_discord", value: JSON.stringify({ provider: "codex", model: "gpt-5.5", soulId: "soul-spicy" }) }).run();

  expect(channelTarget("discord")).toEqual({ provider: "codex", model: "gpt-5.5", soulId: "soul-spicy" });
  expect(channelTarget("telegram")).toEqual({ provider: "claude", model: "opus" });
});

test("with no defaults saved, everything runs on Claude", () => {
  expect(channelTarget("discord")).toEqual({ provider: "claude", model: "sonnet" });
});

test("@claude and @codex are ordinary text: they no longer switch the runtime", () => {
  const routing = routeMessage("ask @codex later, or @claude code");

  expect(routing).toMatchObject({ action: "delegate", reason: "default", prompt: "ask @codex later, or @claude code" });
  expect(routing.provider).toBeUndefined();
});

test("@chat is ordinary text: every message goes to an agent", () => {
  expect(routeMessage("I have something like @chat in my shorthands").action).toBe("delegate");
});

test("@soul answers as that soul, on whatever the turn would run on anyway", () => {
  insertSoul("soul-alfred", "Alfred");

  expect(routeMessage("@Alfred what is on today?")).toMatchObject({ action: "delegate", soulId: "soul-alfred", prompt: "what is on today?" });
});

test("no mention leaves the choice to the caller", () => {
  expect(routeMessage("ship the thing")).toEqual({ action: "delegate", prompt: "ship the thing", reason: "default" });
});

const alfredRow = { provider: "claude", model: "opus", effort: "high", soulId: "alfred" } as const;
const resolve = (name?: string, id?: string) => (name === "Alfred" || id === "row-alfred" ? alfredRow : undefined);

test("moving an agent name keeps what the agent row meant", () => {
  expect(moveAgentToTarget({ agent: "Alfred", agentId: "row-alfred", prompt: "go" }, "agent", resolve))
    .toEqual({ provider: "claude", model: "opus", effort: "high", soulId: "alfred", prompt: "go" });
});

test("what a config already says wins over the agent row", () => {
  expect(moveAgentToTarget({ agent: "Alfred", model: "sonnet", soulId: "spicy" }, "agent", resolve))
    .toEqual({ provider: "claude", model: "sonnet", effort: "high", soulId: "spicy" });
});

test("a model of another provider does not inherit the row's engine", () => {
  expect(moveAgentToTarget({ agent: "Alfred", model: "gpt-5.5" }, "agent", resolve))
    .toEqual({ provider: "codex", model: "gpt-5.5", soulId: "alfred" });
});

test("nothing to move, or an unknown name, leaves the config alone", () => {
  expect(moveAgentToTarget({ prompt: "go", provider: "claude" }, "agent", resolve)).toBeNull();
  expect(moveAgentToTarget({ agent: "Renamed Ghost", prompt: "go" }, "agent", resolve)).toBeNull();
});

test("moved configs are not moved again", () => {
  const moved = moveAgentToTarget({ agent: "Alfred" }, "agent", resolve)!;
  expect(moveAgentToTarget(moved, "agent", resolve)).toBeNull();
});
