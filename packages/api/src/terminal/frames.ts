import type { TerminalInfo } from "@chomp/shared";

/**
 * The wire between Chomp and a holder, over the holder's unix socket.
 * Each frame is a kind byte, a big-endian u32 length and the payload: JSON for control, raw bytes for the terminal.
 * Bump HOLDER_PROTOCOL on any change here: holders started before a deploy keep speaking the old one.
 */
export const HOLDER_PROTOCOL = 1;

export const FrameKind = { control: 0, data: 1 } as const;
type Kind = (typeof FrameKind)[keyof typeof FrameKind];

const HEADER_BYTES = 5;

/** From Chomp to the holder. Data frames carry keystrokes. */
export type HolderRequest =
  | { type: "attach"; cols: number; rows: number }
  | { type: "resize"; cols: number; rows: number }
  | { type: "kill" };

/** From the holder to Chomp. Data frames carry output; the first one after `attached` is the screen so far. */
export type HolderEvent =
  | { type: "hello"; info: TerminalInfo }
  | { type: "attached"; info: TerminalInfo }
  | { type: "size"; cols: number; rows: number }
  | { type: "title"; title: string }
  | { type: "exit"; code: number | null; signal: number | null };

export function encodeFrame(kind: Kind, payload: Buffer | string): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload) : payload;
  const header = Buffer.alloc(HEADER_BYTES);
  header[0] = kind;
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

export const controlFrame = (message: HolderRequest | HolderEvent) => encodeFrame(FrameKind.control, JSON.stringify(message));
export const dataFrame = (bytes: Buffer | string) => encodeFrame(FrameKind.data, bytes);

/** Splits a byte stream back into frames, however the socket chunked it. */
export function frameReader(onFrame: (kind: number, payload: Buffer) => void): (chunk: Buffer) => void {
  let pending: Buffer = Buffer.alloc(0);
  return (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= HEADER_BYTES) {
      const end = HEADER_BYTES + pending.readUInt32BE(1);
      if (pending.length < end) return;
      const kind = pending[0];
      const payload = pending.subarray(HEADER_BYTES, end);
      pending = pending.subarray(end);
      onFrame(kind, payload);
    }
  };
}
