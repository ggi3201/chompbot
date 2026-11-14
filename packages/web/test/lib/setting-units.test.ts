import { describe, expect, it } from "vitest";
import { displayFromRaw, rawFromDisplay } from "../../src/lib/setting-units";

const MB = 1_048_576;

describe("setting units", () => {
  it("shows half a megabyte as 0.5, the documented minimum, not 1", () => {
    expect(displayFromRaw(String(MB / 2), MB)).toBe("0.5");
  });

  it("round-trips the values people type, keeping raw values whole and display values short", () => {
    expect(rawFromDisplay("0.5", MB)).toBe("524288");
    expect(displayFromRaw(rawFromDisplay("45", 60_000), 60_000)).toBe("45");
    // Raw values stay whole and display values short.
    expect(rawFromDisplay("0.123", MB)).toBe("128975");
    expect(displayFromRaw("2500000", MB)).toBe("2.38");
  });
});
