import assert from "node:assert/strict";
import { test } from "node:test";
import { SUBREQUEST_BUDGET } from "../src/schedule.ts";
import { STATE_KEY, TARGETS_KEY, runProbe, type Deps } from "../src/run.ts";
import type { Env, Report, Targets } from "../src/types.ts";

const RESULTS_URL = "https://chomp.example/api/monitoring/outside";
const env = (kv: Env["TARGETS"]): Env => ({
  TARGETS: kv,
  CHOMP_RESULTS_URL: RESULTS_URL,
  TELEGRAM_ALERTS_CHAT_ID: "42",
  MONITOR_OUTSIDE_SECRET: "s3cret",
  TELEGRAM_ALERTS_BOT_TOKEN: "bot-token",
});

const PORT_MINUTE_MS = 15 * 100 * 60_000;

function world(options: { targets?: unknown; state?: unknown; chomp?: number; openPorts?: number[] }) {
  const store = new Map<string, string>();
  if (options.targets !== undefined) store.set(TARGETS_KEY, typeof options.targets === "string" ? options.targets : JSON.stringify(options.targets));
  if (options.state !== undefined) store.set(STATE_KEY, JSON.stringify(options.state));
  const w = {
    subrequests: 0,
    puts: [] as string[],
    reports: [] as Report[],
    telegram: [] as string[],
    probed: [] as string[],
    connected: [] as number[],
    deps: undefined as unknown as Deps,
  };
  w.deps = {
    kv: {
      get: async (key) => (w.subrequests++, store.get(key) ?? null),
      put: async (key, value) => {
        w.subrequests++;
        w.puts.push(key);
        store.set(key, value);
      },
    },
    fetch: async (url, init) => {
      w.subrequests++;
      if (url === RESULTS_URL) {
        w.reports.push(JSON.parse(init.body as string));
        return new Response(null, { status: options.chomp ?? 200 });
      }
      if (url.startsWith("https://api.telegram.org/")) {
        w.telegram.push(JSON.parse(init.body as string).text);
        return new Response(null, { status: 200 });
      }
      w.probed.push(url);
      return new Response(null, { status: 200 });
    },
    connect: ({ port }) => {
      w.subrequests++;
      w.connected.push(port);
      const open = options.openPorts?.includes(port) ?? false;
      return { opened: open ? Promise.resolve() : Promise.reject(new Error("refused")), close: async () => {} };
    },
    now: Date.now,
  };
  return w;
}

const targets = (urlCount: number, ports: number[]): Targets => ({
  version: 1,
  urls: Array.from({ length: urlCount }, (_, i) => ({ key: `u${i}`, url: `https://u${i}.example/` })),
  ports,
  homeHost: "home.example.com",
});

const TWELVE_PORTS = [22, 80, 443, 3001, 5433, 5434, 5435, 5632, 6379, 8000, 9000, 9443];

test("a normal minute checks every URL, posts one report, and touches KV only to read", async () => {
  const w = world({ targets: targets(33, TWELVE_PORTS) });
  await runProbe(env(w.deps.kv as Env["TARGETS"]), w.deps, PORT_MINUTE_MS + 60_000);

  assert.equal(w.probed.length, 33);
  assert.equal(w.connected.length, 0);
  assert.equal(w.reports.length, 1);
  assert.equal(w.reports[0].vantage, "outside");
  assert.equal(w.reports[0].results.length, 33);
  assert.equal(w.reports[0].ports, undefined);
  assert.deepEqual(w.puts, []);
  assert.equal(w.telegram.length, 0);
});

test("a port minute reports the ports that answered and stays inside the budget", async () => {
  const w = world({ targets: targets(33, TWELVE_PORTS), openPorts: [443] });
  await runProbe(env(w.deps.kv as Env["TARGETS"]), w.deps, PORT_MINUTE_MS);

  const open = w.reports[0].ports?.filter((p) => p.open).map((p) => p.port);
  assert.deepEqual(open, [443]);
  assert.equal(w.reports[0].ports?.length, 12);
  assert.ok(w.subrequests <= SUBREQUEST_BUDGET, `${w.subrequests} subrequests`);
});

test("the worst run (huge list, port minute, alarm, state write) stays inside the budget", async () => {
  const ports = Array.from({ length: 20 }, (_, i) => 1000 + i);
  const w = world({
    targets: targets(500, ports),
    state: { failures: 2, since: 0, alarmed: false },
    chomp: 500,
  });
  await runProbe(env(w.deps.kv as Env["TARGETS"]), w.deps, PORT_MINUTE_MS);

  assert.equal(w.telegram.length, 1);
  assert.deepEqual(w.puts, [STATE_KEY]);
  assert.equal(w.subrequests, SUBREQUEST_BUDGET);
});

test("a missing target list still reports, with nothing checked", async () => {
  const w = world({});
  await runProbe(env(w.deps.kv as Env["TARGETS"]), w.deps, PORT_MINUTE_MS);

  assert.equal(w.reports.length, 1);
  assert.deepEqual(w.reports[0].results, []);
  assert.equal(w.reports[0].ports, undefined);
  assert.deepEqual([w.probed.length, w.connected.length], [0, 0]);
});

test("an invalid target list is treated like a missing one", async () => {
  const w = world({ targets: { version: 1, urls: [{ key: "a", url: "ftp://x" }], ports: [], homeHost: "h" } });
  await runProbe(env(w.deps.kv as Env["TARGETS"]), w.deps, PORT_MINUTE_MS + 60_000);

  assert.equal(w.reports.length, 1);
  assert.deepEqual(w.reports[0].results, []);
  assert.equal(w.probed.length, 0);
});

test("three failed runs send the alarm once", async () => {
  const w = world({ targets: targets(1, []), chomp: 502 });
  for (let n = 1; n <= 5; n++) await runProbe(env(w.deps.kv as Env["TARGETS"]), w.deps, PORT_MINUTE_MS + n * 60_000);

  assert.equal(w.telegram.length, 1);
  assert.match(w.telegram[0], /Last error: HTTP 502/);
  assert.deepEqual(w.puts, [STATE_KEY, STATE_KEY, STATE_KEY]);
});

test("the first good run after an alarm says Chomp is back, once", async () => {
  const w = world({
    targets: targets(1, []),
    state: { failures: 3, since: Date.now() - 4 * 60_000, alarmed: true },
  });
  for (let n = 1; n <= 3; n++) await runProbe(env(w.deps.kv as Env["TARGETS"]), w.deps, PORT_MINUTE_MS + n * 60_000);

  assert.deepEqual(w.telegram, ["Chomp is back after 4 min."]);
  assert.deepEqual(w.puts, [STATE_KEY]);
});
