import { readdir, readFile } from "fs/promises";
import { cpus, loadavg, totalmem, uptime } from "os";
import { run } from "./exec.js";
import { noteArrival, recordMetrics } from "./hosts.js";
import { MINI } from "./discover.js";

// The machine Chomp runs on reads itself (/proc on Linux, vm_stat and df on macOS), with the same metric names and arithmetic
// as the host agents (see scripts/host-agent/CONTRACT.md and macos.sh).

const CPU_WINDOW_MS = 300;
const GIB = 1024 ** 3;
const round = (value: number, digits = 1) => Number(value.toFixed(digits));

export interface CpuTimes { idle: number; total: number }

/** The first line of /proc/stat: `cpu user nice system idle iowait irq softirq steal ...`. Idle counts iowait. */
export function parseCpuStat(text: string): CpuTimes | null {
  const fields = text.split("\n")[0]?.split(/\s+/).slice(1).map(Number) ?? [];
  if (fields.length < 5 || fields.some(Number.isNaN)) return null;
  return { idle: fields[3] + fields[4], total: fields.slice(0, 8).reduce((a, b) => a + b, 0) };
}

export function cpuPercent(before: CpuTimes, after: CpuTimes): number {
  const total = after.total - before.total;
  return total > 0 ? round((100 * (total - (after.idle - before.idle))) / total) : 0;
}

/** Memory use as the agents report it: everything the kernel cannot hand out again without swapping counts as used. */
export function parseMeminfo(text: string): { mem_pct: number; mem_used_gb: number; mem_total_gb: number } | null {
  const kb = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(text)?.[1]);
  const total = kb("MemTotal");
  const available = kb("MemAvailable");
  if (!total || Number.isNaN(available)) return null;
  return {
    mem_pct: round((100 * (total - available)) / total),
    mem_used_gb: round((total - available) / 1048576, 2),
    mem_total_gb: round(total / 1048576, 2),
  };
}

/** `df -B1 --output=size,used,avail /`: a header line, then bytes. The share is used / (used + available), as `df` prints it. */
export function parseDf(output: string): { disk_pct: number; disk_used_gb: number; disk_total_gb: number } | null {
  const [size, used, avail] = (output.trim().split("\n").at(-1) ?? "").trim().split(/\s+/).map(Number);
  if (!size || Number.isNaN(used) || Number.isNaN(avail) || used + avail === 0) return null;
  return { disk_pct: round((100 * used) / (used + avail)), disk_used_gb: round(used / GIB, 2), disk_total_gb: round(size / GIB, 2) };
}

/** `vm_stat` on macOS: used is active + wired + compressed pages, as macos.sh counts it. */
export function parseVmStat(text: string, totalBytes: number): { mem_pct: number; mem_used_gb: number; mem_total_gb: number } | null {
  const pages = (label: string) => Number(new RegExp(`^${label}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0);
  const size = Number(/page size of (\d+)/.exec(text)?.[1]);
  const used = (pages("Pages active") + pages("Pages wired down") + pages("Pages occupied by compressor")) * size;
  if (!totalBytes || !used) return null;
  return { mem_pct: round((100 * used) / totalBytes), mem_used_gb: round(used / GIB, 2), mem_total_gb: round(totalBytes / GIB, 2) };
}

/** `df -P -k <volume>`: a header line, then the filesystem, size, used and available in KiB. */
export const parseDfPosix = (output: string) => {
  const [, size, used, avail] = (output.trim().split("\n")[1] ?? "").trim().split(/\s+/).map(Number);
  return parseDf(`${size * 1024} ${used * 1024} ${avail * 1024}`);
};

const cpuTimes = (): CpuTimes =>
  cpus().reduce((sum, { times: t }) => ({ idle: sum.idle + t.idle, total: sum.total + t.user + t.nice + t.sys + t.idle + t.irq }), { idle: 0, total: 0 });

/** macOS has no /proc: CPU from the kernel's counters, memory from vm_stat, disk of the data volume. */
async function collectDarwin(): Promise<Record<string, number>> {
  const first = cpuTimes();
  await new Promise((resolve) => setTimeout(resolve, CPU_WINDOW_MS));
  const [mem, disk] = await Promise.all([
    run("vm_stat", []).then((out) => parseVmStat(out, totalmem())).catch(() => null),
    run("df", ["-P", "-k", "/System/Volumes/Data"]).catch(() => run("df", ["-P", "-k", "/"])).then(parseDfPosix).catch(() => null),
  ]);
  const [load1, load5] = loadavg();
  return { cpu_pct: cpuPercent(first, cpuTimes()), ...mem, ...disk, load1: round(load1, 2), load5: round(load5, 2), uptime_sec: Math.floor(uptime()) };
}

const readOrNull = (file: string) => readFile(file, "utf8").catch(() => null);

/** The hottest sensible thermal zone, in degrees. */
async function hottestZone(): Promise<number | null> {
  const zones = (await readdir("/sys/class/thermal").catch(() => [])).filter((name) => name.startsWith("thermal_zone"));
  const temps = await Promise.all(zones.map(async (zone) => Number(await readOrNull(`/sys/class/thermal/${zone}/temp`)) / 1000));
  const sensible = temps.filter((t) => t > 0 && t < 125);
  return sensible.length ? Math.max(...sensible) : null;
}

/** This machine's metrics, or null where it has neither /proc nor macOS's tools. */
export async function collectLocal(): Promise<Record<string, number> | null> {
  if (process.platform === "darwin") return collectDarwin();
  const first = parseCpuStat((await readOrNull("/proc/stat")) ?? "");
  if (!first) return null;
  await new Promise((resolve) => setTimeout(resolve, CPU_WINDOW_MS));
  const second = parseCpuStat((await readOrNull("/proc/stat")) ?? "");
  const [meminfo, loadavg, uptime, df, temp] = await Promise.all([
    readOrNull("/proc/meminfo"),
    readOrNull("/proc/loadavg"),
    readOrNull("/proc/uptime"),
    run("df", ["-B1", "--output=size,used,avail", "/"]).then(parseDf).catch(() => null),
    hottestZone(),
  ]);
  const [load1, load5] = (loadavg ?? "").split(/\s+/).map(Number);
  const uptimeSec = Math.floor(Number((uptime ?? "").split(/\s+/)[0]));
  const finite = (value: number) => (Number.isFinite(value) ? value : undefined);
  const values: Record<string, number | undefined> = {
    ...(second && { cpu_pct: cpuPercent(first, second) }),
    ...(meminfo && parseMeminfo(meminfo)),
    ...df,
    load1: finite(load1),
    load5: finite(load5),
    uptime_sec: finite(uptimeSec),
    temp_c: temp === null ? undefined : round(temp),
  };
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, number] => entry[1] !== undefined));
}

/** One reading of the mini, stored. Skips quietly where there is nothing to read. */
export async function collectMini(now = Date.now()): Promise<void> {
  const values = await collectLocal();
  if (!values) return;
  recordMetrics(MINI, values, now);
  noteArrival(MINI, now);
}
