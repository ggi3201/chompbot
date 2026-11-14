import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { Server } from "http";
import jwt from "jsonwebtoken";
import { z } from "zod";
import type { TerminalClientMessage, TerminalServerMessage } from "@chomp/shared";
import { JWT_SECRET } from "../auth/config.js";
import { terminalAllowed } from "./access.js";
import { HOLDER_PROTOCOL } from "./frames.js";
import { openHolder, type HolderConnection } from "./registry.js";

const TERMINAL_PATH = "/ws/terminal";
const HEARTBEAT_MS = 30_000;
// Output the browser has not drawn yet. Past the high mark the holder's socket pauses until the browser is back under the low one.
const HIGH_WATER_BYTES = 2 * 1024 * 1024;
const LOW_WATER_BYTES = 512 * 1024;

const size = { cols: z.number().int().min(2).max(1_000), rows: z.number().int().min(1).max(500) };
const clientMessage: z.ZodType<TerminalClientMessage> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("resize"), ...size }),
  z.object({ type: z.literal("ack"), bytes: z.number().int().min(0) }),
]);
const initialSize = z.object({ cols: z.coerce.number().pipe(size.cols), rows: z.coerce.number().pipe(size.rows) });

function authorized(token: string | null): boolean {
  if (!token) return false;
  try {
    jwt.verify(token, JWT_SECRET);
    return true;
  } catch {
    return false;
  }
}

/**
 * Relays one browser to one holder: keystrokes in, output out, with the browser's acks as flow control.
 * The browser sends nothing before `attached`; until then this side is still opening the holder.
 */
export function attachTerminalWebSocket(server: Server) {
  // noServer, for the same reason as the chat socket: several WebSocketServers share this http.Server.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "", `http://${request.headers.host}`);
    if (url.pathname !== TERMINAL_PATH) return;
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  const alive = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (!alive.has(client)) {
        client.terminate();
        continue;
      }
      alive.delete(client);
      client.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  wss.on("connection", async (ws, req) => {
    const url = new URL(req.url ?? "", `http://${req.headers.host}`);
    if (!terminalAllowed(req)) return ws.close(4003, "Not from here");
    if (!authorized(url.searchParams.get("token"))) return ws.close(4001, "Invalid token");
    const requested = initialSize.safeParse({ cols: url.searchParams.get("cols"), rows: url.searchParams.get("rows") });
    const { cols, rows } = requested.success ? requested.data : { cols: 80, rows: 24 };

    alive.add(ws);
    ws.on("pong", () => alive.add(ws));
    const send = (message: TerminalServerMessage) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(message));

    let unacked = 0;
    let paused = false;
    let exited = false;
    let holder: HolderConnection;
    try {
      const opened = await openHolder(url.searchParams.get("id") ?? "", {
        onEvent: (event) => {
          if (event.type === "hello") return;
          if (event.type === "exit") exited = true;
          send(event);
        },
        onOutput: (bytes) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(bytes, { binary: true });
          unacked += bytes.length;
          if (!paused && unacked > HIGH_WATER_BYTES) {
            paused = true;
            holder.pause();
          }
        },
        // 4000 tells the browser the shell ended; any other close it retries.
        onClose: () => ws.close(exited ? 4000 : 1011, exited ? "Shell exited" : "Terminal lost"),
      });
      holder = opened.connection;
      if (opened.info.protocol !== HOLDER_PROTOCOL) {
        send({ type: "error", message: "This terminal runs on an older Chomp. Close it and open a new one." });
        holder.close();
        return ws.close(4005, "Old terminal");
      }
    } catch {
      return ws.close(4004, "No such terminal");
    }
    if (ws.readyState !== WebSocket.OPEN) return holder.close();

    holder.send({ type: "attach", cols, rows });

    ws.on("message", (data: RawData, isBinary) => {
      // binaryType "nodebuffer", the default, delivers one Buffer per message.
      const bytes = data as Buffer;
      if (isBinary) return holder.input(bytes);
      let message: TerminalClientMessage;
      try {
        message = clientMessage.parse(JSON.parse(bytes.toString()));
      } catch {
        return send({ type: "error", message: "Unreadable message." });
      }
      if (message.type === "resize") return holder.send(message);
      unacked = Math.max(0, unacked - message.bytes);
      if (paused && unacked < LOW_WATER_BYTES) {
        paused = false;
        holder.resume();
      }
    });
    ws.on("close", () => holder.close());
  });
}
