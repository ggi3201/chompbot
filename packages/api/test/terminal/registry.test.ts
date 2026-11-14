import { afterEach, describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HolderEvent } from "../../src/terminal/frames.js";
import { createTerminal, killTerminal, listTerminals, openHolder, terminalDir } from "../../src/terminal/registry.js";

const started: string[] = [];

afterEach(async () => {
  for (const id of started.splice(0)) await killTerminal(id).catch(() => {});
});

async function start(scope = "home") {
  const info = await createTerminal({ scope, cwd: tmpdir(), shell: "/bin/sh", cols: 80, rows: 24 });
  started.push(info.id);
  return info;
}

/** Attaches the way the browser's relay does, and keeps what it sees. */
async function attach(id: string, size = { cols: 80, rows: 24 }) {
  let output = "";
  let closed = false;
  const events: HolderEvent[] = [];
  const checks = new Set<() => void>();
  const changed = () => checks.forEach((check) => check());
  const { connection } = await openHolder(id, {
    onOutput: (bytes) => {
      output += bytes.toString();
      changed();
    },
    onEvent: (event) => {
      events.push(event);
      changed();
    },
    onClose: () => {
      closed = true;
      changed();
    },
  });
  connection.send({ type: "attach", ...size });
  const until = (done: () => boolean, what: string) =>
    new Promise<void>((resolve, reject) => {
      const check = () => {
        if (!done()) return;
        checks.delete(check);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        checks.delete(check);
        reject(new Error(`Timed out waiting for ${what}. Output so far:\n${output}`));
      }, 5_000);
      checks.add(check);
      check();
    });
  return {
    connection,
    events,
    output: () => output,
    type: (text: string) => connection.input(Buffer.from(text)),
    waitFor: (pattern: RegExp) => until(() => pattern.test(output), String(pattern)),
    waitForEvent: (type: HolderEvent["type"]) => until(() => events.some((e) => e.type === type), `a ${type} event`),
    waitForClose: () => until(() => closed, "the holder to close"),
  };
}

describe("a terminal's holder", () => {
  test("runs a shell that answers", async () => {
    const info = await start();
    const viewer = await attach(info.id);
    await viewer.waitForEvent("attached");
    viewer.type("echo hi-$((40+2))\n");
    await viewer.waitFor(/hi-42/);
    viewer.connection.close();
  });

  test("gives a later viewer the screen so far, then the live output to both", async () => {
    const info = await start();
    const first = await attach(info.id);
    first.type("echo before-$((1+1))\n");
    await first.waitFor(/before-2/);

    const second = await attach(info.id);
    await second.waitForEvent("attached");
    await second.waitFor(/before-2/);
    first.type("echo after-$((2+2))\n");
    await Promise.all([first.waitFor(/after-4/), second.waitFor(/after-4/)]);
    first.connection.close();
    second.connection.close();
  });

  test("takes its size from the latest viewer, and tells the others", async () => {
    const info = await start();
    const first = await attach(info.id);
    await first.waitForEvent("attached");
    const second = await attach(info.id, { cols: 101, rows: 31 });
    await second.waitForEvent("attached");
    await first.waitForEvent("size");
    expect(first.events.find((e) => e.type === "size")).toEqual({ type: "size", cols: 101, rows: 31 });

    second.type("stty size\n");
    await second.waitFor(/31 101/);
    first.connection.close();
    second.connection.close();
  });

  test("gives the shell a clean environment, not Chomp's", async () => {
    process.env.JWT_SECRET ??= "set-for-this-test";
    const info = await start();
    const viewer = await attach(info.id);
    viewer.type('echo "[$JWT_SECRET][$DB_PATH][$TERM][$CHOMP_TERMINAL_ID]"\n');
    await viewer.waitFor(/\[\]\[\]\[xterm-256color\]\[[\w-]{8}\]/);
    expect(viewer.output()).toContain(`[${info.id}]`);
    viewer.connection.close();
  });

  test("gives a viewer that fell behind a fresh screen instead of the whole backlog", async () => {
    const info = await start();
    const viewer = await attach(info.id);
    await viewer.waitForEvent("attached");
    viewer.connection.pause();
    viewer.type("head -c 12000000 /dev/zero | tr '\\0' x; echo; echo flood-$((5+5))\n");
    // Long enough for the shell to write it all while this viewer reads nothing.
    await new Promise((r) => setTimeout(r, 2_500));
    viewer.connection.resume();
    await viewer.waitFor(/flood-10/);
    expect(viewer.events.filter((e) => e.type === "attached").length).toBe(2);
    expect(viewer.output().length).toBeLessThan(12_000_000);
    viewer.connection.close();
  }, 20_000);

  test("is listed under its scope", async () => {
    const home = await start("home");
    const chat = await start("chat:abc");
    expect((await listTerminals("chat:abc")).map((t) => t.id)).toEqual([chat.id]);
    expect((await listTerminals()).map((t) => t.id)).toEqual(expect.arrayContaining([home.id, chat.id]));
  });

  test("ends when the shell exits, and cleans up after itself", async () => {
    const info = await start();
    const viewer = await attach(info.id);
    await viewer.waitForEvent("attached");
    viewer.type("exit 3\n");
    await viewer.waitForClose();
    expect(viewer.events.find((e) => e.type === "exit")).toMatchObject({ type: "exit", code: 3 });
    expect(existsSync(join(terminalDir(), `${info.id}.sock`))).toBe(false);
    expect(await listTerminals()).not.toContainEqual(expect.objectContaining({ id: info.id }));
  });

  test("ends when killed", async () => {
    const info = await start();
    const viewer = await attach(info.id);
    await viewer.waitForEvent("attached");
    await killTerminal(info.id);
    await viewer.waitForClose();
    expect(viewer.events.some((e) => e.type === "exit")).toBe(true);
  });
});
