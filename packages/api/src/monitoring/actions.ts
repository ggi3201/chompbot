import { execFile } from "child_process";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { incidentEvents, incidents, incidentTargets } from "../db/schema.js";
import { getSecret } from "../lib/secrets.js";
import { getTarget } from "./store.js";
import type { Target } from "./schedule.js";

/** The only machine Chomp runs commands on. Targets on other hosts have no logs or restart here. */
const LOCAL_HOST = "mini";
/** Chomp's own unit. Restarting it from its own page would cut the request that asked. */
const CHOMP_UNIT = "chomp.service";
const LOG_LINES = 100;
const MAX_LINE_CHARS = 2_000;
const MAX_LOG_CHARS = 64 * 1024;
const LOG_TIMEOUT_MS = 15_000;
const RESTART_TIMEOUT_MS = 60_000;
// Names go to a program as arguments. A leading dash would pass for an option.
const CONTAINER_NAME = /^[A-Za-z0-9][\w.-]*$/;
const UNIT_NAME = /^[A-Za-z0-9][\w@.:-]*$/;
// CSI sequences (colours, cursor moves) and OSC sequences (titles, links).
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

/** A refusal or failure with the HTTP status the route answers with. */
export class ActionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

interface Captured { stdout: string; stderr: string }

function capture(command: string, args: string[], timeout: number): Promise<Captured> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ stdout, stderr });
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return reject(new ActionError(`${command} is not installed on this machine`, 502));
      if (err.killed) return reject(new ActionError(`${command} did not answer within ${timeout / 1000} s`, 502));
      reject(new ActionError(String(stderr).trim().split("\n")[0] || err.message, 502));
    });
  });
}

/** What runs a target on the mini: a container, or a systemd unit. */
type Runner = { kind: "container"; name: string } | { kind: "unit"; name: string };

function runnerOf(target: Pick<Target, "host" | "container" | "systemdUnit">): Runner {
  if (target.host !== LOCAL_HOST) throw new ActionError("Logs and restart only work for services on the machine Chomp runs on.", 422);
  if (target.container) {
    if (!CONTAINER_NAME.test(target.container)) throw new ActionError(`Not a usable container name: ${target.container}`, 422);
    return { kind: "container", name: target.container };
  }
  if (target.systemdUnit) {
    const name = normalizeUnit(target.systemdUnit);
    if (!UNIT_NAME.test(name)) throw new ActionError(`Not a usable unit name: ${target.systemdUnit}`, 422);
    return { kind: "unit", name };
  }
  throw new ActionError("This target has no container or systemd unit, so there is nothing to read or restart.", 422);
}

const normalizeUnit = (unit: string) => (/\.[a-z]+$/.test(unit) ? unit : `${unit}.service`);

const targetOrThrow = (key: string): Target => {
  const target = getTarget(key);
  if (!target) throw new ActionError("Target not found", 404);
  return target;
};

/** A unit the user manager knows is a user unit. A system unit shows as not found there. */
async function isUserUnit(unit: string): Promise<boolean> {
  try {
    const { stdout } = await capture("systemctl", ["--user", "show", "-p", "LoadState", "--value", unit], LOG_TIMEOUT_MS);
    return stdout.trim() === "loaded";
  } catch {
    return false;
  }
}

export const stripAnsi = (text: string) => text.replace(ANSI, "");

/** Docker prints the timestamp first, so stdout and stderr lines can be put back in order by it. */
const byTimestamp = (a: string, b: string) => a.slice(0, 30).localeCompare(b.slice(0, 30));

/** Lines cleaned for display, and cut so a runaway log cannot fill the response. Keeps the newest. */
export function tidyLines(raw: string[]): string[] {
  const lines = raw.map((line) => stripAnsi(line).replace(/\r/g, "")).filter((line) => line.trim() !== "").map((line) => line.slice(0, MAX_LINE_CHARS));
  let size = 0;
  const kept: string[] = [];
  for (const line of lines.reverse()) {
    size += line.length + 1;
    if (size > MAX_LOG_CHARS) break;
    kept.push(line);
  }
  return kept.reverse();
}

export interface LogTail { source: "docker" | "journal"; name: string; lines: string[] }

/** The last 100 log lines of the container or unit behind a target on the mini. */
export async function readLogs(key: string): Promise<LogTail> {
  const runner = runnerOf(targetOrThrow(key));
  if (runner.kind === "container") {
    const { stdout, stderr } = await capture("docker", ["logs", "--tail", String(LOG_LINES), "--timestamps", runner.name], LOG_TIMEOUT_MS);
    const lines = [...stdout.split("\n"), ...stderr.split("\n")].filter(Boolean).sort(byTimestamp).slice(-LOG_LINES);
    return { source: "docker", name: runner.name, lines: tidyLines(lines) };
  }
  const user = await isUserUnit(runner.name);
  const args = [...(user ? ["--user"] : []), "-u", runner.name, "-n", String(LOG_LINES), "--no-pager", "-o", "short-iso"];
  const { stdout } = await capture("journalctl", args, LOG_TIMEOUT_MS);
  return { source: "journal", name: runner.name, lines: tidyLines(stdout.split("\n")) };
}

/** Units that may be restarted from here, from the setting `MONITOR_RESTART_UNITS` (comma separated). */
function allowedUnits(): Set<string> {
  return new Set((getSecret("MONITOR_RESTART_UNITS") ?? "").split(",").map((unit) => unit.trim()).filter(Boolean).map(normalizeUnit));
}

/** The open incident the target is part of, if any. */
export const openIncidentOf = (targetKey: string): { id: string; title: string; startedAt: string } | undefined =>
  db.select({ id: incidents.id, title: incidents.title, startedAt: incidents.startedAt }).from(incidentTargets)
    .innerJoin(incidents, eq(incidents.id, incidentTargets.incidentId))
    .where(and(eq(incidentTargets.targetKey, targetKey), isNull(incidentTargets.upAt), eq(incidents.state, "open")))
    .get();

/** Restarts the container or unit behind a target. Returns what to tell the user; throws `ActionError` when it refuses or fails. */
export async function restartTarget(key: string, now = Date.now()): Promise<string> {
  const target = targetOrThrow(key);
  const runner = runnerOf(target);

  if (runner.kind === "container") {
    await capture("docker", ["restart", runner.name], RESTART_TIMEOUT_MS);
  } else {
    if (runner.name === CHOMP_UNIT) throw new ActionError("Chomp does not restart itself. Restart it on the machine it runs on, such as `sudo systemctl restart chomp`.", 403);
    if (!allowedUnits().has(runner.name)) {
      throw new ActionError(`${runner.name} is not in the setting MONITOR_RESTART_UNITS. Add it there to allow a restart from here.`, 403);
    }
    if (await isUserUnit(runner.name)) {
      await capture("systemctl", ["--user", "restart", runner.name], RESTART_TIMEOUT_MS);
    } else {
      try {
        await capture("sudo", ["-n", "systemctl", "restart", runner.name], RESTART_TIMEOUT_MS);
      } catch (err) {
        throw new ActionError(`${runner.name} is a system unit and needs sudo without a password: ${err instanceof Error ? err.message : "sudo failed"}`, 403);
      }
    }
  }

  const message = `Restarted ${runner.kind} ${runner.name}`;
  const incident = openIncidentOf(key);
  if (incident) db.insert(incidentEvents).values({ incidentId: incident.id, ts: new Date(now).toISOString(), kind: "note", text: `${message} from the Monitoring page` }).run();
  return message;
}
