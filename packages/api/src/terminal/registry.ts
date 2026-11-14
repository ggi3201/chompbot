import { spawn } from "node:child_process";
import net from "node:net";
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TerminalInfo } from "@chomp/shared";
import { DB_PATH } from "../db/index.js";
import { controlFrame, dataFrame, FrameKind, frameReader, type HolderEvent, type HolderRequest } from "./frames.js";
import type { HolderConfig } from "./holder.js";

export const TERMINAL_ID = /^[A-Za-z0-9_-]{8}$/;
// macOS refuses unix socket paths over 104 bytes, Linux over 108.
const MAX_SOCKET_PATH = 100;
const HELLO_TIMEOUT_MS = 2_000;
const START_TIMEOUT_MS = 5_000;
const START_POLL_MS = 50;

// In dev and tests this file is TypeScript, and the holder runs through tsx too.
const SELF = fileURLToPath(import.meta.url);
const FROM_SOURCE = SELF.endsWith(".ts");
const HOLDER_PATH = join(dirname(SELF), FROM_SOURCE ? "holder.ts" : "holder.js");
const PACKAGE_ROOT = join(dirname(SELF), "../..");

// The shell gets a login environment, never Chomp's own: that holds JWT_SECRET, DB_PATH and the like.
const PASSED_ENV = ["HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "SSH_AUTH_SOCK", "XDG_RUNTIME_DIR"];

/** Beside the database, so a dev Chomp and prod never see each other's terminals. Long paths move to a short one. */
export function terminalDir(): string {
  const dir = join(dirname(resolve(DB_PATH)), "terminals");
  if (join(dir, "x".repeat(8) + ".sock").length <= MAX_SOCKET_PATH) return dir;
  return join(tmpdir(), `chomp-terminals-${createHash("sha256").update(dir).digest("hex").slice(0, 12)}`);
}

const socketPath = (id: string) => join(terminalDir(), `${id}.sock`);

export interface HolderHandlers {
  onEvent?: (event: HolderEvent) => void;
  onOutput?: (bytes: Buffer) => void;
  onClose?: () => void;
}

export interface HolderConnection {
  send: (request: HolderRequest) => void;
  input: (bytes: Buffer) => void;
  pause: () => void;
  resume: () => void;
  close: () => void;
}

/** Connects to a holder and waits for its hello. Frames after the hello go straight to the handlers. */
export function openHolder(id: string, handlers: HolderHandlers = {}): Promise<{ info: TerminalInfo; connection: HolderConnection }> {
  if (!TERMINAL_ID.test(id)) return Promise.reject(new Error("No such terminal."));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath(id));
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("The terminal did not answer."));
    }, HELLO_TIMEOUT_MS);
    const connection: HolderConnection = {
      send: (request) => socket.write(controlFrame(request)),
      input: (bytes) => socket.write(dataFrame(bytes)),
      pause: () => socket.pause(),
      resume: () => socket.resume(),
      close: () => socket.end(),
    };
    let greeted = false;
    socket.on(
      "data",
      frameReader((kind, payload) => {
        if (kind === FrameKind.data) return handlers.onOutput?.(payload);
        const event = JSON.parse(payload.toString()) as HolderEvent;
        if (greeted) return handlers.onEvent?.(event);
        greeted = true;
        clearTimeout(timer);
        if (event.type === "hello") resolve({ info: event.info, connection });
      }),
    );
    socket.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    socket.on("close", () => greeted && handlers.onClose?.());
  });
}

const isGone = (e: unknown) => ["ECONNREFUSED", "ENOENT"].includes((e as NodeJS.ErrnoException).code ?? "");

async function peek(id: string): Promise<TerminalInfo | null> {
  try {
    const { info, connection } = await openHolder(id);
    connection.close();
    return info;
  } catch (e) {
    // The holder died without cleaning up: a crash or a reboot.
    if (isGone(e)) rmSync(socketPath(id), { force: true });
    return null;
  }
}

export async function listTerminals(scope?: string): Promise<TerminalInfo[]> {
  let files: string[] = [];
  try {
    files = readdirSync(terminalDir());
  } catch {
    return [];
  }
  const ids = files.filter((f) => f.endsWith(".sock")).map((f) => f.slice(0, -".sock".length));
  const found = await Promise.all(ids.map(peek));
  return found.filter((t): t is TerminalInfo => !!t && (!scope || t.scope === scope)).sort((a, b) => a.createdAt - b.createdAt);
}

function shellEnv(shell: string, id: string): Record<string, string> {
  const passed = Object.fromEntries(PASSED_ENV.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])));
  return { LANG: "C.UTF-8", ...passed, SHELL: shell, TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "Chomp", CHOMP_TERMINAL_ID: id };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Starts a shell in `cwd` under its own detached holder, and returns once the holder answers. */
export async function createTerminal(options: { scope: string; cwd: string; cols?: number; rows?: number; shell?: string }): Promise<TerminalInfo> {
  const dir = terminalDir();
  mkdirSync(dir, { recursive: true });
  // The socket gives a shell to whoever can reach it.
  chmodSync(dir, 0o700);
  const id = randomBytes(6).toString("base64url");
  const shell = options.shell ?? (userInfo().shell || process.env.SHELL || "/bin/sh");
  const config: HolderConfig = { id, scope: options.scope, cwd: options.cwd, shell, socketPath: socketPath(id), logPath: join(dir, `${id}.log`), cols: options.cols ?? 80, rows: options.rows ?? 24 };

  const log = openSync(config.logPath, "a", 0o600);
  const child = spawn(process.execPath, [...(FROM_SOURCE ? ["--import", "tsx"] : []), HOLDER_PATH, JSON.stringify(config)], {
    cwd: PACKAGE_ROOT,
    detached: true,
    stdio: ["ignore", log, log],
    env: shellEnv(shell, id),
  });
  closeSync(log);
  child.unref();
  let exited = false;
  child.once("exit", () => (exited = true));

  for (let waited = 0; waited < START_TIMEOUT_MS && !exited; waited += START_POLL_MS) {
    try {
      const { info, connection } = await openHolder(id);
      connection.close();
      return info;
    } catch {
      // Not listening yet. Never clean up here as peek does: the holder may be between bind and listen.
    }
    await sleep(START_POLL_MS);
  }
  child.kill();
  let output = "";
  try {
    output = readFileSync(config.logPath, "utf8").trim().slice(-2_000);
  } catch {
    // No log: the holder never ran.
  }
  throw new Error(`The terminal did not start.${output ? `\n${output}` : ""}`);
}

export async function killTerminal(id: string): Promise<void> {
  const { connection } = await openHolder(id);
  connection.send({ type: "kill" });
  connection.close();
}
