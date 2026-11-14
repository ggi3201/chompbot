import { existsSync } from "fs";
import { eq } from "drizzle-orm";
import express from "express";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

const reportsDir = vi.hoisted(() => {
  process.env.GOODMORNING_DIR = `/tmp/goodmorning-test-${process.pid}`;
  return process.env.GOODMORNING_DIR;
});
import { db } from "../../src/db/index.js";
import { chatMessages, conversations } from "../../src/db/schema.js";
vi.mock("../../src/goodmorning/week.js", () => ({ loadWeek: async () => ({ days: [], missing: [] }) }));

const { isReportKey, loadReport, reportConversationId, reportKey, reportSchema, reportUrl, saveReport } = await import("../../src/goodmorning/report.js");
const { default: routes } = await import("../../src/routes/goodmorning.js");
const { execPublishMorningReport } = await import("../../src/agents/tools/goodmorning.js");

const REPORT = { date: "2026-11-05", place: "Oslo", headline: "Bring the umbrella", lead: "Rain by noon.", voiceScript: "Morning." };

let server: ReturnType<ReturnType<typeof express>["listen"]>;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use("/gm", routes);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/gm`;
});
afterAll(() => server.close());

test("a report survives saving, with empty sections filled in", () => {
  saveReport(reportSchema.parse(REPORT));
  expect(loadReport("2026-11-05")).toMatchObject({ place: "Oslo", headsUp: [], news: [], inbox: [] });
  expect(existsSync(`${reportsDir}/2026-11-05.json`)).toBe(true);
});

test("a report opens a chat holding its text, and publishing again updates that one message", () => {
  saveReport(reportSchema.parse({ ...REPORT, date: "2026-11-06", headsUp: ["Pack socks"] }));
  saveReport(reportSchema.parse({ ...REPORT, date: "2026-11-06", headline: "Second edition" }));

  const id = reportConversationId("2026-11-06");
  expect(db.select().from(conversations).where(eq(conversations.id, id)).get()?.title).toBe("Morning report 2026-11-06");
  const messages = db.select().from(chatMessages).where(eq(chatMessages.conversationId, id)).all();
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ role: "assistant" });
  expect(messages[0].content).toContain("Second edition");
  expect(messages[0].content).toContain("Rain by noon.");
  expect(messages[0].content).not.toContain("Pack socks");
});

test("a missing day is no report, not an error", () => {
  expect(loadReport("2001-01-01")).toBeNull();
});

test("only the real key passes", () => {
  expect(isReportKey(reportKey())).toBe(true);
  expect(isReportKey("nope")).toBe(false);
  expect(isReportKey(undefined)).toBe(false);
  expect(isReportKey([reportKey()])).toBe(false);
});

test("the link carries the date and key", () => {
  expect(reportUrl("2026-11-05")).toContain(`/goodmorning?date=2026-11-05&key=${reportKey()}`);
});

test("the route refuses a wrong key before it reads anything", async () => {
  const response = await fetch(`${base}/2026-11-05?key=nope`);
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain("umbrella");
  expect((await fetch(`${base}/2026-11-05`)).status).toBe(401);
  expect((await fetch(`${base}/2026-11-05/voice.mp3?key=nope`)).status).toBe(401);
});

test("the route serves the report with the right key", async () => {
  const body = await (await fetch(`${base}/2026-11-05?key=${reportKey()}`)).json() as { report: { headline: string }; hasVoice: boolean };
  expect(body.report.headline).toBe("Bring the umbrella");
  expect(body.hasVoice).toBe(false);
});

test("the route rejects a date that could walk out of the folder", async () => {
  for (const date of ["..%2F..%2Fsecret", "2026-13-45", "latest"]) {
    expect((await fetch(`${base}/${date}?key=${reportKey()}`)).status).toBe(400);
  }
  expect((await fetch(`${base}/2026-11-05/voice.mp3?key=${reportKey()}`)).status).toBe(404);
});

test("an invalid report names what is wrong and saves nothing", async () => {
  const result = await execPublishMorningReport({ date: "2001-02-03", place: "Oslo" });
  expect(result).toMatch(/^ERROR: Invalid report: .*headline/);
  expect(loadReport("2001-02-03")).toBeNull();
});
