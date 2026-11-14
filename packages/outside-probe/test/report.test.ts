import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import type { Fetch } from "../src/checks.ts";
import { sendReport, sign } from "../src/report.ts";
import type { Report } from "../src/types.ts";

const report: Report = {
  ts: 1_800_000_000_000,
  colo: null,
  vantage: "outside",
  results: [{ key: "web", ok: true, statusCode: 200, latencyMs: 31, error: null }],
  ports: [{ port: 22, open: false }],
};

test("the signature matches an independent HMAC-SHA256 of '<timestamp>.<body>'", async () => {
  const body = JSON.stringify(report);
  const expected = createHmac("sha256", "s3cret").update(`1800000000.${body}`).digest("hex");
  assert.equal(await sign("s3cret", 1_800_000_000, body), expected);
});

test("the request carries the body, the timestamp in seconds and a matching signature", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const doFetch: Fetch = async (url, init) => ((seen = { url, init }), new Response("{}", { status: 200 }));
  const outcome = await sendReport(doFetch, "https://chomp.example/api/monitoring/outside", "s3cret", report, 1_800_000_000_999);

  assert.deepEqual(outcome, { ok: true });
  assert.equal(seen?.url, "https://chomp.example/api/monitoring/outside");
  assert.equal(seen?.init.method, "POST");
  const headers = seen?.init.headers as Record<string, string>;
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers["X-Chomp-Timestamp"], "1800000000");
  const body = seen?.init.body as string;
  assert.deepEqual(JSON.parse(body), report);
  const expected = createHmac("sha256", "s3cret").update(`1800000000.${body}`).digest("hex");
  assert.equal(headers["X-Chomp-Signature"], `sha256=${expected}`);
});

test("a non-2xx answer is a failure with the status", async () => {
  const outcome = await sendReport(async () => new Response(null, { status: 502 }), "u", "s", report, 0);
  assert.deepEqual(outcome, { ok: false, error: "HTTP 502" });
});

test("a network error is a failure with the message", async () => {
  const outcome = await sendReport(
    async () => {
      throw new TypeError("fetch failed");
    },
    "u",
    "s",
    report,
    0,
  );
  assert.deepEqual(outcome, { ok: false, error: "fetch failed" });
});
