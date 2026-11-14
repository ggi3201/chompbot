import express from "express";
import type { AddressInfo } from "net";
import { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { ApprovalDecision } from "@chomp/shared";

const apns = vi.hoisted(() => ({
  sendAlertPush: vi.fn(async (_push: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
  sendSilentPush: vi.fn(async (_push: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
}));
vi.mock("../../src/lib/apns.js", () => apns);

/** A session that waits on approvals the way the real ones do. */
const fake = vi.hoisted(() => ({
  ask: null as null | ((requestId: string) => Promise<string>),
}));
vi.mock("../../src/agents/runtime/claude.js", () => ({
  DEFAULT_AGENT_CWD: "/tmp",
  forgetClaudeSession: () => {},
  ClaudeRuntime: {
    start: () => {
      const approvals = new Map<string, (decision: ApprovalDecision | "expired") => void>();
      return {
        provider: "claude",
        lastUsedAt: Date.now(),
        failed: null,
        busy: true,
        runTurn(request: TurnRequest) {
          fake.ask = (requestId) => waitForApproval(request, requestId, "Run git push …", (resolve) => approvals.set(requestId, resolve));
          return new Promise<string>(() => {});
        },
        answerApproval(requestId: string, decision: ApprovalDecision) {
          const resolve = approvals.get(requestId);
          resolve?.(decision);
          return !!resolve;
        },
        close: () => {},
      };
    },
  },
}));

import { db } from "../../src/db/index.js";
import { devicePushTokens } from "../../src/db/schema.js";
import { waitForApproval, APPROVAL_TIMEOUT_MS } from "../../src/agents/runtime/approval.js";
import { claudeApprovalSummary, codexApprovalSummary } from "../../src/agents/runtime/describe.js";
import { runAgentTurn } from "../../src/agents/runtime/pool.js";
import type { TurnRequest } from "../../src/agents/runtime/types.js";
import { createPendingQuestion, QUESTION_TIMEOUT_MS } from "../../src/mcp/pending-questions.js";
import { toolHandlers } from "../../src/mcp/tool-handlers.js";
import { forgetPhoneOffer } from "../../src/notifications/phone-requests.js";
import { registerConnection } from "../../src/notifications/web-connections.js";
import routes from "../../src/routes/agent-requests.js";

function turn(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    sessionId: "session-1",
    conversationId: "conv-1",
    agentName: "Alfred",
    prompt: "go",
    access: "supervised",
    deliveryChannel: "telegram",
    cwd: "/tmp",
    ctx: { conversationId: "conv-1", send: () => {} },
    ...overrides,
  };
}

function addPhone() {
  db.insert(devicePushTokens)
    .values({ deviceId: "iphone", apnsToken: "token", platform: "ios", environment: "development", updatedAt: new Date().toISOString() })
    .run();
}

/** Lets the push's promise chain run, on real or fake timers alike. */
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

let server: ReturnType<ReturnType<typeof express>["listen"]>;
let url: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/", routes);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

beforeEach(() => {
  db.delete(devicePushTokens).run();
  apns.sendAlertPush.mockClear().mockImplementation(async () => ({ ok: true }));
  apns.sendSilentPush.mockClear().mockImplementation(async () => ({ ok: true }));
});

afterEach(() => vi.useRealTimers());

const post = (path: string, body: unknown) =>
  fetch(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("waitForApproval", () => {
  test("expires at once when nobody can answer: no phone, a one-off run, or a failed push", async () => {
    // outside web chat, no phone means nobody can answer
    await expect(waitForApproval(turn(), "r1", "Run ls", () => {})).resolves.toBe("expired");
    expect(apns.sendAlertPush).not.toHaveBeenCalled();

    // a one-off run has no conversation to answer through
    addPhone();
    await expect(waitForApproval(turn({ conversationId: "" }), "r1", "Run ls", () => {})).resolves.toBe("expired");
    expect(apns.sendAlertPush).not.toHaveBeenCalled();

    // outside web chat, a failed push expires it at once
    apns.sendAlertPush.mockImplementation(async () => ({ ok: false, error: "APNs not configured" }));
    await expect(waitForApproval(turn(), "r1", "Run ls", () => {})).resolves.toBe("expired");
    expect(apns.sendSilentPush).not.toHaveBeenCalled();
  });

  test("web chat survives a phone that cannot be reached, until the timeout", async () => {
    vi.useFakeTimers();
    const outcome = waitForApproval(turn({ deliveryChannel: "web-chat" }), "r1", "Run ls", () => {});
    let settled = false;
    void outcome.then(() => { settled = true; });
    await settle();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS);
    await expect(outcome).resolves.toBe("expired");
  });

  test("the push names the action, carries the ids to answer with and ends with the wait", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    addPhone();
    let answer!: (decision: ApprovalDecision) => void;
    const outcome = waitForApproval(turn(), "r1", "Run git push …", (resolve) => { answer = resolve; });
    await settle();

    expect(apns.sendAlertPush).toHaveBeenCalledWith({
      deviceToken: "token",
      environment: "development",
      title: "Alfred needs approval",
      body: "Run git push …",
      category: "CHOMP_APPROVAL",
      collapseId: "r1",
      expiresAt: Math.floor((1_000_000 + APPROVAL_TIMEOUT_MS) / 1000),
      data: { chomp: { id: "r1", kind: "approval", conversationId: "conv-1", requestId: "r1" } },
    });

    answer("accept");
    await expect(outcome).resolves.toBe("accept");
    await settle();
    expect(apns.sendSilentPush.mock.calls[0][0]).toMatchObject({ data: { chomp: { withdrawn: "r1" } } });
  });

  test("a request the lock screen cannot show gets no buttons there", async () => {
    addPhone();
    const outcome = waitForApproval(turn({ deliveryChannel: "telegram" }), "req-long", "Send a long message to Far. Open Chomp to read it first.", () => {}, { readFirst: true });
    await settle();

    expect(apns.sendAlertPush).toHaveBeenCalledWith(expect.objectContaining({ category: "CHOMP_READ_FIRST" }));
    void outcome;
  });

  test("with a web client open the phone waits, and an answer in time means no push at all", async () => {
    vi.useFakeTimers();
    addPhone();
    const ws = { readyState: WebSocket.OPEN, on: vi.fn(), send: vi.fn() };
    registerConnection("tab", ws as unknown as WebSocket);

    let answer!: (decision: ApprovalDecision) => void;
    const answered = waitForApproval(turn({ deliveryChannel: "web-chat" }), "r1", "Run ls", (resolve) => { answer = resolve; });
    await settle();
    expect(apns.sendAlertPush).not.toHaveBeenCalled();
    answer("decline");
    await answered;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(apns.sendAlertPush).not.toHaveBeenCalled();
    expect(apns.sendSilentPush).not.toHaveBeenCalled();

    const ignored = waitForApproval(turn({ deliveryChannel: "web-chat" }), "r2", "Run ls", (resolve) => { answer = resolve; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(apns.sendAlertPush).toHaveBeenCalledTimes(1);
    answer("accept");
    await ignored;

    // Answered through the route during the wait: nothing may arrive afterwards.
    apns.sendAlertPush.mockClear();
    apns.sendSilentPush.mockClear();
    const viaRoute = waitForApproval(turn({ deliveryChannel: "web-chat" }), "r3", "Run ls", (resolve) => { answer = resolve; });
    forgetPhoneOffer("r3");
    answer("accept");
    await viaRoute;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(apns.sendAlertPush).not.toHaveBeenCalled();
    expect(apns.sendSilentPush).not.toHaveBeenCalled();

    ws.readyState = WebSocket.CLOSED;
  });
});

describe("POST /approval", () => {
  test("answers the waiting turn, then reports the same request as ended", async () => {
    addPhone();
    void runAgentTurn("claude", turn());
    await vi.waitFor(() => expect(fake.ask).not.toBeNull());
    const outcome = fake.ask!("r-route");
    await settle();

    const res = await post("/approval", { conversationId: "conv-1", requestId: "r-route", decision: "accept" });
    expect(res.status).toBe(200);
    await expect(outcome).resolves.toBe("accept");
    // iOS already removed the notification, and silent pushes are rationed.
    await settle();
    expect(apns.sendSilentPush).not.toHaveBeenCalled();

    const again = await post("/approval", { conversationId: "conv-1", requestId: "unknown", decision: "accept" });
    expect(again.status).toBe(409);
  });

  test("an unknown conversation has ended too, and a bad decision is refused", async () => {
    expect((await post("/approval", { conversationId: "gone", requestId: "r", decision: "accept" })).status).toBe(409);
    expect((await post("/approval", { conversationId: "conv-1", requestId: "r", decision: "maybe" })).status).toBe(400);
  });
});

describe("ask_user on the phone", () => {
  test("pushes the question short, and the route's answer ends the tool call", async () => {
    addPhone();
    const question = `Which one? ${"x".repeat(300)}`;
    const result = toolHandlers.ask_user({ question }, "ask-session");
    await vi.waitFor(() => expect(apns.sendAlertPush).toHaveBeenCalled());

    const push = apns.sendAlertPush.mock.calls[0][0] as { body: string; category: string; data: { chomp: { questionId: string } } };
    expect(push.category).toBe("CHOMP_QUESTION");
    expect(push.body.length).toBeLessThanOrEqual(180);

    const res = await post("/question", { sessionId: "ask-session", questionId: push.data.chomp.questionId, answer: "The blue one" });
    expect(res.status).toBe(200);
    expect((await result).content[0]).toMatchObject({ text: "The blue one" });
    expect(apns.sendSilentPush).not.toHaveBeenCalled();
  });

  test("a late answer to an old question does not land on the next one", async () => {
    vi.useFakeTimers();
    const old = createPendingQuestion("q-session", "Old?", "old");
    const failed = expect(old).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(QUESTION_TIMEOUT_MS);
    await failed;
    const next = createPendingQuestion("q-session", "New?", "new");

    vi.useRealTimers();
    expect((await post("/question", { sessionId: "q-session", questionId: "old", answer: "yes" })).status).toBe(409);
    expect((await post("/question", { sessionId: "q-session", questionId: "new", answer: "no" })).status).toBe(200);
    await expect(next).resolves.toBe("no");
  });
});

describe("lock screen summaries", () => {
  test("commands show only the program and safe words, never secrets", () => {
    const cases: Array<[string, string]> = [
      ["git push origin main", "Run git push …"],
      ["ls", "Run ls"],
      ["/usr/bin/git status", "Run git status"],
      ["rm -rf /", "Run rm …"],
      ["curl -H 'Authorization: Bearer secret' https://x.y", "Run curl …"],
      ["API_KEY=secret npm publish", "Run npm publish"],
      ["cd repo && rm -rf build", "Run a command"],
      ["echo $SECRET", "Run a command"],
      ['KEY="a b" npm test', "Run a command"],
    ];
    for (const [command, summary] of cases) {
      expect(claudeApprovalSummary("Bash", { command }), command).toBe(summary);
      expect(codexApprovalSummary("Run command", command.split(" ")), command).toBe(summary);
    }
  });

  test("files by name, pages by host, other tools by name, and never their input", () => {
    expect(claudeApprovalSummary("Edit", { file_path: "/home/me/secret-client/plan.md", old_string: "password" })).toBe("Edit plan.md");
    expect(claudeApprovalSummary("Read", { file_path: "/etc/hosts" })).toBe("Read hosts");
    expect(claudeApprovalSummary("WebFetch", { url: "https://example.com/a?token=abc" })).toBe("Fetch example.com");
    expect(claudeApprovalSummary("WebFetch", { url: "not a url" })).toBe("Fetch a page");
    expect(claudeApprovalSummary("mcp__chomp-api__save_memory", { content: "my pin is 1234" })).toBe("Use save memory");
    expect(claudeApprovalSummary("Task", { prompt: "the secret plan" })).toBe("Use Task");
    expect(codexApprovalSummary("Change files", undefined)).toBe("Change files");
  });
});
