import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer, type Server } from "http";
import type { CDPSession } from "playwright-core";
import { MAX_SESSIONS, addViewer, chromeExecutable, closedPage, getSession, openSession, removeViewer, type PreviewSession, type Viewer } from "../../src/preview/session.js";

const PAGE = `<!doctype html><meta name="viewport" content="width=device-width"><title>Counter</title>
<h1>Count <span id="n">0</span></h1>
<button onclick="n.textContent = +n.textContent + 1">Add</button>
<input aria-label="Name" oninput="console.log('typed ' + this.value)">
<button onclick="fetch('/missing'); console.error('boom')">Break</button>`;

// The CI container has no Chromium; the dev machine and the server do.
describe.skipIf(!chromeExecutable())("a chat's preview page", () => {
  let http: Server;
  let base: string;
  let session: PreviewSession;

  beforeAll(async () => {
    http = createServer((req, res) => {
      res.writeHead(req.url === "/" ? 200 : 404, { "content-type": "text/html" });
      res.end(req.url === "/" ? PAGE : "nope");
    });
    await new Promise<void>((r) => http.listen(0, r));
    base = `http://localhost:${(http.address() as { port: number }).port}/`;
    session = await openSession("preview-test");
    await session.goto(base);
  }, 30_000);

  afterAll(() => {
    session?.close();
    http?.close();
  });

  test("the agent reads the page and clicks by ref", async () => {
    const snapshot = await session.snapshot();
    const ref = snapshot.match(/button "Add" \[ref=(e\d+)\]/)?.[1];
    expect(ref).toBeDefined();
    await session.act({ action: "click", ref });
    await session.act({ action: "click", ref });
    expect(await session.evaluate("n.textContent")).toBe("2");
  });

  test("an unknown ref fails at once and says what to do", async () => {
    const started = Date.now();
    await expect(session.act({ action: "click", ref: "e999" })).rejects.toThrow(/No element has ref e999 now.*take a new one/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("fills a field and keeps the console", async () => {
    const ref = (await session.snapshot()).match(/textbox "Name" \[ref=(e\d+)\]/)?.[1];
    await session.act({ action: "fill", ref, text: "Alex" });
    expect(session.console.some((e) => e.text === "typed Alex")).toBe(true);
  });

  test("records errors and failed requests", async () => {
    const ref = (await session.snapshot()).match(/button "Break" \[ref=(e\d+)\]/)?.[1];
    await session.act({ action: "click", ref });
    await session.act({ action: "wait", ms: 300 });
    expect(session.console.some((e) => e.level === "error" && e.text === "boom")).toBe(true);
    expect(session.requests.some((r) => r.url.endsWith("/missing") && r.status === 404)).toBe(true);
  });

  test("says what the user points at, with a selector that finds it again and a picture", async () => {
    const box = (await session.evaluate("(() => { const r = document.querySelector('button').getBoundingClientRect(); return { x: r.x + 5, y: r.y + 5 }; })()")) as { x: number; y: number };
    const element = await session.inspect(box.x, box.y, true);
    expect(element?.label).toBe('button "Add"');
    expect(await session.evaluate(`document.querySelector(${JSON.stringify(element!.selector)}).textContent`)).toBe("Add");
    expect(Buffer.from(element!.crop!, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(await session.inspect(box.x, box.y, false)).not.toHaveProperty("crop");
  });

  test("evaluates with REPL semantics", async () => {
    expect(await session.evaluate("const a = 2; await Promise.resolve(a * 21)")).toBe(42);
  });

  test("streams frames to a viewer and follows the pane's size", async () => {
    const frames: Buffer[] = [];
    const viewer: Viewer = { conversationId: "preview-test", pane: { width: 500, height: 300, dpr: 1, dark: false }, sendFrame: (f) => frames.push(f), send: () => {} };
    await addViewer(viewer);
    await session.act({ action: "wait", ms: 500 });
    expect(frames.length).toBeGreaterThan(0);
    expect([frames[0].readUInt16BE(0), frames[0].readUInt16BE(2)]).toEqual([500, 300]);
    expect((await session.state()).viewport).toMatchObject({ preset: "desktop", width: 500, height: 300 });
    await removeViewer(viewer);
  });

  test("a phone preset is a phone to the page, and clicks still work in it", async () => {
    await session.resize({ preset: "mobile" });
    expect(await session.evaluate("[innerWidth, navigator.userAgent.includes('Mobile'), navigator.maxTouchPoints > 0]")).toEqual([375, true, true]);
    const ref = (await session.snapshot()).match(/button "Add" \[ref=(e\d+)\]/)?.[1];
    const before = Number(await session.evaluate("n.textContent"));
    await session.act({ action: "click", ref });
    expect(Number(await session.evaluate("n.textContent"))).toBe(before + 1);
    await session.resize({ preset: "desktop" });
  });

  test("keeps streaming after the size changes back and forth", async () => {
    const frames: Buffer[] = [];
    const viewer: Viewer = { conversationId: "preview-test", pane: { width: 500, height: 300, dpr: 2, dark: false }, sendFrame: (f) => frames.push(f), send: () => {} };
    await addViewer(viewer);
    await session.resize({ preset: "mobile" });
    await session.resize({ preset: "desktop" });
    frames.length = 0;
    await session.evaluate("n.textContent = 'changed'");
    await session.act({ action: "wait", ms: 400 });
    expect(frames.length).toBeGreaterThan(0);
    expect([frames.at(-1)!.readUInt16BE(0), frames.at(-1)!.readUInt16BE(2)]).toEqual([500, 300]);
    await removeViewer(viewer);
  });

  test("a screenshot is at CSS size", async () => {
    const jpeg = await session.screenshot();
    expect(jpeg.subarray(0, 2).toString("hex")).toBe("ffd8");
  });

  test("a crashed page closes and says why, so the pane can offer it again", async () => {
    const crashing = await openSession("crash-test");
    await crashing.goto(base);
    // The page's own CDP session: nothing a page does can crash its renderer on purpose.
    const cdp = await (crashing as unknown as { cdp: Promise<CDPSession> }).cdp;
    await cdp.send("Page.crash").catch(() => {});
    await expect.poll(() => getSession("crash-test"), { timeout: 5_000 }).toBeUndefined();
    expect(closedPage("crash-test")).toEqual({ url: base, because: expect.stringMatching(/crashed/) });
  });

  // Last, as it closes the page the tests above share.
  test("keeps at most MAX_SESSIONS pages open, closing the oldest that nobody watches", async () => {
    const ids = Array.from({ length: MAX_SESSIONS }, (_, i) => `cap-${i}`);
    for (const id of ids) await openSession(id);
    expect(getSession("preview-test")).toBeUndefined();
    expect(closedPage("preview-test").because).toMatch(/make room/);
    expect(ids.every((id) => getSession(id))).toBe(true);
    for (const id of ids) getSession(id)?.close();
  }, 30_000);
});
