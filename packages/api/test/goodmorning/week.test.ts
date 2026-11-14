import { expect, test } from "vitest";
import { buildWeek, phoneEvents, type Match } from "../../src/goodmorning/week.js";

const OSLO = "Europe/Oslo";
const match = (homeId: number, utcDate: string): Match => ({
  utcDate,
  homeTeam: { id: homeId, shortName: homeId === 402 ? "Brentford" : "Hull City", crest: `c/${homeId}.png` },
  awayTeam: { id: homeId === 402 ? 322 : 402, shortName: homeId === 402 ? "Hull City" : "Brentford", crest: `c/${homeId === 402 ? 322 : 402}.png` },
  competition: { name: "Premier League" },
});

test("seven days run from the report's date", () => {
  const days = buildWeek("2026-12-29", [], [], OSLO);
  expect(days.map((day) => day.date)).toEqual(["2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03", "2027-01-04"]);
});

test("a late UTC event lands on its local day and time", () => {
  const [, second] = buildWeek("2026-11-05", [{ summary: "Flight", start: { dateTime: "2026-11-05T23:30:00Z" }, end: {} }], [], OSLO);
  expect(second.items).toEqual([{ title: "Flight", time: "00:30", kind: "event" }]);
});

test("an all-day event shows on each day it spans, not on its exclusive end date", () => {
  const days = buildWeek("2026-11-05", [{ summary: "Oslo", start: { date: "2026-11-05" }, end: { date: "2026-11-07" } }], [], OSLO);
  expect(days.map((day) => day.items.length)).toEqual([1, 1, 0, 0, 0, 0, 0]);
});

test("events outside the week are dropped", () => {
  const days = buildWeek("2026-11-05", [{ summary: "Later", start: { dateTime: "2026-11-20T10:00:00Z" }, end: {} }], [match(402, "2026-10-01T15:00:00Z")], OSLO);
  expect(days.flatMap((day) => day.items)).toEqual([]);
});

test("a match carries the user's team crest, home or away", () => {
  const home = buildWeek("2026-11-05", [], [match(402, "2026-11-07T15:00:00Z")], OSLO, [], 402)[2].items[0];
  const away = buildWeek("2026-11-05", [], [match(322, "2026-11-07T15:00:00Z")], OSLO, [], 402)[2].items[0];
  expect(home).toMatchObject({ title: "Brentford v Hull City", time: "16:00", kind: "match", crest: "c/402.png" });
  expect(away).toMatchObject({ title: "Hull City v Brentford", crest: "c/402.png" });
});

test("all-day items come first, then by time", () => {
  const [day] = buildWeek("2026-11-05", [
    { summary: "Late", start: { dateTime: "2026-11-05T15:00:00Z" }, end: {} },
    { summary: "Early", start: { dateTime: "2026-11-05T07:00:00Z" }, end: {} },
    { summary: "All day", start: { date: "2026-11-05" }, end: { date: "2026-11-06" } },
  ], [], OSLO);
  expect(day.items.map((item) => item.title)).toEqual(["All day", "Early", "Late"]);
});

test("an event without a title still shows", () => {
  const [day] = buildWeek("2026-11-05", [{ start: { dateTime: "2026-11-05T07:00:00Z" }, end: {} }], [], OSLO);
  expect(day.items[0].title).toBe("Busy");
});

test("travel from mail joins the week in time order, and outside the week it is dropped", () => {
  const [first, second] = buildWeek("2026-11-05", [{ summary: "Review", start: { dateTime: "2026-11-06T09:00:00Z" }, end: {} }], [], OSLO, [
    { date: "2026-11-05", title: "In Paris" },
    { date: "2026-11-06", title: "BA304 LHR to CDG", time: "15:15" },
    { date: "2027-01-01", title: "Later" },
  ]);
  expect(first.items).toEqual([{ title: "In Paris", kind: "event" }]);
  expect(second.items.map((item) => item.title)).toEqual(["Review", "BA304 LHR to CDG"]);
});

test("phone slots show as Work/Private, minus ones Google already has", () => {
  const google = [{ summary: "Swim kit", start: { dateTime: "2026-11-10T06:00:00Z" }, end: { dateTime: "2026-11-10T06:25:00Z" } }];
  const phone = phoneEvents(google, [
    { start: "2026-11-10T07:00:00+01:00", end: "2026-11-10T07:25:00+01:00", kind: "private", allDay: false },
    { start: "2026-11-10T08:00:00+01:00", end: "2026-11-10T16:00:00+01:00", kind: "work", allDay: false },
    { start: "2026-11-11T00:00:00+01:00", end: "2026-11-11T23:59:59+01:00", kind: "private", allDay: true },
  ]);
  const days = buildWeek("2026-11-10", [...google, ...phone], [], OSLO);
  expect(days[0].items).toEqual([{ title: "Swim kit", time: "07:00", kind: "event" }, { title: "Work", time: "08:00", kind: "event" }]);
  expect(days[1].items).toEqual([{ title: "Private", kind: "event" }]);
  expect(days[2].items).toEqual([]);
});
