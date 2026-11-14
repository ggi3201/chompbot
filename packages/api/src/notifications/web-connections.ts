import { WebSocket } from "ws";

/** Active WebSocket connections mapped by some identifier */
const activeConnections = new Map<string, WebSocket>();

export function registerConnection(id: string, ws: WebSocket) {
  activeConnections.set(id, ws);
  ws.on("close", () => activeConnections.delete(id));
}

export function hasActiveWebConnection(): boolean {
  for (const ws of activeConnections.values()) {
    if (ws.readyState === WebSocket.OPEN) return true;
  }
  return false;
}

export function sendToWeb(payload: object): boolean {
  for (const ws of activeConnections.values()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return true;
    }
  }
  return false;
}
