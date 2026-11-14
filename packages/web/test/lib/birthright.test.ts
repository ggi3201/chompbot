import { describe, expect, it } from "vitest";
import type { BirthrightEvent } from "@chomp/shared";
import { ARRIVAL, readTurnEvents, riteReducer, takeSpokenPieces, type RiteAction, type RiteState } from "../../src/lib/birthright";

const play = (actions: RiteAction[], from: RiteState = ARRIVAL) => actions.reduce(riteReducer, from);

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    },
  });
}

describe("riteReducer", () => {
  it("builds one agent message out of a turn's deltas", () => {
    const state = play([{ type: "begin" }, { type: "session", id: "s" }, { type: "text", delta: "Hello" }, { type: "text", delta: " there.\n" }, { type: "done" }]);
    expect(state.status).toBe("waiting");
    expect(state.sessionId).toBe("s");
    expect(state.messages).toEqual([{ from: "agent", text: "Hello there." }]);
  });

  it("does not start a message from the whitespace around a control tag", () => {
    const state = play([{ type: "begin" }, { type: "text", delta: "\n" }]);
    expect(state.messages).toEqual([]);
    expect(state.status).toBe("thinking");
  });

  it("keeps the person's words between the agent's", () => {
    const state = play([{ type: "begin" }, { type: "text", delta: "Hi." }, { type: "done" }, { type: "say", text: "Hello" }, { type: "text", delta: "Good." }]);
    expect(state.messages.map((m) => m.from)).toEqual(["agent", "person", "agent"]);
    expect(state.status).toBe("replying");
  });

  it("records known facets and ignores anything else", () => {
    const state = play([
      { type: "facet", key: "voice", value: "Dry." },
      { type: "facet", key: "shoe_size", value: "44" },
      { type: "facet", key: "humor", value: "" },
    ]);
    expect(state.facets).toEqual({ voice: "Dry." });
  });

  it("writes a soul and starts over when it is written again", () => {
    const first = play([
      { type: "soul_start", name: "Vega", description: "d" },
      { type: "soul_delta", delta: "You are " },
      { type: "soul_delta", delta: "Vega." },
      { type: "soul_end" },
      { type: "profile_delta", delta: "Alex." },
    ]);
    expect(first.soul).toEqual({ name: "Vega", description: "d", content: "You are Vega.", profile: "Alex.", writing: true });
    expect(riteReducer(first, { type: "done" }).soul?.writing).toBe(false);
    expect(riteReducer(first, { type: "soul_start", name: "Lyra", description: "" }).soul?.content).toBe("");
  });

  it("takes back a message the agent never answered, so it can return to the composer", () => {
    const state = play([{ type: "begin" }, { type: "text", delta: "Hi." }, { type: "done" }, { type: "say", text: "Hello" }, { type: "failed", message: "It broke" }]);
    expect(state.messages).toEqual([{ from: "agent", text: "Hi." }]);
    expect(state.status).toBe("waiting");
    expect(state.error).toBe("It broke");
  });

  it("goes back to the start when the first turn fails", () => {
    const state = play([{ type: "begin" }, { type: "error", message: "It broke" }]);
    expect(state.status).toBe("arrival");
    expect(state.error).toBe("It broke");
  });

  it("a problem elsewhere leaves the conversation alone", () => {
    const state = play([{ type: "begin" }, { type: "say", text: "Hello" }, { type: "problem", message: "Mic blocked" }]);
    expect(state.messages).toHaveLength(1);
    expect(state.error).toBe("Mic blocked");
  });

  it("shows a choice until the person answers", () => {
    const shown = play([{ type: "begin" }, { type: "choice", options: ["Short.", "A longer reply."] }]);
    expect(shown.choice).toEqual(["Short.", "A longer reply."]);
    expect(riteReducer(shown, { type: "say", text: "The first" }).choice).toBeNull();
  });

  it("ignores a choice with nothing to choose between", () => {
    expect(riteReducer(ARRIVAL, { type: "choice", options: ["Only one"] }).choice).toBeNull();
  });

  it("starts completely fresh when the rite runs again", () => {
    const finished = play([
      { type: "begin" },
      { type: "facet", key: "name", value: "Vega" },
      { type: "speaker", voice: "nova" },
      { type: "soul_start", name: "Vega", description: "" },
      { type: "done" },
      { type: "born" },
    ]);
    expect(finished.status).toBe("born");
    expect(riteReducer(finished, { type: "reset" })).toEqual(ARRIVAL);
    expect(riteReducer(finished, { type: "begin" })).toEqual({ ...ARRIVAL, status: "thinking" });
  });

  it("remembers the chosen voice", () => {
    expect(riteReducer(ARRIVAL, { type: "speaker", voice: "nova" }).speaker).toBe("nova");
  });
});

describe("readTurnEvents", () => {
  const collect = async (body: ReadableStream<Uint8Array>) => {
    const events: BirthrightEvent[] = [];
    for await (const event of readTurnEvents(body)) events.push(event);
    return events;
  };

  it("reads events split across chunks and skips the keepalive", async () => {
    const events = await collect(streamOf('data: {"type":"tex', 't","delta":"Hi"}\n\n: keepalive\n\ndata: {"type":"done"}\n', "\n"));
    expect(events).toEqual([{ type: "text", delta: "Hi" }, { type: "done" }]);
  });

  it("does not break a multi-byte letter cut by a chunk", async () => {
    const bytes = new TextEncoder().encode('data: {"type":"text","delta":"blå"}\n\n');
    const cut = bytes.indexOf(0xc3) + 1;
    const events = await collect(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    }));
    expect(events).toEqual([{ type: "text", delta: "blå" }]);
  });
});

describe("takeSpokenPieces", () => {
  it("waits for the end of a sentence", () => {
    expect(takeSpokenPieces("I am still writing this", 5)).toEqual({ pieces: [], rest: "I am still writing this" });
  });

  it("needs whitespace after the punctuation, so 3.5 is not an ending", () => {
    expect(takeSpokenPieces("It costs 3.5 kroner", 5).pieces).toEqual([]);
  });

  it("joins short sentences until the piece is long enough", () => {
    const { pieces, rest } = takeSpokenPieces("Hi. No. This one is long enough now. And then", 12);
    expect(pieces).toEqual(["Hi. No. This one is long enough now. "]);
    expect(rest).toBe("And then");
  });

  it("loses no characters, so the words on screen and the speech stay in step", () => {
    const text = "One sentence here!  Another one?\nA third… And the rest";
    const { pieces, rest } = takeSpokenPieces(text, 4);
    expect(pieces.join("") + rest).toBe(text);
  });
});
