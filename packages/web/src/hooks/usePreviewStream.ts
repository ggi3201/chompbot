import { useCallback, useEffect, useRef, useState } from "react";
import type { PreviewClientMessage, PreviewElement, PreviewLogLine, PreviewLogSource, PreviewServerMessage, PreviewState } from "@chomp/shared";
import { getToken } from "../lib/api";

export interface PreviewFrame {
  /** The page's CSS size, which pointer positions map onto. */
  width: number;
  height: number;
  jpeg: Blob;
}

export interface AgentMark {
  id: number;
  action: string;
  x: number | null;
  y: number | null;
}

export const sameSource = (a: PreviewLogSource | null, b: PreviewLogSource | null) =>
  !!a && !!b && a.kind === b.kind && (a.kind === "console" || a.name === (b as { name: string }).name);

const RETRY_MS = 1_500;
const KEPT_LOG_LINES = 1_000;
// The server refused the token or the chat; trying again cannot help.
const FINAL_CLOSE_CODES = new Set([4001, 4004]);

/**
 * The chat's preview page on the host: its state, its frames and the agent's actions, while the pane is open.
 * Frames go to one listener instead of state, so thirty a second never re-render the pane.
 */
export function usePreviewStream(conversationId: string | undefined) {
  const [stored, setStored] = useState<{ conversationId: string; state: PreviewState } | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentMark, setAgentMark] = useState<AgentMark | null>(null);
  const [logs, setLogs] = useState<{ source: PreviewLogSource; lines: PreviewLogLine[] } | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const frameListener = useRef<((frame: PreviewFrame) => void) | null>(null);
  // Resent on every reconnect, so the host keeps the pane's size.
  const lastPane = useRef<PreviewClientMessage | null>(null);
  // Opened during the click, as a popup blocker allows, and pointed at the page once the host has exposed it.
  const pendingTab = useRef<Window | null>(null);
  // Answers to inspect requests, by request id. A lost socket answers all of them with nothing.
  const inspecting = useRef(new Map<number, (element: PreviewElement | null) => void>());
  const nextInspect = useRef(1);

  useEffect(() => {
    if (!conversationId) return;
    let ws: WebSocket;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closing = false;
    let marks = 0;

    const onMessage = (event: MessageEvent<ArrayBuffer | string>) => {
      if (typeof event.data !== "string") {
        const view = new DataView(event.data);
        frameListener.current?.({ width: view.getUint16(0), height: view.getUint16(2), jpeg: new Blob([event.data.slice(4)], { type: "image/jpeg" }) });
        return;
      }
      const message = JSON.parse(event.data) as PreviewServerMessage;
      if (message.type === "state") setStored({ conversationId, state: message.state });
      if (message.type === "agent") setAgentMark({ id: ++marks, action: message.action, x: message.x, y: message.y });
      if (message.type === "error") {
        setError(message.message);
        pendingTab.current?.close();
        pendingTab.current = null;
      }
      if (message.type === "logs") {
        setLogs((current) => ({
          source: message.source,
          lines: (message.reset || !current || !sameSource(current.source, message.source) ? message.lines : [...current.lines, ...message.lines]).slice(-KEPT_LOG_LINES),
        }));
      }
      if (message.type === "inspected") {
        inspecting.current.get(message.id)?.(message.element);
        inspecting.current.delete(message.id);
      }
      if (message.type === "exposed") {
        if (pendingTab.current) pendingTab.current.location.href = message.url;
        pendingTab.current = null;
      }
    };

    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const params = new URLSearchParams({ token: getToken() ?? "", conversationId });
      ws = new WebSocket(`${protocol}//${window.location.host}/ws/preview?${params}`);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        socket.current = ws;
        setConnected(true);
        if (lastPane.current) ws.send(JSON.stringify(lastPane.current));
      };
      ws.onmessage = onMessage;
      ws.onclose = (event) => {
        if (socket.current === ws) socket.current = null;
        for (const answer of inspecting.current.values()) answer(null);
        inspecting.current.clear();
        setConnected(false);
        if (!closing && !FINAL_CLOSE_CODES.has(event.code)) retry = setTimeout(connect, RETRY_MS);
      };
    };
    connect();

    return () => {
      closing = true;
      clearTimeout(retry);
      ws.close();
    };
  }, [conversationId]);

  const send = useCallback((message: PreviewClientMessage) => {
    if (message.type === "pane") lastPane.current = message;
    // Input is too frequent to clear an error on; anything the user asks for is a fresh try.
    if (!["pane", "mouse", "wheel", "press", "text"].includes(message.type)) setError(null);
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
  }, []);

  const onFrame = useCallback((listener: ((frame: PreviewFrame) => void) | null) => {
    frameListener.current = listener;
  }, []);

  /** The element at a point of the page, found by the host; crop adds a picture of it. */
  const inspect = useCallback((x: number, y: number, crop: boolean) => {
    if (socket.current?.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    const id = nextInspect.current++;
    return new Promise<PreviewElement | null>((resolve) => {
      inspecting.current.set(id, resolve);
      send({ type: "inspect", id, x, y, crop });
    });
  }, [send]);

  const openInNewTab = useCallback(() => {
    pendingTab.current = window.open("", "_blank");
    send({ type: "expose" });
  }, [send]);

  return {
    state: stored && stored.conversationId === conversationId ? stored.state : null,
    connected,
    error,
    dismissError: () => setError(null),
    agentMark,
    logs,
    send,
    onFrame,
    inspect,
    openInNewTab,
  };
}
