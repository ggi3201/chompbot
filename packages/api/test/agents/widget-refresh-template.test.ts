import { test, expect, describe } from "vitest";
import {
  applyTemplate,
  validateTemplateSyntax,
} from "../../src/agents/widget-refresh-template.js";

// ── path extraction ────────────────────────────────────────────────

describe("$ jsonpath", () => {
  test("resolves $, dot paths, array indexes and bracket-quoted keys", () => {
    expect(applyTemplate("{{$}}", { a: 1 })).toEqual({ a: 1 });
    expect(applyTemplate("{{$.a.b.c}}", { a: { b: { c: "found" } } })).toBe("found");
    expect(applyTemplate("{{$.items[0]}}", { items: ["a", "b"] })).toBe("a");
    expect(applyTemplate("{{$.items[1]}}", { items: ["a", "b"] })).toBe("b");
    expect(applyTemplate('{{$["with space"]}}', { "with space": "ok" })).toBe("ok");
    expect(applyTemplate("{{$['single-quoted']}}", { "single-quoted": "ok" })).toBe("ok");
  });
});

// ── single-placeholder vs interpolation ────────────────────────────

describe("substitution semantics", () => {
  test("single-placeholder string preserves the raw type", () => {
    const result = applyTemplate("{{$.value}}", { value: 42 });
    expect(result).toBe(42);
    expect(typeof result).toBe("number");
    expect(applyTemplate("{{$.flag}}", { flag: true })).toBe(true);
  });

  test("interpolated string coerces values to strings; null/undefined become empty", () => {
    expect(applyTemplate("price: {{$.value}} usd", { value: 42 })).toBe("price: 42 usd");
    expect(applyTemplate("[{{$.missing}}]", {})).toBe("[]");
  });

  test("recurses into arrays and objects, leaving non-string leaves alone", () => {
    expect(applyTemplate(["{{$.a}}", "{{$.b}}"], { a: 1, b: 2 })).toEqual([1, 2]);
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
  test("percent formats numbers and returns empty for non-numeric input", () => {
    expect(applyTemplate("{{$.x | percent}}", { x: 12.3456 })).toBe("12.35%");
    expect(applyTemplate("{{$.x | percent}}", { x: "nope" })).toBe("");
  });

  test("signed_pct: '+' for positive and zero, plain '-' for negative", () => {
    expect(applyTemplate("{{$.x | signed_pct}}", { x: 2.5 })).toBe("+2.50%");
    expect(applyTemplate("{{$.x | signed_pct}}", { x: 0 })).toBe("+0.00%");
    expect(applyTemplate("{{$.x | signed_pct}}", { x: -1.7 })).toBe("-1.70%");
  });

  test("usd switches precision based on magnitude", () => {
    expect(applyTemplate("{{$.x | usd}}", { x: 0.012345 })).toBe("$0.0123");
    expect(applyTemplate("{{$.x | usd}}", { x: 250.5 })).toBe("$250.50");
    expect(applyTemplate("{{$.x | usd}}", { x: 1234567 })).toBe("$1,234,567");
  });

  test("nok, integer, comma_int and two_decimal format numbers", () => {
    expect(applyTemplate("{{$.x | nok}}", { x: 100 })).toBe("100.00 NOK");
    expect(applyTemplate("{{$.x | integer}}", { x: 3.6 })).toBe(4);
    expect(applyTemplate("{{$.x | comma_int}}", { x: 1234567 })).toBe("1,234,567");
    expect(applyTemplate("{{$.x | two_decimal}}", { x: 1 })).toBe("1.00");
  });

  test("upper/lower change case; null/undefined become empty", () => {
    expect(applyTemplate("{{$.x | upper}}", { x: "hello" })).toBe("HELLO");
    expect(applyTemplate("{{$.x | upper}}", {})).toBe("");
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
  test("comparison ops >, == and != pick the right branch", () => {
    const gt = "{{$.value > 0 ? 'positive' : 'non-positive'}}";
    expect(applyTemplate(gt, { value: 5 })).toBe("positive");
    expect(applyTemplate(gt, { value: -1 })).toBe("non-positive");
    expect(applyTemplate(gt, { value: 0 })).toBe("non-positive");
    const eq = "{{$.x == 1 ? 'one' : 'other'}}";
    expect(applyTemplate(eq, { x: 1 })).toBe("one");
    expect(applyTemplate(eq, { x: 2 })).toBe("other");
    const ne = "{{$.status != 'ok' ? 'fail' : 'ok'}}";
    expect(applyTemplate(ne, { status: "ok" })).toBe("ok");
    expect(applyTemplate(ne, { status: "down" })).toBe("fail");
  });

  test("ternary branches can be paths or filtered paths", () => {
    const tpl = "{{$.flag == true ? $.a : $.b}}";
    expect(applyTemplate(tpl, { flag: true, a: "yes", b: "no" })).toBe("yes");
    expect(applyTemplate(tpl, { flag: false, a: "yes", b: "no" })).toBe("no");
    const filtered = "{{$.x > 0 ? $.x | signed_pct : 'n/a'}}";
    expect(applyTemplate(filtered, { x: 2.5 })).toBe("+2.50%");
    expect(applyTemplate(filtered, { x: -1 })).toBe("n/a");
  });

  test("ternary with literal null branches preserve null", () => {
    expect(applyTemplate("{{$.x > 0 ? 'go' : null}}", { x: -1 })).toBe(null);
  });

  test("invalid condition or branch throws a grammar error", () => {
    expect(() => applyTemplate("{{$.x ?? 1 : 2}}", { x: 1 })).toThrow();
    expect(() => applyTemplate("{{$.x > 0 ? bareWord : 'no'}}", { x: 1 })).toThrow();
  });
});

// ── numeric coercion in comparisons ────────────────────────────────

describe("comparison coercion", () => {
  test("numeric strings coerce, non-numeric and missing values cannot be ordered, == falls back to strict-equal", () => {
    expect(applyTemplate('{{$.x > 0 ? "ok" : "no"}}', { x: "1.5" })).toBe("ok");
    expect(applyTemplate('{{$.x > 0 ? "ok" : "no"}}', { x: "banana" })).toBe("no");
    expect(applyTemplate("{{$.missing > 0 ? 'yes' : 'no'}}", {})).toBe("no");
    expect(applyTemplate('{{$.x == "abc" ? "match" : "no"}}', { x: "abc" })).toBe("match");
  });
});

// ── grammar / validation ───────────────────────────────────────────

describe("validateTemplateSyntax", () => {
  test("accepts nested valid templates and does NOT flag missing paths", () => {
    const tpl = {
      type: "metric-grid",
      items: [
        { title: "Up", value: "{{$.up | signed_pct}}", change: "{{$.up > 0 ? '+' : '-'}}" },
      ],
    };
    expect(() => validateTemplateSyntax(tpl)).not.toThrow();
    // Valid syntax, but path won't exist in real data — must not throw at write time.
    expect(() => validateTemplateSyntax("{{$.totally.missing.path}}")).not.toThrow();
  });

  test("rejects unclosed braces, unknown filters, empty placeholders and non-$ expressions", () => {
    expect(() => validateTemplateSyntax("hello {{ $.x ")).toThrow(/Unclosed/);
    expect(() => validateTemplateSyntax("{{$.x | does_not_exist}}")).toThrow(/Unknown filter/);
    expect(() => validateTemplateSyntax("{{}}")).toThrow();
    expect(() => validateTemplateSyntax("{{foo}}")).toThrow();
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
