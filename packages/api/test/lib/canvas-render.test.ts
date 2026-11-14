import { test, expect } from "vitest";
import { renderCanvasForChannel } from "../../src/lib/canvas-render.js";

// ── Pass-through and malformed JSON ─────────────────────────────────

test("text without canvas blocks is unchanged; malformed and unknown blocks are stripped", () => {
  const text = "hello world\n\nno canvas here";
  expect(renderCanvasForChannel(text, "telegram")).toBe(text);
  expect(renderCanvasForChannel(text, "discord")).toBe(text);

  // Malformed JSON and unknown types are stripped, not preserved.
  const malformed = renderCanvasForChannel("before\n\n:::canvas\n{not valid json\n:::\n\nafter", "telegram");
  expect(malformed).not.toContain("not valid json");
  expect(malformed).toContain("before");
  expect(malformed).toContain("after");
  expect(renderCanvasForChannel(':::canvas\n{"type":"never-heard-of-this","value":"x"}\n:::', "discord")).toBe("");
});

test("preserves surrounding text, collapses excess blank lines, and renders several blocks in order", () => {
  const input =
    "before\n\n:::canvas\n" +
    JSON.stringify({ type: "info-card", title: "BTC", value: "$104,000" }) +
    "\n:::\n\nafter";
  const out = renderCanvasForChannel(input, "telegram");
  expect(out).toContain("before");
  expect(out).toContain("after");
  expect(out).toContain("**BTC**");
  expect(out).toContain("$104,000");
  expect(out).not.toMatch(/\n{3,}/);

  // Several blocks each render, in order.
  const a = { type: "info-card", title: "BTC", value: "1" };
  const b = { type: "info-card", title: "ETH", value: "2" };
  const multi = renderCanvasForChannel(`:::canvas\n${JSON.stringify(a)}\n:::\n\n:::canvas\n${JSON.stringify(b)}\n:::`, "telegram");
  expect(multi.indexOf("**BTC**")).toBeGreaterThanOrEqual(0);
  expect(multi.indexOf("**BTC**")).toBeLessThan(multi.indexOf("**ETH**"));
});

// ── info-card ──────────────────────────────────────────────────────

test("info-card renders title, value, change arrow and subtitle", () => {
  const block = {
    type: "info-card",
    title: "BTC",
    value: "$104,000",
    change: "+2.3%",
    subtitle: "24h",
  };
  const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "telegram");
  expect(out).toContain("**BTC**");
  expect(out).toContain("$104,000");
  expect(out).toContain("📈");
  expect(out).toContain("+2.3%");
  expect(out).toContain("_24h_");

  const down = { type: "info-card", title: "ETH", value: "$3,000", change: "-1.5%" };
  const negative = renderCanvasForChannel(`:::canvas\n${JSON.stringify(down)}\n:::`, "discord");
  expect(negative).toContain("📉");
  expect(negative).toContain("-1.5%");
});

// ── metric-grid ────────────────────────────────────────────────────

test("metric-grid lists each item as a bullet", () => {
  const block = {
    type: "metric-grid",
    items: [
      { title: "BTC", value: "$104,000", change: "+2.3%" },
      { title: "ETH", value: "$3,000", change: "-1.5%", subtitle: "24h" },
    ],
  };
  const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "telegram");
  expect(out).toMatch(/•\s+\*\*BTC\*\*/);
  expect(out).toMatch(/•\s+\*\*ETH\*\*/);
  expect(out).toContain("_(24h)_");
  expect(renderCanvasForChannel(`:::canvas\n${JSON.stringify({ type: "metric-grid", items: [] })}\n:::`, "discord")).toBe("");
});

// ── data-table ─────────────────────────────────────────────────────

test("data-table renders markdown table on Discord", () => {
  const block = {
    type: "data-table",
    title: "Holdings",
    headers: ["Symbol", "Shares"],
    rows: [["BTC", "1.5"], ["ETH", "10"]],
  };
  const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "discord");
  expect(out).toContain("**Holdings**");
  expect(out).toContain("| Symbol | Shares |");
  expect(out).toContain("| --- | --- |");
  expect(out).toContain("| BTC | 1.5 |");

  const pipes = { type: "data-table", headers: ["Name"], rows: [["a|b"]] };
  expect(renderCanvasForChannel(`:::canvas\n${JSON.stringify(pipes)}\n:::`, "discord")).toContain("a\\|b");
});

test("data-table renders bullet list on Telegram (no markdown table support)", () => {
  const block = {
    type: "data-table",
    title: "Holdings",
    headers: ["Symbol", "Shares"],
    rows: [["BTC", "1.5"]],
  };
  const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "telegram");
  expect(out).toContain("**Holdings**");
  expect(out).toMatch(/•\s+_Symbol:_\s*BTC/);
  expect(out).toMatch(/•\s+_Shares:_\s*1\.5/);
  expect(out).not.toContain("---"); // no md table separator

  const empty = { type: "data-table", title: "Empty", headers: ["A"], rows: [] };
  expect(renderCanvasForChannel(`:::canvas\n${JSON.stringify(empty)}\n:::`, "telegram")).toBe("**Empty**");
});

// ── progress-bar ───────────────────────────────────────────────────

test("progress-bar and slider draw a bar with their numbers", () => {
  {
    const block = { type: "progress-bar", label: "Deploy", value: 75, max: 100 };
    const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "telegram");
    expect(out).toContain("**Deploy**");
    expect(out).toMatch(/[▰▱]+/);
    expect(out).toContain("75%");
    expect(out).toContain("(75 / 100)");

    const hidden = { type: "progress-bar", label: "x", value: 50, max: 100, showPercent: false };
    const noPercent = renderCanvasForChannel(`:::canvas\n${JSON.stringify(hidden)}\n:::`, "telegram");
    expect(noPercent).not.toContain("50%");
    expect(noPercent).toContain("(50 / 100)");

    // Overflow: value text reflects the raw value; the bar fills to max.
    const over = { type: "progress-bar", label: "x", value: 200, max: 100 };
    const clamped = renderCanvasForChannel(`:::canvas\n${JSON.stringify(over)}\n:::`, "telegram");
    expect(clamped).toContain("(200 / 100)");
    expect(clamped).toMatch(/▰{12}/); // fully filled (12-wide default)
  }
  {
    const block = { type: "slider", label: "Budget", value: 5000, min: 0, max: 10000, unit: "$" };
    const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "telegram");
    expect(out).toContain("**Budget**");
    expect(out).toContain("5000$");
    expect(out).toContain("(0–10000$)");
  }
});

// ── link-list ──────────────────────────────────────────────────────

test("list blocks (link-list, tabs, timeline) keep every item", () => {
  {
    const block = {
      type: "link-list",
      title: "Top Stories",
      items: [
        { label: "AI hits mainstream", url: "https://example.com/1", description: "HN discussion" },
        { label: "Plain", url: "https://example.com/2" },
        { label: "No url label" },
      ],
    };
    const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "discord");
    expect(out).toContain("**Top Stories**");
    expect(out).toContain("[AI hits mainstream](https://example.com/1)");
    expect(out).toContain("_HN discussion_");
    expect(out).toContain("[Plain](https://example.com/2)");
    expect(out).toContain("• No url label");
  }
  {
    const block = {
      type: "tabs",
      tabs: [
        { label: "Summary", content: "Revenue grew **12%**" },
        { label: "Notes", content: "Forecast holds" },
      ],
    };
    const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "discord");
    expect(out).toContain("**Summary**");
    expect(out).toContain("Revenue grew **12%**");
    expect(out).toContain("**Notes**");
    expect(out).toContain("Forecast holds");
  }
  {
    const block = {
      type: "timeline",
      title: "Today",
      events: [
        { time: "09:00", title: "Standup", description: "with team" },
        { title: "Lunch" },
      ],
    };
    const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "telegram");
    expect(out).toContain("**Today**");
    expect(out).toContain("`09:00`");
    expect(out).toContain("**Standup**");
    expect(out).toContain("with team");
    expect(out).toContain("**Lunch**");
  }
});

// ── bar-chart ──────────────────────────────────────────────────────

test("chart blocks (bar, line, sparkline, donut) draw every value", () => {
  {
    const block = {
      type: "bar-chart",
      title: "Allocation",
      bars: [
        { label: "BTC", value: 45 },
        { label: "ETH", value: 30 },
      ],
    };
    const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "telegram");
    expect(out).toContain("**Allocation**");
    expect(out).toContain("BTC");
    expect(out).toContain("ETH");
    expect(out).toMatch(/[▰▱]/);
    expect(out).toContain("45");
    expect(out).toContain("30");
  }
  {
    const block = {
      type: "line-chart",
      title: "Weekly",
      series: [
        { label: "Up", data: [1, 2, 3, 4, 5] },
        { label: "Down", data: [10, 7, 5, 3, 1] },
        { label: "Flat", data: [5, 5, 5, 5] },
      ],
    };
    const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "telegram");
    expect(out).toContain("**Up**");
    expect(out).toContain("📈");
    expect(out).toContain("**Down**");
    expect(out).toContain("📉");
    expect(out).toContain("**Flat**");
    expect(out).toContain("→");
    expect(out).toContain("1 → 5");
    expect(out).toContain("10 → 1");

    const empty = { type: "line-chart", series: [{ label: "Empty", data: [] }] };
    expect(renderCanvasForChannel(`:::canvas\n${JSON.stringify(empty)}\n:::`, "telegram")).toContain("(no data)");
  }
  {
    const block = { type: "sparkline", label: "BTC 7d", values: [104, 102, 105, 108, 107, 110, 112] };
    const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "telegram");
    expect(out).toContain("**BTC 7d**");
    expect(out).toContain("(latest: 112)");
    expect(out).toMatch(/[▁▂▃▄▅▆▇█]+/);

    const empty = { type: "sparkline", label: "x", values: [] };
    expect(renderCanvasForChannel(`:::canvas\n${JSON.stringify(empty)}\n:::`, "telegram")).toContain("(no data)");
  }
  {
    const block = {
      type: "donut-chart",
      title: "Mix",
      segments: [
        { label: "A", value: 30 },
        { label: "B", value: 70 },
      ],
    };
    const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "telegram");
    expect(out).toContain("**A**");
    expect(out).toContain("(30%)");
    expect(out).toContain("**B**");
    expect(out).toContain("(70%)");
  }
});

// ── line-chart ─────────────────────────────────────────────────────


// ── slider ─────────────────────────────────────────────────────────


// ── tabs ───────────────────────────────────────────────────────────


// ── sparkline ──────────────────────────────────────────────────────


// ── timeline ───────────────────────────────────────────────────────


// ── donut-chart ────────────────────────────────────────────────────


// ── callout ────────────────────────────────────────────────────────

test("callout renders blockquote with variant icon", () => {
  const block = { type: "callout", variant: "warning", title: "Heads up", message: "be careful\nseriously" };
  const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "telegram");
  expect(out).toContain("⚠️");
  expect(out).toContain("**Heads up**");
  // Multi-line message should keep blockquote prefix on every line
  expect(out).toMatch(/> be careful\n> seriously/);

  const unknown = { type: "callout", variant: "moonbeam", message: "hi" };
  expect(renderCanvasForChannel(`:::canvas\n${JSON.stringify(unknown)}\n:::`, "telegram")).toContain("💡");
});

// ── countdown ──────────────────────────────────────────────────────

test("countdown shows Expired for a past target and time remaining for a future one", () => {
  const past = { type: "countdown", title: "Done", target: "2000-01-01T00:00:00Z" };
  const expired = renderCanvasForChannel(`:::canvas\n${JSON.stringify(past)}\n:::`, "telegram");
  expect(expired).toContain("**Done**");
  expect(expired).toContain("Expired");

  const future = new Date(Date.now() + 2 * 86_400_000 + 3 * 3_600_000 + 4 * 60_000).toISOString();
  const block = { type: "countdown", title: "Launch", target: future, subtitle: "soon" };
  const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "telegram");
  expect(out).toContain("⏳");
  expect(out).toContain("d"); // days segment present
  expect(out).toContain("_soon_");
});

// ── pixel-canvas ───────────────────────────────────────────────────

test("pixel-canvas and drawing-canvas render a channel fallback", () => {
  const block = {
    type: "pixel-canvas",
    title: "Sketch",
    width: 16,
    height: 12,
    initialPixels: [{ x: 1, y: 2, color: "#ef4444" }],
  };
  const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "discord");
  expect(out).toContain("**Sketch**");
  expect(out).toContain("16x12");
  expect(out).toContain("1 pixel prefilled");

  const drawing = {
    type: "drawing-canvas",
    title: "Vector sketch",
    width: 640,
    height: 360,
    paths: [{ d: "M 0 0 L 10 10", stroke: "#fff" }],
    shapes: [{ type: "circle", cx: 10, cy: 10, r: 5 }],
    labels: [{ x: 1, y: 1, text: "hi" }],
  };
  const vector = renderCanvasForChannel(`:::canvas\n${JSON.stringify(drawing)}\n:::`, "discord");
  expect(vector).toContain("**Vector sketch**");
  expect(vector).toContain("640x360");
  expect(vector).toContain("3 elements");
});

// ── interactive blocks (web-only) ─────────────────────────────────

test("choice and form fall back to a plain option list, embed to a plain link", () => {
  const choice = ':::canvas\n{"type":"choice","title":"Plan?","options":[{"label":"Cheap"},{"label":"Fast"}]}\n:::';
  expect(renderCanvasForChannel(choice, "telegram")).toBe("**Plan?**\n• Cheap\n• Fast");
  const form = ':::canvas\n{"type":"form","fields":[{"name":"city","label":"City"}]}\n:::';
  expect(renderCanvasForChannel(form, "discord")).toBe("• City");
  const embed = ':::canvas\n{"type":"embed","title":"Login booth","url":"https://booth.example:8451/vnc.html"}\n:::';
  expect(renderCanvasForChannel(embed, "telegram")).toBe("[Login booth](https://booth.example:8451/vnc.html)");
});
