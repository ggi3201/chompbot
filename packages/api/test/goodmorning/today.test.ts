import express from "express";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

vi.hoisted(() => {
  process.env.GOODMORNING_DIR = `/tmp/goodmorning-today-test-${process.pid}`;
});
vi.mock("../../src/goodmorning/week.js", () => ({ loadWeek: async () => ({ days: [], missing: [] }) }));

const { reportSchema, saveReport } = await import("../../src/goodmorning/report.js");
const { default: routes } = await import("../../src/routes/today.js");

let server: ReturnType<ReturnType<typeof express>["listen"]>;
let url: string;

beforeAll(async () => {
  const app = express();
  app.use("/today", routes);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/today`;
});
afterAll(() => server.close());

test("today has no report until one is published", async () => {
  const body = await (await fetch(url)).json() as { date: string; report: unknown; reportUrl: unknown };

  expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(body.report).toBeNull();
  expect(body.reportUrl).toBeNull();
});

test("today shows the headline, place and weather of today's report, with a link to it", async () => {
  const { date } = await (await fetch(url)).json() as { date: string };
  saveReport(reportSchema.parse({
    date,
    place: "Oslo",
    headline: "Bring the umbrella",
    lead: "Rain by noon.",
    voiceScript: "Morning.",
    weather: { summary: "Rain", high: 9, low: 4 },
  }));

  const body = await (await fetch(url)).json() as { report: Record<string, unknown>; reportUrl: string };

  expect(body.report).toEqual({ place: "Oslo", headline: "Bring the umbrella", weather: { summary: "Rain", high: 9, low: 4 } });
  expect(body.reportUrl).toContain(`/goodmorning?date=${date}&key=`);
});
