import type { TerminalClientMessage, TerminalInfo, TerminalServerMessage } from "@chomp/shared";
import { getToken } from "../api";

/** `ended`: the shell exited. `gone`: no such terminal. `refused`: the token or the network was turned away. */
export type TerminalStatus = "connecting" | "live" | "reconnecting" | "ended" | "gone" | "refused";

export interface TerminalEvents {
  status: (status: TerminalStatus) => void;
  /** The screen is about to be sent again from scratch, at this size: clear and resize before writing. */
  attached: (info: TerminalInfo) => void;
  /** Call `drawn` once the bytes are on screen; that is what lets the host send more. */
  output: (bytes: Uint8Array, drawn: () => void) => void;
  size: (cols: number, rows: number) => void;
  title: (title: string) => void;
  exit: (code: number | null, signal: number | null) => void;
  error: (message: string) => void;
}

export interface TerminalConnection {
  input: (data: string | Uint8Array) => void;
  resize: (cols: number, rows: number) => void;
  close: () => void;
}

const RETRY_MS = [300, 1_000, 2_000, 4_000];
const ACK_EVERY_BYTES = 64 * 1024;
// A phone back from the background may hold a socket that died silently; past this, reconnect at once.
const STALE_AFTER_HIDDEN_MS = 5_000;
const FINAL_CLOSE: Record<number, TerminalStatus> = { 4000: "ended", 4001: "refused", 4003: "refused", 4004: "gone", 4005: "gone" };

const encoder = new TextEncoder();

/** One terminal's socket: reconnects on its own, and nothing goes out before the host has re-sent the screen. */
export function connectTerminal(id: string, size: () => { cols: number; rows: number }, on: TerminalEvents): TerminalConnection {
  let ws: WebSocket | null = null;
  let attached = false;
  // Closed by the caller, or by the host for good.
  let stopped = false;
  let attempt = 0;
  let drawnSinceAck = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let hiddenAt = 0;

  const ready = () => attached && ws?.readyState === WebSocket.OPEN;
  const send = (message: TerminalClientMessage) => ready() && ws!.send(JSON.stringify(message));

  const onMessage = (event: MessageEvent<ArrayBuffer | string>) => {
    if (typeof event.data !== "string") {
      const bytes = new Uint8Array(event.data);
      on.output(bytes, () => {
        drawnSinceAck += bytes.length;
        if (drawnSinceAck < ACK_EVERY_BYTES) return;
        send({ type: "ack", bytes: drawnSinceAck });
        drawnSinceAck = 0;
      });
      return;
    }
    const message = JSON.parse(event.data) as TerminalServerMessage;
    switch (message.type) {
      case "attached":
        attached = true;
        attempt = 0;
        drawnSinceAck = 0;
        on.attached(message.info);
        on.status("live");
        return;
      case "size":
        return on.size(message.cols, message.rows);
      case "title":
        return on.title(message.title);
      case "exit":
        return on.exit(message.code, message.signal);
      case "error":
        return on.error(message.message);
    }
  };

  const connect = () => {
    clearTimeout(retry);
    const { cols, rows } = size();
    const params = new URLSearchParams({ token: getToken() ?? "", id, cols: String(cols), rows: String(rows) });
    const socket = new WebSocket(`${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws/terminal?${params}`);
    socket.binaryType = "arraybuffer";
    ws = socket;
    attached = false;
    socket.onmessage = onMessage;
    socket.onclose = (event) => {
      if (ws !== socket) return;
      ws = null;
      attached = false;
      if (stopped) return;
      const final = FINAL_CLOSE[event.code];
      if (final) {
        stopped = true;
        return on.status(final);
      }
      on.status("reconnecting");
      retry = setTimeout(connect, RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]);
    };
  };

  const onVisibility = () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      return;
    }
    if (stopped || Date.now() - hiddenAt < STALE_AFTER_HIDDEN_MS) return;
    const stale = ws;
    ws = null;
    stale?.close();
    on.status("reconnecting");
    connect();
  };
  document.addEventListener("visibilitychange", onVisibility);

  on.status("connecting");
  connect();

  return {
    input: (data) => ready() && ws!.send(typeof data === "string" ? encoder.encode(data) : data),
    resize: (cols, rows) => send({ type: "resize", cols, rows }),
    close: () => {
      stopped = true;
      clearTimeout(retry);
      document.removeEventListener("visibilitychange", onVisibility);
      ws?.close();
    },
  };
}
