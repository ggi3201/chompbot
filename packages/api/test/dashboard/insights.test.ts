import express from "express";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { db } from "../../src/db/index.js";
import { agentSessions, chatItems, chatMessages, conversations, memories, proactiveRuleRuns, proactiveRules } from "../../src/db/schema.js";
import { buildInsights } from "../../src/dashboard/insights.js";
import routes from "../../src/routes/dashboard.js";

const NOW = new Date("2026-11-06T12:00:00.000Z"); // a Friday

function session(id: string, startedAt: string, status: string, model = "opus", durationMs = 60_000) {
  db.insert(agentSessions).values({ sessionId: id, agentName: "Alfred", agentType: "claude-sdk", status, model, durationMs, startedAt }).run();
}

let server: ReturnType<ReturnType<typeof express>["listen"]>;
let url: string;

beforeAll(async () => {
  const app = express();
  app.use("/dashboard", routes);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dashboard`;
});
afterAll(() => server.close());

beforeEach(() => {
  db.delete(chatItems).run();
  db.delete(chatMessages).run();
  db.delete(conversations).run();
  db.delete(agentSessions).run();
  db.delete(proactiveRuleRuns).run();
  db.delete(proactiveRules).run();
  db.delete(memories).run();
});

test("buckets runs by the user's day, and sorts them by outcome and model", () => {
  session("a", "2026-11-05T23:30:00.000Z", "completed", "claude-sonnet-4.6"); // already Friday in Oslo
  session("b", "2026-11-06T08:00:00.000Z", "crashed", "gpt-5.5");
  session("c", "2026-11-06T09:00:00.000Z", "killed", "opus");
  session("d", "2026-11-06T10:00:00.000Z", "running", "opus");

  const insights = buildInsights(NOW, "Europe/Oslo");

  expect(insights.daily).toEqual({ "2026-11-06": 3 });
  expect(insights.weekly.at(-1)).toMatchObject({ week: "2026-11-02", completed: 1, killed: 1, failed: 1, sonnet: 1, gpt: 1, opus: 1 });
  expect(insights.weekly).toHaveLength(26);
  expect(insights.tiles).toMatchObject({ runs7: 3, runs30: 3, runsWeekBefore: 0 });
  expect(insights.tiles.successRate30).toBeCloseTo(1 / 3);
  // Only the day with runs has a rate: quiet days must not read as 0% success.
  expect(insights.tiles.spark.successRate).toHaveLength(1);
});

test("the punchcard counts only the user's messages, in local time", () => {
  db.insert(conversations).values({ id: "c1", title: "t" }).run();
  const message = (id: string, role: string, createdAt: string) =>
    db.insert(chatMessages).values({ id, conversationId: "c1", role, content: "x", createdAt }).run();
  message("m1", "user", "2026-11-05T23:30:00.000Z"); // Friday 00:30 in Oslo
  message("m2", "assistant", "2026-11-05T23:31:00.000Z");

  const { punchcard } = buildInsights(NOW, "Europe/Oslo");

  expect(punchcard[4][0]).toBe(1);
  expect(punchcard.flat().reduce((a, b) => a + b, 0)).toBe(1);
});

test("turn lengths, memory growth and context handle gaps and bad snapshots", () => {
  session("a", "2026-11-06T08:00:00.000Z", "completed", "opus", 5_000);
  session("b", "2026-11-06T08:00:00.000Z", "completed", "opus", 7_200_000);
  const memory = (id: string, createdAt: string) => db.insert(memories).values({ id, content: "x", category: "facts", createdAt, updatedAt: createdAt }).run();
  memory("m1", "2026-10-20T08:00:00.000Z");
  memory("m2", "2026-11-03T08:00:00.000Z");
  db.insert(conversations).values([
    { id: "c1", title: "t", updatedAt: NOW.toISOString(), contextUsage: JSON.stringify({ categories: [{ name: "Skills", tokens: 100 }, { name: "MCP tools", tokens: 10 }, { name: "System tools", tokens: 20 }] }) },
    { id: "c2", title: "t", updatedAt: NOW.toISOString(), contextUsage: "not json" },
  ]).run();

  const insights = buildInsights(NOW, "Europe/Oslo");

  expect(insights.durations.counts[0]).toBe(1);
  expect(insights.durations.counts[7]).toBe(1);
  // The empty week in the middle still gets a point.
  expect(insights.memoryGrowth).toEqual([
    { week: "2026-10-19", total: 1 },
    { week: "2026-10-26", total: 1 },
    { week: "2026-11-02", total: 2 },
  ]);
  expect(insights.context).toEqual({ conversations: 1, groups: [{ name: "Skills", tokens: 100 }, { name: "Tools and MCP", tokens: 30 }] });
});

test("timeseries returns every series at the requested range and ignores unknown ones", async () => {
  // Now, not a minute ago: in the first minute of an hour that would land in the previous hour.
  session("a", new Date().toISOString(), "failed");

  const day = await (await fetch(`${url}/timeseries`)).json();
  const week = await (await fetch(`${url}/timeseries?range=7d`)).json();
  const bogus = await fetch(`${url}/timeseries?range=__proto__`);

  expect(day.hours).toHaveLength(24);
  expect(day.failedRuns.at(-1)).toBe(1);
  expect(week.hours).toHaveLength(28);
  expect(week.toolCalls).toHaveLength(28);
  expect(bogus.status).toBe(200);
  expect((await bogus.json()).hours).toHaveLength(24);
});
