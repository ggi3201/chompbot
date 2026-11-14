import { test, expect, describe } from "vitest";
import {
  applyTemplate,
  validateTemplateSyntax,
  SUPPORTED_FILTERS,
} from "../../src/agents/widget-refresh-template.js";

// ── path extraction ────────────────────────────────────────────────

describe("$ jsonpath", () => {
  test("$ alone returns the whole context", () => {
    expect(applyTemplate("{{$}}", { a: 1 })).toEqual({ a: 1 });
  });

  test("dot path drills into nested objects", () => {
    expect(applyTemplate("{{$.a.b.c}}", { a: { b: { c: "found" } } })).toBe("found");
  });

  test("missing keys return empty string in interpolation context", () => {
    expect(applyTemplate("hi: {{$.missing}}", {})).toBe("hi: ");
  });

  test("numeric index reads array elements", () => {
    expect(applyTemplate("{{$.items[0]}}", { items: ["a", "b"] })).toBe("a");
    expect(applyTemplate("{{$.items[1]}}", { items: ["a", "b"] })).toBe("b");
  });

  test("bracket-quoted keys allow non-identifier characters", () => {
    expect(applyTemplate('{{$["with space"]}}', { "with space": "ok" })).toBe("ok");
    expect(applyTemplate("{{$['single-quoted']}}", { "single-quoted": "ok" })).toBe("ok");
  });
});

// ── single-placeholder vs interpolation ────────────────────────────

describe("substitution semantics", () => {
  test("single-placeholder string preserves the raw type (number stays number)", () => {
    const tpl = "{{$.value}}";
    const result = applyTemplate(tpl, { value: 42 });
    expect(result).toBe(42);
    expect(typeof result).toBe("number");
  });

  test("single-placeholder string preserves raw boolean value", () => {
    expect(applyTemplate("{{$.flag}}", { flag: true })).toBe(true);
  });

  test("interpolated string coerces values to strings", () => {
    expect(applyTemplate("price: {{$.value}} usd", { value: 42 })).toBe("price: 42 usd");
  });

  test("null/undefined inside interpolated text become empty string", () => {
    expect(applyTemplate("[{{$.missing}}]", {})).toBe("[]");
  });

  test("recurses into arrays", () => {
    const tpl = ["{{$.a}}", "{{$.b}}"];
    expect(applyTemplate(tpl, { a: 1, b: 2 })).toEqual([1, 2]);
  });

  test("recurses into objects, leaving non-string leaves alone", () => {
    const tpl = { color: "{{$.c}}", count: 5, nested: { v: "{{$.x}}" } };
    expect(applyTemplate(tpl, { c: "red", x: 7 })).toEqual({
      color: "red",
      count: 5,
      nested: { v: 7 },
    });
  });
});

// ── filters ────────────────────────────────────────────────────────

describe("filters", () => {
  test("SUPPORTED_FILTERS exposes the filter names", () => {
    expect(SUPPORTED_FILTERS).toContain("percent");
    expect(SUPPORTED_FILTERS).toContain("signed_pct");
    expect(SUPPORTED_FILTERS).toContain("usd");
    expect(SUPPORTED_FILTERS).toContain("nok");
    expect(SUPPORTED_FILTERS).toContain("integer");
    expect(SUPPORTED_FILTERS).toContain("comma_int");
    expect(SUPPORTED_FILTERS).toContain("two_decimal");
    expect(SUPPORTED_FILTERS).toContain("upper");
    expect(SUPPORTED_FILTERS).toContain("lower");
  });

  test("percent: number → '12.34%'", () => {
    expect(applyTemplate("{{$.x | percent}}", { x: 12.3456 })).toBe("12.35%");
  });

  test("percent on non-numeric input returns empty string", () => {
    expect(applyTemplate("{{$.x | percent}}", { x: "nope" })).toBe("");
  });

  test("signed_pct: positive numbers get a '+' prefix", () => {
    expect(applyTemplate("{{$.x | signed_pct}}", { x: 2.5 })).toBe("+2.50%");
  });

  test("signed_pct: zero counts as non-negative and gets '+'", () => {
    expect(applyTemplate("{{$.x | signed_pct}}", { x: 0 })).toBe("+0.00%");
  });

  test("signed_pct: negative numbers keep their sign without '+'", () => {
    expect(applyTemplate("{{$.x | signed_pct}}", { x: -1.7 })).toBe("-1.70%");
  });

  test("usd switches precision based on magnitude", () => {
    expect(applyTemplate("{{$.x | usd}}", { x: 0.012345 })).toBe("$0.0123");
    expect(applyTemplate("{{$.x | usd}}", { x: 250.5 })).toBe("$250.50");
    expect(applyTemplate("{{$.x | usd}}", { x: 1234567 })).toBe("$1,234,567");
  });

  test("nok appends NOK with two decimals", () => {
    expect(applyTemplate("{{$.x | nok}}", { x: 100 })).toBe("100.00 NOK");
  });

  test("integer rounds to nearest whole number", () => {
    expect(applyTemplate("{{$.x | integer}}", { x: 3.6 })).toBe(4);
  });

  test("comma_int formats with thousands separators", () => {
    expect(applyTemplate("{{$.x | comma_int}}", { x: 1234567 })).toBe("1,234,567");
  });

  test("two_decimal returns fixed two-decimal string", () => {
    expect(applyTemplate("{{$.x | two_decimal}}", { x: 1 })).toBe("1.00");
  });

  test("upper uppercases strings; null/undefined become empty", () => {
    expect(applyTemplate("{{$.x | upper}}", { x: "hello" })).toBe("HELLO");
    expect(applyTemplate("{{$.x | upper}}", {})).toBe("");
  });

  test("lower lowercases strings", () => {
    expect(applyTemplate("{{$.x | lower}}", { x: "HELLO" })).toBe("hello");
  });

  test("filters chain left-to-right", () => {
    expect(applyTemplate("{{$.x | comma_int | lower}}", { x: 1234 })).toBe("1,234");
  });

  test("unknown filter throws with a helpful message", () => {
    expect(() => applyTemplate("{{$.x | nope}}", { x: 1 })).toThrow(/Unknown filter "nope"/);
  });
});

// ── ternary ────────────────────────────────────────────────────────

describe("ternary expressions", () => {
  test("comparison op > picks truthy branch", () => {
    const tpl = "{{$.value > 0 ? 'positive' : 'non-positive'}}";
    expect(applyTemplate(tpl, { value: 5 })).toBe("positive");
    expect(applyTemplate(tpl, { value: -1 })).toBe("non-positive");
    expect(applyTemplate(tpl, { value: 0 })).toBe("non-positive");
  });

  test("== compares numbers", () => {
    const tpl = "{{$.x == 1 ? 'one' : 'other'}}";
    expect(applyTemplate(tpl, { x: 1 })).toBe("one");
    expect(applyTemplate(tpl, { x: 2 })).toBe("other");
  });

  test("!= compares strings", () => {
    const tpl = "{{$.status != 'ok' ? 'fail' : 'ok'}}";
    expect(applyTemplate(tpl, { status: "ok" })).toBe("ok");
    expect(applyTemplate(tpl, { status: "down" })).toBe("fail");
  });

  test("ternary branches can be paths", () => {
    const tpl = "{{$.flag == true ? $.a : $.b}}";
    expect(applyTemplate(tpl, { flag: true, a: "yes", b: "no" })).toBe("yes");
    expect(applyTemplate(tpl, { flag: false, a: "yes", b: "no" })).toBe("no");
  });

  test("ternary branches can be filtered paths", () => {
    const tpl = "{{$.x > 0 ? $.x | signed_pct : 'n/a'}}";
    expect(applyTemplate(tpl, { x: 2.5 })).toBe("+2.50%");
    expect(applyTemplate(tpl, { x: -1 })).toBe("n/a");
  });

  test("ternary with literal null branches preserve null", () => {
    expect(applyTemplate("{{$.x > 0 ? 'go' : null}}", { x: -1 })).toBe(null);
  });

  test("comparing a missing path with > returns false (falls through to false branch)", () => {
    const tpl = "{{$.missing > 0 ? 'yes' : 'no'}}";
    expect(applyTemplate(tpl, {})).toBe("no");
  });

  test("invalid condition expression throws a grammar error", () => {
    expect(() => applyTemplate("{{$.x ?? 1 : 2}}", { x: 1 })).toThrow();
  });

  test("invalid ternary branch (not a literal or $-path) throws", () => {
    expect(() => applyTemplate("{{$.x > 0 ? bareWord : 'no'}}", { x: 1 })).toThrow();
  });
});

// ── numeric coercion in comparisons ────────────────────────────────

describe("comparison coercion", () => {
  test("numeric strings on either side are coerced to numbers", () => {
    expect(applyTemplate('{{$.x > 0 ? "ok" : "no"}}', { x: "1.5" })).toBe("ok");
  });

  test("non-numeric strings cannot be ordered", () => {
    expect(applyTemplate('{{$.x > 0 ? "ok" : "no"}}', { x: "banana" })).toBe("no");
  });

  test("== falls back to strict-equal when sides aren't both numeric", () => {
    expect(applyTemplate('{{$.x == "abc" ? "match" : "no"}}', { x: "abc" })).toBe("match");
  });
});

// ── grammar / validation ───────────────────────────────────────────

describe("validateTemplateSyntax", () => {
  test("accepts a deeply nested valid template", () => {
    const tpl = {
      type: "metric-grid",
      items: [
        { title: "Up", value: "{{$.up | signed_pct}}", change: "{{$.up > 0 ? '+' : '-'}}" },
      ],
    };
    expect(() => validateTemplateSyntax(tpl)).not.toThrow();
  });

  test("rejects unclosed {{ braces", () => {
    expect(() => validateTemplateSyntax("hello {{ $.x ")).toThrow(/Unclosed/);
  });

  test("rejects unknown filters", () => {
    expect(() => validateTemplateSyntax("{{$.x | does_not_exist}}")).toThrow(/Unknown filter/);
  });

  test("rejects empty placeholders", () => {
    expect(() => validateTemplateSyntax("{{}}")).toThrow();
  });

  test("rejects expressions that do not start with $", () => {
    expect(() => validateTemplateSyntax("{{foo}}")).toThrow();
  });

  test("does NOT flag missing-path errors (they degrade gracefully at runtime)", () => {
    // Valid syntax, but path won't exist in real data — must not throw at write time.
    expect(() => validateTemplateSyntax("{{$.totally.missing.path}}")).not.toThrow();
  });
});

// ── round-trip example ────────────────────────────────────────────

test("full canvas template renders against realistic API payload", () => {
  const tpl = {
    type: "metric-grid",
    items: [
      {
        title: "BTC",
        value: "{{$.bitcoin.usd | usd}}",
        change: "{{$.bitcoin.usd_24h_change | signed_pct}}",
      },
      {
        title: "ETH",
        value: "{{$.ethereum.usd | usd}}",
        change: "{{$.ethereum.usd_24h_change | signed_pct}}",
      },
    ],
  };
  const data = {
    bitcoin: { usd: 104230.5, usd_24h_change: 2.341 },
    ethereum: { usd: 3821.7, usd_24h_change: -0.512 },
  };
  expect(applyTemplate(tpl, data)).toEqual({
    type: "metric-grid",
    items: [
      { title: "BTC", value: "$104,231", change: "+2.34%" },
      { title: "ETH", value: "$3,822", change: "-0.51%" },
    ],
  });
});
