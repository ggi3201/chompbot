import express from "express";
import type { AddressInfo } from "net";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { db } from "../../src/db/index.js";
import { chatMessages, devicePushTokens } from "../../src/db/schema.js";

const notify = vi.hoisted(() => vi.fn(async () => "telegram"));
const dispatchToAgent = vi.hoisted(() => vi.fn());
const sendAlertPush = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock("../../src/notifications/router.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  notify,
}));
vi.mock("../../src/agents/dispatch.js", () => ({ dispatchToAgent }));
vi.mock("../../src/lib/apns.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendAlertPush,
}));

const { askRoutes } = await import("../../src/routes/ask.js");


let server: ReturnType<ReturnType<typeof express>["listen"]>;
let url: string;

const post = (body: unknown, path = "ask") => fetch(`${url}/${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/ask", askRoutes(5000));
  app.use("/ask-impatient", askRoutes(100));
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  db.delete(devicePushTokens).run();
  dispatchToAgent.mockReset();
  notify.mockClear();
  sendAlertPush.mockClear();
});

test("a question gets its answer in a new chat, with the phone's reply format", async () => {
  dispatchToAgent.mockResolvedValue({ response: "It is four.", agentUsed: "Alfred" });

  const res = await post({ question: "What is 2 + 2?" });
  const { conversationId, reply } = await res.json();

  expect(res.status).toBe(200);
  expect(reply).toBe("It is four.");
  expect(sendAlertPush).not.toHaveBeenCalled();
  const options = dispatchToAgent.mock.calls[0][2];
  expect(options).toMatchObject({ deliveryChannel: "proactive" });
  expect(options.channelContext).toContain("Ask Chomp");
  expect(db.select().from(chatMessages).where(eq(chatMessages.conversationId, conversationId)).all().map((message) => message.role)).toEqual(["user", "assistant"]);
});

test("an image alone is enough, and it reaches the agent", async () => {
  dispatchToAgent.mockResolvedValue({ response: "That is an invoice.", agentUsed: "Alfred" });

  const res = await post({ attachments: [{ url: "/api/uploads/screen.jpg", name: "screen.jpg", mimeType: "image/jpeg" }] });

  expect((await res.json()).reply).toBe("That is an invoice.");
  expect(dispatchToAgent.mock.calls[0][0].prompt).toMatch(/Attached files, on disk:\n- screen\.jpg \(image\/jpeg\): \/.+\/screen\.jpg/);
});

test("every reply of the turn is returned, in order", async () => {
  dispatchToAgent.mockImplementation(async (_routing, ctx) => {
    db.insert(chatMessages).values({ id: crypto.randomUUID(), conversationId: ctx.conversationId, role: "assistant", content: "Looking.", createdAt: new Date().toISOString() }).run();
    return { response: "Found it.", agentUsed: "Alfred" };
  });

  expect((await (await post({ question: "Find it" })).json()).reply).toBe("Looking.\n\nFound it.");
});

test("a slow answer comes as a push after the phone stopped waiting", async () => {
  db.insert(devicePushTokens).values({ deviceId: "phone", apnsToken: "token", environment: "production", updatedAt: new Date().toISOString() }).run();
  let finish: (result: object) => void = () => {};
  dispatchToAgent.mockReturnValue(new Promise((resolve) => { finish = resolve; }));

  const res = await post({ question: "Plan my week" }, "ask-impatient");

  expect(await res.json()).toMatchObject({ reply: null });
  expect(sendAlertPush).not.toHaveBeenCalled();

  finish({ response: "Done planning.", agentUsed: "Alfred" });
  await vi.waitFor(() => expect(sendAlertPush).toHaveBeenCalledWith(expect.objectContaining({ title: "Chomp", body: "Done planning." })));
  expect(notify).not.toHaveBeenCalled();
});

test("a slow answer goes to the other channels when no phone can be reached", async () => {
  let finish: (result: object) => void = () => {};
  dispatchToAgent.mockReturnValue(new Promise((resolve) => { finish = resolve; }));

  const { conversationId } = await (await post({ question: "Plan my week" }, "ask-impatient")).json();

  finish({ response: "Done planning.", agentUsed: "Alfred" });
  await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(expect.objectContaining({ body: "Done planning.", conversationId, broadcast: true })));
});

test("an agent failure comes back as the answer", async () => {
  dispatchToAgent.mockRejectedValue(new Error("session lost"));

  expect((await (await post({ question: "Hello" })).json()).reply).toContain("session lost");
});

test("an empty ask and a bad attachment are refused", async () => {
  for (const bad of [{}, { question: "  " }, { question: "Hi", attachments: [{ url: "/x" }] }]) {
    expect((await post(bad)).status).toBe(400);
  }
  expect(dispatchToAgent).not.toHaveBeenCalled();
});
