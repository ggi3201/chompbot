/**
 * Log Tailer — tails a JSONL file for real-time agent event streaming.
 *
 * Used by both agent runners (on spawn) and the reconnect module (on startup)
 * to parse JSON-line events from agent stdout log files.
 */

import { createReadStream, watch, statSync, existsSync, type FSWatcher } from "fs";

export interface TailHandle {
  /** Stop tailing and clean up watchers */
  stop: () => void;
  /** Current byte offset in the file */
  offset: number;
}

/**
 * Tail a file from a given byte offset, invoking `onLine` for each complete line.
 * Uses `fs.watch` to detect new writes. Returns a handle to stop tailing.
 */
export function tailFile(
  filePath: string,
  onLine: (line: string) => void,
  startOffset = 0,
): TailHandle {
  const handle: TailHandle = { stop: () => {}, offset: startOffset };
  let watcher: FSWatcher | null = null;
  let reading = false;
  let stopped = false;
  let lineBuf = "";

  function readNewData() {
    if (reading || stopped) return;
    if (!existsSync(filePath)) return;

    let fileSize: number;
    try {
      fileSize = statSync(filePath).size;
    } catch {
      return;
    }

    if (fileSize <= handle.offset) return;
    reading = true;

    const stream = createReadStream(filePath, {
      start: handle.offset,
      encoding: "utf-8",
    });

    stream.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      handle.offset += Buffer.byteLength(text, "utf-8");
      lineBuf += text;

      // PTY transcripts are not clean JSONL: terminal TUIs commonly redraw the
      // current line with bare carriage returns and may render the final idle
      // prompt without a newline. Treat CR as a record boundary too so callers
      // can react to prompt/status frames as they are drawn.
      const lines = lineBuf.split(/\r\n|\n|\r/);
      lineBuf = lines.pop()!; // keep incomplete trailing line

      for (const line of lines) {
        if (line.trim() && !stopped) onLine(line);
      }
    });

    stream.on("end", () => {
      reading = false;
      // Check if more data arrived while we were reading
      if (!stopped) {
        try {
          const newSize = statSync(filePath).size;
          if (newSize > handle.offset) readNewData();
        } catch { /* file gone */ }
      }
    });

    stream.on("error", () => {
      reading = false;
    });
  }

  // Start watching for changes
  try {
    watcher = watch(filePath, { persistent: false }, () => {
      readNewData();
    });
  } catch {
    // File might not exist yet — poll briefly until it does
    const poll = setInterval(() => {
      if (stopped) { clearInterval(poll); return; }
      if (existsSync(filePath)) {
        clearInterval(poll);
        try {
          watcher = watch(filePath, { persistent: false }, () => readNewData());
        } catch { /* give up */ }
        readNewData();
      }
    }, 200);
    // Don't poll forever
    setTimeout(() => clearInterval(poll), 10_000);
  }

  // Initial read
  readNewData();

  handle.stop = () => {
    stopped = true;
    watcher?.close();
    watcher = null;
  };

  return handle;
}
