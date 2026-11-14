// WebSocket endpoint that accepts device-bridge connections.
//
// Auth: a ?token=... query param. The phone sends its login JWT, like chat does.
// Scripts like fake-phone.ts can send the DEVICE_BRIDGE_TOKEN env var instead.
//
// We use `noServer: true` and a manual upgrade dispatcher rather than the
// `path:` option. When multiple WebSocketServers attach to the same
// http.Server via `path:`, each one registers an 'upgrade' listener that
// fires for *every* incoming upgrade — the one whose path doesn't match
// responds with HTTP 400 even though another WSS already handled it. With
// `noServer: true` we own the dispatch and only invoke handleUpgrade when
// the pathname actually matches.

import { WebSocketServer, WebSocket } from "ws";
import type { Server, IncomingMessage } from "http";
import type { Duplex } from "stream";
import { randomUUID } from "crypto";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../auth/config.js";
import { parseFromDeviceMessage, type ToDeviceMessage } from "./protocol.js";
import { deviceRegistry, wsSender, type DeviceSession } from "./registry.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
const BRIDGE_PATH = "/device-bridge";

export function isValidBridgeToken(token: string | null): boolean {
  if (!token) return false;
  if (token === process.env.DEVICE_BRIDGE_TOKEN) return true;
  try {
    jwt.verify(token, JWT_SECRET);
    return true;
  } catch {
    return false;
  }
}

export function attachDeviceBridgeWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "", `http://${request.headers.host}`);
    if (url.pathname !== BRIDGE_PATH) return; // not ours — leave the socket for other WSSes
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if ((client as WebSocket & { __alive?: boolean }).__alive === false) {
        client.terminate();
        continue;
      }
      (client as WebSocket & { __alive?: boolean }).__alive = false;
      try {
        client.ping();
      } catch {
        // ignore — terminate on next tick
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "", `http://${req.headers.host}`);
    if (!isValidBridgeToken(url.searchParams.get("token"))) {
      ws.close(4001, "Invalid token");
      return;
    }

    (ws as WebSocket & { __alive?: boolean }).__alive = true;
    ws.on("pong", () => {
      (ws as WebSocket & { __alive?: boolean }).__alive = true;
    });

    const sessionId = randomUUID();
    let session: DeviceSession | undefined;

    const sendError = (errorText: string) => {
      const payload: ToDeviceMessage = { type: "error", error: errorText };
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    };

    ws.on("message", (data) => {
      const text = data.toString();
      const parsed = parseFromDeviceMessage(text);
      if (!parsed.ok) {
        sendError(parsed.error);
        return;
      }
      const msg = parsed.message;

      if (msg.type === "hello") {
        if (session) {
          sendError("Already registered");
          return;
        }
        const send = wsSender(ws);
        session = {
          sessionId,
          deviceId: msg.deviceId,
          deviceName: msg.deviceName,
          platform: msg.platform,
          tools: msg.tools,
          connectedAt: Date.now(),
          lastSeen: Date.now(),
          send,
        };
        deviceRegistry.register(session);
        send({ type: "welcome", sessionId });
        console.log(
          `[device-bridge] device connected: ${msg.deviceName} (${msg.deviceId}, ${msg.platform}) advertising ${msg.tools.length} tool(s)`,
        );
        return;
      }

      if (!session) {
        sendError("Send hello first");
        return;
      }

      deviceRegistry.touch(session.sessionId);

      if (msg.type === "tool_result") {
        const handled = deviceRegistry.resolveCall(msg.callId, {
          ok: msg.ok,
          result: msg.result,
          error: msg.error,
        });
        if (!handled) {
          console.warn(`[device-bridge] orphan tool_result for callId=${msg.callId}`);
        }
        return;
      }

      if (msg.type === "event") {
        // Currently logged only — future: route into Chomp's event bus.
        console.log(`[device-bridge] event from ${session.deviceId}: ${msg.name}`);
        return;
      }

      // heartbeat — touch already done above.
    });

    ws.on("close", () => {
      if (session) {
        console.log(`[device-bridge] device disconnected: ${session.deviceId}`);
        deviceRegistry.unregister(session.sessionId);
      }
    });

    ws.on("error", (err) => {
      console.warn(`[device-bridge] socket error: ${err instanceof Error ? err.message : err}`);
    });
  });

  return wss;
}
