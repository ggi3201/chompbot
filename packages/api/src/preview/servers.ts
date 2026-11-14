import { spawn, type ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { existsSync, readFileSync } from "fs";
import { connect, createServer } from "net";
import { join, resolve } from "path";
import type { PreviewLogLine, PreviewServer, PreviewServerStatus } from "@chomp/shared";

export interface LaunchConfig {
  name: string;
  runtimeExecutable: string;
  runtimeArgs: string[];
  port: number;
  url?: string;
  cwd?: string;
  env: Record<string, string>;
  autoPort: boolean;
}

export const LAUNCH_FILE = join(".claude", "launch.json");
const KEPT_LOG_LINES = 1000;
const START_TIMEOUT_MS = 90_000;
const STOP_GRACE_MS = 3_000;
/** A server no preview page has shown for this long is forgotten work, and dev servers hold a lot of memory. */
export const SERVER_IDLE_MS = 15 * 60_000;
// Terminal colours and cursor moves, which dev servers print even into a pipe.
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

interface DevServer extends PreviewServer {
  dir: string;
  logs: PreviewLogLine[];
  child: ChildProcess;
  /** When a preview page last showed it, or when it started. */
  lastShown: number;
}

const servers = new Map<string, DevServer>();

/** "change" (dir) when a server starts, comes up or exits; "log" (dir, name, line) per output line. */
export const serverEvents = new EventEmitter();
serverEvents.setMaxListeners(0);

const keyOf = (dir: string, name: string) => `${dir}\0${name}`;

function fail(message: string): never {
  throw new Error(`${LAUNCH_FILE}: ${message}`);
}

function parseConfig(raw: unknown, index: number): LaunchConfig {
  const c = (raw ?? {}) as Record<string, unknown>;
  const at = `configurations[${index}]`;
  if (typeof c.name !== "string" || !c.name) fail(`${at} needs a "name"`);
  if (typeof c.runtimeExecutable !== "string" || !c.runtimeExecutable) fail(`${at} needs a "runtimeExecutable", such as "pnpm"`);
  if (!Number.isInteger(c.port) || (c.port as number) < 1 || (c.port as number) > 65_535) fail(`${at} needs a "port" from 1 to 65535`);
  if (c.runtimeArgs !== undefined && !(Array.isArray(c.runtimeArgs) && c.runtimeArgs.every((a) => typeof a === "string"))) fail(`${at}.runtimeArgs must be a list of strings`);
  if (c.env !== undefined && !(typeof c.env === "object" && c.env && Object.values(c.env).every((v) => typeof v === "string"))) fail(`${at}.env must map names to strings`);
  if (c.url !== undefined && typeof c.url !== "string") fail(`${at}.url must be a string`);
  if (c.cwd !== undefined && typeof c.cwd !== "string") fail(`${at}.cwd must be a string`);
  return {
    name: c.name,
    runtimeExecutable: c.runtimeExecutable,
    runtimeArgs: (c.runtimeArgs as string[] | undefined) ?? [],
    port: c.port as number,
    url: c.url as string | undefined,
    cwd: c.cwd as string | undefined,
    env: (c.env as Record<string, string> | undefined) ?? {},
    autoPort: c.autoPort === true,
  };
}

/** A project's dev servers, in the format Claude Code's desktop app reads, so one file serves both. */
export function readLaunchConfigs(dir: string): LaunchConfig[] {
  const path = join(dir, LAUNCH_FILE);
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    fail(`not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  const list = (parsed as { configurations?: unknown } | null)?.configurations;
  if (!Array.isArray(list)) fail(`needs a "configurations" list`);
  return list.map(parseConfig);
}

export function isListening(port: number): Promise<boolean> {
  return new Promise((done) => {
    // "localhost" with family auto-selection tries IPv4 and IPv6, as Vite binds either.
    const socket = connect({ port, host: "localhost", autoSelectFamily: true });
    const finish = (up: boolean) => {
      socket.destroy();
      done(up);
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function freePort(): Promise<number> {
  return new Promise((done, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => done(port));
    });
  });
}

function serverEnv(config: LaunchConfig, port: number): Record<string, string | undefined> {
  // Chomp's own port and database must not leak in: a Chomp checkout started here would open prod's DB.
  const { PORT: _port, DB_PATH: _db, CHOMP_ALLOW_PROD_DB: _allow, ...base } = process.env;
  return { ...base, ...config.env, PORT: String(port) };
}

function setStatus(server: DevServer, status: PreviewServerStatus, exitCode: number | null = null) {
  server.status = status;
  server.exitCode = exitCode;
  serverEvents.emit("change", server.dir);
}

function capture(server: DevServer, stream: "out" | "err", source: NodeJS.ReadableStream) {
  let partial = "";
  source.setEncoding("utf8");
  source.on("data", (chunk: string) => {
    const lines = (partial + chunk).split(/\r?\n/);
    partial = lines.pop() ?? "";
    for (const text of lines) {
      const line = { at: Date.now(), stream, text: text.replace(ANSI, "") };
      server.logs.push(line);
      serverEvents.emit("log", server.dir, server.name, line);
    }
    if (server.logs.length > KEPT_LOG_LINES) server.logs.splice(0, server.logs.length - KEPT_LOG_LINES);
  });
}

const tail = (server: DevServer, count = 20) => server.logs.slice(-count).map((l) => l.text).join("\n");

async function waitUntilUp(server: DevServer): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.status === "exited") throw new Error(`"${server.name}" exited with code ${server.exitCode} before it opened port ${server.port}. Last output:\n${tail(server)}`);
    if (await isListening(server.port)) {
      if (server.status === "starting") setStatus(server, "running");
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`"${server.name}" did not open port ${server.port} within ${START_TIMEOUT_MS / 1000}s. Last output:\n${tail(server)}`);
}

/** Starts a launch config, or returns it if it already runs, once its port answers. */
export async function startServer(dir: string, name: string): Promise<PreviewServer> {
  const config = readLaunchConfigs(dir).find((c) => c.name === name);
  if (!config) throw new Error(`No configuration named "${name}" in ${join(dir, LAUNCH_FILE)}.`);
  const running = servers.get(keyOf(dir, name));
  if (running && running.status !== "exited") {
    running.lastShown = Date.now();
    await waitUntilUp(running);
    return serverView(running);
  }

  let port = config.port;
  if (await isListening(port)) {
    if (!config.autoPort) {
      const holder = [...servers.values()].find((s) => s.port === port && s.status !== "exited");
      const by = holder ? ` by "${holder.name}" in ${holder.dir}` : "";
      throw new Error(`Port ${port} is already in use${by}. Show that server with preview_start's url, stop it, or set "autoPort": true to take a free port, passed as PORT.`);
    }
    port = await freePort();
  }

  const child = spawn(config.runtimeExecutable, config.runtimeArgs, {
    cwd: resolve(dir, config.cwd ?? "."),
    env: serverEnv(config, port),
    // Its own process group, so stopping it also stops what `pnpm dev` and the like spawn.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = config.url ? config.url.replace(`:${config.port}`, `:${port}`) : `http://localhost:${port}/`;
  const server: DevServer = { name, port, url, status: "starting", exitCode: null, dir, logs: [], child, lastShown: Date.now() };
  servers.set(keyOf(dir, name), server);
  capture(server, "out", child.stdout!);
  capture(server, "err", child.stderr!);
  child.once("error", (e) => {
    server.logs.push({ at: Date.now(), stream: "err", text: e.message });
    setStatus(server, "exited", -1);
  });
  child.once("exit", (code, signal) => {
    if (server.status !== "exited") setStatus(server, "exited", code ?? (signal ? 128 : -1));
  });
  serverEvents.emit("change", dir);

  await waitUntilUp(server);
  return serverView(server);
}

function killGroup(server: DevServer, signal: NodeJS.Signals) {
  try {
    process.kill(-server.child.pid!, signal);
  } catch {
    // Already gone.
  }
}

export async function stopServer(dir: string, name: string): Promise<void> {
  const server = servers.get(keyOf(dir, name));
  if (!server || server.status === "exited") throw new Error(`"${name}" is not running.`);
  const exited = new Promise((r) => server.child.once("exit", r));
  killGroup(server, "SIGTERM");
  const forced = setTimeout(() => killGroup(server, "SIGKILL"), STOP_GRACE_MS);
  await exited;
  clearTimeout(forced);
}

const serverView = ({ name, port, url, status, exitCode }: DevServer): PreviewServer => ({ name, port, url, status, exitCode });

export function listServers(dir: string): PreviewServer[] {
  return [...servers.values()].filter((s) => s.dir === dir).map(serverView);
}

export function serverLogs(dir: string, name: string): PreviewLogLine[] {
  const server = servers.get(keyOf(dir, name));
  if (!server) throw new Error(`No server named "${name}" has run in this chat's project.`);
  return server.logs;
}

/** Stops every server whose port no open preview page has shown for SERVER_IDLE_MS, and says so in its output. */
export function stopUnshownServers(shownPorts: Set<number>, now = Date.now()) {
  for (const server of servers.values()) {
    if (server.status === "exited") continue;
    if (shownPorts.has(server.port)) {
      server.lastShown = now;
      continue;
    }
    if (now - server.lastShown < SERVER_IDLE_MS) continue;
    const line = { at: now, stream: "out" as const, text: `Chomp stopped this server: no preview page showed it for ${SERVER_IDLE_MS / 60_000} minutes.` };
    server.logs.push(line);
    serverEvents.emit("log", server.dir, server.name, line);
    void stopServer(server.dir, server.name).catch(() => {});
  }
}

/** Dev servers live in their own process groups, so they would outlive Chomp without this. */
export function stopAllServers() {
  for (const server of servers.values()) if (server.status !== "exited") killGroup(server, "SIGTERM");
}
process.once("exit", stopAllServers);
