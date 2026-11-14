import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import jwt from "jsonwebtoken";
import { WebSocket } from "ws";
import type { TerminalServerMessage } from "@chomp/shared";
import { JWT_SECRET } from "../../src/auth/config.js";
import { createTerminal, killTerminal } from "../../src/terminal/registry.js";
import { attachTerminalWebSocket } from "../../src/terminal/socket.js";

let http: Server;
let host: string;
let terminalId: string;
const token = jwt.sign({ sub: "test" }, JWT_SECRET);

beforeAll(async () => {
  http = createServer();
  attachTerminalWebSocket(http);
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  host = `127.0.0.1:${(http.address() as { port: number }).port}`;
  terminalId = (await createTerminal({ scope: "home", cwd: tmpdir(), shell: "/bin/sh" })).id;
});

afterAll(async () => {
  await killTerminal(terminalId).catch(() => {});
  http?.close();
});

/** A browser tab on the terminal: what it was told, what it drew, and how the socket closed. */
function open(params: Record<string, string>, origin = `http://${host}`) {
  const ws = new WebSocket(`ws://${host}/ws/terminal?${new URLSearchParams(params)}`, { origin });
  const messages: TerminalServerMessage[] = [];
  let screen = "";
  const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
  ws.on("message", (data, isBinary) => {
    if (isBinary) screen += data.toString();
    else messages.push(JSON.parse(data.toString()));
  });
  const waitFor = (done: () => boolean) =>
    new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (done()) return resolve();
        if (Date.now() - started > 5_000) return reject(new Error(`Timed out. Screen so far:\n${screen}`));
        setTimeout(tick, 20);
      };
      tick();
    });
  return { ws, messages, screen: () => screen, closed, waitFor };
}

describe("the terminal socket", () => {
  test("refuses a missing token (so the tab stops retrying), a page from another site, and a terminal that does not exist", async () => {
    expect(await open({ id: terminalId }).closed).toBe(4001);
    expect(await open({ id: terminalId, token }, "https://evil.example").closed).toBe(4003);
    expect(await open({ id: "nope1234", token }).closed).toBe(4004);
  });

  test("attaches at the tab's size, relays keys and output, and follows a resize", async () => {
    const tab = open({ id: terminalId, token, cols: "90", rows: "20" });
    await tab.waitFor(() => tab.messages.some((m) => m.type === "attached"));
    expect(tab.messages.find((m) => m.type === "attached")).toMatchObject({ info: { id: terminalId, cols: 90, rows: 20 } });

    tab.ws.send(Buffer.from("echo relayed-$((6*7))\n"));
    await tab.waitFor(() => /relayed-42/.test(tab.screen()));

    tab.ws.send(JSON.stringify({ type: "resize", cols: 70, rows: 15 }));
    await tab.waitFor(() => tab.messages.some((m) => m.type === "size"));
    tab.ws.send(Buffer.from("stty size\n"));
    await tab.waitFor(() => /15 70/.test(tab.screen()));
    tab.ws.close();
  });

  test("closes with 4000 when the shell exits", async () => {
    const tab = open({ id: terminalId, token });
    await tab.waitFor(() => tab.messages.some((m) => m.type === "attached"));
    tab.ws.send(Buffer.from("exit\n"));
    expect(await tab.closed).toBe(4000);
    expect(tab.messages.some((m) => m.type === "exit")).toBe(true);
  });
});
