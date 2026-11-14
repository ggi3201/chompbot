import { createHmac } from "crypto";
import express from "express";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createToken } from "../../src/auth/middleware.js";
import { db } from "../../src/db/index.js";
import { webhooks } from "../../src/db/schema.js";
import { PHONE_CALENDAR_WEBHOOK } from "../../src/lib/phone-calendar.js";
import webhooksRoutes, { keepRawBody } from "../../src/routes/webhooks.js";
import { serve } from "../monitoring/helpers.js";

const SECRET = "test-secret";
// Spacing and a non-ASCII character: JSON.stringify(JSON.parse(BODY)) is not these bytes.
const BODY = '{ "title": "Bl\\u00e5b\\u00e6r",  "n": 1 }';

let api: Awaited<ReturnType<typeof serve>>;

beforeAll(async () => {
  db.insert(webhooks).values([
    { id: "signed", name: "signed", secret: SECRET },
    { id: "phone", name: PHONE_CALENDAR_WEBHOOK, secret: SECRET },
  ]).onConflictDoNothing().run();
  const app = express();
  app.use(express.json({ verify: keepRawBody }));
  app.use("/api/webhooks", webhooksRoutes);
  api = await serve(app);
});
afterAll(() => api.close());

const post = async (id: string, headers: Record<string, string> = {}) =>
  (await fetch(`${api.url}/api/webhooks/receive/${id}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: BODY })).status;
const sign = (secret: string) => "sha256=" + createHmac("sha256", secret).update(BODY).digest("hex");

test("a signature over the exact bytes sent is accepted, in either header", async () => {
  expect(await post("signed", { "x-hub-signature-256": sign(SECRET) })).toBe(200);
  expect(await post("signed", { "x-webhook-signature": sign(SECRET) })).toBe(200);
});

test("no proof of the secret, or a wrong signature even from a logged-in caller, is rejected", async () => {
  expect(await post("signed")).toBe(401);
  expect(await post("signed", { "x-webhook-signature": sign("other"), authorization: `Bearer ${createToken()}` })).toBe(401);
});

test("the secret itself in x-webhook-secret is accepted, a wrong one is not", async () => {
  expect(await post("signed", { "x-webhook-secret": SECRET })).toBe(200);
  expect(await post("signed", { "x-webhook-secret": "nope" })).toBe(401);
});

test("the logged-in Test button needs no signature", async () => {
  expect(await post("signed", { authorization: `Bearer ${createToken()}` })).toBe(200);
});

test("the iPhone calendar webhook still takes bare requests, but not a wrong secret", async () => {
  expect(await post("phone")).toBe(200);
  expect(await post("phone", { "x-webhook-secret": "nope" })).toBe(401);
});
