import { existsSync, readFileSync } from "fs";
import { expect, test } from "vitest";
import {
  addStrokes,
  createSketch,
  describeSketch,
  readSketch,
  removeLastUserStroke,
  renderRehearsal,
  renderSketchViews,
  sketchFence,
  sketchSvg,
  updateSketch,
} from "../../src/lib/sketches.js";

const LINE = { d: "M10 10 L 90 90" };
const PNG_SIGNATURE = "89504e47";

test("a new sheet is the user's turn and empty", () => {
  const s = createSketch({ title: "Dog" });
  expect(readSketch(s.id)).toMatchObject({ title: "Dog", turn: "user", strokes: [] });
});

test("an unknown or malformed id reads as null, so it cannot walk the filesystem", () => {
  expect(readSketch("../../etc/passwd")).toBeNull();
  expect(readSketch("00000000-0000-0000-0000-000000000000")).toBeNull();
});

test("an agent's marks hand the turn back and replace its note; a user's marks do neither", () => {
  const s = createSketch({ title: "Logo", note: "start" });
  updateSketch(s.id, { turn: "agent" });
  expect(addStrokes(s.id, [LINE], "user")).toMatchObject({ turn: "agent", note: "start" });
  expect(addStrokes(s.id, [LINE], "agent", { note: "Is this it?" })).toMatchObject({ turn: "user", note: "Is this it?" });
});

test("stroke input is validated, because it ends up in SVG markup", () => {
  const s = createSketch({ title: "x" });
  expect(() => addStrokes(s.id, [{ d: 'M0 0"/><script>alert(1)</script>' }], "user")).toThrow(/valid SVG path/);
  expect(() => addStrokes(s.id, [{ d: "L 10 10" }], "user")).toThrow(/start with M/);
  const [stroke] = addStrokes(s.id, [{ d: "M0 0 L1 1", color: 'red"/>', width: 9000, fill: "url(#x)" }], "user").strokes;
  expect(stroke).toMatchObject({ color: "#2a2a2c", width: 40 });
  expect(stroke.fill).toBeUndefined();
});

test("a reference must be one of our own uploads", () => {
  expect(() => createSketch({ title: "x", reference: "https://evil.example/a.png" })).toThrow(/uploads/);
  expect(() => createSketch({ title: "x", reference: "/api/uploads/../../secret" })).toThrow(/uploads/);
  expect(createSketch({ title: "x", reference: "/api/uploads/a-b_c.jpg" }).reference).toBe("/api/uploads/a-b_c.jpg");
});

test("undo removes the user's last mark, never the agent's", () => {
  const s = createSketch({ title: "x" });
  addStrokes(s.id, [{ d: "M1 1 L2 2" }], "user");
  addStrokes(s.id, [{ d: "M3 3 L4 4" }], "agent");
  const after = removeLastUserStroke(s.id);
  expect(after.strokes.map((m) => m.author)).toEqual(["agent"]);
  expect(removeLastUserStroke(s.id).strokes).toHaveLength(1);
});

test("the fence freezes a copy at the current number of marks", () => {
  const s = addStrokes(createSketch({ title: "x" }).id, [LINE, LINE], "agent");
  expect(JSON.parse(sketchFence(s).split("\n")[1])).toEqual({ type: "sketchpad", id: s.id, title: "x", upTo: 2 });
});

test("the grid view numbers each mark at its start", () => {
  const s = addStrokes(createSketch({ title: "x" }).id, [{ d: "M120 240 L 130 250" }], "user");
  expect(sketchSvg(s)).not.toContain("<circle");
  expect(sketchSvg(s, { grid: true })).toContain('cx="120" cy="240"');
  expect(describeSketch(s)).toContain("0 user #2a2a2c from 120,240");
});

test("the agent can look at the sheet, and rehearse without changing it", async () => {
  const s = addStrokes(createSketch({ title: "x" }).id, [LINE], "user");
  const views = await renderSketchViews(s.id);
  expect(readFileSync(views.sheet).subarray(0, 4).toString("hex")).toBe(PNG_SIGNATURE);
  expect(readFileSync(views.grid).subarray(0, 4).toString("hex")).toBe(PNG_SIGNATURE);

  const rehearsal = await renderRehearsal(s.id, [{ d: "M5 5 L 50 50", color: "#c2571a" }]);
  expect(existsSync(rehearsal.sheet)).toBe(true);
  expect(readSketch(s.id)?.strokes).toHaveLength(1);
});
