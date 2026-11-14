/**
 * One terminal's keeper: a detached process that owns the shell's PTY and outlives Chomp.
 * registry.ts starts it; Chomp connects over its unix socket, as many times at once as there are viewers.
 * A headless xterm mirrors the screen, so each new connection gets the exact screen, scrollback and modes,
 * then the live output. It never logs what goes through it.
 */
import net from "node:net";
import { rmSync } from "node:fs";
import { spawn } from "node-pty";
import headless from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import type { TerminalInfo } from "@chomp/shared";
import { controlFrame, dataFrame, FrameKind, frameReader, HOLDER_PROTOCOL, type HolderEvent, type HolderRequest } from "./frames.js";

export interface HolderConfig {
  id: string;
  scope: string;
  cwd: string;
  shell: string;
  socketPath: string;
  logPath: string;
  cols: number;
  rows: number;
}

const SCROLLBACK_LINES = 10_000;
// A viewer this far behind stops getting output, and gets a fresh screen once its socket drains.
const MAX_BEHIND_BYTES = 4 * 1024 * 1024;
const KILL_GRACE_MS = 3_000;

const config = JSON.parse(process.argv[2]) as HolderConfig;
const createdAt = Date.now();

const shell = spawn(config.shell, ["-l"], {
  name: "xterm-256color",
  cols: config.cols,
  rows: config.rows,
  cwd: config.cwd,
  env: process.env as Record<string, string>,
});
const screen = new headless.Terminal({ cols: config.cols, rows: config.rows, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
const serializer = new SerializeAddon();
screen.loadAddon(serializer);

let title = "";
const info = (): TerminalInfo => ({
  id: config.id,
  scope: config.scope,
  cwd: config.cwd,
  shell: config.shell,
  title,
  cols: screen.cols,
  rows: screen.rows,
  createdAt,
  protocol: HOLDER_PROTOCOL,
});

interface Viewer {
  socket: net.Socket;
  /** `catching-up` waits for the mirror to parse what came before it attached; output meanwhile is queued. */
  state: "connected" | "catching-up" | "live" | "behind";
  queued: string[];
}
const viewers = new Set<Viewer>();

function write(viewer: Viewer, frame: Buffer) {
  viewer.socket.write(frame);
  if (viewer.state === "live" && viewer.socket.writableLength > MAX_BEHIND_BYTES) viewer.state = "behind";
}

function broadcast(event: HolderEvent) {
  for (const viewer of viewers) if (viewer.state === "live" || viewer.state === "behind") write(viewer, controlFrame(event));
}

/** The mirror parses asynchronously; the empty write's callback runs once everything before it is on screen. */
function attach(viewer: Viewer) {
  viewer.state = "catching-up";
  viewer.queued = [];
  screen.write("", () => {
    if (!viewers.has(viewer)) return;
    viewer.socket.write(controlFrame({ type: "attached", info: info() }));
    viewer.socket.write(dataFrame(serializer.serialize({ scrollback: SCROLLBACK_LINES })));
    for (const output of viewer.queued) viewer.socket.write(dataFrame(output));
    viewer.queued = [];
    viewer.state = "live";
  });
}

/** The latest viewer to attach or resize sets the size, as in tmux's `window-size latest`. */
function resize(cols: number, rows: number) {
  if (cols === screen.cols && rows === screen.rows) return;
  shell.resize(cols, rows);
  screen.resize(cols, rows);
  broadcast({ type: "size", cols, rows });
}

function handle(viewer: Viewer, request: HolderRequest) {
  switch (request.type) {
    case "attach":
      resize(request.cols, request.rows);
      return attach(viewer);
    case "resize":
      return resize(request.cols, request.rows);
    case "kill":
      shell.kill();
      setTimeout(() => shell.kill("SIGKILL"), KILL_GRACE_MS).unref();
  }
}

shell.onData((output) => {
  screen.write(output);
  for (const viewer of viewers) {
    if (viewer.state === "catching-up") viewer.queued.push(output);
    if (viewer.state === "live") write(viewer, dataFrame(output));
  }
});

screen.onTitleChange((next) => {
  title = next;
  broadcast({ type: "title", title });
});

const server = net.createServer((socket) => {
  const viewer: Viewer = { socket, state: "connected", queued: [] };
  viewers.add(viewer);
  socket.write(controlFrame({ type: "hello", info: info() }));
  socket.on(
    "data",
    frameReader((kind, payload) => {
      if (kind === FrameKind.data) return shell.write(payload);
      handle(viewer, JSON.parse(payload.toString()) as HolderRequest);
    }),
  );
  socket.on("drain", () => viewer.state === "behind" && attach(viewer));
  socket.on("close", () => viewers.delete(viewer));
  // A viewer that vanished mid-write; its close event follows.
  socket.on("error", () => {});
});

shell.onExit(({ exitCode, signal }) => {
  server.close();
  rmSync(config.socketPath, { force: true });
  rmSync(config.logPath, { force: true });
  const exit = controlFrame({ type: "exit", code: exitCode, signal: signal ?? null });
  for (const viewer of viewers) viewer.socket.end(exit);
  // Lets the last frames flush to slow viewers, but never hangs on one that stopped reading.
  setTimeout(() => process.exit(0), 2_000).unref();
});

rmSync(config.socketPath, { force: true });
server.listen(config.socketPath);
