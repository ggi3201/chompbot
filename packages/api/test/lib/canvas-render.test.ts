import { test, expect } from "vitest";
import { renderCanvasForChannel } from "../../src/lib/canvas-render.js";

// ── Pass-through and malformed JSON ─────────────────────────────────

test("text without canvas blocks is returned unchanged", () => {
  const text = "hello world\n\nno canvas here";
  expect(renderCanvasForChannel(text, "telegram")).toBe(text);
  expect(renderCanvasForChannel(text, "discord")).toBe(text);
});

test("malformed canvas JSON is stripped, not preserved", () => {
  const input = "before\n\n:::canvas\n{not valid json\n:::\n\nafter";
  const out = renderCanvasForChannel(input, "telegram");
  expect(out).not.toContain("not valid json");
  expect(out).toContain("before");
  expect(out).toContain("after");
});

test("unknown canvas types are stripped silently", () => {
  const input = ':::canvas\n{"type":"never-heard-of-this","value":"x"}\n:::';
  expect(renderCanvasForChannel(input, "discord")).toBe("");
});

test("preserves surrounding text and collapses excess blank lines", () => {
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
});

test("info-card with negative change uses down arrow", () => {
  const block = { type: "info-card", title: "ETH", value: "$3,000", change: "-1.5%" };
  const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "discord");
  expect(out).toContain("📉");
  expect(out).toContain("-1.5%");
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
});

test("metric-grid with no items returns empty", () => {
  const block = { type: "metric-grid", items: [] };
  const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "discord");
  expect(out).toBe("");
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
});

test("data-table escapes pipe characters in cells on Discord", () => {
  const block = {
    type: "data-table",
    headers: ["Name"],
    rows: [["a|b"]],
  };
  const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "discord");
  expect(out).toContain("a\\|b");
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
});

test("data-table without rows still emits title", () => {
  const block = { type: "data-table", title: "Empty", headers: ["A"], rows: [] };
  const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "telegram");
  expect(out).toBe("**Empty**");
});

// ── progress-bar ───────────────────────────────────────────────────

test("progress-bar renders unicode bar and percentage", () => {
  const block = { type: "progress-bar", label: "Deploy", value: 75, max: 100 };
  const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "telegram");
  expect(out).toContain("**Deploy**");
  expect(out).toMatch(/[▰▱]+/);
  expect(out).toContain("75%");
  expect(out).toContain("(75 / 100)");
});

test("progress-bar with showPercent: false hides the percentage", () => {
  const block = { type: "progress-bar", label: "x", value: 50, max: 100, showPercent: false };
  const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "telegram");
  expect(out).not.toContain("50%");
  expect(out).toContain("(50 / 100)");
});

test("progress-bar clamps overflow values to 100% bar fill", () => {
  const block = { type: "progress-bar", label: "x", value: 200, max: 100 };
  const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "telegram");
  // value text reflects raw value; bar fills to max
  expect(out).toContain("(200 / 100)");
  expect(out).toMatch(/▰{12}/); // fully filled (12-wide default)
});

// ── link-list ──────────────────────────────────────────────────────

test("link-list renders markdown links with optional descriptions", () => {
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
});

// ── bar-chart ──────────────────────────────────────────────────────

test("bar-chart includes labels, bars and values", () => {
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
});

// ── line-chart ─────────────────────────────────────────────────────

test("line-chart renders sparkline and first→last delta arrow per series", () => {
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
});

test("line-chart series with empty data gracefully degrades", () => {
  const block = { type: "line-chart", series: [{ label: "Empty", data: [] }] };
  const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "telegram");
  expect(out).toContain("(no data)");
});

// ── slider ─────────────────────────────────────────────────────────

test("slider renders fill-bar between min and max", () => {
  const block = { type: "slider", label: "Budget", value: 5000, min: 0, max: 10000, unit: "$" };
  const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "telegram");
  expect(out).toContain("**Budget**");
  expect(out).toContain("5000$");
  expect(out).toContain("(0–10000$)");
});

// ── tabs ───────────────────────────────────────────────────────────

test("tabs renders each tab as label + content block", () => {
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
});

// ── sparkline ──────────────────────────────────────────────────────

test("sparkline renders unicode chars and latest value", () => {
  const block = { type: "sparkline", label: "BTC 7d", values: [104, 102, 105, 108, 107, 110, 112] };
  const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "telegram");
  expect(out).toContain("**BTC 7d**");
  expect(out).toContain("(latest: 112)");
  expect(out).toMatch(/[▁▂▃▄▅▆▇█]+/);
});

test("sparkline with no values shows '(no data)' when label is set", () => {
  const block = { type: "sparkline", label: "x", values: [] };
  const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "telegram");
  expect(out).toContain("(no data)");
});

// ── timeline ───────────────────────────────────────────────────────

test("timeline renders events with optional time prefix and description", () => {
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
});

// ── donut-chart ────────────────────────────────────────────────────

test("donut-chart shows segments with percentages summing to 100", () => {
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
});

// ── callout ────────────────────────────────────────────────────────

test("callout renders blockquote with variant icon", () => {
  const block = { type: "callout", variant: "warning", title: "Heads up", message: "be careful\nseriously" };
  const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "telegram");
  expect(out).toContain("⚠️");
  expect(out).toContain("**Heads up**");
  // Multi-line message should keep blockquote prefix on every line
  expect(out).toMatch(/> be careful\n> seriously/);
});

test("callout with unknown variant falls back to default icon", () => {
  const block = { type: "callout", variant: "moonbeam", message: "hi" };
  const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "telegram");
  expect(out).toContain("💡");
});

// ── countdown ──────────────────────────────────────────────────────

test("countdown shows expired marker when target is in the past", () => {
  const block = { type: "countdown", title: "Done", target: "2000-01-01T00:00:00Z" };
  const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "telegram");
  expect(out).toContain("**Done**");
  expect(out).toContain("Expired");
});

test("countdown with future target shows time-remaining and ISO target", () => {
  const future = new Date(Date.now() + 2 * 86_400_000 + 3 * 3_600_000 + 4 * 60_000).toISOString();
  const block = { type: "countdown", title: "Launch", target: future, subtitle: "soon" };
  const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "telegram");
  expect(out).toContain("⏳");
  expect(out).toContain("d"); // days segment present
  expect(out).toContain("_soon_");
});

// ── pixel-canvas ───────────────────────────────────────────────────

test("pixel-canvas renders a channel fallback", () => {
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
});

// ── drawing-canvas ─────────────────────────────────────────────────

test("drawing-canvas renders a channel fallback", () => {
  const block = {
    type: "drawing-canvas",
    title: "Vector sketch",
    width: 640,
    height: 360,
    paths: [{ d: "M 0 0 L 10 10", stroke: "#fff" }],
    shapes: [{ type: "circle", cx: 10, cy: 10, r: 5 }],
    labels: [{ x: 1, y: 1, text: "hi" }],
  };
  const out = renderCanvasForChannel(`:::canvas\n${JSON.stringify(block)}\n:::`, "discord");
  expect(out).toContain("**Vector sketch**");
  expect(out).toContain("640x360");
  expect(out).toContain("3 elements");
});

// ── multiple blocks in one message ─────────────────────────────────

test("multiple canvas blocks each render and are separated by blank lines", () => {
  const a = { type: "info-card", title: "BTC", value: "1" };
  const b = { type: "info-card", title: "ETH", value: "2" };
  const input = `:::canvas\n${JSON.stringify(a)}\n:::\n\n:::canvas\n${JSON.stringify(b)}\n:::`;
  const out = renderCanvasForChannel(input, "telegram");
  expect(out).toContain("**BTC**");
  expect(out).toContain("**ETH**");
  expect(out.indexOf("**BTC**")).toBeLessThan(out.indexOf("**ETH**"));
});

// ── interactive blocks (web-only) ─────────────────────────────────

test("choice and form fall back to a plain option list", () => {
  const choice = ':::canvas\n{"type":"choice","title":"Plan?","options":[{"label":"Cheap"},{"label":"Fast"}]}\n:::';
  expect(renderCanvasForChannel(choice, "telegram")).toBe("**Plan?**\n• Cheap\n• Fast");
  const form = ':::canvas\n{"type":"form","fields":[{"name":"city","label":"City"}]}\n:::';
  expect(renderCanvasForChannel(form, "discord")).toBe("• City");
});

test("embed falls back to a plain link outside web chat", () => {
  const input = ':::canvas\n{"type":"embed","title":"Login booth","url":"https://booth.example:8451/vnc.html"}\n:::';
  expect(renderCanvasForChannel(input, "telegram")).toBe("[Login booth](https://booth.example:8451/vnc.html)");
});
