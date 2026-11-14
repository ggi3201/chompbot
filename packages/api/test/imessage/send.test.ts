import express from "express";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { ApprovalOutcome, ApprovalQuestion } from "../../src/agents/runtime/approval.js";

const askForApproval = vi.hoisted(() => vi.fn<(conversationId: string, question: ApprovalQuestion) => Promise<ApprovalOutcome>>());
vi.mock("../../src/agents/runtime/pool.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  askForApproval,
}));

import { execSendImessage } from "../../src/agents/tools/imessage.js";

const FAR = { chatId: 9, name: "Far", identifier: "+4740000001" };

let server: ReturnType<ReturnType<typeof express>["listen"]>;
let resolved: unknown;
let sendStatus: number;
const sent: unknown[] = [];
const tokens: (string | undefined)[] = [];

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    tokens.push(req.headers.authorization);
    next();
  });
  app.post("/resolve", (_req, res) => {
    res.json(resolved);
  });
  app.post("/send", (req, res) => {
    sent.push(req.body);
    res.status(sendStatus).json(sendStatus === 200 ? { ok: true } : { error: "Not authorized to send Apple events" });
  });
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
});
afterAll(() => server.close());

beforeEach(() => {
  process.env.IMESSAGE_MAC_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  process.env.IMESSAGE_SEND_TOKEN = "send-token";
  resolved = FAR;
  sendStatus = 200;
  sent.length = 0;
  tokens.length = 0;
  askForApproval.mockReset();
});

const send = (text = "I love you", chat = "Far", conversationId: string | undefined = "conv-1") => execSendImessage({ chat, text }, conversationId);

test("an approved message reaches the Mac as written, with the send token; approving for the session still sends only this one", async () => {
  askForApproval.mockResolvedValue("accept");

  await expect(send('Hei "far"\nline two')).resolves.toBe("Sent to Far (+4740000001).");

  expect(sent).toEqual([{ chatId: 9, text: 'Hei "far"\nline two' }]);
  expect(tokens).toEqual(["Bearer send-token", "Bearer send-token"]);

  sent.length = 0;
  askForApproval.mockResolvedValue("accept-session");
  await send();
  expect(sent).toHaveLength(1);
});

test("the card shows the exact text and recipient before anything is sent", async () => {
  askForApproval.mockImplementation(async () => {
    expect(sent).toEqual([]);
    return "accept";
  });

  await send();

  expect(askForApproval).toHaveBeenCalledWith("conv-1", {
    title: "Send to Far (+4740000001)",
    detail: "I love you",
    summary: 'Send to Far: "I love you"',
    readFirst: false,
  });
});

test("a decline or an expiry sends nothing and says so", async () => {
  for (const [outcome, words] of [["decline", "the user declined"], ["expired", "nobody approved in time"]] as const) {
    askForApproval.mockResolvedValue(outcome);
    await expect(send()).resolves.toContain(`Nothing was sent: ${words}`);
  }
  expect(sent).toEqual([]);
});

test("a message too long for the lock screen has no buttons there, and the card keeps all of it", async () => {
  askForApproval.mockResolvedValue("accept");
  const long = "x".repeat(400);

  await send(long);

  const [, question] = askForApproval.mock.calls[0];
  expect(question).toMatchObject({ detail: long, readFirst: true, summary: "Send a long message to Far. Open Chomp to read it first." });
  expect(sent).toEqual([{ chatId: 9, text: long }]);
});

test("several matches ask the agent which one, and nobody found says so, with no approval", async () => {
  resolved = { candidates: ["9: Far [+4740000001]", "12: Farmor [+4740000002]"] };

  const result = await send();

  expect(result).toContain("Nothing was sent");
  expect(result).toContain("12: Farmor");

  resolved = { error: 'No chat found for "Far".' };
  await expect(send()).resolves.toBe('ERROR: Nothing was sent. No chat found for "Far".');

  expect(askForApproval).not.toHaveBeenCalled();
  expect(sent).toEqual([]);
});

test("a send the Mac refuses after approval is reported as failed", async () => {
  askForApproval.mockResolvedValue("accept");
  sendStatus = 502;

  const result = await send();

  expect(result).toMatch(/^ERROR: The user approved, but it may not have been sent/);
  expect(result).toContain("Not authorized");
});

test("a Mac that cannot be reached is an error before anyone is asked", async () => {
  process.env.IMESSAGE_MAC_URL = "http://127.0.0.1:1";

  await expect(send()).resolves.toContain("ERROR: Nothing was sent. Could not reach the user's Mac");
  expect(askForApproval).not.toHaveBeenCalled();
});

test("no chat to approve in, or no settings, sends nothing", async () => {
  await expect(execSendImessage({ chat: "Far", text: "hi" }, undefined)).resolves.toContain("no chat the user could approve");
  delete process.env.IMESSAGE_SEND_TOKEN;
  await expect(send()).resolves.toContain("IMESSAGE_SEND_TOKEN");
  expect(sent).toEqual([]);
});

test("empty text or recipient is refused", async () => {
  await expect(send("   ")).resolves.toBe("ERROR: text required");
  await expect(send("hi", " ")).resolves.toBe("ERROR: chat required");
});
