import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECK_SLOTS, SUBREQUEST_BUDGET, planRun } from "../src/schedule.ts";
import type { Targets } from "../src/types.ts";

const targets = (urlCount: number, portCount: number): Targets => ({
  version: 1,
  urls: Array.from({ length: urlCount }, (_, i) => ({ key: `u${i}`, url: `https://u${i}.example/` })),
  ports: Array.from({ length: portCount }, (_, i) => 1000 + i),
  homeHost: "home.example.com",
});

const PORT_MINUTE = 15 * 100;

test("the budget leaves room for the fixed work of a run", () => {
  assert.equal(SUBREQUEST_BUDGET, 48);
  assert.equal(CHECK_SLOTS, 43);
});

test("checks ports only when the minute divides by 15", () => {
  const t = targets(5, 12);
  assert.equal(planRun(t, PORT_MINUTE).ports.length, 12);
  assert.equal(planRun(t, PORT_MINUTE + 1).ports.length, 0);
  assert.equal(planRun(t, PORT_MINUTE + 14).ports.length, 0);
  assert.equal(planRun(t, PORT_MINUTE + 15).ports.length, 12);
});

test("checks every URL each minute when they fit", () => {
  const t = targets(33, 12);
  assert.equal(planRun(t, PORT_MINUTE + 1).urls.length, 33);
});

test("shards URLs on a port minute so that the plan stays inside the budget", () => {
  const plan = planRun(targets(33, 12), PORT_MINUTE);
  assert.ok(plan.urls.length < 33);
  assert.ok(plan.urls.length + plan.ports.length <= CHECK_SLOTS);
});

test("with today's 33 URLs and 12 ports every URL is checked at least every 2 minutes", () => {
  const t = targets(33, 12);
  const lastSeen = new Map<string, number>();
  for (let minute = 0; minute < 200; minute++) {
    for (const url of planRun(t, minute).urls) {
      const previous = lastSeen.get(url.key);
      if (previous !== undefined) assert.ok(minute - previous <= 2, `${url.key} waited ${minute - previous} min`);
      lastSeen.set(url.key, minute);
    }
  }
  assert.equal(lastSeen.size, 33);
});

test("a very large list is sharded, covers every URL, and never exceeds the budget", () => {
  const t = targets(200, 20);
  const covered = new Set<string>();
  for (let minute = 0; minute < 60; minute++) {
    const plan = planRun(t, minute);
    assert.ok(plan.urls.length + plan.ports.length <= CHECK_SLOTS, `minute ${minute}`);
    for (const url of plan.urls) covered.add(url.key);
  }
  assert.equal(covered.size, 200);
});

test("plans nothing for an empty list and carries the home host", () => {
  const plan = planRun(targets(0, 0), PORT_MINUTE);
  assert.deepEqual([plan.urls, plan.ports, plan.homeHost], [[], [], "home.example.com"]);
});
