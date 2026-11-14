import express from "express";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { settings, souls } from "../../src/db/schema.js";

const queryMock = vi.hoisted(() => vi.fn());
const memoryRows = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));
const chatRows = vi.hoisted(() => ({ rows: [] as Array<Record<string, string>> }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));
vi.mock("../../src/db/memories.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAllMemories: () => memoryRows.rows,
}));

vi.mock("../../src/birthright/evidence.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readChatRows: () => chatRows.rows,
}));

const { runInterviewTurn } = await import("../../src/birthright/interview.js");
const { default: birthrightRoutes } = await import("../../src/routes/birthright.js");

const textDelta = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});

function sdkYields(...messages: unknown[]) {
  queryMock.mockImplementation(() => ({
    close: () => {},
    async *[Symbol.asyncIterator]() {
      yield* messages;
    },
  }));
}

const SUCCESS = { type: "result", subtype: "success", is_error: false, result: "An answer." };

async function collect(input: Partial<Parameters<typeof runInterviewTurn>[0]> = {}) {
  const events = [];
  for await (const event of runInterviewTurn({ abortController: new AbortController(), ...input })) events.push(event);
  return events;
}

const optionsOfCall = () => queryMock.mock.calls[0][0].options;

let server: ReturnType<ReturnType<typeof express>["listen"]>;
let url: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/birthright", birthrightRoutes);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/birthright/turn`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  memoryRows.rows = [];
  chatRows.rows = [];
  db.delete(souls).run();
  db.delete(settings).where(eq(settings.key, "user_profile_md")).run();
  db.delete(settings).where(eq(settings.key, "voice_tts_voice")).run();
});

describe("runInterviewTurn", () => {
  it("starts a session with the prompt and no tools, and resumes one without it", async () => {
    sdkYields(SUCCESS);
    const [first] = await collect();
    expect(first.type).toBe("session");
    expect(optionsOfCall().tools).toEqual([]);
    expect(optionsOfCall().settingSources).toEqual([]);
    expect(optionsOfCall().sessionId).toBe((first as { id: string }).id);
    expect(optionsOfCall().systemPrompt).toContain("moment of your birth");
    expect(optionsOfCall().resume).toBeUndefined();

    queryMock.mockClear();
    sdkYields(SUCCESS);
    const id = "3f7d2a54-9c11-4f6e-8a55-1f6a2b7c9d10";
    const events = await collect({ sessionId: id, message: "Call yourself Vega." });
    expect(events[0]).toEqual({ type: "session", id });
    expect(queryMock.mock.calls[0][0].prompt).toBe("Call yourself Vega.");
    expect(optionsOfCall().resume).toBe(id);
    expect(optionsOfCall().systemPrompt).toBeUndefined();
  });

  it("streams words and control tags as separate events", async () => {
    sdkYields(textDelta("Vega."), textDelta('\n<facet key="na'), textDelta('me">Vega</facet>'), SUCCESS);
    const events = await collect();
    expect(events.slice(1)).toEqual([
      { type: "text", delta: "Vega." },
      { type: "text", delta: "\n" },
      { type: "facet", key: "name", value: "Vega" },
    ]);
  });

  it("throws when the turn fails", async () => {
    sdkYields({ type: "result", subtype: "error_during_execution", is_error: true });
    await expect(collect()).rejects.toThrow("error_during_execution");
  });

  it("tells a new person's interview that it knows nothing, ignoring seeded defaults, and brings in what it knows", async () => {
    memoryRows.rows = [{ content: "user_location: London, UK", category: "preferences", source: "seed", updatedAt: "2026-01-01" }];
    sdkYields(SUCCESS);
    await collect();
    const prompt = optionsOfCall().systemPrompt;
    expect(prompt).toContain("This person is new to you");
    expect(prompt).not.toContain("London");

    // What it already knows comes into the prompt.
    queryMock.mockClear();
    memoryRows.rows = [
      { content: "Lives in Example City", category: "facts", source: "user", updatedAt: "2026-01-01" },
      { content: "Guessed from a chat", category: "facts", source: "auto", updatedAt: "2026-01-01" },
    ];
    const now = new Date().toISOString();
    db.insert(souls).values({ id: "s1", name: "Ember", description: "", content: "You are Ember.", color: "violet", isDefault: true, createdAt: now, updatedAt: now }).run();
    sdkYields(SUCCESS);
    await collect();
    const known = optionsOfCall().systemPrompt;
    expect(known).toContain("Lives in Example City");
    expect(known).not.toContain("Guessed from a chat");
    expect(known).toContain("You are Ember.");
  });
});

describe("what the interview asks for", () => {
  it("starts from what the person actually corrected", async () => {
    chatRows.rows = [
      { conversationId: "c1", role: "assistant", text: "Deployed.", tail: "Deployed, all good.", createdAt: "2026-10-01T10:00:00Z" },
      { conversationId: "c1", role: "user", text: "Still does not work in prod", tail: "", createdAt: "2026-10-01T10:01:00Z" },
    ];
    sdkYields(SUCCESS);
    await collect();
    const prompt = optionsOfCall().systemPrompt;
    expect(prompt).toContain("Still does not work in prod");
    expect(prompt).toContain("Deployed, all good.");
  });
});

describe("POST /birthright/birth", () => {
  const birth = (body: unknown) => fetch(`${url.replace("/turn", "/birth")}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const soulRows = () => db.select().from(souls).all();
  const setting = (key: string) => db.select().from(settings).where(eq(settings.key, key)).get()?.value;
  const VEGA = { name: "Vega", description: "Keeps it shipping.", content: "You are Vega." };

  it("creates exactly one soul, and running many times never adds another", async () => {
    const created = await birth(VEGA);
    expect(created.status).toBe(200);
    expect(soulRows()).toMatchObject([{ name: "Vega", isDefault: true }]);
    const first = (await created.json()).id;
    await birth({ ...VEGA, name: "Lyra", content: "You are Lyra." });
    const third = (await (await birth({ ...VEGA, name: "Orion", content: "You are Orion." })).json()).id;
    expect(third).toBe(first);
    expect(soulRows()).toHaveLength(1);
    expect(soulRows()[0]).toMatchObject({ id: first, name: "Orion", content: "You are Orion.", isDefault: true });
  });

  it("leaves every other soul alone, and keeps only one default", async () => {
    const now = new Date().toISOString();
    const row = { description: "", color: "violet", createdAt: now, updatedAt: now };
    db.insert(souls).values([
      { ...row, id: "main", name: "Alfred", content: "old", isDefault: true },
      { ...row, id: "stray", name: "Stray", content: "also default", isDefault: true },
      { ...row, id: "hygge", name: "Hygge", content: "mood", isDefault: false },
    ]).run();
    await birth(VEGA);
    expect(soulRows()).toHaveLength(3);
    expect(soulRows().filter((s) => s.isDefault).map((s) => s.name)).toEqual(["Vega"]);
    expect(soulRows().find((s) => s.id === "hygge")).toMatchObject({ name: "Hygge", content: "mood" });
  });

  it("saves the profile and voice, and keeps them when a run has none", async () => {
    await birth({ ...VEGA, profile: "Lives in Example City.", voice: "nova" });
    expect(setting("user_profile_md")).toBe("Lives in Example City.");
    expect(setting("voice_tts_voice")).toBe("nova");
    await birth(VEGA);
    expect(setting("user_profile_md")).toBe("Lives in Example City.");
    expect(setting("voice_tts_voice")).toBe("nova");
  });

  it("refuses an empty soul, no name, or an unknown voice", async () => {
    for (const body of [{ ...VEGA, content: "  " }, { ...VEGA, name: "" }, { ...VEGA, voice: "robot" }]) {
      expect((await birth(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(soulRows()).toHaveLength(0);
  });
});

describe("POST /birthright/trial", () => {
  const trial = (body: unknown) => fetch(`${url.replace("/turn", "/trial")}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const opener = (id: string, text: string) => ({ conversationId: id, role: "user", text, tail: "", createdAt: "2026-10-01T10:00:00Z" });

  /** Answers with the soul each run was given, so the test can see which is which. */
  function sdkAnswersWithItsPrompt() {
    queryMock.mockImplementation(({ options }: { options: { systemPrompt: string } }) => ({
      close: () => {},
      async *[Symbol.asyncIterator]() {
        yield { ...SUCCESS, result: options.systemPrompt.split("\n\n")[0] };
      },
    }));
  }

  it("answers real messages with both souls, each run with no tools", async () => {
    const now = new Date().toISOString();
    db.insert(souls).values({ id: "main", name: "Alfred", description: "", content: "You are Alfred.", color: "violet", isDefault: true, createdAt: now, updatedAt: now }).run();
    chatRows.rows = [opener("c1", "Can you look at why the deploy is so slow?"), opener("c2", "Find me a good burrito recipe for tonight")];
    sdkAnswersWithItsPrompt();

    const result = await (await trial({ soul: "You are Vega." })).json();

    expect(result.current).toBe("Alfred");
    expect(result.rounds).toHaveLength(2);
    for (const round of result.rounds) {
      const byName = Object.fromEntries(round.answers.map((a: { source: string; text: string }) => [a.source, a.text]));
      expect(byName).toEqual({ new: "You are Vega.", current: "You are Alfred." });
    }
    expect(queryMock).toHaveBeenCalledTimes(4);
    expect(optionsOfCall().tools).toEqual([]);
    expect(optionsOfCall().model).toBe("claude-opus-5-5");
    expect(optionsOfCall().persistSession).toBe(false);
  });

  it("compares against no soul when there is none yet", async () => {
    chatRows.rows = [opener("c1", "Can you look at why the deploy is so slow?")];
    sdkAnswersWithItsPrompt();
    const result = await (await trial({ soul: "You are Vega." })).json();
    expect(result.current).toBeNull();
    expect(result.rounds[0].answers.map((a: { source: string }) => a.source).sort()).toEqual(["current", "new"]);
  });

  it("returns no rounds without past chats, and runs nothing", async () => {
    const result = await (await trial({ soul: "You are Vega." })).json();
    expect(result.rounds).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("reports a failed run", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    chatRows.rows = [opener("c1", "Can you look at why the deploy is so slow?")];
    sdkYields({ type: "result", subtype: "error_max_turns", is_error: true });
    expect((await trial({ soul: "You are Vega." })).status).toBe(502);
  });
});

describe("POST /birthright/turn", () => {
  const post = (body: unknown) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("refuses a message without a session, a session without a message, a non-uuid session id, or a blank message", async () => {
    for (const body of [
      { message: "Hello" },
      { sessionId: "3f7d2a54-9c11-4f6e-8a55-1f6a2b7c9d10" },
      { sessionId: "../../etc", message: "Hello" },
      { sessionId: "3f7d2a54-9c11-4f6e-8a55-1f6a2b7c9d10", message: "   " },
    ]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("streams the turn as server-sent events and ends with done", async () => {
    sdkYields(textDelta("Hi."), SUCCESS);
    const res = await post({});
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = (await res.text()).split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.slice("data: ".length)));
    expect(events.map((e) => e.type)).toEqual(["session", "text", "done"]);
  });

  it("reports a failed turn as an event, because the headers are already sent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    sdkYields({ type: "result", subtype: "error_max_turns", is_error: true });
    const events = (await (await post({})).text()).split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.slice("data: ".length)));
    expect(events.at(-1).type).toBe("error");
  });
});
