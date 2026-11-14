import { execFile } from "child_process";
import net from "net";
import { promisify } from "util";
import { run, Unavailable } from "./exec.js";
import { isWildcard } from "./exposure.js";
import { hostAddress, isFresh, latestReport } from "./hosts.js";
import { HOST_FRESH_MS, pushDeadline, type Target } from "./schedule.js";

export interface CheckResult {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  error: string | null;
}

const HTTP_TIMEOUT_MS = 8_000;
const TCP_TIMEOUT_MS = 3_000;
const PING_TIMEOUT_MS = 5_000;

const fail = (error: string, latencyMs: number | null = null, statusCode: number | null = null): CheckResult =>
  ({ ok: false, statusCode, latencyMs, error });
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Up when the server answers below 500, or with the status the target expects (a 503 from a service that should say 503). */
export async function checkHttp(url: string, expectedStatus: number | null): Promise<CheckResult> {
  const start = Date.now();
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    void res.body?.cancel();
    const latencyMs = Date.now() - start;
    if (res.status < 500 || res.status === expectedStatus) return { ok: true, statusCode: res.status, latencyMs, error: null };
    return fail(`HTTP ${res.status}`, latencyMs, res.status);
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return fail(timedOut ? `No answer in ${HTTP_TIMEOUT_MS / 1000} s` : errorText((err as { cause?: unknown }).cause ?? err));
  }
}

export function checkTcp(host: string, port: number): Promise<CheckResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: TCP_TIMEOUT_MS });
    const done = (result: CheckResult) => { socket.destroy(); resolve(result); };
    socket.once("connect", () => done({ ok: true, statusCode: null, latencyMs: Date.now() - start, error: null }));
    socket.once("timeout", () => done(fail(`No answer in ${TCP_TIMEOUT_MS / 1000} s`)));
    socket.once("error", (err) => done(fail(err.message)));
  });
}

/**
 * A URL that names the target's own container (http://app-1/) only resolves on Docker's networks.
 * The host reaches that container by its address, so the request goes there.
 * fetch does not let a request choose its Host header, so the container sees its address as the host name.
 */
export function viaContainerAddress(target: Pick<Target, "url" | "container" | "containerInfo">): string | null {
  if (!target.url || !target.container || !target.containerInfo?.ip) return null;
  const url = new URL(target.url);
  if (url.hostname !== target.container) return null;
  url.hostname = target.containerInfo.ip;
  return url.toString();
}

/** Where this machine reaches a port that is bound on the target's host: the address the host's reports come from, else its name. */
const tcpAddress = (host: string, bindAddress: string | null) => {
  if (bindAddress && !isWildcard(bindAddress)) return bindAddress;
  return host === "mini" ? "127.0.0.1" : hostAddress(host) ?? host;
};

/** Up while the container runs and, if it has a health check, passes it. */
export async function checkContainer(name: string): Promise<CheckResult> {
  const start = Date.now();
  try {
    const [state, health] = (await run("docker", ["inspect", "--format", "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}", name], 5_000)).trim().split(" ");
    const latencyMs = Date.now() - start;
    if (state !== "running") return fail(`Container is ${state}`, latencyMs);
    if (health && health !== "healthy") return fail(`Container is ${health}`, latencyMs);
    return { ok: true, statusCode: null, latencyMs, error: null };
  } catch (err) {
    return fail(err instanceof Unavailable ? err.message : errorText(err));
  }
}

/** A container on another host is as the host's latest report says. The mini cannot ask that host's Docker. */
export function checkReportedContainer(host: string, name: string, now: number): CheckResult {
  const report = latestReport(host);
  if (!report || !isFresh(report.at, now)) return fail(`No report from ${host}`);
  const container = report.containers.find((c) => c.name === name);
  if (!container) return fail("Container is gone");
  if (container.state !== "running") return fail(`Container is ${container.state}`);
  if (container.health && container.health !== "healthy") return fail(`Container is ${container.health}`);
  return { ok: true, statusCode: null, latencyMs: null, error: null };
}

/** A host is up while it keeps reporting. */
export function checkHost(target: Pick<Target, "lastPushAt">, now: number): CheckResult {
  if (target.lastPushAt === null) return fail("Never reported");
  return now - target.lastPushAt > HOST_FRESH_MS ? fail(`No report in ${HOST_FRESH_MS / 60_000} minutes`) : { ok: true, statusCode: null, latencyMs: null, error: null };
}

// macOS counts -W in milliseconds, Linux in seconds.
const PING_WAIT = process.platform === "darwin" ? "2000" : "2";
const SAFE_HOST = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export async function checkPing(host: string): Promise<CheckResult> {
  if (!SAFE_HOST.test(host)) return fail("Invalid host");
  try {
    const { stdout } = await promisify(execFile)("ping", ["-c", "1", "-W", PING_WAIT, host], { timeout: PING_TIMEOUT_MS });
    const latency = /time[=<]([\d.]+)/.exec(stdout)?.[1];
    return { ok: true, statusCode: null, latencyMs: latency ? Math.round(Number(latency)) : null, error: null };
  } catch {
    return fail("No ping reply");
  }
}

/** A job is up while its last push said up and the next one is not yet overdue. */
export function checkPush(target: Target, now: number): CheckResult {
  if (target.lastPushOk === false) return fail(target.lastPushMsg ?? "Job reported down");
  if (now > pushDeadline(target)) {
    return fail(target.lastPushAt ? "No push in time" : "Never pushed");
  }
  return { ok: true, statusCode: null, latencyMs: null, error: null };
}

export async function runCheck(target: Target, now = Date.now()): Promise<CheckResult> {
  switch (target.kind) {
    case "http": {
      if (!target.url) return fail("No URL");
      return checkHttp(viaContainerAddress(target) ?? target.url, target.expectedStatus);
    }
    case "tcp":
      return target.host && target.port ? checkTcp(tcpAddress(target.host, target.bindAddress), target.port) : fail("No host or port");
    case "container": {
      if (!target.container) return fail("No container");
      return target.host && target.host !== "mini" ? checkReportedContainer(target.host, target.container, now) : checkContainer(target.container);
    }
    case "ping":
      return target.host ? checkPing(target.host) : fail("No host");
    case "push":
      return checkPush(target, now);
    case "host":
      return checkHost(target, now);
  }
}
