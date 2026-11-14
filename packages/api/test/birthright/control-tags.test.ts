import { describe, expect, it } from "vitest";
import { ControlTagParser } from "../../src/birthright/control-tags.js";

/** Feeds the text in pieces of `size`, the way a stream would cut it. */
function run(text: string, size: number) {
  const parser = new ControlTagParser();
  const events = [];
  for (let i = 0; i < text.length; i += size) events.push(...parser.push(text.slice(i, i + size)));
  return [...events, ...parser.flush()];
}

function joined(events: ReturnType<typeof run>, type: "text" | "soul_delta" | "profile_delta") {
  return events.flatMap((e) => (e.type === type ? [e.delta] : [])).join("");
}

const REPLY = `Vega it is.
<facet key="name">Vega</facet>
<facet key="voice">Short and dry.</facet>
Which one?
<choice>
<option>Done.</option>
<option>All done, and here is why.</option>
</choice>
Here I am.
<soul name="Vega" description="Keeps Alex shipping.">
You are Vega.
</soul>
<user_profile>
Alex lives in Example City.
</user_profile>`;

describe("ControlTagParser", () => {
  it.each([1, 2, 3, 7, 40, REPLY.length])("reads the same reply however the stream cuts it (%i characters at a time)", (size) => {
    const events = run(REPLY, size);

    expect(joined(events, "text").trim()).toBe("Vega it is.\n\n\nWhich one?\n\nHere I am.");
    expect(events.filter((e) => e.type === "choice")).toEqual([
      { type: "choice", options: ["Done.", "All done, and here is why."] },
    ]);
    expect(events.filter((e) => e.type === "facet")).toEqual([
      { type: "facet", key: "name", value: "Vega" },
      { type: "facet", key: "voice", value: "Short and dry." },
    ]);
    expect(events.find((e) => e.type === "soul_start")).toEqual({ type: "soul_start", name: "Vega", description: "Keeps Alex shipping." });
    expect(joined(events, "soul_delta").trim()).toBe("You are Vega.");
    expect(joined(events, "profile_delta").trim()).toBe("Alex lives in Example City.");
    expect(events.at(-1)).toEqual({ type: "profile_end" });
  });

  it("keeps angle brackets that are not its tags", () => {
    expect(joined(run("if a < b, try <soulful> or <facets>", 1), "text")).toBe("if a < b, try <soulful> or <facets>");
  });

  it("gives back text held for a tag that never came", () => {
    expect(run("wait <fac", 3)).toEqual([
      { type: "text", delta: "wai" },
      { type: "text", delta: "t " },
      { type: "text", delta: "<fac" },
    ]);
  });

  it("closes a soul the stream cut off, so the page never waits forever", () => {
    const events = run('<soul name="Vega" description="d">You are', 5);
    expect(joined(events, "soul_delta")).toBe("You are");
    expect(events.at(-1)).toEqual({ type: "soul_end" });
  });

  it("drops a facet or choice the stream cut off", () => {
    expect(run('<facet key="voice">Short', 4)).toEqual([]);
    expect(run("<choice><option>One</option>", 4)).toEqual([]);
  });
});
