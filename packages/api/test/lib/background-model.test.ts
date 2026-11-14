import { beforeEach, expect, test, vi } from "vitest";

const queryMock = vi.hoisted(() => vi.fn());
const codex = vi.hoisted(() => ({ calls: [] as string[][], reply: "from codex" }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));
vi.mock("node:child_process", () => ({
  execFileSync: () => "/usr/bin/claude",
  execFile: (_bin: string, args: string[], _opts: unknown, cb: (err: Error | null, out: string, err2: string) => void) => {
    codex.calls.push(args);
    const out = args[args.indexOf("-o") + 1];
    import("node:fs").then((fs) => { fs.writeFileSync(out, codex.reply); cb(null, "", ""); });
    return { stdin: { end: () => {} } };
  },
}));

const { db } = await import("../../src/db/index.js");
const { settings } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const { backgroundCompletion } = await import("../../src/lib/background-model.js");

function claudeFails() {
  queryMock.mockImplementation(() => ({ close: () => {}, async *[Symbol.asyncIterator]() { throw new Error("not logged in"); } }));
}

beforeEach(() => {
  vi.clearAllMocks();
  codex.calls = [];
  db.delete(settings).where(eq(settings.key, "background_model")).run();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

test("with nothing picked, Claude answers first, with tools off", async () => {
  queryMock.mockImplementation(() => ({ close: () => {}, async *[Symbol.asyncIterator]() { yield { type: "result", subtype: "success", result: "hi" }; } }));
  expect(await backgroundCompletion({ system: "s", prompt: "p" })).toBe("hi");
  expect(queryMock.mock.calls[0][0].options).toMatchObject({ model: "claude-haiku-5-5", tools: [], settingSources: [] });
  expect(codex.calls).toHaveLength(0);
});

test("with nothing picked and Claude not logged in, Codex answers in a read-only sandbox", async () => {
  claudeFails();
  expect(await backgroundCompletion({ system: "s", prompt: "p" })).toBe("from codex");
  expect(codex.calls[0]).toEqual(expect.arrayContaining(["exec", "--ephemeral", "-s", "read-only", "-m", "gpt-6-luna"]));
});

test("a picked model is the only one tried", async () => {
  db.insert(settings).values({ key: "background_model", value: JSON.stringify({ provider: "codex", model: "gpt-6-sol" }) }).run();
  codex.reply = "sol";
  expect(await backgroundCompletion({ system: "s", prompt: "p" })).toBe("sol");
  expect(queryMock).not.toHaveBeenCalled();
  expect(codex.calls[0]).toEqual(expect.arrayContaining(["-m", "gpt-6-sol"]));
});
