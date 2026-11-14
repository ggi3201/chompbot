import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, test } from "vitest";
import { tailFile } from "../../src/agents/log-tailer.js";

const tempDirs: string[] = [];

function makeTempFile(content: string) {
  const dir = mkdtempSync(join(tmpdir(), "chomp-log-tailer-"));
  tempDirs.push(dir);
  const file = join(dir, "agent.log");
  writeFileSync(file, content);
  return file;
}

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for tailFile callback");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("tailFile", () => {
  test("emits carriage-return-delimited PTY frames without waiting for newlines", async () => {
    const file = makeTempFile("thinking\r❯ \x1b[7m \x1b[27m\r");
    const lines: string[] = [];
    const tail = tailFile(file, (line) => lines.push(line));

    try {
      await waitFor(() => lines.length >= 2);
      expect(lines).toEqual(["thinking", "❯ \x1b[7m \x1b[27m"]);
    } finally {
      tail.stop();
    }
  });

  test("keeps an unterminated trailing frame buffered", async () => {
    const file = makeTempFile("partial");
    const lines: string[] = [];
    const tail = tailFile(file, (line) => lines.push(line));

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(lines).toEqual([]);
    } finally {
      tail.stop();
    }
  });
});
