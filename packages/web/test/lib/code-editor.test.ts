import { describe, expect, it } from "vitest";
import { jsonError } from "../../src/components/CodeEditor";

describe("jsonError", () => {
  it("accepts valid JSON and empty input", () => {
    expect(jsonError('{"a": [1, 2]}')).toBeNull();
    expect(jsonError("   ")).toBeNull();
  });

  it("reports a parse error for broken JSON", () => {
    expect(jsonError('{"a": }')).toEqual(expect.any(String));
  });
});
