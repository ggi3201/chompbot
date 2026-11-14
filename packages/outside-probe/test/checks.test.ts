import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PORT_TIMEOUT_MS,
  URL_TIMEOUT_MS,
  USER_AGENT,
  checkPort,
  checkUrl,
  mapLimit,
  type Connect,
  type Fetch,
} from "../src/checks.ts";

const target = { key: "web", url: "https://web.example/" };

function clock(...ticks: number[]) {
  const queue = [...ticks];
  return () => queue.shift() ?? 0;
}

const respond = (status: number): Fetch => async () => new Response(null, { status });

test("a URL check sends the documented request", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  await checkUrl(target, async (url, init) => ((seen = { url, init }), new Response(null, { status: 200 })), clock(0, 1));
  assert.equal(seen?.url, target.url);
  assert.equal(seen?.init.redirect, "manual");
  assert.deepEqual(seen?.init.headers, { "User-Agent": USER_AGENT });
  assert.ok(seen?.init.signal instanceof AbortSignal);
  assert.equal(URL_TIMEOUT_MS, 8000);
});

test("statuses below 500 are up, including redirects and client errors; from 500 down, unless it is the expected status", async () => {
  for (const status of [200, 204, 301, 302, 401, 403, 404]) {
    const result = await checkUrl(target, respond(status), clock(0, 5));
    assert.deepEqual(result, { key: "web", ok: true, statusCode: status, latencyMs: 5, error: null });
  }
  const down = await checkUrl(target, respond(503), clock(10, 52));
  assert.deepEqual(down, { key: "web", ok: false, statusCode: 503, latencyMs: 42, error: "HTTP 503" });

  const result = await checkUrl({ ...target, expectedStatus: 502 }, respond(502), clock(0, 1));
  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 502);
  const other = await checkUrl({ ...target, expectedStatus: 502 }, respond(500), clock(0, 1));
  assert.equal(other.ok, false);
});

test("a network error is down with no status code, and a timeout is reported as a timeout", async () => {
  const failing: Fetch = async () => {
    throw new TypeError("fetch failed");
  };
  assert.deepEqual(await checkUrl(target, failing, clock(0, 9)), {
    key: "web",
    ok: false,
    statusCode: null,
    latencyMs: 9,
    error: "fetch failed",
  });

  const timingOut: Fetch = async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };
  const result = await checkUrl(target, timingOut, clock(0, 8000));
  assert.equal(result.error, "timeout");
  assert.equal(result.latencyMs, 8000);
});

function fakeSocket(opened: Promise<unknown>) {
  const socket = { closed: 0, opened, close: async () => void socket.closed++ };
  return socket;
}

test("an open port is open, and the socket is closed", async () => {
  const socket = fakeSocket(Promise.resolve());
  let address: unknown;
  const connect: Connect = (a) => ((address = a), socket);
  assert.deepEqual(await checkPort("home.example", 22, connect), { port: 22, open: true });
  assert.deepEqual(address, { hostname: "home.example", port: 22 });
  assert.equal(socket.closed, 1);
  assert.equal(PORT_TIMEOUT_MS, 3000);
});

test("a refused port, or a connect() that throws, is closed rather than an error", async () => {
  const socket = fakeSocket(Promise.reject(new Error("connection refused")));
  assert.deepEqual(await checkPort("h", 5432, () => socket), { port: 5432, open: false });
  assert.equal(socket.closed, 1);

  // A connect() that throws is closed, not an error.
  const throwing: Connect = () => {
    throw new Error("blocked");
  };
  assert.deepEqual(await checkPort("h", 25, throwing), { port: 25, open: false });
});

test("a port that never answers is closed after the timeout", async () => {
  const socket = fakeSocket(new Promise(() => {}));
  const started = Date.now();
  const result = await checkPort("h", 6379, () => socket, 30);
  const elapsed = Date.now() - started;
  assert.deepEqual(result, { port: 6379, open: false });
  assert.ok(elapsed >= 25 && elapsed < 1000, `took ${elapsed} ms`);
  assert.equal(socket.closed, 1);
});

test("mapLimit keeps order and never runs more than the limit at once", async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9], 3, async (n) => {
    peak = Math.max(peak, ++running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16, 18]);
  assert.equal(peak, 3);
  assert.deepEqual(await mapLimit([], 6, async (n) => n), []);
});
