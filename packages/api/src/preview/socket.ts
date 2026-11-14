import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { PreviewClientMessage, PreviewLogLine, PreviewLogSource, PreviewServerMessage } from "@chomp/shared";
import { JWT_SECRET } from "../auth/config.js";
import { db } from "../db/index.js";
import { conversations } from "../db/schema.js";
import { serverEvents, serverLogs, stopServer } from "./servers.js";
import { addViewer, getSession, openSession, previewEvents, removeViewer, setPane, type ConsoleEntry, type Viewer } from "./session.js";
import { previewDir, previewState, startPreview } from "./state.js";
import { exposeOnTailnet } from "./expose.js";

const PREVIEW_PATH = "/ws/preview";
const HEARTBEAT_MS = 30_000;
// A frame behind this much unsent data is dropped, so a slow phone sees fewer frames instead of old ones.
const MAX_BUFFERED_BYTES = 1_000_000;
const STATE_COALESCE_MS = 50;

const coord = z.number().finite();
const clientMessage: z.ZodType<PreviewClientMessage> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pane"), width: z.number().min(1).max(8000), height: z.number().min(1).max(8000), dpr: z.number().min(0.5).max(4), dark: z.boolean() }),
  z.object({
    type: z.literal("mouse"),
    event: z.enum(["down", "up", "move"]),
    x: coord,
    y: coord,
    button: z.enum(["left", "middle", "right", "none"]),
    clickCount: z.number().int().min(0).max(3),
    modifiers: z.number().int().min(0).max(15),
  }),
  z.object({ type: z.literal("wheel"), x: coord, y: coord, dx: coord, dy: coord }),
  z.object({ type: z.literal("press"), key: z.string().min(1).max(64) }),
  z.object({ type: z.literal("text"), text: z.string().min(1).max(10_000) }),
  z.object({ type: z.literal("navigate"), url: z.string().min(1).max(4096) }),
  z.object({ type: z.literal("history"), action: z.enum(["back", "forward", "reload"]) }),
  z.object({ type: z.literal("preset"), preset: z.enum(["desktop", "tablet", "mobile"]) }),
  z.object({ type: z.literal("start"), name: z.string().min(1) }),
  z.object({ type: z.literal("stop"), name: z.string().min(1) }),
  z.object({
    type: z.literal("logs"),
    source: z.discriminatedUnion("kind", [z.object({ kind: z.literal("console") }), z.object({ kind: z.literal("server"), name: z.string().min(1) })]).nullable(),
  }),
  z.object({ type: z.literal("expose") }),
  z.object({ type: z.literal("inspect"), id: z.number().int(), x: coord, y: coord, crop: z.boolean() }),
]);

function authorized(token: string | null): boolean {
  if (!token) return false;
  try {
    jwt.verify(token, JWT_SECRET);
    return true;
  } catch {
    return false;
  }
}

/** A typed address bar entry without a scheme is a local port or a host, as in a browser. */
function toUrl(typed: string): string {
  const text = typed.trim();
  if (/^\d+(\/.*)?$/.test(text)) return `http://localhost:${text}`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  return `${/^(localhost|127\.|\[::1\])/.test(text) ? "http" : "https"}://${text}`;
}

/** A console message as a line of output: errors and warnings as the error stream, the level in front unless it is a plain log. */
function consoleLine(entry: ConsoleEntry): PreviewLogLine {
  const isError = entry.level === "error" || entry.level === "warning";
  return { at: entry.at, stream: isError ? "err" : "out", text: entry.level === "log" ? entry.text : `[${entry.level}] ${entry.text}` };
}

async function handle(message: PreviewClientMessage, conversationId: string, viewer: Viewer, follow: (source: PreviewLogSource | null) => void) {
  switch (message.type) {
    case "pane":
      return setPane(viewer, { width: message.width, height: message.height, dpr: message.dpr, dark: message.dark });
    case "mouse":
    case "wheel":
    case "press":
    case "text":
      return getSession(conversationId)?.input(message);
    case "navigate":
      return (await openSession(conversationId)).goto(toUrl(message.url));
    case "history":
      return getSession(conversationId)?.history(message.action);
    case "preset":
      return getSession(conversationId)?.resize({ preset: message.preset });
    case "start":
      follow({ kind: "server", name: message.name });
      await startPreview(conversationId, { name: message.name });
      return;
    case "stop":
      return stopServer(previewDir(conversationId), message.name);
    case "logs":
      return follow(message.source);
    case "inspect": {
      const session = getSession(conversationId);
      viewer.send({ type: "inspected", id: message.id, element: session ? await session.inspect(message.x, message.y, message.crop) : null });
      return;
    }
    case "expose": {
      const page = await getSession(conversationId)?.state();
      if (!page) throw new Error("No page is open.");
      viewer.send({ type: "exposed", url: await exposeOnTailnet(page.url) });
      return;
    }
  }
}

export function attachPreviewWebSocket(server: Server) {
  // noServer, for the same reason as the chat socket: several WebSocketServers share this http.Server.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "", `http://${request.headers.host}`);
    if (url.pathname !== PREVIEW_PATH) return;
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

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "", `http://${req.headers.host}`);
    const conversationId = url.searchParams.get("conversationId") ?? "";
    if (!authorized(url.searchParams.get("token"))) return ws.close(4001, "Invalid token");
    if (!db.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, conversationId)).get()) return ws.close(4004, "No such chat");

    alive.add(ws);
    ws.on("pong", () => alive.add(ws));

    const send = (message: PreviewServerMessage) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(message));
    const viewer: Viewer = {
      conversationId,
      pane: null,
      send,
      sendFrame: (frame) => ws.readyState === WebSocket.OPEN && ws.bufferedAmount < MAX_BUFFERED_BYTES && ws.send(frame),
    };

    // Page events come in bursts (a load fires several), so one state message covers each burst.
    let stateTimer: NodeJS.Timeout | null = null;
    const pushState = () => {
      stateTimer ??= setTimeout(() => {
        stateTimer = null;
        void previewState(conversationId).then((state) => send({ type: "state", state })).catch(() => {});
      }, STATE_COALESCE_MS);
    };
    let following: PreviewLogSource | null = null;
    const pastLines = (source: PreviewLogSource): PreviewLogLine[] => {
      if (source.kind === "console") return (getSession(conversationId)?.console ?? []).map(consoleLine);
      try {
        return serverLogs(previewDir(conversationId), source.name);
      } catch {
        // Not started yet; its lines arrive live once it is.
        return [];
      }
    };
    const follow = (source: PreviewLogSource | null) => {
      following = source;
      if (source) send({ type: "logs", source, lines: pastLines(source).slice(-300), reset: true });
    };

    const onPreview = (id: string) => id === conversationId && pushState();
    const onServerChange = (dir: string) => dir === previewDir(conversationId) && pushState();
    const onLog = (dir: string, name: string, line: PreviewLogLine) => {
      if (following?.kind === "server" && following.name === name && dir === previewDir(conversationId)) send({ type: "logs", source: following, lines: [line], reset: false });
    };
    const onConsole = (id: string, entry: ConsoleEntry) => {
      if (following?.kind === "console" && id === conversationId) send({ type: "logs", source: following, lines: [consoleLine(entry)], reset: false });
    };
    previewEvents.on("state", onPreview);
    previewEvents.on("console", onConsole);
    serverEvents.on("change", onServerChange);
    serverEvents.on("log", onLog);

    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let parsed: PreviewClientMessage;
      try {
        parsed = clientMessage.parse(JSON.parse(data.toString()));
      } catch {
        return send({ type: "error", message: "Unreadable message." });
      }
      handle(parsed, conversationId, viewer, follow).catch((e) => send({ type: "error", message: e instanceof Error ? e.message : String(e) }));
    });

    ws.on("close", () => {
      previewEvents.off("state", onPreview);
      previewEvents.off("console", onConsole);
      serverEvents.off("change", onServerChange);
      serverEvents.off("log", onLog);
      if (stateTimer) clearTimeout(stateTimer);
      void removeViewer(viewer).catch(() => {});
    });

    void addViewer(viewer).catch(() => {});
    pushState();
  });
}
