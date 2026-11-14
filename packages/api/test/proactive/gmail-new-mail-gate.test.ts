import { afterEach, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { newsSeen } from "../../src/db/schema.js";

const mails = [{ id: "m1", subject: "Price drop on a TV", from: "Price Watch <noreply@alerts.example.com>", date: "x", snippet: "Now 899" }];
vi.mock("../../src/agents/tools/gmail.js", () => ({ searchEmailMessages: vi.fn(async () => mails) }));

const { runScriptGate } = await import("../../src/proactive/script-gates.js");
const gate = { script: "gmail_new_mail", input: { query: "from:alerts.pricewatch.example", key: "test-gate" } };

afterEach(() => {
  db.delete(newsSeen).where(eq(newsSeen.ticker, "gmail:test-gate")).run();
});

test("fires once per new mail, then stays quiet", async () => {
  const first = await runScriptGate(gate);
  expect(first.matched).toBe(true);
  expect(first.data?.mails).toEqual(mails);

  const second = await runScriptGate(gate);
  expect(second.matched).toBe(false);
});

test("requires query and key", async () => {
  await expect(runScriptGate({ script: "gmail_new_mail", input: { query: "x" } })).rejects.toThrow(/input.key/);
});
