import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "../../src/db/index.js";
import { hostMetricRollups, hostMetrics, monitorWarnings } from "../../src/db/schema.js";
import { deleteSecret, saveSecret } from "../../src/lib/secrets.js";
import { averagesByBucket, buildHostSeries, buildHostTiles, fillBuckets } from "../../src/monitoring/host-views.js";
import { collectHomeAssistant, readSensors } from "../../src/monitoring/homeassistant.js";
import { noteArrival, recordMetrics, syncHostWarnings } from "../../src/monitoring/hosts.js";
import { collectLocal, collectMini, cpuPercent, parseCpuStat, parseDf, parseDfPosix, parseMeminfo, parseVmStat } from "../../src/monitoring/local-metrics.js";
import { getTarget, hourStart, rollupAndPrune, rollupSince } from "../../src/monitoring/store.js";
import { evaluateHostWarnings, type HostReading } from "../../src/monitoring/warnings.js";
import { fixture } from "./fixtures.js";
import { clearMonitoring, DAY, HOUR, MINUTE, NOW } from "./helpers.js";

beforeEach(clearMonitoring);

/** One reading a minute for `minutes` minutes ending at `end`, from `value(minutesAgo)`. */
function fill(host: string, metric: string, minutes: number, value: (minutesAgo: number) => number, end = NOW) {
  for (let ago = 0; ago < minutes; ago++) recordMetrics(host, { [metric]: value(ago) }, end - ago * MINUTE);
}

// ── Warnings ────────────────────────────────────────────────────────────

describe("host warning rules", () => {
  const samples = (minutes: number, value: (ago: number) => number) =>
    Array.from({ length: minutes }, (_, i) => ({ ts: NOW - (minutes - 1 - i) * MINUTE, value: value(minutes - 1 - i) }));
  const reading = (over: Partial<HostReading>): HostReading => ({ host: "mini", title: "mini", diskPct: 50, memory: [], ...over });
  const evaluate = (over: Partial<HostReading>) => evaluateHostWarnings([reading(over)], NOW);

  test("disk over 85% is a warning and over 92% its critical kind; 85%, 92% exactly and no readings are not", () => {
    expect(evaluate({ diskPct: 85 })).toEqual([]);
    expect(evaluate({ diskPct: 85.1 })).toEqual([{ key: "host-disk:mini", kind: "host-disk", targetKey: "host:mini", text: "mini disk is 85% full." }]);
    expect(evaluate({ diskPct: 92 })[0].kind).toBe("host-disk");
    expect(evaluate({ diskPct: 92.1 })).toMatchObject([{ key: "host-disk:mini", kind: "host-disk-critical", text: "mini disk is 92% full." }]);
    expect(evaluate({ diskPct: null, memory: [] })).toEqual([]);
  });

  test("memory over 90% for 10 minutes is a warning and over 97% critical; 9 minutes, a recent dip or exactly 90% is not", () => {
    {
      expect(evaluate({ memory: samples(11, () => 93) })).toEqual([{
        key: "host-memory:mini", kind: "host-memory", targetKey: "host:mini",
        text: "mini memory is 93% used, and has been over 90% for 10 minutes.",
      }]);
      expect(evaluate({ memory: samples(10, () => 99) })).toEqual([]);
      expect(evaluate({ memory: samples(30, (ago) => (ago === 5 ? 80 : 95)) })).toEqual([]);
      expect(evaluate({ memory: samples(30, () => 90) })).toEqual([]);
      // A dip that ended more than 10 minutes ago does not count.
      expect(evaluate({ memory: samples(30, (ago) => (ago === 20 ? 80 : 95)) })).toHaveLength(1);
    }
    {
      expect(evaluate({ memory: samples(12, () => 98) })[0].kind).toBe("host-memory-critical");
      expect(evaluate({ memory: samples(12, (ago) => (ago === 0 ? 98 : 92)) })[0].kind).toBe("host-memory-critical");
      expect(evaluate({ memory: samples(12, () => 97) })[0].kind).toBe("host-memory");
    }
  });

});

describe("host warnings in the database", () => {
  const sync = (now: number) => syncHostWarnings(now);
  const warnings = () => db.select().from(monitorWarnings).all();

  test("high memory for 10 minutes opens a warning on the host, and it resolves when memory falls", () => {
    fill("mini", "mem_pct", 12, () => 94);
    fill("mini", "disk_pct", 1, () => 40);
    noteArrival("mini", NOW);
    sync(NOW);
    expect(warnings()).toMatchObject([{ key: "host-memory:mini", kind: "host-memory", targetKey: "host:mini", resolvedAt: null }]);
    recordMetrics("mini", { mem_pct: 50 }, NOW + MINUTE);
    noteArrival("mini", NOW + MINUTE);
    sync(NOW + MINUTE);
    expect(warnings()[0].resolvedAt).not.toBeNull();
  });

  test("a disk that gets worse turns the warning critical without a second one", () => {
    recordMetrics("rpi", { disk_pct: 88 }, NOW);
    noteArrival("rpi", NOW);
    sync(NOW);
    recordMetrics("rpi", { disk_pct: 94 }, NOW + MINUTE);
    noteArrival("rpi", NOW + MINUTE);
    sync(NOW + MINUTE);
    expect(warnings()).toMatchObject([{ key: "host-disk:rpi", kind: "host-disk-critical", resolvedAt: null }]);
  });

  test("a host that goes quiet keeps its warning open, and a host that is fine is left alone", () => {
    recordMetrics("rpi", { disk_pct: 90 }, NOW);
    noteArrival("rpi", NOW);
    recordMetrics("mini", { disk_pct: 40, mem_pct: 30 }, NOW);
    noteArrival("mini", NOW);
    sync(NOW);
    sync(NOW + 20 * MINUTE);
    expect(warnings()).toMatchObject([{ key: "host-disk:rpi", resolvedAt: null }]);
  });

  test("memory is judged on the host's own readings from the last quarter hour only", () => {
    fill("mini", "mem_pct", 20, (ago) => (ago < 8 ? 95 : 40), NOW - 30 * MINUTE);
    fill("mini", "mem_pct", 8, () => 95, NOW);
    noteArrival("mini", NOW);
    sync(NOW);
    expect(warnings()).toEqual([]);
  });
});

// ── Series ──────────────────────────────────────────────────────────────

describe("bucketing", () => {
  const shape = { bucketMs: 15 * MINUTE, count: 4 };
  const end = Math.floor(NOW / shape.bucketMs) * shape.bucketMs;

  test("averages land in the bucket that ends the range at `now`, oldest first, gaps are null, and rows off the range or grid are ignored", () => {
    const rows = [{ bucket: end, value: 7 }, { bucket: end - 3 * shape.bucketMs, value: 1 }];
    expect(averagesByBucket(rows, shape, NOW)).toEqual([1, null, null, 7]);
    const off = [{ bucket: end - 4 * shape.bucketMs, value: 9 }, { bucket: end + shape.bucketMs, value: 9 }, { bucket: end + 1, value: 9 }];
    expect(averagesByBucket(off, shape, NOW)).toEqual([null, null, null, null]);
  });

  test("filling starts at the first reading, repeats the last reading across gaps, and fills a missing series with zeros", () => {
    expect(fillBuckets({ a: [null, 2, null, 4], b: [null, null, 5, null], c: [null, null, null, null] })).toEqual({
      start: 1,
      columns: { a: [2, 2, 4], b: [5, 5, 5], c: [0, 0, 0] },
    });
    // With no readings at all there is nothing to draw.
    expect(fillBuckets({ a: [null, null] })).toEqual({ start: 2, columns: { a: [] } });
    expect(fillBuckets({})).toEqual({ start: 0, columns: {} });
  });
});

describe("the series route's data", () => {
  /** Three hours of one reading a minute: cpu counts up by hour, memory is constant, load alternates. */
  function threeHours(host = "mini") {
    for (let ago = 0; ago < 180; ago++) {
      const ts = NOW - ago * MINUTE;
      recordMetrics(host, { cpu_pct: 10 + Math.floor(ago / 60) * 10, mem_pct: 60, disk_pct: 40, load1: ago % 2 }, ts);
    }
  }

  test("24 hours is 15-minute points from raw readings, drawn from the first reading on", () => {
    threeHours();
    const { times, series } = buildHostSeries("mini", "24h", NOW);
    expect(times).toHaveLength(13); // 12:00 back to 09:00 in 15-minute steps
    expect(times[0]).toBe("2026-11-08T09:00:00.000Z");
    expect(times.at(-1)).toBe("2026-11-08T12:00:00.000Z");
    expect(Object.keys(series)).toEqual(["cpu", "mem", "disk", "load1"]);
    expect(series.cpu).toHaveLength(13);
    // 09:00 holds readings from 2.00 to 2.99 hours ago (cpu 30), the end holds the one at 12:00 (cpu 10).
    expect(series.cpu[0]).toBe(30);
    expect(series.cpu.at(-1)).toBe(10);
    expect(series.mem.every((v) => v === 60)).toBe(true);
    expect(series.load1[1]).toBe(0.5);
  });

  test("a gap in the readings repeats the value before it, and the chart still ends now", () => {
    fill("rpi", "cpu_pct", 5, () => 20, NOW - 2 * HOUR);
    const { times, series } = buildHostSeries("rpi", "24h", NOW);
    expect(times.at(-1)).toBe("2026-11-08T12:00:00.000Z");
    expect(series.cpu.at(-1)).toBe(20);
    expect(series.mem.at(-1)).toBe(0);
    expect(series.cpu).toHaveLength(times.length);
  });

  test("7 days is hourly points from the rollups, using the average", () => {
    threeHours();
    expect(buildHostSeries("mini", "7d", NOW).times).toEqual([]);
    rollupSince(NOW - 4 * HOUR);
    const { times, series } = buildHostSeries("mini", "7d", NOW);
    expect(times).toEqual(["2026-11-08T09:00:00.000Z", "2026-11-08T10:00:00.000Z", "2026-11-08T11:00:00.000Z", "2026-11-08T12:00:00.000Z"]);
    // An hour's first minute belongs to it: the reading at exactly 10:00 is 30 and the 59 after it are 20.
    expect(series.cpu).toEqual([30, 20.2, 10.2, 10]);
    expect(series.mem).toEqual([60, 60, 60, 60]);
  });

  test("30 days is 4-hour points averaged from the rollups", () => {
    for (const [hour, cpu] of [[8, 10], [9, 20], [10, 30], [11, 40]] as const) {
      db.insert(hostMetricRollups).values({ host: "mini", metric: "cpu_pct", hour: Date.parse(`2026-11-08T${String(hour).padStart(2, "0")}:00:00Z`), avg: cpu, max: cpu + 5 }).run();
    }
    db.insert(hostMetricRollups).values({ host: "mini", metric: "cpu_pct", hour: Date.parse("2026-11-07T23:00:00Z"), avg: 5, max: 5 }).run();
    const { times, series } = buildHostSeries("mini", "30d", NOW);
    // 4-hour buckets are aligned to midnight UTC: 20:00-23:59 (5), 00:00-03:59 (none yet), 08:00-11:59 (25).
    expect(times.at(-1)).toBe("2026-11-08T12:00:00.000Z");
    expect(series.cpu.at(-2)).toBe(25);
    expect(series.cpu[0]).toBe(5);
  });


  test("another host's readings do not leak into the series", () => {
    threeHours("rpi");
    expect(buildHostSeries("mini", "24h", NOW).times).toEqual([]);
  });

  test("tiles carry 48 half-hour points of the last day", () => {
    for (let ago = 0; ago < 24 * 60; ago += 5) recordMetrics("mini", { cpu_pct: ago < 60 ? 80 : 10, mem_pct: 50, disk_pct: 30 }, NOW - ago * MINUTE);
    noteArrival("mini", NOW);
    const tile = buildHostTiles(NOW).hosts[0];
    expect(tile.spark.cpu).toHaveLength(48);
    expect(tile.spark.cpu.at(-1)).toBe(80);
    expect(tile.spark.cpu[0]).toBe(10);
    expect(tile.spark.mem.every((v) => v === 50)).toBe(true);
  });
});

describe("hourly rollups", () => {
  const rows = () => db.select().from(hostMetricRollups).orderBy(hostMetricRollups.hour).all();

  test("an hour keeps the average and the highest reading, and rolling up again does not add rows", () => {
    const hour = hourStart(NOW - 2 * HOUR);
    for (const [minute, value] of [[1, 10], [2, 30], [3, 80]] as const) recordMetrics("mini", { cpu_pct: value }, hour + minute * MINUTE);
    recordMetrics("mini", { cpu_pct: 5 }, hour + HOUR + MINUTE);
    rollupSince(hour);
    rollupSince(hour);
    expect(rows()).toEqual([
      { host: "mini", metric: "cpu_pct", hour, avg: 40, max: 80 },
      { host: "mini", metric: "cpu_pct", hour: hour + HOUR, avg: 5, max: 5 },
    ]);
  });

  test("raw readings are kept 7 days and rollups far longer", () => {
    recordMetrics("mini", { cpu_pct: 10 }, NOW - 6 * DAY);
    recordMetrics("mini", { cpu_pct: 20 }, NOW - 8 * DAY);
    db.insert(hostMetricRollups).values({ host: "mini", metric: "cpu_pct", hour: hourStart(NOW - 300 * DAY), avg: 1, max: 1 }).run();
    rollupSince(NOW - 9 * DAY);
    const pruned = rollupAndPrune(NOW);
    expect(pruned.metrics).toBe(1);
    expect(db.select().from(hostMetrics).all().map((r) => r.value)).toEqual([10]);
    expect(rows()).toHaveLength(3);
  });
});

// ── The mini ────────────────────────────────────────────────────────────

describe("reading the mini's /proc", () => {
  test("the cpu line is read as idle and total, and the share busy is the difference between two reads", () => {
    const before = parseCpuStat(fixture("proc-stat.txt"))!;
    expect(before).toEqual({ idle: 14641021872 + 5545305, total: 251151496 + 371092 + 123090250 + 14641021872 + 5545305 + 0 + 5711440 + 0 });
    // 1000 jiffies pass, 900 of them idle.
    expect(cpuPercent(before, { idle: before.idle + 900, total: before.total + 1000 })).toBe(10);
    expect(cpuPercent(before, before)).toBe(0);
    // A line that is not a cpu line gives nothing.
    expect(parseCpuStat("")).toBeNull();
    expect(parseCpuStat("cpu  1 2")).toBeNull();
  });

  test("memory used is total minus available, and disk used is used over used plus available, as the agents report them", () => {
    {
      expect(parseMeminfo(fixture("proc-meminfo.txt"))).toEqual({ mem_pct: 39, mem_used_gb: 11.38, mem_total_gb: 29.17 });
      expect(parseMeminfo("MemTotal: 100 kB")).toBeNull();
    }
    {
      expect(parseDf(fixture("df-root.txt"))).toEqual({ disk_pct: 41.4, disk_used_gb: 368.09, disk_total_gb: 936.79 });
      expect(parseDf("")).toBeNull();
    }
  });


  test("on macOS memory is active + wired + compressed pages, and disk comes from df -P -k", () => {
    const vmStat = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:  12612.\nPages active:  193642.\nPages wired down:  853283.\nPages occupied by compressor:  65536.\n";
    expect(parseVmStat(vmStat, 32 * 1024 ** 3)).toEqual({ mem_pct: 53, mem_used_gb: 16.97, mem_total_gb: 32 });
    expect(parseVmStat("", 32 * 1024 ** 3)).toBeNull();
    const df = "Filesystem   1024-blocks      Used Available Capacity  Mounted on\n/dev/disk3s5   482797652 349053908  87328780    80%    /System/Volumes/Data\n";
    expect(parseDfPosix(df)).toEqual({ disk_pct: 80, disk_used_gb: 332.88, disk_total_gb: 460.43 });
    expect(parseDfPosix("")).toBeNull();
  });

  test.skipIf(process.platform === "linux" || process.platform === "darwin")("without /proc nothing is read, nothing is stored and nothing is logged", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await collectLocal()).toBeNull();
    await collectMini(NOW);
    expect(db.select().from(hostMetrics).all()).toEqual([]);
    expect(getTarget("host:mini")).toBeUndefined();
    expect(error).not.toHaveBeenCalled();
  });

  test.skipIf(process.platform !== "linux" && process.platform !== "darwin")("on Linux and macOS the readings carry the contract's names and the mini is marked seen", async () => {
    await collectMini(NOW);
    const names = db.select().from(hostMetrics).all().map((r) => r.metric);
    expect(names).toEqual(expect.arrayContaining(["cpu_pct", "mem_pct", "disk_pct", "load1", "load5", "uptime_sec"]));
    expect(getTarget("host:mini")).toMatchObject({ lastPushAt: NOW, sources: ["local"] });
  });
});

// ── Home Assistant ──────────────────────────────────────────────────────

describe("Home Assistant", () => {
  const state = (entity_id: string, value: string) => ({ entity_id, state: value, attributes: {} });
  const plain = [state("light.kitchen", "on"), state("sensor.oven_temperature", "21"), state("weather.home", "cloudy")];

  const answer = (body: unknown, status = 200) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
  beforeEach(() => {
    saveSecret("HOMEASSISTANT_URL", "http://ha.test:8123/");
    saveSecret("HOMEASSISTANT_TOKEN", "ha-test-token");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    deleteSecret("HOMEASSISTANT_URL");
    deleteSecret("HOMEASSISTANT_TOKEN");
  });

  test("System Monitor sensors are found by pattern, whatever the machine is called", () => {
    expect(readSensors([
      ...plain,
      state("sensor.system_monitor_processor_use", "7.5"),
      state("sensor.home_assistant_memory_use_percent", "52"),
      state("sensor.system_monitor_disk_use_percent", "41.2"),
    ])).toEqual({ cpu_pct: 7.5, mem_pct: 52, disk_pct: 41.2 });
    // With several disks the shortest sensor id, the main one, wins; unavailable sensors are skipped.
    expect(readSensors([
      state("sensor.system_monitor_disk_use_percent_media", "90"),
      state("sensor.system_monitor_disk_use_percent", "41"),
      state("sensor.system_monitor_processor_use", "unavailable"),
      state("sensor.pi_processor_use", "12"),
    ])).toEqual({ disk_pct: 41, cpu_pct: 12 });
    // None of the 358 states of today's Home Assistant is a System Monitor sensor.
    expect(readSensors(plain)).toEqual({});
  });

  test("reachable without sensors: Home Assistant is seen, and no metrics are stored", async () => {
    answer(plain);
    await collectHomeAssistant(NOW);
    expect(db.select().from(hostMetrics).all()).toEqual([]);
    expect(getTarget("host:ha")).toMatchObject({ kind: "host", title: "home assistant", sources: ["ha"], lastPushAt: NOW, tracked: true });
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://ha.test:8123/api/states");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ha-test-token");
    expect(buildHostTiles(NOW).hosts.find((h) => h.host === "ha")).toMatchObject({ state: "up", metrics: { cpu: null, mem: null, disk: null } });
  });

  test("with sensors their readings are stored as the host's cpu, memory and disk", async () => {
    answer([...plain, state("sensor.system_monitor_processor_use", "7.5"), state("sensor.system_monitor_memory_use_percent", "52")]);
    await collectHomeAssistant(NOW);
    expect(Object.fromEntries(db.select().from(hostMetrics).all().map((r) => [r.metric, r.value]))).toEqual({ cpu_pct: 7.5, mem_pct: 52 });
    expect(buildHostTiles(NOW).hosts.find((h) => h.host === "ha")?.metrics).toEqual({ cpu: 7.5, mem: 52, disk: null });
  });

  test("an answer that is not OK, or no answer, throws and does not mark it seen", async () => {
    answer({ message: "401: Unauthorized" }, 401);
    await expect(collectHomeAssistant(NOW)).rejects.toThrow("Home Assistant answered 401");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(collectHomeAssistant(NOW)).rejects.toThrow("fetch failed");
    expect(getTarget("host:ha")).toBeUndefined();
  });

  test("without a URL and token nothing is asked", async () => {
    deleteSecret("HOMEASSISTANT_TOKEN");
    vi.stubGlobal("fetch", vi.fn());
    const had = { url: process.env.HOMEASSISTANT_URL, token: process.env.HOMEASSISTANT_TOKEN };
    delete process.env.HOMEASSISTANT_URL;
    delete process.env.HOMEASSISTANT_TOKEN;
    await collectHomeAssistant(NOW);
    Object.assign(process.env, Object.fromEntries(Object.entries({ HOMEASSISTANT_URL: had.url, HOMEASSISTANT_TOKEN: had.token }).filter(([, v]) => v !== undefined)));
    expect(fetch).not.toHaveBeenCalled();
    expect(getTarget("host:ha")).toBeUndefined();
  });
});
